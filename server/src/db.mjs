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
  migrate(db);
}

/** 旧库结构升级：补首次入库原始读数列（重导幂等判定依据）。 */
function migrate(db) {
  const cols = db.prepare('PRAGMA table_info(punch)').all().map((c) => c.name);
  const addPoint = !cols.includes('orig_point');
  const addSeconds = !cols.includes('orig_seconds');
  if (addPoint) db.exec("ALTER TABLE punch ADD COLUMN orig_point TEXT NOT NULL DEFAULT ''");
  if (addSeconds) db.exec('ALTER TABLE punch ADD COLUMN orig_seconds INTEGER NOT NULL DEFAULT 0');
  // 迁移时尚无新数据：旧记录的首次入库读数即现值（更正改的是现值列）。
  if (addPoint) db.prepare('UPDATE punch SET orig_point = point').run();
  if (addSeconds) db.prepare('UPDATE punch SET orig_seconds = seconds').run();
}

/** 推进赛事修订号并返回新值（任何配置/读数/更正变化都使旧修订过期） */
export const bumpRevision = db =>
  db.prepare('UPDATE event SET revision = revision + 1 WHERE id = 1 RETURNING revision').get().revision;

export function currentRevision(db = getDb()) {
  const row = db.prepare('SELECT revision FROM event WHERE id = 1').get();
  return row ? row.revision : null;
}
