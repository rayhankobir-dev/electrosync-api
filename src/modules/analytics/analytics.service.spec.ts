import { config as loadEnv } from 'dotenv';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Client } from 'pg';

import { USAGE_GRANULARITY } from '@/database/types/usage.type';
import { type DrizzleDb } from '@/database/types/drizzle';

import { AnalyticsService } from './analytics.service';

loadEnv();

// Every test round-trips a remote Postgres; the default 5s trips on latency
// alone rather than on anything this suite is asserting.
jest.setTimeout(30_000);

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

  async function daily(from: string, to: string) {
    return service.usage(USER_ID, {
      granularity: USAGE_GRANULARITY.DAILY,
      from,
      to,
    });
  }

  async function dailyCosts(
    from: string,
    to: string,
  ): Promise<Record<string, number>> {
    const result = await daily(from, to);

    return Object.fromEntries(
      result.points.map((point) => [point.date, point.consumedCost]),
    );
  }

  /**
   * The observed gap: four daily settlements plus one that covers two days
   * because the Aug 17 reading was never published. Reproduced from the real
   * `meter_usage_sample` rows that produced the bad response.
   */
  async function addBatchedGapFixture(): Promise<void> {
    await addSample('2026-08-13 00:00:00', '2026-08-14 00:00:00', 67.26);
    await addSample('2026-08-14 00:00:00', '2026-08-15 00:00:00', 64.26);
    await addSample('2026-08-15 00:00:00', '2026-08-16 00:00:00', 44.53);
    // Aug 17 00:00 was never captured, so one window spans Aug 16 and Aug 17.
    await addSample('2026-08-16 00:00:00', '2026-08-18 00:00:00', 83.9);
    await addSample('2026-08-18 00:00:00', '2026-08-19 00:00:00', 64.37);
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

  it('reports no point for a day no settlement was attributed to', async () => {
    // The bug: Aug 16 was returned as `consumedCost: 0, coverage: 1`, which
    // asserts a fully observed day on which nothing was spent. Its ৳83.90 is
    // not zero and not separable — it is inside the Aug 16→18 settlement. A
    // day with no figure of its own must be absent, exactly like a day with no
    // readings at all, so a chart draws a gap instead of a floor of zero.
    await addBatchedGapFixture();

    const result = await daily('2026-08-13', '2026-08-19');
    const dates = result.points.map((point) => point.date);

    expect(dates).not.toContain('2026-08-16');
    expect(dates).toEqual([
      '2026-08-13',
      '2026-08-14',
      '2026-08-15',
      '2026-08-17',
      '2026-08-18',
    ]);
  });

  it('never reports coverage without the cost that coverage vouches for', async () => {
    // `coverage` documents itself as the signal for whether `consumedCost` is a
    // total or a floor, so the two have to be derived from one attribution
    // rule. Splitting them is what let a zero inherit a full day's coverage.
    await addBatchedGapFixture();

    const result = await daily('2026-08-13', '2026-08-19');

    for (const point of result.points) {
      expect(point.coverage).toBeGreaterThan(0);
    }
  });

  it('counts only days holding a settlement as observed', async () => {
    await addBatchedGapFixture();

    const result = await daily('2026-08-13', '2026-08-19');

    // Aug 16 has readings across it but no figure of its own; Aug 19 has
    // neither. Neither is a day whose usage we know.
    expect(result.observedDays).toBe(5);
  });

  it("discloses that a batched figure covers more than its bucket's day", async () => {
    await addBatchedGapFixture();

    const result = await daily('2026-08-13', '2026-08-19');
    const settled = Object.fromEntries(
      result.points.map((point) => [point.date, point.settledDays]),
    );

    // Coverage saturates at 1 and so cannot say "this is two days of spend".
    // Without that distinction the batched figure is indistinguishable from a
    // single unusually heavy day.
    expect(settled['2026-08-17']).toBe(2);
    expect(settled['2026-08-13']).toBe(1);
  });

  it('omits a weekday no settlement ever closed on', async () => {
    await addBatchedGapFixture();

    const result = await service.usage(USER_ID, {
      granularity: USAGE_GRANULARITY.WEEKDAY,
      from: '2026-08-13',
      to: '2026-08-19',
    });

    const weekdays = result.points.map((point) => point.weekday);

    // Sunday Aug 16 is the only Sunday in range and carries no settlement, so
    // reporting it at all would report ৳0 as that Sunday's mean spend.
    expect(weekdays).not.toContain(7);
    // Monday holds the whole batched figure rather than half of it.
    const monday = result.points.find((point) => point.weekday === 1);
    expect(monday?.consumedCost).toBe(83.9);
  });

  it('keeps the total equal to what was settled when a window spans two days', async () => {
    await addBatchedGapFixture();

    const result = await daily('2026-08-13', '2026-08-19');

    expect(result.total.consumedCost).toBe(324.32);
  });
});
