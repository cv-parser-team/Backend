import pg from 'pg';
import { drizzle, NodePgDatabase } from 'drizzle-orm/node-postgres';
import { config } from '../../config/config.js';
import * as schema from './schema.js';

const { Pool } = pg;

export class AppDatabase {
  readonly pool: pg.Pool;
  readonly db: NodePgDatabase<typeof schema>;

  constructor(connectionString: string = config.db.url) {
    this.pool = new Pool({ connectionString, max: 10 });
    this.db = drizzle(this.pool, { schema });
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
