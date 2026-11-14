// 微博收藏 → 收藏库。
//
// 两条进来的路：
//   1) 已经导出过的 Weibo-archiver（Chrome 插件）JSON：{ user, weibo, favorites, followings }，
//      favorites 里每条 { id, mblogid, text, imgs[], createdAt, user{uid,name}, retweet{…}, card{link,title,img,desc}, … }。
//      POST /api/weibo/import {path} 读本机文件直接入库。
//   2) 油猴脚本在 weibo.com 上翻收藏（/ajax/favorites/all_fav，每页 20 条），推 /api/weibo/push，
//      每条是微博网页版自己的 mblog 结构 { idstr, mblogid, text_raw, created_at, user{idstr,screen_name}, pic_infos, page_info, retweeted_status, … }。
// normalizeWeibo 把两种形状整成一个，后面的入库/存档/媒体就一套。
//
// 媒体：微博的图片（sinaimg.cn）带 Referer 就能直接从服务端下，所以导入旧文件后不需要浏览器也能把图存全
//（fetchPendingMedia）；视频地址要登录态而且会过期，只有脚本在浏览器里能拿到，走和抖音一样的 pending/media 接口。
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { db, q, one, run } from '../db.js';
import { launchProfile, DEFAULT_PROFILE } from './browser-profiles.js';
import { saveItem, setTags, tagsOf } from '../store.js';
import { archiveRoot } from '../archive.js';
import { assertSafeUrl } from '../net-guard.js';
import { writeTextArchive, storeMediaFile, hasImage } from './favorites-archive.js';

