import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { and, eq } from 'drizzle-orm';

import { account, user } from '@/database/schema';
import type { DrizzleDb } from '@/database/types/drizzle';
import { DRIZZLE } from '@/database/constants/database.constants';

import { ChangePasswordDto } from './dto/change-password.dto';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';
import { AuthenticatedUser, CREDENTIAL_PROVIDER, IssuedToken } from './types';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
  ) {}

  async register(dto: RegisterDto): Promise<IssuedToken> {
    const email = this.normalizeEmail(dto.email);

    const existing = await this.db.query.user.findFirst({
      where: () => eq(user.email, dto.email),
      columns: { id: true },
    });

    if (existing) throw new ConflictException('Email already exists.');
    const passwordHash = await this.passwords.hash(dto.password);

    const created = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(user)
        .values({
          name: dto.name,
          email,
          mobile: dto.mobile,
          updatedAt: new Date(),
        })
        .returning({ id: user.id, email: user.email });

      await tx.insert(account).values({
        userId: row.id,
        accountId: email,
        providerId: CREDENTIAL_PROVIDER,
        password: passwordHash,
        updatedAt: new Date(),
      });

      return row;
    });

    return this.tokens.issue(created);
  }

  async login(dto: LoginDto): Promise<IssuedToken> {
    const email = this.normalizeEmail(dto.email);

    const found = await this.db
      .select({
        id: user.id,
        email: user.email,
        password: account.password,
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

    const record = found.at(0);

    if (!record?.password) {
      throw new UnauthorizedException('Invalid email or password.');
    }

    const valid = await this.passwords.verify(record.password, dto.password);
    if (!valid) {
      throw new UnauthorizedException('Invalid email or password.');
    }

    return this.tokens.issue({ id: record.id, email: record.email });
  }

  /**
   * Changes the password of a signed-in user, who proves the change is theirs
   * with the password they already have.
   *
   * Here rather than in `PasswordResetService` because the two flows share only
   * the column they write. That one exists to let someone in who *cannot*
   * authenticate, and pays for it with a mail round trip, a code table and a
   * throttle; this one is a single verify against a row the caller's token
   * already identifies.
   *
   * Every rejection is a 400, deliberately — including the wrong-password case,
   * where a 401 would be the more obvious status. The token in the request is
   * valid and the session is not in question; it is a field in the body that is
   * wrong. Clients treat 401 as "your session is over" and sign the user out on
   * it, so answering a typo with 401 would end the session it was protecting.
   */
  async changePassword(userId: string, dto: ChangePasswordDto): Promise<void> {
    const [credential] = await this.db
      .select({ id: account.id, password: account.password })
      .from(account)
      .where(
        and(
          eq(account.userId, userId),
          eq(account.providerId, CREDENTIAL_PROVIDER),
        ),
      )
      .limit(1);

    // No credential row, or one without a password: an OAuth-only account, once
    // that exists. There is nothing for `currentPassword` to be checked
    // against, so this is not a change that can be authorised.
    if (!credential?.password) {
      this.logger.warn(
        `Password change refused for ${userId}: no credential password`,
      );
      throw new BadRequestException('This account has no password to change.');
    }

    const valid = await this.passwords.verify(
      credential.password,
      dto.currentPassword,
    );

    if (!valid) {
      this.logger.warn(
        `Password change refused for ${userId}: current password mismatch`,
      );
      throw new BadRequestException('Your current password is wrong.');
    }

    // After the verify, not before. Reversed, the "same password" answer would
    // confirm a guess at the current password to anyone holding a stolen token,
    // turning this route into an oracle for it.
    if (dto.currentPassword === dto.newPassword) {
      throw new BadRequestException(
        'Your new password must be different from your current one.',
      );
    }

    const passwordHash = await this.passwords.hash(dto.newPassword);

    await this.db
      .update(account)
      .set({ password: passwordHash, updatedAt: new Date() })
      .where(eq(account.id, credential.id));

    this.logger.log(`Password changed for ${userId}`);

    /**
     * The caller's token — and every other token this account holds — stays
     * valid. Same reason as the reset flow: `JwtAuthGuard` verifies signatures
     * without touching the database, so there is no session state to revoke
     * against. Worth knowing that changing a password does not evict a device
     * that already has one.
     */
  }

  async findProfile(userId: string) {
    const profile = await this.db.query.user.findFirst({
      where: () => eq(user.id, userId),
      with: { meters: true },
    });

    if (!profile) throw new NotFoundException('User not found.');

    return profile;
  }

  private normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
  }
}

export type { AuthenticatedUser };
