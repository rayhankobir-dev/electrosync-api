import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

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

  @ApiPropertyOptional({
    description: "Alert when a day's usage jumps above the meter's normal.",
  })
  @IsOptional()
  @IsBoolean()
  usageAnomalyAlerts?: boolean;

  /**
   * Floored at 10 rather than 0: a 0% threshold would fire on every day that
   * came in a taka above average, which is most of them. The ceiling is loose —
   * 500% is "only tell me about something extraordinary", which is a legitimate
   * thing to want.
   */
  @ApiPropertyOptional({
    description:
      'Percent above the trailing baseline that counts as an anomaly. ' +
      '40 means 40% above normal.',
    minimum: 10,
    maximum: 500,
  })
  @IsOptional()
  @IsInt()
  @Min(10)
  @Max(500)
  usageAnomalyThreshold?: number;

  @ApiPropertyOptional({ description: 'Also deliver alerts over WhatsApp.' })
  @IsOptional()
  @IsBoolean()
  whatsappAlerts?: boolean;

  @ApiPropertyOptional({ description: 'Also deliver alerts over SMS.' })
  @IsOptional()
  @IsBoolean()
  smsAlerts?: boolean;

  @ApiPropertyOptional({ description: 'Also deliver alerts over email.' })
  @IsOptional()
  @IsBoolean()
  emailAlerts?: boolean;

  /**
   * Null clears the override and puts the channel back on `user.mobile` — which
   * is why `@IsOptional` is the right decorator rather than a presence check: it
   * skips validation for null as well as undefined, and the two mean different
   * things here. Undefined leaves the stored value alone (the PATCH merges),
   * null actively resets it.
   *
   * Bounded but not pattern-matched, matching `UpdateProfileDto.mobile`: numbers
   * arrive as `+8801700000000`, `01700000000`, with spaces or dashes, and in
   * Bengali digits. `toBangladeshMsisdn` is what normalises them at send time,
   * and it is better placed to reject a number than a regex here.
   */
  @ApiPropertyOptional({ example: '+8801700000000', nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  whatsappNumber?: string | null;

  @ApiPropertyOptional({ example: '+8801700000000', nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  smsNumber?: string | null;

  @ApiPropertyOptional({ enum: ['en', 'bn'] })
  @IsOptional()
  @IsIn(['en', 'bn'])
  language?: 'en' | 'bn';

  @ApiPropertyOptional({ enum: ['light', 'dark', 'system'] })
  @IsOptional()
  @IsIn(['light', 'dark', 'system'])
  theme?: 'light' | 'dark' | 'system';
}

/**
 * Compile-time proof that this DTO declares every key of `UserSettings`.
 *
 * `implements UserSettings` looks like it already guarantees this, but it does
 * not: every property on that interface is optional, so a class satisfies it by
 * declaring none of them. That gap is not theoretical — `whatsappAlerts`,
 * `smsAlerts`, `emailAlerts` and the anomaly settings were all added to the
 * interface, read by the sweep and the notifier, and silently rejected at the
 * edge with "property whatsappAlerts should not exist", because the global
 * validation pipe runs `forbidNonWhitelisted` and this file never learned about
 * them. Nothing failed to compile.
 *
 * Now it does. Add a key to `UserSettings` without adding it here and this line
 * stops type-checking.
 *
 * It cannot check the decorators, only the declarations — `whitelist` strips any
 * property carrying no validator, so a new field still needs its `@IsOptional`
 * alongside. But the decorators are right beside the declaration, and the
 * declaration is the part that was missing.
 */
type MissingFromDto = Exclude<keyof UserSettings, keyof UpdateUserSettingsDto>;
type AssertNever<T extends never> = T;
export type _SettingsDtoIsExhaustive = AssertNever<MissingFromDto>;
