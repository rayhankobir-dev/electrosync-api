import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, MaxLength } from 'class-validator';

export class ForgotPasswordDto {
  @ApiProperty({ example: 'raju@example.com' })
  @IsEmail()
  @MaxLength(255)
  email: string;
}
