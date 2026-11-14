// 最小数据层：收藏条目 + 标签。
//
// 每条收藏（抖音视频、微博、推文、收藏的歌）在这里是一行 items，url 唯一——同一条内容被几个账号、
// 几个收藏夹、既点赞又书签，都只有一张卡，区别全靠标签（tags / taggings 多对多）。
// 媒体文件不进数据库：archives 表（见 archive.js）只记"这条的目录在哪、里面有哪些文件"，文件本身是硬盘上的普通文件。
import { db, q, one, run } from './db.js';

db.exec(`
CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL DEFAULT 'link',
  url TEXT UNIQUE,
  title TEXT,
  body TEXT,                 -- 正文（给人读的）
  note TEXT,                 -- 自己写的备注
  excerpt TEXT,              -- 卡片上显示的摘要
  image TEXT,                -- 封面：先是站外地址，封面落盘后改指 /archive/...
  source TEXT,               -- 抖音 / 微博 / X
  type TEXT NOT NULL DEFAULT 'reference',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS taggings (
  tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  item_kind TEXT NOT NULL,
  item_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (tag_id, item_kind, item_id)
);
CREATE INDEX IF NOT EXISTS idx_taggings_item ON taggings(item_kind, item_id);
CREATE INDEX IF NOT EXISTS idx_items_source ON items(source);
CREATE INDEX IF NOT EXISTS idx_items_created ON items(created_at);
-- 存档记录：这条的目录在哪、里面有哪些文件（{文件名: 字节}）。文件本身在硬盘上，这里只是索引。逻辑见 archive.js
CREATE TABLE IF NOT EXISTS archives (
  item_kind TEXT NOT NULL,
  item_id INTEGER NOT NULL,
  dir TEXT,
  formats TEXT,
  bytes INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',   -- pending/done/failed
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  archived_at TEXT,
  PRIMARY KEY (item_kind, item_id)
);
`);

// —— 标签 ——
const cleanTag = (s) => String(s ?? '').trim().replace(/\s+/g, ' ').slice(0, 40);

export function setTags(itemKind, itemId, names) {
  const wanted = [...new Set((names ?? []).map(cleanTag).filter(Boolean))];
  run('DELETE FROM taggings WHERE item_kind = ? AND item_id = ?', itemKind, itemId);
  for (const name of wanted) {
    run('INSERT OR IGNORE INTO tags (name) VALUES (?)', name);
    const tag = one('SELECT id FROM tags WHERE name = ?', name);
    run('INSERT OR IGNORE INTO taggings (tag_id, item_kind, item_id) VALUES (?,?,?)', tag.id, itemKind, itemId);
  }
  return wanted;
}
export function addTags(itemKind, itemId, names) {
  const cur = tagsOf(itemKind, itemId);
  const next = [...new Set([...cur, ...(names ?? []).map(cleanTag).filter(Boolean)])];
  if (next.length !== cur.length) setTags(itemKind, itemId, next);
  return next;
}
export const tagsOf = (itemKind, itemId) =>
  q('SELECT t.name FROM taggings g JOIN tags t ON t.id = g.tag_id WHERE g.item_kind = ? AND g.item_id = ? ORDER BY t.name', itemKind, itemId).map((r) => r.name);

// 标签云（带计数）；顺手清掉指向已删条目的孤儿行和没人用的标签
export function listTags() {
  run(`DELETE FROM taggings WHERE item_kind = 'link' AND NOT EXISTS (SELECT 1 FROM items WHERE id = taggings.item_id)`);
  run('DELETE FROM tags WHERE id NOT IN (SELECT tag_id FROM taggings)');
  return q(`SELECT t.id, t.name, COUNT(*) AS count FROM tags t JOIN taggings g ON g.tag_id = t.id GROUP BY t.id ORDER BY count DESC, t.name`);
}

// —— 条目 ——
export const findByUrl = (url) => (url ? one('SELECT * FROM items WHERE url = ?', String(url)) : null);
export const getItem = (id) => one('SELECT * FROM items WHERE id = ?', Number(id));

