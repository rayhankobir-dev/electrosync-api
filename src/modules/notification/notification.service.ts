import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';

import { toBangladeshMsisdn } from '@/common/phone-number';
import { DRIZZLE } from '@/database/constants/database.constants';
import { type DrizzleDb } from '@/database/types/drizzle';
import { deviceToken, notification, user } from '@/database/schema';
import {
  DEFAULT_USER_SETTINGS,
  type UserSettings,
} from '@/database/types/user-settings.type';
import { MailService } from '@/modules/mail/mail.service';
import { alertMail } from '@/modules/mail/templates/alert.template';
import { isMailLocale } from '@/modules/mail/templates/password-reset.template';
import { SmsService } from '@/modules/sms/sms.service';

import { RegisterDeviceTokenDto } from './dto/register-device-token.dto';
import { ListNotificationsQueryDto } from './dto/list-notifications.query.dto';
import { FcmService } from './fcm/fcm.service';
import { FcmSendResult, PushPayload } from './fcm/fcm.types';

/**
 * Why the SMS channel did or did not run, for one notification.
 *
 * `skipped` carries a machine-readable reason rather than a boolean because
 * "the user turned SMS off" and "the user has no valid number on file" look
 * identical from the outside and want opposite responses — the first is working
 * as intended, the second is a misconfiguration the app should prompt the user
 * to fix.
 */
export type SmsOutcome =
  | { readonly status: 'sent'; readonly to: string; readonly segments: number }
  | {
      readonly status: 'skipped';
      readonly reason:
        'provider-not-configured' | 'channel-disabled' | 'no-usable-number';
    }
  | { readonly status: 'failed'; readonly reason: string };

/**
 * Why the email channel did or did not run, for one notification.
 *
 * Deliberately shaped like `SmsOutcome`. The two channels answer the same
 * question and a caller that handles one should not have to learn a second
 * vocabulary to handle the other — `no-usable-address` differs from
 * `no-usable-number` only because the thing that is missing differs.
 */
export type EmailOutcome =
  | { readonly status: 'sent'; readonly to: string }
  | {
      readonly status: 'skipped';
      readonly reason:
        'provider-not-configured' | 'channel-disabled' | 'no-usable-address';
    }
  | { readonly status: 'failed'; readonly reason: string };

export interface SendOutcome {
  readonly notificationId: string;
  readonly pushAttempted: boolean;
  readonly delivery: FcmSendResult;
  readonly sms: SmsOutcome;
  readonly email: EmailOutcome;
}

/**
 * Everything the extra channels need about the user, read once.
 *
 * Settings are resolved against the defaults here rather than in each channel,
 * so the two cannot disagree about what an absent flag means.
 */
interface Recipient {
  readonly userId: string;
  readonly mobile: string | null;
  readonly email: string | null;
  readonly settings: Required<UserSettings>;
}

