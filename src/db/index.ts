/**
 * SQLite connection and schema bootstrap.
 *
 * WAL mode so the poll loop's writes never block a guest's read. `busy_timeout`
 * covers the rare contention window; every write in the app is short.
 */
import BetterSqlite3, { type Database } from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { log } from '../log.js';

const here = dirname(fileURLToPath(import.meta.url));

export type Db = Database;

export function openDatabase(path: string): Db {
  const db = new BetterSqlite3(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');

  const schema = readFileSync(join(here, 'schema.sql'), 'utf8');
  db.exec(schema);

  log.info('database ready', { path });
  return db;
}

/** ISO-8601 UTC, the only timestamp format stored anywhere in this app. */
export function now(): string {
  return new Date().toISOString();
}
