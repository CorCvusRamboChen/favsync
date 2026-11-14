// 社交平台收藏（抖音 / 微博 …）共用的存档落盘逻辑。
// 每条收藏在收藏库里是一张 link 卡；存档目录和其它收藏一样（年/月/站点-标题-link<id>/），
// 入库时就写 readable.md + metadata.json（文本最小最耐久），封面/图/视频文件晚点到了再补进同一个目录。
// archives 表在文本落盘那一刻就标 done：后台的网页存档不会再去抓这些站的登录墙。
import { mkdirSync, writeFileSync, statSync, openSync, readSync, closeSync, renameSync } from 'node:fs';
import path from 'node:path';
import { one, run, q } from '../db.js';
import { archiveRoot, dirFor } from '../archive.js';

function itemRow(itemId) {
  const r = one('SELECT id, url, title, note, source, created_at FROM items WHERE id = ?', itemId);
  return r ? { ...r, item_kind: 'link', item_id: r.id } : null;
}
export function archiveDirOf(itemId) {
  const st = one(`SELECT dir FROM archives WHERE item_kind = 'link' AND item_id = ?`, itemId);
  if (st?.dir) return st.dir;
  const it = itemRow(itemId);
  return it ? dirFor(it) : null;
}
export function upsertArchive(itemId, rel, written) {
  const st = one(`SELECT formats, attempts FROM archives WHERE item_kind = 'link' AND item_id = ?`, itemId);
  let formats = {};
  try { formats = JSON.parse(st?.formats ?? '{}'); } catch { /* 坏 JSON 当没有 */ }
  Object.assign(formats, written);
  const bytes = Object.values(formats).reduce((n, b) => n + (Number(b) || 0), 0);
  run(`INSERT INTO archives (item_kind, item_id, dir, formats, bytes, status, error, attempts, archived_at)
       VALUES ('link', ?, ?, ?, ?, 'done', NULL, ?, datetime('now'))
       ON CONFLICT(item_kind, item_id) DO UPDATE SET dir = excluded.dir, formats = excluded.formats, bytes = excluded.bytes,
         status = 'done', error = NULL, archived_at = excluded.archived_at`,
    itemId, rel, JSON.stringify(formats), bytes, (st?.attempts ?? 0) + 1);
  return formats;
}
// 文本存档：title / url / sourceLabel / body 是给人读的，meta 是给机器读的（原始字段挑过的）
export function writeTextArchive(itemId, { title, url, sourceLabel, body, meta }) {
  const rel = archiveDirOf(itemId);
  if (!rel) return null;
  const abs = path.join(archiveRoot(), rel);
  mkdirSync(abs, { recursive: true });
  const md = [`# ${title}`, '', url ? `原始链接：${url}` : null, `来源：${sourceLabel}　收藏同步于：${new Date().toISOString().slice(0, 16)}`, '', '---', '', body].filter((l) => l !== null).join('\n');
  writeFileSync(path.join(abs, 'readable.md'), md, 'utf-8');
  writeFileSync(path.join(abs, 'metadata.json'), JSON.stringify({ item_kind: 'link', item_id: itemId, ...meta, archived_at: new Date().toISOString() }, null, 2), 'utf-8');
  upsertArchive(itemId, rel, { 'readable.md': Buffer.byteLength(md), 'metadata.json': statSync(path.join(abs, 'metadata.json')).size });
  return rel;
}

// 文件内容必须像那回事：登录墙/风控页会以 200 + HTML 回来，不能把它当视频或图片存下来
export const MAGIC = {
  video: (b) => b.length > 16 * 1024 && (b.subarray(4, 8).toString('latin1') === 'ftyp' || b.subarray(0, 4).toString('latin1') === '\x1aE\xdf\xa3'),
  image: (b) => b.length > 512 && (b[0] === 0xff && b[1] === 0xd8 || b.subarray(0, 4).toString('latin1') === '\x89PNG' || b.subarray(8, 12).toString('latin1') === 'WEBP' || b.subarray(0, 3).toString('latin1') === 'GIF'),
};
export const imgExt = (b) => b[0] === 0xff ? 'jpg' : b.subarray(0, 4).toString('latin1') === '\x89PNG' ? 'png' : b.subarray(8, 12).toString('latin1') === 'WEBP' ? 'webp' : 'gif';
// video = 正片 video.mp4；cover = 静态封面；image = 图文第 N 张（原图，GIF/动态 WebP 原样保留）；
// anim = 动态封面 cover-anim.webp；live = 图文第 N 张的实况/动图短片 live-NN.mp4
// audio = 收藏的音乐/原声 audio.mp3（或按文件头 m4a/ogg/flac）
export const MEDIA_KINDS = ['video', 'cover', 'image', 'anim', 'live', 'audio'];
const isVideoKind = (k) => k === 'video' || k === 'live';
MAGIC.audio = (b) => b.length > 8 * 1024 && (b.subarray(0, 3).toString('latin1') === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)
  || b.subarray(4, 8).toString('latin1') === 'ftyp' || b.subarray(0, 4).toString('latin1') === 'OggS' || b.subarray(0, 4).toString('latin1') === 'fLaC');
