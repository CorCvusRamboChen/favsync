// 本地 SQLite（Node 内置的 node:sqlite，不用装原生依赖）。
// 库文件：FAVSYNC_DB，默认 data/app.db；数据目录（各种 json 状态文件、缩略图缓存）：FAVSYNC_DATA，默认 <项目>/data。
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import path from 'node:path';

export const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const expandHome = (p) => String(p).replace(/^~(?=$|[\\/])/, homedir());
export const dataDir = () => path.resolve(expandHome(process.env.FAVSYNC_DATA || path.join(projectRoot, 'data')));
mkdirSync(dataDir(), { recursive: true });

// FAVSYNC_DB 也用于测试隔离（每个测试文件指向自己的临时库）
const dbFile = process.env.FAVSYNC_DB ? path.resolve(expandHome(process.env.FAVSYNC_DB)) : path.join(dataDir(), 'app.db');
mkdirSync(path.dirname(dbFile), { recursive: true });
export const db = new DatabaseSync(dbFile);

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;   -- 别的进程（脚本、测试）碰巧在写时等一下，不要直接报 database is locked
PRAGMA foreign_keys = ON;
`);

export function q(sql, ...params) { return db.prepare(sql).all(...params); }
export function one(sql, ...params) { return db.prepare(sql).get(...params); }
export function run(sql, ...params) { return db.prepare(sql).run(...params); }

// 给 ALTER TABLE ADD COLUMN 用：列已经存在就当没事
export function addColumn(table, colDef) {
  try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${colDef}`); } catch { /* 已存在 */ }
}
