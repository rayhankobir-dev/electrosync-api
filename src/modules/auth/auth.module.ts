import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';

import { MailModule } from '@/modules/mail/mail.module';

import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { PasswordResetService } from './password-reset.service';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';

function pem(value: string): string {
  return value.replace(/\\n/g, '\n');
}

@Global()
@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        privateKey: pem(config.getOrThrow<string>('JWT_PRIVATE_KEY')),
        publicKey: pem(config.getOrThrow<string>('JWT_PUBLIC_KEY')),
        signOptions: { algorithm: 'RS256' },
        verifyOptions: { algorithms: ['RS256'] },
      }),
    }),
    MailModule,
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    TokenService,
    PasswordService,
    PasswordResetService,
    JwtAuthGuard,
  ],
  exports: [JwtAuthGuard, JwtModule, TokenService],
})
export class AuthModule {}
