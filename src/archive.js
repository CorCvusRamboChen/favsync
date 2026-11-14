// 存档层：把收藏的东西**变成你硬盘上的普通文件**，这样站点被封、被删、链接失效之后，你手里还有内容。
//
// 三条原则（参照 ArchiveBox）：
//   1) 多份冗余：正文 readable.md + metadata.json 先落盘（最小、最耐久），封面 / 原图 / 视频 / 音频晚点到了补进同一个目录。
//   2) 普通文件、普通目录：不塞数据库 blob、不用私有格式。云盘能同步，资源管理器能翻，别的程序能读。
//   3) 能脱离本工具存活：根目录生成一个纯静态的 index.html，用 file:// 直接打开就能浏览全部存档。
//
// 目录结构：<存档根>/年/月/站点-标题-link<id>/。存档根默认 ~/FavSync/archive，可用 FAVSYNC_ARCHIVE 或设置页改——指向云盘同步的文件夹即可。
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { q, one, dataDir } from './db.js';
import { countItems } from './store.js';   // archives 表由 store.js 建（数据层统一建表）

const cfgFile = () => path.join(dataDir(), 'archive.json');
const readCfg = () => { try { return JSON.parse(readFileSync(cfgFile(), 'utf-8')); } catch { return {}; } };
const expandHome = (p) => String(p).replace(/^~(?=$|[\\/])/, homedir());

export function archiveRoot() {
  const p = process.env.FAVSYNC_ARCHIVE || readCfg().root;
  return path.resolve(expandHome(p || path.join(homedir(), 'FavSync', 'archive')));
}
export function setArchiveRoot(root) {
  mkdirSync(path.dirname(cfgFile()), { recursive: true });
  writeFileSync(cfgFile(), JSON.stringify({ root: root ? expandHome(root) : null }, null, 2));
  return archiveRoot();
}

const slug = (s, max = 48) => String(s ?? '').replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ').replace(/\s+/g, '-').replace(/^-+|-+$/g, '').slice(0, max) || 'item';
const hostOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } };

// 目录名带上日期和 id：日期便于人眼按时间找，id 保证唯一、重跑不会撞
export function dirFor(item) {
  const d = new Date(item.created_at ?? Date.now());
  const ym = `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}`;
  const name = [hostOf(item.url), slug(item.title)].filter(Boolean).join('-');
  return `${ym}/${slug(name)}-${item.item_kind ?? 'link'}${item.item_id ?? item.id}`;
}

export function archiveStatus() {
  const rows = q(`SELECT status, COUNT(*) AS c, SUM(bytes) AS bytes FROM archives GROUP BY status`);
  const total = countItems();
  const done = rows.find((r) => r.status === 'done')?.c ?? 0;
  return { root: archiveRoot(), exists: existsSync(archiveRoot()), total, done, pending: Math.max(0, total - done),
    failed: rows.find((r) => r.status === 'failed')?.c ?? 0, bytes: rows.reduce((n, r) => n + (r.bytes ?? 0), 0), index: path.join(archiveRoot(), 'index.html') };
}

// 给一批条目挂上各自的存档状态（目录、文件名列表）：前端拼 /archive/ 前缀即可直接打开
export function archivesFor(items) {
  if (!items.length) return items;
  const rows = q('SELECT item_kind, item_id, dir, formats, status, error, archived_at FROM archives');
  const byKey = new Map(rows.map((r) => [`${r.item_kind}:${r.item_id}`, r]));
  return items.map((it) => {
    const a = byKey.get(`${it.item_kind}:${it.item_id}`);
    if (!a) return { ...it, archive: null };
    let files = [];
    try { files = Object.keys(JSON.parse(a.formats ?? '{}')); } catch { /* 坏 JSON 当没有 */ }
    return { ...it, archive: { dir: a.dir, status: a.status, error: a.error, archived_at: a.archived_at, files } };
  });
}

