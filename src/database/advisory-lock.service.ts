import { Inject, Injectable, Logger } from '@nestjs/common';
import { Pool } from 'pg';

import { PG_POOL } from './constants/database.constants';

/** What `runExclusively` returns when another holder already has the lock. */
export const LOCK_NOT_ACQUIRED = Symbol('LOCK_NOT_ACQUIRED');

/**
 * Cross-instance mutual exclusion, backed by PostgreSQL advisory locks.
 *
 * Lives in the database module because it is the one caller that legitimately
 * needs the raw `Pool` rather than the Drizzle handle: advisory locks are
 * *session*-scoped, so acquire and release must run on the same connection.
 * Issuing them through Drizzle would let the pool hand out a different
 * connection for the release, which then succeeds while unlocking nothing.
 *
 * Exposing this instead of exporting `PG_POOL` keeps the pool encapsulated —
 * nothing else in the app gets a lever to bypass the ORM.
 */
@Injectable()
export class AdvisoryLockService {
  private readonly logger = new Logger(AdvisoryLockService.name);

  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /**
   * Runs `work` while holding the lock for `key`, or returns
   * `LOCK_NOT_ACQUIRED` immediately if someone else holds it.
   *
   * Non-blocking on purpose (`pg_try_advisory_lock`, not `pg_advisory_lock`).
   * For a periodic job, a second instance that cannot get the lock should stand
   * down rather than queue up to repeat work that is already being done.
   *
   * One pooled connection is held for the whole of `work`, so this suits jobs
   * measured in minutes, not hours.
   */
  async runExclusively<T>(
    key: number,
    work: () => Promise<T>,
  ): Promise<T | typeof LOCK_NOT_ACQUIRED> {
    const client = await this.pool.connect();

    try {
      const { rows } = await client.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock($1) AS locked',
        [key],
      );

      if (!rows[0]?.locked) {
        return LOCK_NOT_ACQUIRED;
      }

      try {
        return await work();
      } finally {
        // Best effort: if the connection died, the lock died with it, which is
        // exactly the behaviour a session-scoped lock is chosen for. Failing
        // to unlock must not mask whatever `work` threw.
        try {
          await client.query('SELECT pg_advisory_unlock($1)', [key]);
        } catch (error) {
          this.logger.warn(
            `Could not release advisory lock ${key}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
    } finally {
      client.release();
    }
  }
}
