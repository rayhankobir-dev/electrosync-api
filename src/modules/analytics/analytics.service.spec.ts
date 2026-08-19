import { config as loadEnv } from 'dotenv';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Client } from 'pg';

import { USAGE_GRANULARITY } from '@/database/types/usage.type';
import { type DrizzleDb } from '@/database/types/drizzle';

import { AnalyticsService } from './analytics.service';

loadEnv();

/**
 * The day-attribution rule this suite pins down lives in SQL, not TypeScript,
 * so a mocked database would only assert that the mock was called. These tests
 * run against a real Postgres and shadow `meter` and `meter_usage_sample` with
 * temporary tables of the same name — Postgres searches `pg_temp` ahead of
 * `public`, so the service's own queries hit the fixtures without knowing it.
 *
 * Everything happens inside one transaction that is always rolled back, and
 * temp tables are session-scoped besides, so the target database is untouched.
 */
const CONNECTION = directConnection(process.env.DATABASE_URL);

/**
 * Temp tables and `search_path` are session state, which a transaction-pooling
 * proxy is free to hand to a different backend between statements. Neon's
 * pooler endpoint does exactly that, so the direct host is required here.
 */
function directConnection(url: string | undefined): string | null {
  if (!url) return null;
  return url.replace('-pooler.', '.');
}

const USER_ID = 'user-under-test';
const METER_ID = 'meter-under-test';

const describeWithDb = CONNECTION ? describe : describe.skip;

describeWithDb('AnalyticsService day attribution', () => {
  let client: Client;
  let service: AnalyticsService;

  beforeEach(async () => {
    client = new Client({ connectionString: CONNECTION as string });
    await client.connect();
    await client.query('BEGIN');

    await client.query(`
      CREATE TEMP TABLE meter (
        id text PRIMARY KEY,
        user_id text NOT NULL
      ) ON COMMIT DROP`);

    await client.query(`
      CREATE TEMP TABLE meter_usage_sample (
        meter_id text NOT NULL,
        window_start timestamptz NOT NULL,
        window_end timestamptz NOT NULL,
        consumed_cost double precision NOT NULL,
        recharge_paid double precision NOT NULL DEFAULT 0
      ) ON COMMIT DROP`);

    await client.query(`INSERT INTO meter (id, user_id) VALUES ($1, $2)`, [
      METER_ID,
      USER_ID,
    ]);

    service = new AnalyticsService(drizzle(client) as unknown as DrizzleDb);
  });

  afterEach(async () => {
    await client.query('ROLLBACK');
    await client.end();
  });

  /** Bounds are given as Dhaka wall clock; the fixed +06:00 is exact year-round. */
  async function addSample(
    startDhaka: string,
    endDhaka: string,
    consumedCost: number,
  ): Promise<void> {
    await client.query(
      `INSERT INTO meter_usage_sample
         (meter_id, window_start, window_end, consumed_cost)
       VALUES ($1, $2, $3, $4)`,
      [METER_ID, `${startDhaka}+06:00`, `${endDhaka}+06:00`, consumedCost],
    );
  }

  async function dailyCosts(
    from: string,
    to: string,
  ): Promise<Record<string, number>> {
    const result = await service.usage(USER_ID, {
      granularity: USAGE_GRANULARITY.DAILY,
      from,
      to,
    });

    return Object.fromEntries(
      result.points.map((point) => [point.date, point.consumedCost]),
    );
  }

  it('bills a window that straddles Dhaka midnight to the day it closed on', async () => {
    // NESCO settles in batches, so a single settlement period routinely runs
    // from one evening into the next morning. Splitting its cost across both
    // days makes every daily figure disagree with the portal's own.
    await addSample('2026-08-14 18:00:00', '2026-08-15 06:00:00', 64.26);

    const costs = await dailyCosts('2026-08-14', '2026-08-15');

    expect(costs['2026-08-15']).toBe(64.26);
    expect(costs['2026-08-14'] ?? 0).toBe(0);
  });

  it('leaves a window contained in one day on that day', async () => {
    await addSample('2026-08-13 00:00:00', '2026-08-14 00:00:00', 67.26);

    const costs = await dailyCosts('2026-08-13', '2026-08-14');

    expect(costs['2026-08-13']).toBe(67.26);
    expect(costs['2026-08-14'] ?? 0).toBe(0);
  });

  it('keeps the range total equal to what was settled', async () => {
    await addSample('2026-08-13 00:00:00', '2026-08-14 00:00:00', 67.26);
    await addSample('2026-08-14 18:00:00', '2026-08-15 06:00:00', 64.26);

    const result = await service.usage(USER_ID, {
      granularity: USAGE_GRANULARITY.DAILY,
      from: '2026-08-13',
      to: '2026-08-15',
    });

    expect(result.total.consumedCost).toBe(131.52);
  });
});