// —— 脱离本工具也能用的静态目录：纯静态、相对路径、样式内联，不联网、不依赖任何 CDN ——
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export function writeIndex() {
  const root = archiveRoot();
  mkdirSync(root, { recursive: true });
  const rows = q(`SELECT * FROM archives WHERE status = 'done' ORDER BY archived_at DESC`);
  const items = rows.map((r) => {
    let meta = {};
    try { meta = JSON.parse(readFileSync(path.join(root, r.dir, 'metadata.json'), 'utf-8')); } catch { /* 用数据库里的兜底 */ }
    const it = one('SELECT title, url, source, created_at FROM items WHERE id = ?', r.item_id) ?? {};
    let files = []; try { files = Object.keys(JSON.parse(r.formats || '{}')); } catch { /* 略 */ }
    return { title: meta.title ?? it.title, url: meta.url ?? it.url, source: meta.source ?? it.source, tags: meta.tags ?? [], archived_at: meta.archived_at ?? r.archived_at, dir: r.dir, files, bytes: r.bytes };
  });
  const allTags = [...new Set(items.flatMap((i) => i.tags ?? []))].sort();
  const kb = (n) => (n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>我的收藏存档（${items.length} 条）</title>
<style>
  :root{--bg:#0d1117;--panel:#161b22;--line:#30363d;--text:#e6edf3;--dim:#7d8590;--accent:#58a6ff}
  @media (prefers-color-scheme:light){:root{--bg:#faf9f7;--panel:#fff;--line:#e3e0da;--text:#25272b;--dim:#6b6960;--accent:#2f5fe0}}
  *{box-sizing:border-box}body{margin:0 auto;background:var(--bg);color:var(--text);font:15px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;padding:24px;max-width:900px}
  h1{font-size:20px;margin:0 0 4px}.sub{color:var(--dim);font-size:13px;margin-bottom:18px}
  input,select{background:var(--panel);border:1px solid var(--line);color:var(--text);border-radius:6px;padding:7px 10px;font:inherit}
  .bar{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:12px 14px;margin-bottom:10px}
  .t{font-weight:600}.meta{color:var(--dim);font-size:12.5px;margin-top:3px}a{color:var(--accent)}
  .tag{display:inline-block;font-size:11.5px;border:1px solid var(--line);border-radius:20px;padding:1px 8px;margin:3px 4px 0 0;color:var(--dim)}
  .files{margin-top:6px;font-size:12.5px}.files a{margin-right:10px}
  footer{color:var(--dim);font-size:12px;margin-top:24px;border-top:1px solid var(--line);padding-top:12px}
</style></head><body>
<h1>我的收藏存档</h1>
<div class="sub">${items.length} 条 · 共 ${kb(items.reduce((n, i) => n + (i.bytes || 0), 0))} · 生成于 ${new Date().toISOString().slice(0, 16).replace('T', ' ')}
<br>这个页面是纯静态的：不联网、不需要跑 FavSync，双击就能看。每条下面的文件都是普通文件，可以直接用系统自带程序打开。</div>
<div class="bar"><input id="q" placeholder="搜标题、链接、标签…" style="flex:1;min-width:220px" oninput="flt()">
  <select id="tag" onchange="flt()"><option value="">全部标签</option>${allTags.map((t) => `<option>${esc(t)}</option>`).join('')}</select></div>
<div id="list">
${items.map((i) => `<div class="card" data-s="${esc([i.title, i.url, (i.tags || []).join(' ')].filter(Boolean).join(' ').toLowerCase())}" data-tags="${esc((i.tags || []).join('|'))}">
  <div class="t">${esc(i.title || i.dir)}</div>
  <div class="meta">${[i.url ? `<a href="${esc(i.url)}">${esc(i.url).slice(0, 80)}</a>` : null, i.source ? esc(i.source) : null, i.archived_at ? '存档于 ' + esc(String(i.archived_at).slice(0, 10)) : null].filter(Boolean).join(' · ')}</div>
  ${(i.tags || []).map((t) => `<span class="tag">${esc(t)}</span>`).join('')}
  <div class="files">${(i.files || []).map((f) => `<a href="${esc(i.dir)}/${esc(f)}">${esc(f)}</a>`).join('')}</div>
</div>`).join('\n')}
</div>
<footer>目录结构：<code>年/月/站点-标题-link编号/</code>，每个文件夹里是 readable.md（正文）、metadata.json、cover.jpg、image-NN、video.mp4、audio.mp3 等。即使这个索引页丢了，直接翻文件夹一样能看。</footer>
<script>
function flt(){const q=document.getElementById('q').value.toLowerCase().trim();const t=document.getElementById('tag').value;
for(const c of document.querySelectorAll('.card')){c.style.display=(!q||c.dataset.s.includes(q))&&(!t||c.dataset.tags.split('|').includes(t))?'':'none';}}
</script></body></html>`;
  const out = path.join(root, 'index.html');
  writeFileSync(out, html, 'utf-8');
  writeFileSync(path.join(root, 'index.json'), JSON.stringify({ generated_at: new Date().toISOString(), count: items.length, items }, null, 2), 'utf-8');
  return { index: out, count: items.length };
}
