import { Global, Inject, Module, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import { AdvisoryLockService } from './advisory-lock.service';
import { DRIZZLE, PG_POOL } from './constants/database.constants';
import { DatabaseHealthService } from './database.health';
import * as schema from './schema';

@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        new Pool({
          connectionString: config.getOrThrow<string>('DATABASE_URL'),
          max: 10,
          idleTimeoutMillis: 30_000,
          connectionTimeoutMillis: 5_000,
          ssl: false,
        }),
    },
    {
      provide: DRIZZLE,
      inject: [PG_POOL],
      useFactory: (pool: Pool) => drizzle(pool, { schema }),
    },
    DatabaseHealthService,
    AdvisoryLockService,
  ],
  // `PG_POOL` stays unexported on purpose: `AdvisoryLockService` is the only
  // legitimate need for a raw connection, and it lives here.
  exports: [DRIZZLE, DatabaseHealthService, AdvisoryLockService],
})
export class DatabaseModule implements OnModuleDestroy {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
