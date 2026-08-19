import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsISO8601, IsOptional, IsString } from 'class-validator';

import {
  USAGE_GRANULARITY,
  type UsageGranularity,
} from '@/database/types/usage.type';

const GRANULARITIES = Object.values(USAGE_GRANULARITY);

export class UsageAnalyticsQueryDto {
  @ApiProperty({
    enum: GRANULARITIES,
    example: USAGE_GRANULARITY.DAILY,
    description:
      'daily and weekly return one point per period. weekday returns exactly seven points — the mean cost for each day of the week over the range.',
  })
  @IsIn(GRANULARITIES)
  granularity: UsageGranularity;

  @ApiProperty({
    example: '2026-08-01',
    description: 'First day to include, inclusive. Asia/Dhaka calendar date.',
  })
  @IsISO8601({ strict: true })
  from: string;

  @ApiProperty({
    example: '2026-08-07',
    description: 'Last day to include, inclusive. Asia/Dhaka calendar date.',
  })
  @IsISO8601({ strict: true })
  to: string;

  @ApiPropertyOptional({
    description: 'Restrict to one meter. Omit to combine all of your meters.',
  })
  @IsOptional()
  @IsString()
  meterId?: string;
}

export class UsagePointDto {
  @ApiProperty({
    example: '2026-08-02',
    description:
      'Start of the bucket, as an Asia/Dhaka calendar date. For weekday buckets this is absent and `weekday` is set instead.',
    required: false,
  })
  date?: string;

  @ApiProperty({
    example: 5,
    description:
      'ISO day of week, 1 = Monday … 7 = Sunday. Only present for granularity=weekday.',
    required: false,
  })
  weekday?: number;

  @ApiProperty({
    example: 172.4,
    description:
      'Consumption cost in BDT, as published by the portal for the settlement periods that closed in this bucket. A day the portal never published a separate figure for — because a missed reading batched it into a longer period — has no point at all rather than a point of 0. Check `settledDays` before reading this as one day of spend.',
  })
  consumedCost: number;

  @ApiProperty({
    example: 500,
    description:
      'Gross recharges in BDT. Always 0 for granularity=weekday, where averaging a point event would be meaningless.',
  })
  rechargedAmount: number;

  @ApiProperty({
    example: 0.75,
    description:
      'Fraction of the bucket covered by the settlements its cost came from, 0–1. Below 1 the cost is a floor, not a total — the gap is missing data, not an idle meter. Saturates at 1, so it cannot report a bucket holding more than its own length; `settledDays` can.',
  })
  coverage: number;

  @ApiProperty({
    example: 2,
    description:
      "Days' worth of settlement time behind `consumedCost`. Normally 1 for a daily bucket. Above 1 means the portal published one figure covering several days — a missed reading batched them together — so this bucket's cost is that whole period, not one day of it. Below 1 means the period was shorter than the bucket.",
  })
  settledDays: number;
}

export class UsageTotalsDto {
  @ApiProperty({ example: 345.2 })
  consumedCost: number;

  @ApiProperty({ example: 500 })
  rechargedAmount: number;
}

export class UsageAnalyticsDto {
  @ApiProperty({ enum: GRANULARITIES })
  granularity: UsageGranularity;

  @ApiProperty({ example: 'BDT' })
  currency: string;

  @ApiProperty({
    example: 2,
    description: 'Meters included in these figures.',
  })
  meterCount: number;

  @ApiProperty({
    example: 19,
    description:
      'Distinct Dhaka days in the range that a settlement closed on, and whose usage is therefore separately known. Lets a client tell "no data yet" apart from "genuinely no usage", and decide whether a pattern has enough history to be worth showing. A day merely crossed by a longer settlement period does not count.',
  })
  observedDays: number;

  @ApiProperty({ type: UsagePointDto, isArray: true })
  points: UsagePointDto[];

  @ApiProperty({ type: UsageTotalsDto })
  total: UsageTotalsDto;
}