db.exec(`
CREATE TABLE IF NOT EXISTS weibo_favorites (
  weibo_id TEXT PRIMARY KEY,
  item_id INTEGER NOT NULL REFERENCES items(id),
  mblogid TEXT,
  author TEXT,
  author_uid TEXT,
  create_time TEXT,
  cover_url TEXT,
  images_json TEXT,              -- 正文 + 转发原文的图
  play_url TEXT,                 -- 视频直链（只有脚本在浏览器里拿得到，会过期）
  link_url TEXT,                 -- 卡片链接（文章 / 视频页）
  stats_json TEXT,
  unavailable INTEGER NOT NULL DEFAULT 0,   -- 原微博已删/被屏蔽，只剩收藏时的壳
  raw_json TEXT,
  media_status TEXT NOT NULL DEFAULT 'pending',   -- 图：pending / done / failed / none
  video_status TEXT NOT NULL DEFAULT 'none',      -- 视频：none / pending / done / failed
  media_error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  origin TEXT NOT NULL DEFAULT 'script',          -- script / import
  collected_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

try { db.exec('ALTER TABLE weibo_favorites ADD COLUMN origin_id TEXT'); } catch { /* 已存在 */ }

const MAX_ATTEMPTS = 3;
const MAX_IMAGES = 18;
export const TAG = '微博收藏';
export const DEAD_TAG = '已失效';   // 原微博已删/被屏蔽：打上这个标签，收藏库里一键滤掉
const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
// "Mon Jan 04 16:40:10 +0800 2016" → ISO。两种来源都是这个格式。
export function parseWeiboTime(s) {
  const m = String(s ?? '').match(/^\w{3} (\w{3}) (\d{1,2}) (\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2}) (\d{4})$/);
  if (!m) { const t = Date.parse(s); return Number.isFinite(t) ? new Date(t).toISOString() : null; }
  const [, mon, d, hh, mm, ss, sign, tzh, tzm, y] = m;
  const offsetMin = (sign === '-' ? -1 : 1) * (Number(tzh) * 60 + Number(tzm));
  const utc = Date.UTC(Number(y), MONTHS[mon] ?? 0, Number(d), Number(hh), Number(mm), Number(ss)) - offsetMin * 60000;
  return new Date(utc).toISOString();
}
const stripHtml = (s) => String(s ?? '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').trim();
const UNAVAILABLE_RE = /已被作者删除|无法查看|已被屏蔽|违反.*社区公约|抱歉，此微博|已不可见|可见时间范围|微博不存在|该微博已|内容已删除|已被删除|请至手机客户端查看/;
const uniq = (arr) => [...new Set(arr.filter((u) => typeof u === 'string' && u.startsWith('http')))];

// 网页版 mblog 的图：pic_infos[picid].largest/original/large 挑最大的
function rawImages(m) {
  const ids = Array.isArray(m.pic_ids) ? m.pic_ids : Object.keys(m.pic_infos ?? {});
  return ids.map((id) => { const p = m.pic_infos?.[id]; return p?.largest?.url ?? p?.original?.url ?? p?.large?.url ?? p?.bmiddle?.url ?? null; });
}
function rawVideo(pi) {
  const mi = pi?.media_info ?? {};
  return mi.mp4_720p_mp4 ?? mi.mp4_hd_url ?? mi.stream_url_hd ?? mi.mp4_sd_url ?? mi.stream_url ?? mi.h5_url ?? null;
}

// 两种形状 → 一种。纯函数；坏条目返回 null。
export function normalizeWeibo(w) {
  if (!w || typeof w !== 'object') return null;
  const isRaw = 'text_raw' in w || 'created_at' in w || 'pic_infos' in w;
  const id = String(w.idstr ?? w.id ?? '').trim();
  if (!/^\d{6,}$/.test(id)) return null;
  const mblogid = String(w.mblogid ?? '').trim() || null;
  const author = String(isRaw ? w.user?.screen_name ?? '' : w.user?.name ?? '').trim();
  const author_uid = (isRaw ? w.user?.idstr ?? w.user?.id : w.user?.uid) != null ? String(isRaw ? w.user.idstr ?? w.user.id : w.user.uid) : null;
  const text = isRaw ? (w.text_raw ? String(w.text_raw) : stripHtml(w.text)) : String(w.text ?? '');
  const rt = isRaw ? w.retweeted_status : w.retweet;
  const retweet = rt ? {
    text: isRaw ? (rt.text_raw ? String(rt.text_raw) : stripHtml(rt.text)) : String(rt.text ?? ''),
    author: String(isRaw ? rt.user?.screen_name ?? '' : rt.user?.name ?? '').trim(),
    images: uniq(isRaw ? rawImages(rt) : rt.imgs ?? []),
    mblogid: rt.mblogid ?? null, id: String(rt.idstr ?? rt.id ?? '') || null,
  } : null;
  const ownImages = uniq(isRaw ? rawImages(w) : w.imgs ?? []);
  const images = uniq([...ownImages, ...(retweet?.images ?? [])]).slice(0, MAX_IMAGES);
  const pi = isRaw ? (w.page_info ?? rt?.page_info ?? null) : null;
  const card = isRaw
    ? (pi ? { link: pi.page_url ?? null, title: pi.page_title ?? pi.content1 ?? null, img: pi.page_pic ?? null, desc: pi.content2 ?? null } : null)
    : (w.card ?? null);
  const play_url = isRaw ? rawVideo(pi) : null;
  const st = isRaw ? { reposts: w.reposts_count, comments: w.comments_count, likes: w.attitudes_count } : { reposts: w.repostsCount, comments: w.commentsCount, likes: w.likesCount };
  // 整条就是一句系统提示（没图、没转发、要么没作者要么就那二三十个字）才算失效；作者自己写了"已删除"仨字不算
  const notice = (t, au, imgs) => !imgs.length && UNAVAILABLE_RE.test(t) && (!au || t.replace(/s/g, '').length <= 40);
  const ownDead = !retweet && notice(text, author, ownImages);
  // 转发的原文没了、自己那句又只是个表情/几个字 → 这条也等于没了
  const rtDead = !!retweet && notice(retweet.text, retweet.author, retweet.images) && cleanTitle(text).length <= 10;
  const unavailable = ownDead || rtDead;
  const url = author_uid && mblogid ? `https://weibo.com/${author_uid}/${mblogid}` : `https://weibo.com/detail/${id}`;
  return {
    weibo_id: id, mblogid, url, text: text.trim(), author, author_uid,
    create_time: parseWeiboTime(isRaw ? w.created_at : w.createdAt),
    retweet, images,
    cover: card?.img || images[0] || null,
    card, play_url, link_url: card?.link ?? null,
    stats: { reposts: Number(st.reposts) || 0, comments: Number(st.comments) || 0, likes: Number(st.likes) || 0 },
    region: String(isRaw ? w.region_name ?? '' : w.regionName ?? '').replace(/^发布于\s*/, '') || null,
    unavailable,
  };
}
const cleanTitle = (s) => String(s ?? '').replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').replace(/^(\/\/@[^:：]+[:：])+/, '').trim();
export function titleOf(n) {
  const own = cleanTitle(n.text);
  if (n.unavailable) return `（已失效的微博）${own.slice(0, 60)}`;
  const FILLER = /^(转发微博?|转|转发|mark|马克|m|收藏|学习了?|存|留|好|好的|哈哈+|笑死|赞|顶|[!！。．…~～\s]*)$/i;
  const rt = cleanTitle(n.retweet?.text ?? '');
  if (own && (!rt || (own.length >= 6 && !FILLER.test(own)))) return own.slice(0, 120);
  if (rt) return `${n.retweet.author ? '@' + n.retweet.author + '：' : ''}${rt}`.slice(0, 120);
  if (n.card?.title) return String(n.card.title).slice(0, 120);
  return n.author ? `@${n.author} 的微博` : '微博';
}
export function bodyOf(n) {
  return [n.author ? `作者：@${n.author}${n.region ? '（' + n.region + '）' : ''}` : (n.unavailable ? '原微博已删除或不可见，只剩收藏时的记录' : null),
    n.text || null,
    n.retweet ? `\n转发自 ${n.retweet.author ? '@' + n.retweet.author : '（已删除的微博）'}：\n${n.retweet.text}` : null,
    n.card?.link ? `\n卡片：${n.card.title ?? ''} ${n.card.link}${n.card.desc ? '\n' + n.card.desc : ''}` : null,
    n.images.length ? `图片 ${n.images.length} 张` : null,
    `🔁 ${n.stats.reposts} · 💬 ${n.stats.comments} · 👍 ${n.stats.likes}`,
    n.create_time ? `发布于 ${n.create_time.slice(0, 10)}` : null].filter(Boolean).join('\n');
}

