import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';

import { DRIZZLE } from '@/database/constants/database.constants';
import { type DrizzleDb } from '@/database/types/drizzle';
import { deviceToken, notification } from '@/database/schema';

import { RegisterDeviceTokenDto } from './dto/register-device-token.dto';
import { ListNotificationsQueryDto } from './dto/list-notifications.query.dto';
import { FcmService } from './fcm/fcm.service';
import { FcmSendResult, PushPayload } from './fcm/fcm.types';

export interface SendOutcome {
  readonly notificationId: string;
  readonly pushAttempted: boolean;
  readonly delivery: FcmSendResult;
}

@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly fcm: FcmService,
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
      };
    }

    const tokens = await this.activeTokensFor(userId);
    if (tokens.length === 0) {
      return {
        notificationId: record.id,
        pushAttempted: false,
        delivery: empty,
      };
    }

    const delivery = await this.fcm.sendToTokens(tokens, payload);

    if (delivery.invalidTokens.length > 0) {
      await this.deactivateTokens(delivery.invalidTokens);
    }

    return { notificationId: record.id, pushAttempted: true, delivery };
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
