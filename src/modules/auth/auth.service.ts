import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { and, eq } from 'drizzle-orm';

import { account, user } from '@/database/schema';
import type { DrizzleDb } from '@/database/types/drizzle';
import { DRIZZLE } from '@/database/constants/database.constants';

import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';
import { AuthenticatedUser, CREDENTIAL_PROVIDER, IssuedToken } from './types';

@Injectable()
export class AuthService {
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
