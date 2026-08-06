import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Both fields are optional so the client can PATCH one without restating the
 * other. `email` is deliberately absent: it is the login identity and carries a
 * verification flag, so changing it is a separate flow rather than a text edit.
 */
export class UpdateProfileDto {
  @ApiPropertyOptional({ example: 'Md. Raju Ahmed' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  name?: string;

  /**
   * An empty string is accepted and stored as NULL — that is how the client
   * clears a number it no longer wants on the account. `@MinLength` would make
   * clearing impossible.
   */
  @ApiPropertyOptional({ example: '+8801700000000' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  mobile?: string;
}
