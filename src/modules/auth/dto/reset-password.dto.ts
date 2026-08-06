import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString, Matches, MaxLength, MinLength } from 'class-validator';

import { CODE_LENGTH } from '../password-reset.policy';

export class ResetPasswordDto {
  @ApiProperty({ example: 'raju@example.com' })
  @IsEmail()
  @MaxLength(255)
  email: string;

  /**
   * Validated as a digit *string*, not coerced to a number. Codes are
   * zero-padded, so `000042` is legitimate — parsing it as an integer would
   * make it compare equal to `42` and accept the wrong input.
   */
  @ApiProperty({ example: '482910', description: 'The 6-digit code from the email.' })
  @IsString()
  @Matches(new RegExp(`^\\d{${CODE_LENGTH}}$`), {
    message: `code must be exactly ${CODE_LENGTH} digits`,
  })
  code: string;

  @ApiProperty({ minLength: 8, example: 'correct horse battery staple' })
  @IsString()
  @MinLength(8)
  @MaxLength(256)
  password: string;
}
