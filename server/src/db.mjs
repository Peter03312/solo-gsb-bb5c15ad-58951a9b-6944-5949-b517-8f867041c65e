import Database from 'better-sqlite3';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

let _db = null;

export function getDb() {
  if (_db) return _db;
  const dbFile = process.env.DB_FILE || join(__dirname, '..', '..', 'data', 'orienteering.db');
  mkdirSync(dirname(dbFile), { recursive: true });
  _db = new Database(dbFile);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  return _db;
}

export function initDb(db = getDb()) {
  const schema = readFileSync(join(__dirname, 'schema.sql'), 'utf8');
  db.exec(schema);
}

/** 推进赛事修订号并返回新值（任何配置/读数/更正变化都使旧修订过期） */
export const bumpRevision = db =>
  db.prepare('UPDATE event SET revision = revision + 1 WHERE id = 1 RETURNING revision').get().revision;

export function currentRevision(db = getDb()) {
  const row = db.prepare('SELECT revision FROM event WHERE id = 1').get();
  return row ? row.revision : null;
}
