/**
 * Exercises AnalyticsService against a real Postgres using TEMP tables inside a
 * transaction that is always rolled back. Temp tables shadow the real ones for
 * this session only, so nothing in the actual schema is read or written.
 */
import 'dotenv/config';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { Pool } from 'pg';

import { AnalyticsService } from './src/modules/analytics/analytics.service';

const USER = 'user-1';

/** The traced scenario: three clean days, one failed poll, one recharge. */
const SAMPLES = [
  // Aug 1 — first poll at 06:00 leaves 00:00-06:00 unmeasured.
  ['2026-08-01T06:00:00+06:00', '2026-08-01T12:00:00+06:00', 850, 812, 0, 0, 38],
  ['2026-08-01T12:00:00+06:00', '2026-08-01T18:00:00+06:00', 812, 770, 0, 0, 42],
  ['2026-08-01T18:00:00+06:00', '2026-08-02T00:00:00+06:00', 770, 725, 0, 0, 45],
  // Aug 2 — three clean windows...
  ['2026-08-02T00:00:00+06:00', '2026-08-02T06:00:00+06:00', 725, 690, 0, 0, 35],
  ['2026-08-02T06:00:00+06:00', '2026-08-02T12:00:00+06:00', 690, 648, 0, 0, 42],
  ['2026-08-02T12:00:00+06:00', '2026-08-02T18:00:00+06:00', 648, 601, 0, 0, 47],
  // ...then the 00:00 poll fails, so this one is 12h and straddles midnight.
  ['2026-08-02T18:00:00+06:00', '2026-08-03T06:00:00+06:00', 601, 904.5, 399.5, 500, 96],
];

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const db = drizzle(pool);

  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql`
        CREATE TEMP TABLE meter (
          id text PRIMARY KEY, user_id text NOT NULL
        ) ON COMMIT DROP
      `);
      await tx.execute(sql`
        CREATE TEMP TABLE meter_usage_sample (
          meter_id text NOT NULL,
          window_start timestamptz NOT NULL,
          window_end timestamptz NOT NULL,
          opening_balance double precision NOT NULL,
          closing_balance double precision NOT NULL,
          recharge_credited double precision NOT NULL DEFAULT 0,
          recharge_paid double precision NOT NULL DEFAULT 0,
          consumed_cost double precision NOT NULL,
          raw_delta double precision NOT NULL,
          anomaly text,
          created_at timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (meter_id, window_start)
        ) ON COMMIT DROP
      `);

      await tx.execute(sql`INSERT INTO meter VALUES ('m1', ${USER})`);

      for (const [ws, we, open, close, credited, paid, cost] of SAMPLES) {
        await tx.execute(sql`
          INSERT INTO meter_usage_sample
            (meter_id, window_start, window_end, opening_balance,
             closing_balance, recharge_credited, recharge_paid,
             consumed_cost, raw_delta)
          VALUES ('m1', ${ws}, ${we}, ${open}, ${close},
                  ${credited}, ${paid}, ${cost}, ${cost})
        `);
      }

      // Proves the duplicate guard, not just the query.
      const dup = await tx.execute(sql`
        INSERT INTO meter_usage_sample
          (meter_id, window_start, window_end, opening_balance,
           closing_balance, consumed_cost, raw_delta)
        VALUES ('m1', ${SAMPLES[0][0]}, ${SAMPLES[0][1]}, 850, 812, 38, 38)
        ON CONFLICT DO NOTHING
      `);
      console.log(`replay insert affected ${dup.rowCount} row(s)  (expect 0)\n`);

      const service = new AnalyticsService(tx as never);

      const daily = await service.usage(USER, {
        granularity: 'daily',
        from: '2026-08-01',
        to: '2026-08-03',
      });
      console.log('DAILY');
      console.dir(daily, { depth: null });

      const weekly = await service.usage(USER, {
        granularity: 'weekly',
        from: '2026-08-01',
        to: '2026-08-03',
      });
      console.log('\nWEEKLY');
      console.dir(weekly, { depth: null });

      const weekday = await service.usage(USER, {
        granularity: 'weekday',
        from: '2026-08-01',
        to: '2026-08-03',
      });
      console.log('\nWEEKDAY');
      console.dir(weekday, { depth: null });

      throw new Error('__rollback__');
    });
  } catch (error) {
    if (!(error instanceof Error) || error.message !== '__rollback__') throw error;
    console.log('\nrolled back — nothing persisted');
  } finally {
    await pool.end();
  }
}

void main();