// 存一条。url 已经有了就复用那条（只补标签，不改标题）——这就是"同一条内容只有一张卡"。
export function saveItem({ kind = 'link', url = null, title = null, body = null, note = null, excerpt = null, image = null, source = null, type = 'reference', tags = null }) {
  if (kind === 'link' && !url) throw new Error('链接必须有 url');
  const existing = findByUrl(url);
  if (existing) {
    if (tags?.length) addTags('link', existing.id, tags);
    return { id: existing.id, kind: existing.kind, existing: true, tags: tagsOf('link', existing.id) };
  }
  const r = run('INSERT INTO items (kind, url, title, body, note, excerpt, image, source, type) VALUES (?,?,?,?,?,?,?,?,?)', kind, url, title, body, note, excerpt, image, source, type);
  const id = Number(r.lastInsertRowid);
  if (tags?.length) setTags('link', id, tags);
  return { id, kind, existing: false, tags: tagsOf('link', id) };
}
// 只补空着的字段（封面、摘要、来源）：同步时每轮都会调，不能把已经落盘的本地封面冲掉
export function fillItem(id, fields) {
  const cols = ['title', 'body', 'note', 'excerpt', 'image', 'source'].filter((c) => fields[c] !== undefined);
  if (!cols.length) return;
  run(`UPDATE items SET ${cols.map((c) => `${c} = COALESCE(${c}, ?)`).join(', ')} WHERE id = ?`, ...cols.map((c) => fields[c]), Number(id));
}
export function updateItem(id, fields) {
  const cols = ['title', 'body', 'note', 'excerpt', 'image', 'source'].filter((c) => fields[c] !== undefined);
  if (!cols.length) return getItem(id);
  run(`UPDATE items SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`, ...cols.map((c) => fields[c]), Number(id));
  return getItem(id);
}
// 删掉数据库里的记录（标签、存档记录一起）。**不删硬盘上的文件**——防删是这个项目的底线。
export function removeItem(id) {
  run(`DELETE FROM taggings WHERE item_kind = 'link' AND item_id = ?`, Number(id));
  run(`DELETE FROM archives WHERE item_kind = 'link' AND item_id = ?`, Number(id));
  run('DELETE FROM items WHERE id = ?', Number(id));
  return { removed: true, id: Number(id), files_kept: true };
}

// —— 媒体类型（照相册 App 的「媒体类型」）：按存档目录里实际有什么文件分 ——
// archives.formats 是 {文件名: 字节} 的 JSON，用 LIKE 就够。动图 = image-NN.gif 或 image-NN.anim.webp；实况 = live-NN.mp4
const hasDouyinTable = () => !!one("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'douyin_favorites'");
export const MEDIA_TYPES = {
  video: { label: '视频', icon: '🎬', sql: `a.formats LIKE '%"video.mp4"%'` },
  image: { label: '图文', icon: '🖼', sql: `a.formats LIKE '%"image-%'` },
  live:  { label: '实况', icon: '📸', sql: `a.formats LIKE '%"live-%'` },
  anim:  { label: '动图', icon: '🌀', sql: `(a.formats LIKE '%"image-%.gif"%' OR a.formats LIKE '%.anim.webp"%' OR a.formats LIKE '%"image-%.anim.gif"%')` },
  // 音乐 = 抖音收藏夹里收的歌（有没有文件都算）；配乐 = 帖子自带的背景音
  music: { label: '音乐', icon: '🎵', get sql() { return hasDouyinTable() ? `EXISTS (SELECT 1 FROM douyin_favorites f WHERE f.item_id = a.item_id AND f.kind = 'music')` : '0'; } },
  audio: { label: '配乐', icon: '🔊', get sql() { return `a.formats LIKE '%"audio.%'` + (hasDouyinTable() ? ` AND NOT EXISTS (SELECT 1 FROM douyin_favorites f WHERE f.item_id = a.item_id AND f.kind = 'music')` : ''); } },
  text:  { label: '仅文字 / 待下载', icon: '📝', sql: `a.formats LIKE '%"readable.md"%' AND a.formats NOT LIKE '%"video.mp4"%' AND a.formats NOT LIKE '%"image-%' AND a.formats NOT LIKE '%"audio.%' AND a.formats NOT LIKE '%"cover%' AND a.formats NOT LIKE '%"screenshot%'` },
};
export function mediaTypeCounts() {
  const sel = Object.entries(MEDIA_TYPES).map(([k, v]) => `SUM(${v.sql}) AS ${k}`).join(', ');
  const r = one(`SELECT ${sel} FROM archives a WHERE a.status = 'done'`) ?? {};
  return Object.fromEntries(Object.keys(MEDIA_TYPES).map((k) => [k, Number(r[k]) || 0]));
}

