import { resolve } from 'node:path';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import Database from 'better-sqlite3';
import * as schema from './schema';
import { building } from '$app/env';
import { DATABASE_URL } from '$app/env/private';

if (!DATABASE_URL) throw new Error('DATABASE_URL is not set');

// Route analysis at build time imports this module: never touch the real database then.
const client = new Database(building ? ':memory:' : DATABASE_URL);
client.pragma('foreign_keys = ON');
client.pragma('journal_mode = WAL');

export const db = drizzle(client, { schema });
// Local single-user SQLite: apply pending migrations at startup (the app runs from apps/studio).
migrate(db, { migrationsFolder: resolve('drizzle') });
