import * as schema from '../schema/index';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
export type DrizzleDb = NodePgDatabase<typeof schema>;
