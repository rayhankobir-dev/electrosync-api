import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { AuthService } from './auth.service';
import { type AuthenticatedUser } from './types';
import { CurrentUser } from './decorators/current-user.decorator';
import { Public } from './decorators/public.decorator';
import {
  IssuedTokenDto,
  PublicKeyDto,
  UserProfileDto,
} from './dto/auth-response.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { PasswordResetService } from './password-reset.service';
import { TokenService } from './token.service';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly tokens: TokenService,
    private readonly passwordReset: PasswordResetService,
  ) {}

  @Public()
  @Post('register')
  @ApiOperation({ summary: 'Create an account and sign in.' })
  @ApiCreatedResponse({ type: IssuedTokenDto })
  @ApiConflictResponse({ description: 'That email is already registered.' })
  register(@Body() dto: RegisterDto): Promise<IssuedTokenDto> {
    return this.auth.register(dto);
  }

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Exchange credentials for a token.' })
  @ApiOkResponse({ type: IssuedTokenDto })
  @ApiUnauthorizedResponse({ description: 'Invalid email or password.' })
  login(@Body() dto: LoginDto): Promise<IssuedTokenDto> {
    return this.auth.login(dto);
  }

  @Public()
  @Post('forgot-password')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Email a one-time password-reset code.',
    description:
      'Accepts every syntactically valid email and returns 202 whether or not an ' +
      'account exists, so this cannot be used to discover which emails are ' +
      'registered. A code is only sent to an account that has a password.',
  })
  @ApiAcceptedResponse({ description: 'Request accepted. No body.' })
  @ApiTooManyRequestsResponse({
    description:
      'One code per email per minute, and five per hour. The body carries ' +
      '`retryAfterSeconds`.',
  })
  forgotPassword(@Body() dto: ForgotPasswordDto): Promise<void> {
    return this.passwordReset.request(dto);
  }

  @Public()
  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Trade a reset code for a new password and a session.',
    description:
      'Returns the same token shape as /auth/login — the user is signed in on ' +
      'success. Tokens issued before the reset remain valid until they expire; ' +
      'there is no session table to revoke against.',
  })
  @ApiOkResponse({ type: IssuedTokenDto })
  @ApiBadRequestResponse({
    description:
      'The code is wrong, expired, already used, or out of attempts — all ' +
      'reported identically, so a caller cannot learn whether a live code exists.',
  })
  resetPassword(@Body() dto: ResetPasswordDto): Promise<IssuedTokenDto> {
    return this.passwordReset.reset(dto);
  }

  @Public()
  @Get('public-key')
  @ApiOperation({ summary: 'RS256 public key for verifying tokens.' })
  @ApiOkResponse({ type: PublicKeyDto })
  publicKey(): PublicKeyDto {
    return { algorithm: 'RS256', publicKey: this.tokens.publicKey() };
  }

  @Get('me')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'The authenticated user’s profile.' })
  @ApiOkResponse({ type: UserProfileDto })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid token.' })
  me(@CurrentUser() user: AuthenticatedUser) {
    return this.auth.findProfile(user.id);
  }
}