const audioExt = (b) => b.subarray(4, 8).toString('latin1') === 'ftyp' ? 'm4a' : b.subarray(0, 4).toString('latin1') === 'OggS' ? 'ogg' : b.subarray(0, 4).toString('latin1') === 'fLaC' ? 'flac' : 'mp3';
// 动态 WebP：VP8X 块带 ANIM 标志；GIF 本身就可能是动图。只用来在 metadata 里标一下，文件照原样存
export const isAnimatedImage = (b) => (b.subarray(0, 3).toString('latin1') === 'GIF' && b.includes(Buffer.from('NETSCAPE2.0')))
  || (b.subarray(8, 12).toString('latin1') === 'WEBP' && b.subarray(12, 16).toString('latin1') === 'VP8X' && (b[20] & 0x02) !== 0);

// 一个媒体文件落盘：返回 {ok, file, dir, formats}；不像媒体就 {ok:false, suspicious:true}
export function storeMediaFile(itemId, { kind, index = 0, bytes }) {
  if (!MEDIA_KINDS.includes(kind)) throw new Error('kind 只能是 video / cover / image');
  if (!Buffer.isBuffer(bytes) || !bytes.length) throw new Error('没有内容');
  if (!(kind === 'audio' ? MAGIC.audio : isVideoKind(kind) ? MAGIC.video : MAGIC.image)(bytes)) return { ok: false, suspicious: true, reason: `${kind} 内容不像媒体文件（${bytes.length} 字节，可能是登录墙）` };
  const rel = archiveDirOf(itemId);
  const abs = path.join(archiveRoot(), rel);
  mkdirSync(abs, { recursive: true });
  const nn = String(index + 1).padStart(2, '0');
  const name = kind === 'video' ? 'video.mp4' : kind === 'live' ? `live-${nn}.mp4` : kind === 'audio' ? `audio.${audioExt(bytes)}` : kind === 'cover' ? `cover.${imgExt(bytes)}`
    : kind === 'anim' ? `cover-anim.${imgExt(bytes)}` : `image-${nn}.${imgExt(bytes) === 'webp' && isAnimatedImage(bytes) ? 'anim.webp' : imgExt(bytes)}`;   // 动态 WebP 带 .anim.，按文件名就能分出「动图」
  writeFileSync(path.join(abs, name), bytes);
  const formats = upsertArchive(itemId, rel, { [name]: bytes.length });
  if (kind === 'cover') run('UPDATE items SET image = ? WHERE id = ?', archiveUrl(rel, name), itemId);
  return { ok: true, file: name, dir: rel, formats, animated: !isVideoKind(kind) && isAnimatedImage(bytes) };
}
// 存档路径里有中文和 #（标题里的话题标签）：不编码的话 URL 在 # 处就断了，卡片封面全白
export const archiveUrl = (rel, name) => `/archive/${String(rel).split('/').map(encodeURIComponent).join('/')}/${encodeURIComponent(name)}`;
// 启动时把库里的 /archive/ 路径统一成"只编码一层"：先一路解码到不再变化，再按段编码一次。
// 之前那版只看"含不含 % / 中文"，结果编码过的路径每次重启再被编一层（%25E4…），封面全 404 —— 这版幂等。
export const decodeAll = (s) => { let cur = String(s ?? ''); for (let i = 0; i < 6; i++) { let next; try { next = decodeURIComponent(cur); } catch { break; } if (next === cur) break; cur = next; } return cur; };
export const normalizeArchiveUrl = (u) => { if (!u || !String(u).startsWith('/archive/')) return u; const parts = decodeAll(String(u).slice('/archive/'.length)).split('/'); const name = parts.pop(); return archiveUrl(parts.join('/'), name); };
for (const r of q(`SELECT id, image FROM items WHERE image LIKE '/archive/%'`)) {
  const fixed = normalizeArchiveUrl(r.image);
  if (fixed !== r.image) run('UPDATE items SET image = ? WHERE id = ?', fixed, r.id);
}
// 早先存的 image-NN.webp 里有动图没标出来：读文件头认一遍，是动图就改名 image-NN.anim.webp 并更新 formats（幂等，可反复跑）
export function flagAnimatedImages({ limit = 5000 } = {}) {
  const out = { checked: 0, flagged: 0, missing: 0 };
  for (const r of q(`SELECT item_id, dir, formats FROM archives WHERE item_kind = 'link' AND status = 'done' AND formats LIKE '%.webp"%' LIMIT ?`, limit)) {
    let formats = {}; try { formats = JSON.parse(r.formats ?? '{}'); } catch { continue; }
    let changed = false;
    for (const name of Object.keys(formats)) {
      if (!/^image-\d+\.webp$/.test(name)) continue;
      const abs = path.join(archiveRoot(), r.dir, name);
      out.checked++;
      let head;
      try { const fd = openSync(abs, 'r'); head = Buffer.alloc(64); readSync(fd, head, 0, 64, 0); closeSync(fd); } catch { out.missing++; continue; }
      if (!isAnimatedImage(head)) continue;
      const next = name.replace(/\.webp$/, '.anim.webp');
      try { renameSync(abs, path.join(archiveRoot(), r.dir, next)); } catch { out.missing++; continue; }
      formats[next] = formats[name]; delete formats[name]; changed = true; out.flagged++;
      run('UPDATE items SET image = ? WHERE id = ? AND image = ?', archiveUrl(r.dir, next), r.item_id, archiveUrl(r.dir, name));
    }
    if (changed) run('UPDATE archives SET formats = ? WHERE item_kind = ? AND item_id = ?', JSON.stringify(formats), 'link', r.item_id);
  }
  return out;
}
export const hasImage = (formats, i) => Object.keys(formats).some((f) => f.startsWith(`image-${String(i + 1).padStart(2, '0')}.`));
