import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';

import { DRIZZLE } from '@/database/constants/database.constants';
import {
  VERIFICATION_TYPE,
  account,
  user,
  verification,
} from '@/database/schema';
import type { DrizzleDb } from '@/database/types/drizzle';
import { MailService } from '@/modules/mail/mail.service';
import {
  isMailLocale,
  passwordResetMail,
} from '@/modules/mail/templates/password-reset.template';

import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { PasswordService } from './password.service';
import {
  CODE_TTL_MINUTES,
  codeExpiryFrom,
  generateCode,
  rejectionFor,
  requestWindowStart,
  throttleFor,
  type CodeRejection,
  type Throttle,
} from './password-reset.policy';
import { TokenService } from './token.service';
import { CREDENTIAL_PROVIDER, IssuedToken } from './types';

/**
 * Forgotten-password recovery: issue a one-time code by email, then trade it
 * for a new password and a session.
 *
 * Split out of `AuthService` rather than added to it. That file owns
 * register/login/profile; this flow brings its own dependencies (mail, the
 * verification table) and its own policy module, and folding the two together
 * would leave neither small enough to read in one sitting.
 */
@Injectable()
export class PasswordResetService {
  private readonly logger = new Logger(PasswordResetService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly mail: MailService,
  ) {}

  /**
   * Sends a code, if the email belongs to an account with a password.
   *
   * Returns normally either way. An unknown email is not an error the caller
   * gets to see: `/auth/register` already leaks account existence through its
   * 409, and there is no reason to hand out a second, cheaper oracle that needs
   * no write attempt.
   *
   * The one crack in that guarantee is deliberate and documented at the throw
   * site below.
   */
  async request(dto: ForgotPasswordDto): Promise<void> {
    const email = normalizeEmail(dto.email);
    const now = new Date();

    const recipient = await this.findCredentialUser(email);

    if (!recipient) {
      // Logged, because "no email arrived" is the most common support report
      // this flow will generate and the server is the only place that knows
      // which of the two reasons applied.
      this.logger.log(
        `Reset requested for unknown email ${email} — no mail sent`,
      );
      return;
    }

    await this.assertNotThrottled(email, now);

    const code = generateCode();
    const codeHash = await this.passwords.hash(code);

    // Retiring the previous codes before writing the new one is what makes
    // "only the newest code works" true. Without it, every resend leaves
    // another live code behind and the attempt ceiling stops being a ceiling —
    // five guesses per code, times as many codes as the user requested.
    await this.db.transaction(async (tx) => {
      await tx
        .update(verification)
        .set({ consumedAt: now, updatedAt: now })
        .where(
          and(
            eq(verification.identifier, email),
            eq(verification.type, VERIFICATION_TYPE.PASSWORD_RESET),
            isNull(verification.consumedAt),
          ),
        );

      await tx.insert(verification).values({
        identifier: email,
        type: VERIFICATION_TYPE.PASSWORD_RESET,
        value: codeHash,
        expiresAt: codeExpiryFrom(now),
        createdAt: now,
        updatedAt: now,
      });
    });

    /**
     * Awaited, and allowed to throw a 503 through to the client.
     *
     * This is the crack in the enumeration guarantee: while SMTP is broken a
     * registered email gets 503 where an unregistered one still gets 202, so the
     * status difference becomes an existence oracle. Accepted knowingly. The
     * alternative — swallow the failure and report success — makes a
     * misconfigured mail server invisible from the only vantage point that would
     * notice, and the oracle exists only in a window where the feature is
     * already broken for everyone.
     */
    await this.mail.send(
      passwordResetMail({
        to: recipient.email,
        name: firstName(recipient.name),
        code,
        expiresInMinutes: CODE_TTL_MINUTES,
        locale: isMailLocale(recipient.settings?.language)
          ? recipient.settings.language
          : 'en',
      }),
    );
  }

