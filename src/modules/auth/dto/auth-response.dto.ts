import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class IssuedTokenDto {
  @ApiProperty({ description: 'Bearer token for the Authorization header.' })
  accessToken: string;

  @ApiProperty({
    example: 7776000,
    description:
      'Lifetime in seconds. There is no refresh — re-login after this.',
  })
  expiresIn: number;
}

export class PublicKeyDto {
  @ApiProperty({ example: 'RS256' })
  algorithm: string;

  @ApiProperty({
    description: 'PEM-encoded public key. Safe to embed in a client.',
  })
  publicKey: string;
}

export class UserProfileDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  name: string;

  @ApiProperty()
  email: string;

  @ApiPropertyOptional({ type: Boolean, nullable: true })
  emailVerified: boolean | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  mobile: string | null;

  @ApiProperty()
  createdAt: Date;
}
