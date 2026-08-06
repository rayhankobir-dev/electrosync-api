import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { and, eq, sql, type SQL } from 'drizzle-orm';

import { DRIZZLE } from '@/database/constants/database.constants';
import { meter } from '@/database/schema';
import { type DrizzleDb } from '@/database/types/drizzle';
import {
  REPORTING_TIME_ZONE,
  USAGE_GRANULARITY,
} from '@/database/types/usage.type';

import {
  UsageAnalyticsDto,
  UsageAnalyticsQueryDto,
  UsagePointDto,
} from './dto/usage-analytics.dto';

const SECONDS_PER_DAY = 86_400;
const MS_PER_DAY = SECONDS_PER_DAY * 1000;

/**
 * Bangladesh is UTC+6 year-round with no daylight saving, so a fixed offset is
 * exact rather than an approximation. Used only to turn the caller's calendar
 * dates into instants; all bucketing happens in Postgres via `AT TIME ZONE`.
 */
const DHAKA_OFFSET = '+06:00';

/** Refuses ranges wide enough to spread a chart into uselessness anyway. */
const MAX_RANGE_DAYS = 366;

/**
 * Postgres returns `numeric` as a string to preserve precision that a JS
 * number cannot hold, so every aggregate arrives as text and is converted
 * once, at the edge.
 */
interface BucketRow extends Record<string, unknown> {
  bucket: string;
  cost: string | null;
  recharged: string | null;
  secs: string | null;
  observed_days: string | null;
}

