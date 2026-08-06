import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { AuthenticatedUser, IssuedToken, JwtPayload } from './types';

@Injectable()
export class TokenService {
  private readonly expiryDays: number;

  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {
    this.expiryDays = this.config.getOrThrow<number>('JWT_EXPIRY_DAYS');
  }

  async issue(user: AuthenticatedUser): Promise<IssuedToken> {
    const payload: JwtPayload = {
      sub: user.id,
      email: user.email,
      type: 'access',
    };

    const expiresIn = this.expiryDays * 24 * 60 * 60;
    const accessToken = await this.jwt.signAsync(payload, { expiresIn });

    return { accessToken, expiresIn };
  }

  publicKey(): string {
    return this.config
      .getOrThrow<string>('JWT_PUBLIC_KEY')
      .replace(/\\n/g, '\n');
  }
}
