import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import { DRIZZLE } from './constants/database.constants';
import type { DrizzleDb } from './types/drizzle';

export interface DatabaseHealth {
  readonly status: 'up' | 'down';
  readonly error?: string;
}

function describeFailure(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }

  const cause: unknown = error.cause;
  if (cause instanceof Error && cause.message.length > 0) {
    return cause.message;
  }

  return error.message;
}

@Injectable()
export class DatabaseHealthService {
  private readonly logger = new Logger(DatabaseHealthService.name);

  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  async check(): Promise<DatabaseHealth> {
    try {
      await this.db.execute(sql`select 1`);
      return { status: 'up' };
    } catch (error) {
      const message = describeFailure(error);
      this.logger.error(`Database health check failed: ${message}`);
      return { status: 'down', error: message };
    }
  }
}