  /**
   * Redeems a code and returns a session.
   *
   * Signing the user in here rather than sending them back to the login screen:
   * they have just proved control of the inbox *and* chosen the password, so a
   * second manual login adds friction without adding evidence.
   */
  async reset(dto: ResetPasswordDto): Promise<IssuedToken> {
    const email = normalizeEmail(dto.email);
    const now = new Date();

    const [pending] = await this.db
      .select({
        id: verification.id,
        value: verification.value,
        expiresAt: verification.expiresAt,
        consumedAt: verification.consumedAt,
        attempts: verification.attempts,
      })
      .from(verification)
      .where(
        and(
          eq(verification.identifier, email),
          eq(verification.type, VERIFICATION_TYPE.PASSWORD_RESET),
        ),
      )
      .orderBy(desc(verification.createdAt))
      .limit(1);

    const rejection = rejectionFor(pending, now);
    if (rejection) throw this.invalidCode(email, rejection);

    const matches = await this.passwords.verify(pending.value, dto.code);

    if (!matches) {
      // The increment is what enforces the ceiling, so it has to happen on the
      // failure path before the throw. Done in SQL rather than read-modify-write
      // so concurrent guesses cannot both read `attempts: 4` and each write 5.
      await this.db
        .update(verification)
        .set({ attempts: sql`${verification.attempts} + 1`, updatedAt: now })
        .where(eq(verification.id, pending.id));

      throw this.invalidCode(email, 'mismatch');
    }

    const recipient = await this.findCredentialUser(email);

    if (!recipient) {
      // The account was deleted between the two requests. Rare, but treating it
      // as a 500 would be wrong — nothing failed, the code is simply no longer
      // redeemable.
      throw this.invalidCode(email, 'account-gone');
    }

    const passwordHash = await this.passwords.hash(dto.password);

    // One transaction, because a consumed code with an unchanged password locks
    // the user out of the recovery they just completed, and a changed password
    // with a live code leaves that code usable again.
    await this.db.transaction(async (tx) => {
      await tx
        .update(verification)
        .set({ consumedAt: now, updatedAt: now })
        .where(eq(verification.id, pending.id));

      await tx
        .update(account)
        .set({ password: passwordHash, updatedAt: now })
        .where(
          and(
            eq(account.userId, recipient.id),
            eq(account.providerId, CREDENTIAL_PROVIDER),
          ),
        );
    });

    this.logger.log(`Password reset completed for ${email}`);

    /**
     * Tokens issued before this point stay valid until they expire — there is no
     * session table and `JwtAuthGuard` verifies signatures without touching the
     * database, so nothing exists to revoke against. Consequence worth knowing:
     * resetting after a device is stolen does not sign that device out.
     */
    return this.tokens.issue({ id: recipient.id, email: recipient.email });
  }

  /** The user, only if they have a credential account — an OAuth-only user has no password to reset. */
  private async findCredentialUser(email: string) {
    const [found] = await this.db
      .select({
        id: user.id,
        email: user.email,
        name: user.name,
        settings: user.settings,
      })
      .from(user)
      .innerJoin(
        account,
        and(
          eq(account.userId, user.id),
          eq(account.providerId, CREDENTIAL_PROVIDER),
        ),
      )
      .where(eq(user.email, email))
      .limit(1);

    return found;
  }

  private async assertNotThrottled(email: string, now: Date): Promise<void> {
    // Bounded by the window rather than by a row count: the cooldown check needs
    // the newest row and the quota check needs everything inside the hour, and
    // that is the same query.
    const recent = await this.db
      .select({ createdAt: verification.createdAt })
      .from(verification)
      .where(
        and(
          eq(verification.identifier, email),
          eq(verification.type, VERIFICATION_TYPE.PASSWORD_RESET),
          gt(verification.createdAt, requestWindowStart(now)),
        ),
      )
      .orderBy(desc(verification.createdAt));

    const throttle = throttleFor(recent, now);
    if (throttle) throw this.tooManyRequests(email, throttle);
  }

  /**
   * One response for every way a code can fail to work.
   *
   * Wrong, expired, already used and never-existed are distinguishable in the
   * log and collapsed on the wire, because telling them apart tells an attacker
   * whether a live code exists for an email they do not control.
   */
  private invalidCode(
    email: string,
    reason: CodeRejection | 'mismatch' | 'account-gone',
  ): BadRequestException {
    this.logger.warn(`Reset code rejected for ${email}: ${reason}`);

    return new BadRequestException(
      'That code is wrong or has expired. Request a new one.',
    );
  }

  private tooManyRequests(email: string, throttle: Throttle): HttpException {
    this.logger.warn(
      `Reset throttled for ${email}: ${throttle.reason}, retry in ${throttle.retryAfterSeconds}s`,
    );

    return new HttpException(
      {
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
        message: 'Too many reset requests. Please wait before trying again.',
        retryAfterSeconds: throttle.retryAfterSeconds,
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * First word of the stored name, for the greeting. A full "Md. Raju Ahmed" reads
 * as a form letter where "Hi Raju" reads as a message.
 */
function firstName(name: string): string {
  return name.trim().split(/\s+/).at(0) || name;
}