// 同一条内容只要一张卡：A 转发了 X、B 也转发了 X、X 本身——三条收藏都指向 X 那张卡
function sameContentItem(weiboId, originId) {
  const hit = originId
    ? one('SELECT item_id FROM weibo_favorites WHERE weibo_id = ? OR origin_id = ? LIMIT 1', originId, originId)
    : one('SELECT item_id FROM weibo_favorites WHERE origin_id = ? LIMIT 1', weiboId);
  return hit?.item_id ?? null;
}
// 一批条目入库：按 weibo_id 去重，复用手动存过的同 url 卡；写文本存档；没有图的直接 media_status=none
export function ingestFavorites(list, { origin = 'script' } = {}) {
  const out = { received: Array.isArray(list) ? list.length : 0, added: 0, updated: 0, invalid: 0, item_ids: [] };
  for (const raw of Array.isArray(list) ? list : []) {
    const n = normalizeWeibo(raw);
    if (!n) { out.invalid++; continue; }
    const existing = one('SELECT item_id, video_status FROM weibo_favorites WHERE weibo_id = ?', n.weibo_id);
    if (existing) {
      run(`UPDATE weibo_favorites SET play_url = COALESCE(?, play_url), cover_url = COALESCE(cover_url, ?), stats_json = ?,
             video_status = CASE WHEN ? IS NOT NULL AND video_status IN ('none','failed') THEN 'pending' ELSE video_status END WHERE weibo_id = ?`,
        n.play_url, n.cover, JSON.stringify(n.stats), n.play_url, n.weibo_id);
      out.updated++; out.item_ids.push(existing.item_id);
      continue;
    }
    let itemId = one('SELECT id FROM items WHERE url = ? AND kind = ?', n.url, 'link')?.id ?? null;
    const originId = n.retweet?.id ?? null;
    if (!itemId) itemId = sameContentItem(n.weibo_id, originId);
    if (!itemId) itemId = saveItem({ kind: 'link', url: n.url, title: titleOf(n), body: bodyOf(n), source: '微博', type: 'reference', tags: n.unavailable ? [TAG, DEAD_TAG] : [TAG] }).id;
    run('UPDATE items SET image = COALESCE(image, ?), excerpt = COALESCE(excerpt, ?), source = COALESCE(source, ?) WHERE id = ?',
      n.cover, (n.text || n.retweet?.text || '').slice(0, 300) || null, '微博', itemId);
    run(`INSERT INTO weibo_favorites (weibo_id, item_id, mblogid, author, author_uid, create_time, cover_url, images_json, play_url, link_url, stats_json, unavailable, raw_json, media_status, video_status, origin, origin_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      n.weibo_id, itemId, n.mblogid, n.author, n.author_uid, n.create_time, n.cover, JSON.stringify(n.images), n.play_url, n.link_url,
      JSON.stringify(n.stats), n.unavailable ? 1 : 0, JSON.stringify(raw).slice(0, 20000),
      n.images.length || n.cover ? 'pending' : 'none', n.play_url ? 'pending' : 'none', origin, originId);
    try {
      writeTextArchive(itemId, { title: titleOf(n), url: n.url, sourceLabel: '微博收藏', body: bodyOf(n),
        meta: { source: '微博', weibo_id: n.weibo_id, mblogid: n.mblogid, url: n.url, title: titleOf(n), text: n.text, author: n.author, author_uid: n.author_uid,
          create_time: n.create_time, retweet: n.retweet, card: n.card, images: n.images, cover_url: n.cover, stats: n.stats, region: n.region, unavailable: n.unavailable } });
    } catch (e) { console.warn('[weibo] 写文本存档失败：', e.message); }
    out.added++; out.item_ids.push(itemId);
  }
  return out;
}

// 导入 Weibo-archiver 导出的 JSON（本机文件）。默认只要 favorites；include_own=true 时把自己发的微博也当收藏存。
export function importExportFile(filePath, { include_own = false } = {}) {
  const p = path.resolve(String(filePath ?? '').replace(/^"|"$/g, ''));
  if (!existsSync(p)) throw new Error(`文件不存在：${p}`);
  if (statSync(p).size > 200 * 1024 * 1024) throw new Error('文件超过 200MB，不像导出文件');
  let d;
  try { d = JSON.parse(readFileSync(p, 'utf-8')); } catch { throw new Error('不是合法的 JSON'); }
  const favorites = Array.isArray(d) ? d : Array.isArray(d?.favorites) ? d.favorites : null;
  if (!favorites) throw new Error('JSON 里没有 favorites 数组（这不是 Weibo-archiver 的导出文件？）');
  const list = include_own && Array.isArray(d?.weibo) ? [...favorites, ...d.weibo] : favorites;
  const r = ingestFavorites(list, { origin: 'import' });
  return { ...r, file: p, user: d?.user?.name ?? null, favorites: favorites.length, own_posts: Array.isArray(d?.weibo) ? d.weibo.length : 0 };
}

// —— 媒体 ——
const rowOut = (r) => ({ weibo_id: r.weibo_id, item_id: r.item_id, cover_url: r.cover_url, images: JSON.parse(r.images_json ?? '[]'),
  play_url: r.play_url, need_images: r.media_status === 'pending', need_video: r.video_status === 'pending', attempts: r.attempts });
// 给脚本的：图还没齐的，或者视频还没拿到的
export function pendingMedia(limit = 8) {
  return q(`SELECT * FROM weibo_favorites WHERE (media_status = 'pending' OR video_status = 'pending') AND attempts < ?
            ORDER BY collected_at DESC, rowid DESC LIMIT ?`, MAX_ATTEMPTS, Number(limit) || 8).map(rowOut);
}
function recomputeImages(fav, formats) {
  const images = JSON.parse(fav.images_json ?? '[]');
  const coverOk = !fav.cover_url || Object.keys(formats).some((f) => f.startsWith('cover.'));
  return coverOk && images.every((_, i) => hasImage(formats, i));
}
export function storeMedia(weiboId, { kind, index = 0, bytes }) {
  const fav = one('SELECT * FROM weibo_favorites WHERE weibo_id = ?', String(weiboId));
  if (!fav) throw new Error('这条不在微博收藏里');
  const r = storeMediaFile(fav.item_id, { kind, index, bytes });
  if (!r.ok) return { ok: false, suspicious: true, ...markMediaFailed(weiboId, r.reason) };
  if (kind === 'video') run(`UPDATE weibo_favorites SET video_status = 'done' WHERE weibo_id = ?`, fav.weibo_id);
  const imagesDone = recomputeImages(fav, r.formats);
  if (imagesDone && fav.media_status === 'pending') run(`UPDATE weibo_favorites SET media_status = 'done', media_error = NULL WHERE weibo_id = ?`, fav.weibo_id);
  const row = one('SELECT media_status, video_status FROM weibo_favorites WHERE weibo_id = ?', fav.weibo_id);
  return { ok: true, file: r.file, dir: r.dir, complete: row.media_status !== 'pending' && row.video_status !== 'pending' };
}
export function markMediaFailed(weiboId, error) {
  run(`UPDATE weibo_favorites SET attempts = attempts + 1, media_error = ?,
         media_status = CASE WHEN attempts + 1 >= ? AND media_status = 'pending' THEN 'failed' ELSE media_status END,
         video_status = CASE WHEN attempts + 1 >= ? AND video_status = 'pending' THEN 'failed' ELSE video_status END WHERE weibo_id = ?`,
    String(error ?? '').slice(0, 300), MAX_ATTEMPTS, MAX_ATTEMPTS, String(weiboId));
  const r = one('SELECT attempts, media_status, video_status FROM weibo_favorites WHERE weibo_id = ?', String(weiboId));
  return { attempts: r?.attempts ?? 0, media_status: r?.media_status ?? null, video_status: r?.video_status ?? null };
}

// 服务端自己把图下下来（sinaimg 只认 Referer，不要登录态）。导入旧文件之后靠这个把图补全。
const IMG_LIMIT = 30 * 1024 * 1024;
async function fetchBytes(url, fetchImpl) {
  await assertSafeUrl(url);
  const res = await fetchImpl(url, { headers: { Referer: 'https://weibo.com/', 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(15000), redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > IMG_LIMIT) throw new Error('图片超过 30MB');
  return buf;
}
export async function fetchPendingMedia({ limit = 20, fetchImpl = globalThis.fetch } = {}) {
  const rows = q(`SELECT * FROM weibo_favorites WHERE media_status = 'pending' AND attempts < ? ORDER BY collected_at DESC, rowid DESC LIMIT ?`, MAX_ATTEMPTS, Number(limit) || 20);
  const out = { tried: rows.length, done: 0, failed: 0, files: 0 };
  for (const fav of rows) {
    const images = JSON.parse(fav.images_json ?? '[]');
    let formats = {};
    try { formats = JSON.parse(one(`SELECT formats FROM archives WHERE item_kind = 'link' AND item_id = ?`, fav.item_id)?.formats ?? '{}'); } catch { /* 略 */ }
    let failed = null;
    const jobs = [];
    if (fav.cover_url && !Object.keys(formats).some((f) => f.startsWith('cover.'))) jobs.push({ kind: 'cover', url: fav.cover_url, index: 0 });
    images.forEach((url, i) => { if (!hasImage(formats, i)) jobs.push({ kind: 'image', url, index: i }); });
    for (const j of jobs) {
      try {
        const r = storeMediaFile(fav.item_id, { kind: j.kind, index: j.index, bytes: await fetchBytes(j.url, fetchImpl) });
        if (!r.ok) throw new Error(r.reason);
        out.files++;
      } catch (e) { failed = `${j.kind}#${j.index + 1}: ${e.message}`; break; }
    }
    if (failed) { markMediaFailed(fav.weibo_id, failed); out.failed++; }
    else { run(`UPDATE weibo_favorites SET media_status = 'done', media_error = NULL WHERE weibo_id = ?`, fav.weibo_id); out.done++; }
  }
  return out;
}
// —— 服务端定时同步：站在已登录的持久化 profile 里直接调收藏接口 ——
// 不要签名，只要 cookie + X-XSRF-TOKEN。增量模式碰到连续两页全是已有的就停；full 翻到底。
// 和抖音默认账号共用 default profile；同一目录排队启动，撞上了等前一个关掉
const launchShared = (headless = true) => launchProfile(DEFAULT_PROFILE, { headless });
// 收藏接口的一页：旧格式 { data: [mblog…], total_number }，2026-10 起是 { data: { status: [mblog…], total_number } }。
// 两种都认；认不出来时 recognized=false，调用方报错，而不是把格式变化误判成"没有新收藏"后悄悄什么都不做。
export function favoritesPage(json) {
  const d = json?.data;
  const list = Array.isArray(d) ? d : Array.isArray(d?.status) ? d.status : [];
  const t = d?.total_number ?? json?.total_number;
  return { list, total: t != null && Number.isFinite(Number(t)) ? Number(t) : null, recognized: Array.isArray(d) || Array.isArray(d?.status) };
}

