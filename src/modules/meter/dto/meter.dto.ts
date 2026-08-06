import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

import {
  DEFAULT_METER_PROVIDER,
  DEFAULT_METER_TYPE,
  MeterProvider,
  MeterType,
} from '@/database/types/meter.type';

export class AddMeterDto {
  @ApiProperty({
    example: '33009605',
    description: 'Customer (consumer) number — digits only.',
  })
  @IsNotEmpty()
  @IsString()
  @Matches(/^\d{6,20}$/, {
    message: 'Customer number must be a numeric',
  })
  customerNo: string;

  @ApiPropertyOptional({
    enum: MeterType,
    default: DEFAULT_METER_TYPE,
    description: 'What the meter is for. Defaults to HOME.',
  })
  @IsOptional()
  @IsEnum(MeterType)
  type?: MeterType;

  @ApiPropertyOptional({
    enum: MeterProvider,
    default: DEFAULT_METER_PROVIDER,
    description: 'Utility supplying this meter. Defaults to NESCO.',
  })
  @IsOptional()
  @IsEnum(MeterProvider)
  provider?: MeterProvider;

  @ApiPropertyOptional({ example: 'Home', description: 'Your name for it.' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  label?: string;
}

export class UpdateMeterDto {
  @ApiPropertyOptional({ example: 'Shop' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  label?: string;

  @ApiPropertyOptional({
    description:
      'Pass `true` to make this the default meter, which demotes the current ' +
      'one. `false` is rejected: an account must always have a primary, so ' +
      'switching means promoting the meter you want instead.',
  })
  @IsOptional()
  @IsBoolean()
  isPrimary?: boolean;
}

export class MeterDto {
  @ApiProperty()
  id: string;

  @ApiProperty({ example: '33009605' })
  customerNo: string;

  @ApiProperty({ enum: MeterType })
  type: MeterType;

  @ApiProperty({ enum: MeterProvider })
  provider: MeterProvider;

  @ApiPropertyOptional({ type: String, nullable: true })
  label: string | null;

  @ApiProperty()
  isPrimary: boolean;

  @ApiProperty()
  createdAt: Date;
}
