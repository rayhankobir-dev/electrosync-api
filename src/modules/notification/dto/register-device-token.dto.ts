import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export enum DevicePlatform {
  IOS = 'ios',
  ANDROID = 'android',
  WEB = 'web',
}

export class RegisterDeviceTokenDto {
  @ApiProperty({
    description: 'FCM registration token issued by the client SDK.',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(4096)
  token: string;

  @ApiProperty({ enum: DevicePlatform })
  @IsEnum(DevicePlatform)
  platform: DevicePlatform;

  @ApiPropertyOptional({ description: 'Stable per-install device identifier.' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  deviceId?: string;
}
