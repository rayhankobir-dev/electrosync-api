import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

export class ChangePasswordDto {
  /**
   * Unconstrained beyond being a non-empty string. It is checked against the
   * stored hash, not against a policy — an account created before the current
   * rules would be locked out of changing its password by a `@MinLength(8)`
   * here.
   */
  @ApiProperty({ example: 'correct horse battery staple' })
  @IsString()
  @MinLength(1)
  @MaxLength(256)
  currentPassword: string;

  /** Same bounds as `RegisterDto.password` — one rule for setting a password. */
  @ApiProperty({ minLength: 8, example: 'a whole new passphrase' })
  @IsString()
  @MinLength(8)
  @MaxLength(256)
  newPassword: string;
}
