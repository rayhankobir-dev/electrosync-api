import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';

import { UserSettings } from '@/database/types/user-settings.type';

export class UpdateUserSettingsDto implements UserSettings {
  @ApiPropertyOptional({ description: 'Master switch for push notifications.' })
  @IsOptional()
  @IsBoolean()
  pushEnabled?: boolean;

  @ApiPropertyOptional({
    description: 'Alert when the meter balance runs low.',
  })
  @IsOptional()
  @IsBoolean()
  lowBalanceAlerts?: boolean;

  @ApiPropertyOptional({
    description: 'Balance in BDT below which a low-balance alert fires.',
    minimum: 0,
    maximum: 100000,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100_000)
  lowBalanceThreshold?: number;

  @ApiPropertyOptional({ description: 'Alert when a recharge is recorded.' })
  @IsOptional()
  @IsBoolean()
  rechargeAlerts?: boolean;

  @ApiPropertyOptional({ enum: ['en', 'bn'] })
  @IsOptional()
  @IsIn(['en', 'bn'])
  language?: 'en' | 'bn';

  @ApiPropertyOptional({ enum: ['light', 'dark', 'system'] })
  @IsOptional()
  @IsIn(['light', 'dark', 'system'])
  theme?: 'light' | 'dark' | 'system';
}