@Injectable()
export class AnalyticsService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  async usage(
    userId: string,
    query: UsageAnalyticsQueryDto,
  ): Promise<UsageAnalyticsDto> {
    const { rangeStart, rangeEnd, days } = this.resolveRange(query);
    const meterCount = await this.countMeters(userId, query.meterId);

    // No meters in scope means no denominator for coverage and no rows to sum.
    // Returning an empty series beats dividing by zero and shipping NaN to a
    // chart, where it renders as a silently broken axis rather than an error.
    if (meterCount === 0) {
      return this.empty(query, 0);
    }

    const rows = await this.fetchBuckets(
      userId,
      query,
      rangeStart,
      rangeEnd,
      days,
    );

    const points = rows.map((row) =>
      this.toPoint(query, row, meterCount, days),
    );

    return {
      granularity: query.granularity,
      currency: 'BDT',
      meterCount,
      observedDays: Number(rows[0]?.observed_days ?? 0),
      points,
      total: {
        consumedCost: round(
          points.reduce((sum, point) => sum + point.consumedCost, 0),
        ),
        rechargedAmount: round(
          points.reduce((sum, point) => sum + point.rechargedAmount, 0),
        ),
      },
    };
  }

  /**
   * Turns two Asia/Dhaka calendar dates into a half-open instant range.
   *
   * `to` is inclusive for the caller — asking for 01→07 means seven days — so
   * the exclusive upper bound is the start of the 8th. Getting this wrong is
   * the classic off-by-one that silently drops the most recent day, which is
   * the one the user is actually looking at.
   */
  private resolveRange(query: UsageAnalyticsQueryDto): {
    rangeStart: Date;
    rangeEnd: Date;
    days: string[];
  } {
    const rangeStart = new Date(`${query.from}T00:00:00${DHAKA_OFFSET}`);
    const inclusiveEnd = new Date(`${query.to}T00:00:00${DHAKA_OFFSET}`);

    if (
      Number.isNaN(rangeStart.getTime()) ||
      Number.isNaN(inclusiveEnd.getTime())
    ) {
      throw new BadRequestException('from and to must be YYYY-MM-DD dates.');
    }

    if (inclusiveEnd < rangeStart) {
      throw new BadRequestException('to must not be earlier than from.');
    }

    const dayCount =
      Math.round((inclusiveEnd.getTime() - rangeStart.getTime()) / MS_PER_DAY) +
      1;

    if (dayCount > MAX_RANGE_DAYS) {
      throw new BadRequestException(
        `Range must not exceed ${MAX_RANGE_DAYS} days.`,
      );
    }

    const days: string[] = [];
    for (let i = 0; i < dayCount; i += 1) {
      days.push(addDays(query.from, i));
    }

    return {
      rangeStart,
      rangeEnd: new Date(inclusiveEnd.getTime() + MS_PER_DAY),
      days,
    };
  }

  private async countMeters(userId: string, meterId?: string): Promise<number> {
    const filters: SQL[] = [eq(meter.userId, userId)];
    if (meterId) filters.push(eq(meter.id, meterId));

    const [row] = await this.db
      .select({ count: sql<string>`count(*)` })
      .from(meter)
      .where(and(...filters));

    return Number(row?.count ?? 0);
  }

  private async fetchBuckets(
    userId: string,
    query: UsageAnalyticsQueryDto,
    rangeStart: Date,
    rangeEnd: Date,
    days: string[],
  ): Promise<BucketRow[]> {
    const meterFilter = query.meterId
      ? sql`AND s.meter_id = ${query.meterId}`
      : sql``;

    // The overlap inside one day, as an interval. Written once and reused for
    // both the cost share and the coverage seconds so the two can never
    // disagree about how much of the window landed here.
    const overlap = sql`(
      LEAST(b.we, d + interval '1 day') - GREATEST(b.ws, d)
    )`;

    const spread = sql`
      WITH bounds AS (
        SELECT
          s.consumed_cost,
          s.recharge_paid,
          s.window_start AT TIME ZONE ${REPORTING_TIME_ZONE} AS ws,
          s.window_end   AT TIME ZONE ${REPORTING_TIME_ZONE} AS we
        FROM meter_usage_sample s
        JOIN meter m ON m.id = s.meter_id
        WHERE m.user_id = ${userId}
          AND s.window_end   > ${rangeStart}
          AND s.window_start < ${rangeEnd}
          ${meterFilter}
      ),
      spread AS (
        SELECT
          d::date AS day,
          EXTRACT(EPOCH FROM ${overlap}) AS secs,
          b.consumed_cost
            * EXTRACT(EPOCH FROM ${overlap})
            / NULLIF(EXTRACT(EPOCH FROM (b.we - b.ws)), 0) AS cost,
          -- A recharge is a point event with a known timestamp, so it is never
          -- split. It lands whole on the day holding window_end. The
          -- microsecond step is what keeps a window ending exactly at midnight
          -- attributed to the day it ran through, not the one it touched.
          CASE
            WHEN d = date_trunc('day', b.we - interval '1 microsecond')
            THEN b.recharge_paid
            ELSE 0
          END AS recharged
        FROM bounds b
        CROSS JOIN LATERAL generate_series(
          date_trunc('day', b.ws),
          -- Half-open intervals: a window ending at 00:00 belongs entirely to
          -- the previous day. Without the microsecond, three of the four daily
          -- sweeps would each emit a phantom zero-second row on the next day.
          date_trunc('day', b.we - interval '1 microsecond'),
          interval '1 day'
        ) AS d
        -- Clips days a straddling window pulled in from outside the request.
        WHERE d::date >= ${days[0]}::date
          AND d::date <= ${days[days.length - 1]}::date
      )
    `;

    const result = await this.db.execute<BucketRow>(
      sql`${spread} ${this.selectFor(query)}`,
    );

    return result.rows;
  }

  private selectFor(query: UsageAnalyticsQueryDto): SQL {
    switch (query.granularity) {
      case USAGE_GRANULARITY.DAILY:
        return sql`
          SELECT day::text AS bucket,
                 SUM(cost) AS cost,
                 SUM(recharged) AS recharged,
                 SUM(secs) AS secs,
                 (SELECT COUNT(DISTINCT day) FROM spread) AS observed_days
          FROM spread GROUP BY day ORDER BY day
        `;

      case USAGE_GRANULARITY.WEEKLY:
        return sql`
          SELECT date_trunc('week', day)::date::text AS bucket,
                 SUM(cost) AS cost,
                 SUM(recharged) AS recharged,
                 SUM(secs) AS secs,
                 (SELECT COUNT(DISTINCT day) FROM spread) AS observed_days
          FROM spread GROUP BY 1 ORDER BY 1
        `;

      case USAGE_GRANULARITY.WEEKDAY:
        // Averaged over the days actually observed, not over every date in the
        // range. A Monday with no data should not drag the Monday average down
        // — that would report missing readings as cheap electricity.
        return sql`
          SELECT EXTRACT(ISODOW FROM day)::int::text AS bucket,
                 SUM(cost) / NULLIF(COUNT(DISTINCT day), 0) AS cost,
                 0 AS recharged,
                 SUM(secs) / NULLIF(COUNT(DISTINCT day), 0) AS secs,
                 (SELECT COUNT(DISTINCT day) FROM spread) AS observed_days
          FROM spread GROUP BY 1 ORDER BY 1
        `;

      default: {
        const unhandled: never = query.granularity;
        throw new Error(`Unhandled granularity: ${String(unhandled)}`);
      }
    }
  }

  private toPoint(
    query: UsageAnalyticsQueryDto,
    row: BucketRow,
    meterCount: number,
    days: string[],
  ): UsagePointDto {
    const secs = Number(row.secs ?? 0);
    const expectedDays = this.expectedDays(query, row.bucket, days);
    const coverage =
      expectedDays === 0
        ? 0
        : Math.min(secs / (SECONDS_PER_DAY * expectedDays * meterCount), 1);

    const point: UsagePointDto = {
      consumedCost: round(Number(row.cost ?? 0)),
      rechargedAmount: round(Number(row.recharged ?? 0)),
      coverage: round(coverage),
    };

    if (query.granularity === USAGE_GRANULARITY.WEEKDAY) {
      point.weekday = Number(row.bucket);
    } else {
      point.date = row.bucket;
    }

    return point;
  }

  /**
   * How many days this bucket *should* hold, given the requested range.
   *
   * A week clipped by the range edge legitimately holds fewer than seven days,
   * and dividing by seven anyway would report a complete week as 40% covered —
   * making the request's own boundary look like missing data.
   */
  private expectedDays(
    query: UsageAnalyticsQueryDto,
    bucket: string,
    days: string[],
  ): number {
    if (query.granularity !== USAGE_GRANULARITY.WEEKLY) return 1;

    // Calendar comparison, so both sides are read in the same zone. UTC is
    // used only because it never shifts a date across midnight — no instant
    // here is meant to represent a real moment.
    const weekStart = Date.parse(`${bucket}T00:00:00Z`);
    const weekEnd = weekStart + 7 * MS_PER_DAY;

    return days.filter((day) => {
      const time = Date.parse(`${day}T00:00:00Z`);
      return time >= weekStart && time < weekEnd;
    }).length;
  }

  private empty(
    query: UsageAnalyticsQueryDto,
    meterCount: number,
  ): UsageAnalyticsDto {
    return {
      granularity: query.granularity,
      currency: 'BDT',
      meterCount,
      observedDays: 0,
      points: [],
      total: { consumedCost: 0, rechargedAmount: 0 },
    };
  }
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Calendar-day arithmetic on a `YYYY-MM-DD` string.
 *
 * Anchored to UTC midnight so a date can never slide across a boundary while
 * being shifted. Nothing here is an instant — the zone is an implementation
 * detail chosen for having no offset to trip over.
 */
function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * MS_PER_DAY)
    .toISOString()
    .slice(0, 10);
}