@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly fcm: FcmService,
    private readonly sms: SmsService,
    private readonly mail: MailService,
  ) {}

  async registerDeviceToken(userId: string, dto: RegisterDeviceTokenDto) {
    const now = new Date();

    const [row] = await this.db
      .insert(deviceToken)
      .values({
        userId,
        token: dto.token,
        platform: dto.platform,
        deviceId: dto.deviceId,
        isActive: true,
        lastUsedAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: deviceToken.token,
        set: {
          userId,
          platform: dto.platform,
          deviceId: dto.deviceId,
          isActive: true,
          lastUsedAt: now,
          updatedAt: now,
        },
      })
      .returning();

    return row;
  }

  async unregisterDeviceToken(userId: string, token: string): Promise<void> {
    const [row] = await this.db
      .update(deviceToken)
      .set({ isActive: false, updatedAt: new Date() })
      .where(and(eq(deviceToken.token, token), eq(deviceToken.userId, userId)))
      .returning({ id: deviceToken.id });

    if (!row) {
      throw new NotFoundException('That device token is not registered.');
    }
  }

  async sendToUser(userId: string, payload: PushPayload): Promise<SendOutcome> {
    const [record] = await this.db
      .insert(notification)
      .values({
        userId,
        title: payload.title,
        body: payload.body,
        data: payload.data,
        sentAt: new Date(),
      })
      .returning({ id: notification.id });

    // One read for both channels. They want the same row, and the balance
    // sweep runs one of these per meter per pass.
    const recipient = await this.recipientFor(userId);

    // Both run regardless of how push turns out, and regardless of each other.
    // These are parallel channels, not fallbacks: a user who switched two of
    // them on asked for two messages, and a dead FCM token or a broken SMS
    // gateway is not a reason to withhold the third.
    const sms = await this.deliverSms(recipient, payload);
    const email = await this.deliverEmail(recipient, payload);

    const empty: FcmSendResult = {
      successCount: 0,
      failureCount: 0,
      invalidTokens: [],
    };

    if (!this.fcm.isConfigured) {
      this.logger.warn(
        `Stored notification ${record.id} but did not push: Firebase is not configured.`,
      );
      return {
        notificationId: record.id,
        pushAttempted: false,
        delivery: empty,
        sms,
        email,
      };
    }

    const tokens = await this.activeTokensFor(userId);
    if (tokens.length === 0) {
      return {
        notificationId: record.id,
        pushAttempted: false,
        delivery: empty,
        sms,
        email,
      };
    }

    const delivery = await this.fcm.sendToTokens(tokens, payload);

    if (delivery.invalidTokens.length > 0) {
      await this.deactivateTokens(delivery.invalidTokens);
    }

    return {
      notificationId: record.id,
      pushAttempted: true,
      delivery,
      sms,
      email,
    };
  }

  /**
   * Reads the one row both extra channels depend on.
   *
   * A missing user is not an error here: the notification has already been
   * written and pushed, and the channels below each have a well-defined answer
   * for "no address on file". Throwing would turn a delivered alert into a
   * failed sweep entry.
   */
  private async recipientFor(userId: string): Promise<Recipient> {
    const [row] = await this.db
      .select({
        mobile: user.mobile,
        email: user.email,
        settings: user.settings,
      })
      .from(user)
      .where(eq(user.id, userId));

    return {
      userId,
      mobile: row?.mobile ?? null,
      email: row?.email ?? null,
      settings: { ...DEFAULT_USER_SETTINGS, ...(row?.settings ?? {}) },
    };
  }

  /**
   * Sends the same notification as a text, when the user asked for one.
   *
   * Failures are caught rather than propagated, which is the one place in this
   * file that deliberately swallows an error. By the time this runs the
   * notification row is committed and the push has been attempted, so letting a
   * gateway outage throw would abort a *delivered* notification — and, in the
   * balance sweep, take down the alert for every meter behind it in the batch.
   * The compensating requirement is that nothing here fails quietly: every path
   * either logs or is reported in the returned `SmsOutcome`.
   */
  private async deliverSms(
    recipient: Recipient,
    payload: PushPayload,
  ): Promise<SmsOutcome> {
    if (!this.sms.isConfigured) {
      return { status: 'skipped', reason: 'provider-not-configured' };
    }

    const { settings } = recipient;

    if (!settings.smsAlerts) {
      return { status: 'skipped', reason: 'channel-disabled' };
    }

    // The settings override wins over the profile number, and `??` is what
    // implements that: `smsNumber` is null when the user has not set one, which
    // means "use the profile number" rather than "send nowhere".
    const number = toBangladeshMsisdn(settings.smsNumber ?? recipient.mobile);

    if (!number) {
      this.logger.warn(
        `User ${recipient.userId} has SMS alerts on but no usable mobile number; skipping the text.`,
      );
      return { status: 'skipped', reason: 'no-usable-number' };
    }

    try {
      // Title and body joined into one message because SMS has no subject
      // line, and the title alone ("Low meter balance") does not say which
      // meter — the part the user needs before deciding to act.
      const result = await this.sms.send({
        to: number,
        message: `${payload.title}: ${payload.body}`,
      });

      return { status: 'sent', to: result.to, segments: result.segments };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);

      this.logger.error(
        `SMS alert to user ${recipient.userId} failed (push and history are unaffected): ${reason}`,
      );

      return { status: 'failed', reason };
    }
  }

  /**
   * Sends the same notification as an email, when the user asked for one.
   *
   * Swallows failures on the same terms as `deliverSms`, and for the same
   * reason: by this point the notification is committed and the other channels
   * have run, so a rejected SMTP handshake must not take the alert down with
   * it — nor, inside the sweep, the meters queued behind it.
   *
   * The address is `user.email` with no settings override, unlike SMS. That is
   * not an omission: email is the login identity, so the column is `notNull`
   * and `unique` and there is exactly one right answer per account.
   */
  private async deliverEmail(
    recipient: Recipient,
    payload: PushPayload,
  ): Promise<EmailOutcome> {
    const { settings } = recipient;

    if (!settings.emailAlerts) {
      return { status: 'skipped', reason: 'channel-disabled' };
    }

    // Checked before sending rather than left to `MailService`. With no SMTP
    // host it logs the body and returns *successfully*, which is right for a
    // reset code a developer needs to read but wrong here — it would report a
    // delivery that never happened to a user relying on the channel.
    if (!this.mail.isConfigured) {
      return { status: 'skipped', reason: 'provider-not-configured' };
    }

    const to = recipient.email?.trim();

    if (!to) {
      this.logger.warn(
        `User ${recipient.userId} has email alerts on but no address on file; skipping the email.`,
      );
      return { status: 'skipped', reason: 'no-usable-address' };
    }

    try {
      await this.mail.send(
        alertMail({
          to,
          // Kept apart, unlike the SMS join above: email has a subject line, so
          // the title can do the job it was written for.
          title: payload.title,
          body: payload.body,
          locale: isMailLocale(settings.language) ? settings.language : 'en',
        }),
      );

      return { status: 'sent', to };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);

      this.logger.error(
        `Email alert to user ${recipient.userId} failed (push and history are unaffected): ${reason}`,
      );

      return { status: 'failed', reason };
    }
  }

  async listForUser(userId: string, query: ListNotificationsQueryDto) {
    const conditions = [eq(notification.userId, userId)];

    if (!query.includeArchived) {
      conditions.push(isNull(notification.archivedAt));
    }

    return this.db
      .select()
      .from(notification)
      .where(and(...conditions))
      .orderBy(desc(notification.sentAt))
      .limit(query.limit ?? 50);
  }

  async markAsRead(id: string, userId: string) {
    const [row] = await this.db
      .update(notification)
      .set({ readAt: new Date() })
      .where(and(eq(notification.id, id), eq(notification.userId, userId)))
      .returning();

    if (!row) {
      throw new NotFoundException('No such notification for this user.');
    }

    return row;
  }

  /**
   * Mark every unread notification read in one statement.
   *
   * Scoped to unread rows rather than blanket-setting `readAt`, so re-running
   * it does not rewrite the timestamp on rows the user read days ago — the
   * column is meant to record when something was first read.
   *
   * Archived rows are skipped: they are already out of the list this acts on,
   * and touching them would silently rewrite history the user cannot see.
   */
  async markAllAsRead(userId: string): Promise<{ updated: number }> {
    const rows = await this.db
      .update(notification)
      .set({ readAt: new Date() })
      .where(
        and(
          eq(notification.userId, userId),
          isNull(notification.readAt),
          isNull(notification.archivedAt),
        ),
      )
      .returning({ id: notification.id });

    return { updated: rows.length };
  }

  /**
   * Clear the user's notification list.
   *
   * A soft archive, not a `DELETE`. `listForUser` already hides archived rows
   * unless `includeArchived` asks for them, so from the app's side this empties
   * the list exactly as a delete would — but the history survives for support
   * and for the alert audit trail, and a mistaken tap costs nothing.
   */
  async archiveAll(userId: string): Promise<{ archived: number }> {
    const rows = await this.db
      .update(notification)
      .set({ archivedAt: new Date() })
      .where(
        and(eq(notification.userId, userId), isNull(notification.archivedAt)),
      )
      .returning({ id: notification.id });

    return { archived: rows.length };
  }

  private async activeTokensFor(userId: string): Promise<string[]> {
    const rows = await this.db
      .select({ token: deviceToken.token })
      .from(deviceToken)
      .where(
        and(eq(deviceToken.userId, userId), eq(deviceToken.isActive, true)),
      );

    return rows.map((row) => row.token);
  }

  private async deactivateTokens(tokens: readonly string[]): Promise<void> {
    await this.db
      .update(deviceToken)
      .set({ isActive: false, updatedAt: new Date() })
      .where(inArray(deviceToken.token, [...tokens]));

    this.logger.log(
      `Deactivated ${tokens.length} device token(s) FCM reported as unregistered.`,
    );
  }
}