export async function syncFavorites({ full = false, maxPages = 500, headless = true, launch = launchShared } = {}) {
  const ctx = await launch(headless);
  try {
    const page = ctx.pages()[0] ?? await ctx.newPage();
    await page.goto('https://weibo.com/', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(2500);
    const uid = await page.evaluate(() => window.$CONFIG?.uid ?? window.$CONFIG?.user?.idstr ?? null).catch(() => null);
    if (!uid || /passport|login/i.test(page.url())) return { need_login: true };
    const out = { added: 0, updated: 0, pages: 0, total: null };
    let stale = 0;
    for (let p = 1; p <= maxPages; p++) {
      const json = await page.evaluate(async ({ uid, p }) => {
        const xsrf = (document.cookie.match(/XSRF-TOKEN=([^;]+)/) ?? [])[1] ?? '';
        const r = await fetch(`/ajax/favorites/all_fav?uid=${uid}&page=${p}&with_total=true`, { credentials: 'include', headers: { 'X-XSRF-TOKEN': xsrf, 'X-Requested-With': 'XMLHttpRequest', Accept: 'application/json' } });
        if (!r.ok) return { error: r.status };
        return r.json();
      }, { uid, p });
      if (json?.error === 403 || json?.error === 401) return { need_login: true, ...out };
      if (json?.error) throw new Error(`微博接口 HTTP ${json.error}`);
      const { list, total, recognized } = favoritesPage(json);
      if (!recognized) throw new Error(`微博收藏接口的返回格式变了（顶层字段：${Object.keys(json ?? {}).join(',')}），需要更新解析`);
      if (total != null) out.total = total;
      if (!list.length) break;
      const r = ingestFavorites(list, { origin: 'sync' });
      out.added += r.added; out.updated += r.updated; out.pages = p;
      if (!full) { stale = r.added ? 0 : stale + 1; if (stale >= 2) break; }
      if (out.total != null && p * list.length >= out.total) break;
      await page.waitForTimeout(700 + Math.random() * 500);
    }
    return out;
  } finally { await ctx.close().catch(() => {}); }
}

export function favoritesStatus() {
  const c = one(`SELECT COUNT(*) AS total, SUM(media_status = 'done') AS media_done, SUM(media_status = 'pending') AS media_pending,
                        SUM(media_status = 'failed') AS media_failed, SUM(media_status = 'none') AS media_none,
                        SUM(video_status = 'done') AS video_done, SUM(video_status = 'pending') AS video_pending,
                        SUM(unavailable) AS unavailable, SUM(origin = 'import') AS imported, MAX(collected_at) AS last_collected_at FROM weibo_favorites`);
  return { total: c?.total ?? 0, media_done: c?.media_done ?? 0, media_pending: c?.media_pending ?? 0, media_failed: c?.media_failed ?? 0, media_none: c?.media_none ?? 0,
    video_done: c?.video_done ?? 0, video_pending: c?.video_pending ?? 0, unavailable: c?.unavailable ?? 0, imported: c?.imported ?? 0,
    last_collected_at: c?.last_collected_at ?? null, archive_root: archiveRoot(), archive_exists: existsSync(archiveRoot()) };
}

// 早于 origin_id 的那批：从 raw_json 补 origin_id
for (const r of q('SELECT weibo_id, raw_json FROM weibo_favorites WHERE origin_id IS NULL')) {
  try { const o = normalizeWeibo(JSON.parse(r.raw_json)); if (o?.retweet?.id) run('UPDATE weibo_favorites SET origin_id = ? WHERE weibo_id = ?', o.retweet.id, r.weibo_id); } catch { /* 略 */ }
}
// 同一条原文的多张卡合成一张：留最早那张，其余收藏行改指它，多出来的卡删掉（标签/存档记录一起）
export function mergeDuplicateCards() {
  let merged = 0;
  const groups = q(`SELECT COALESCE(origin_id, weibo_id) AS k, MIN(item_id) AS keep, COUNT(DISTINCT item_id) AS n FROM weibo_favorites GROUP BY k HAVING n > 1`);
  for (const g of groups) {
    const extra = q('SELECT DISTINCT item_id FROM weibo_favorites WHERE COALESCE(origin_id, weibo_id) = ? AND item_id != ?', g.k, g.keep).map((r) => r.item_id);
    for (const id of extra) {
      run('UPDATE weibo_favorites SET item_id = ? WHERE item_id = ?', g.keep, id);
      run(`DELETE FROM taggings WHERE item_kind = 'link' AND item_id = ?`, id);
      run(`DELETE FROM archives WHERE item_kind = 'link' AND item_id = ?`, id);
      run('DELETE FROM items WHERE id = ?', id);
      merged++;
    }
  }
  return merged;
}
const mergedNow = mergeDuplicateCards();
if (mergedNow) console.log(`[weibo] 合并了 ${mergedNow} 张重复的转发卡`);
// 标题按新规则重算（只改没被人手动改过的：当前标题等于旧规则算出来的那种）
for (const r of q('SELECT f.weibo_id, f.item_id, f.raw_json, s.title FROM weibo_favorites f JOIN items s ON s.id = f.item_id')) {
  try {
    const n = normalizeWeibo(JSON.parse(r.raw_json)); if (!n) continue;
    const t = titleOf(n);
    if (t !== r.title && (r.title === cleanTitle(n.text).slice(0, 120) || /^转发$|^转发微博$/.test(r.title) || r.title.length < 6)) run('UPDATE items SET title = ? WHERE id = ?', t, r.item_id);
  } catch { /* 略 */ }
}
// 失效判断的词库扩了之后，把之前漏标的补上（幂等）
for (const r of q('SELECT weibo_id, item_id, raw_json FROM weibo_favorites WHERE unavailable = 0')) {
  try {
    const n = normalizeWeibo(JSON.parse(r.raw_json));
    if (n?.unavailable) { run('UPDATE weibo_favorites SET unavailable = 1 WHERE weibo_id = ?', r.weibo_id); run('UPDATE items SET title = ? WHERE id = ?', titleOf(n), r.item_id); }
  } catch { /* 略 */ }
}
// 早于「已失效」标签导入的那批补上（幂等）
for (const r of q(`SELECT item_id FROM weibo_favorites WHERE unavailable = 1`)) {
  const tags = tagsOf('link', r.item_id);
  if (!tags.includes(DEAD_TAG)) setTags('link', r.item_id, [...tags, DEAD_TAG]);
}