// —— 列表 ——
// 返回给前端的形状保留 item_kind / item_id 两个字段（标签、存档都按这对键找），body 用摘要兜底。
const row = (r) => ({ item_kind: 'link', item_id: r.id, id: r.id, kind: r.kind, title: r.title ?? r.url ?? '(无标题)', url: r.url, note: r.note, body: r.excerpt ?? r.body, excerpt: r.excerpt,
  image: r.image, source: r.source, type: r.type, created_at: r.created_at, tags: tagsOf('link', r.id) });

export function listItems({ kind = null, tag = null, exclude_tag = null, source = null, media = null, q: text = null, limit = 60, offset = 0 } = {}) {
  const where = [], params = [];
  if (kind) { where.push('x.kind = ?'); params.push(kind); }
  if (source) { where.push('x.source = ?'); params.push(String(source)); }
  if (media && MEDIA_TYPES[media]) where.push(`EXISTS (SELECT 1 FROM archives a WHERE a.item_kind = 'link' AND a.item_id = x.id AND a.status = 'done' AND ${MEDIA_TYPES[media].sql})`);
  if (text) { where.push('(x.title LIKE ? OR x.note LIKE ? OR x.body LIKE ? OR x.excerpt LIKE ?)'); const t = `%${String(text).replace(/[%_]/g, '')}%`; params.push(t, t, t, t); }
  if (tag) { where.push(`EXISTS (SELECT 1 FROM taggings g JOIN tags t ON t.id = g.tag_id WHERE g.item_kind = 'link' AND g.item_id = x.id AND t.name = ?)`); params.push(String(tag)); }
  // 反向筛：带这个标签的不要（收藏库默认把「已失效」的藏起来就靠它）
  if (exclude_tag) { where.push(`NOT EXISTS (SELECT 1 FROM taggings g JOIN tags t ON t.id = g.tag_id WHERE g.item_kind = 'link' AND g.item_id = x.id AND t.name = ?)`); params.push(String(exclude_tag)); }
  return q(`SELECT x.* FROM items x ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY x.created_at DESC, x.id DESC LIMIT ? OFFSET ?`,
    ...params, Math.min(Number(limit) || 60, 500), Number(offset) || 0).map(row);
}
export const countItems = () => one('SELECT COUNT(*) AS n FROM items')?.n ?? 0;
export const itemView = (id) => { const r = getItem(id); return r ? row(r) : null; };

export function stats() {
  const bySource = Object.fromEntries(q(`SELECT COALESCE(source, '其它') AS s, COUNT(*) AS c FROM items GROUP BY s`).map((r) => [r.s, r.c]));
  const byKind = Object.fromEntries(q('SELECT kind, COUNT(*) AS c FROM items GROUP BY kind').map((r) => [r.kind, r.c]));
  const untagged = one(`SELECT COUNT(*) AS c FROM items x WHERE NOT EXISTS (SELECT 1 FROM taggings g WHERE g.item_kind = 'link' AND g.item_id = x.id)`)?.c ?? 0;
  return { total: countItems(), by_kind: byKind, by_source: bySource, untagged, media_types: mediaTypeCounts() };
}
