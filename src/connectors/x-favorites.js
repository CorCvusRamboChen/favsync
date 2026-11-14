// X（Twitter）的点赞 + 书签 → 收藏库。
//
// 拿数据的方式和抖音一样：油猴脚本在你登着 X 的浏览器里旁听页面自己加载「点赞」「书签」时间线时的 GraphQL 响应
//（Likes / Bookmarks / BookmarkFolderTimeline），把推文原样推过来，脚本自己不调任何接口、不碰签名。
// 另一条路：导入 twitter-web-exporter 这类工具导出的 JSON（本机文件），字段兼容两种形状（GraphQL 原样 / 扁平化）。
//
// 这个模块是服务端那一半：整形（normalizeTweet）、入库去重（同一条推既点赞又收藏 → 一张卡两个标签）、
// 文本存档，图片/视频由服务端自己从 X 的公开 CDN（pbs.twimg.com / video.twimg.com）下到存档目录——不需要登录态，
// 所以不像抖音那样要脚本在浏览器里下。推文被删了这边不删（防删）。
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { launchProfile } from './browser-profiles.js';
import { assertSafeUrl } from '../net-guard.js';
import { db, q, one, run, dataDir } from '../db.js';
import { issueLoginTicket, loginTicketOk, consumeLoginTicket } from '../auth.js';
import { saveItem, setTags, tagsOf } from '../store.js';
import { archiveRoot } from '../archive.js';
import { writeTextArchive, storeMediaFile, hasImage } from './favorites-archive.js';

db.exec(`
CREATE TABLE IF NOT EXISTS x_favorites (
  tweet_id TEXT PRIMARY KEY,
  item_id INTEGER NOT NULL REFERENCES items(id),
  author TEXT,
  author_handle TEXT,
  created_at TEXT,
  text TEXT,
  media_json TEXT,               -- [{type: photo|video|gif, url, thumb, width, height}]
  stats_json TEXT,
  liked INTEGER NOT NULL DEFAULT 0,
  bookmarked INTEGER NOT NULL DEFAULT 0,
  accounts_json TEXT,            -- 哪个 X 账号点赞/收藏的（多账号）
  raw_json TEXT,
  media_status TEXT NOT NULL DEFAULT 'pending',   -- pending / done / failed / none
  media_error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  origin TEXT NOT NULL DEFAULT 'script',          -- script / import
  collected_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
);`);

const MAX_ATTEMPTS = 3;
const MAX_MEDIA = 8;

// —— 登录态：X 没有扫码登录。在有屏幕的电脑上跑 scripts/login-x.mjs（弹真 Chrome 登录），凭一次性口令把 cookie 投到这里，
// 存 data/x-sync.json；服务端同步时把 cookie 塞进无头浏览器的上下文。——
const STATE_FILE = () => process.env.FAVSYNC_X_SYNC || path.join(dataDir(), 'x-sync.json');
export function readState() { try { return JSON.parse(readFileSync(STATE_FILE(), 'utf-8')); } catch { return {}; } }
export function writeState(patch) { const next = { ...readState(), ...patch }; mkdirSync(path.dirname(STATE_FILE()), { recursive: true }); writeFileSync(STATE_FILE(), JSON.stringify(next, null, 2)); return next; }
// 15 分钟一次性口令（auth.js 统一管）
export const issueTicket = () => issueLoginTicket('x');
export const ticketOk = (code) => loginTicketOk('x', code);
export const consumeTicket = () => consumeLoginTicket('x');
// cookies：Playwright 格式的数组 [{name, value, domain, path, expires, httpOnly, secure, sameSite}]；要有 auth_token + ct0 才算登录
export function setCookies(cookies, { handle = null } = {}) {
  const list = (Array.isArray(cookies) ? cookies : []).filter((c) => c && c.name && c.value && /(^|\.)(x|twitter)\.com$/.test(String(c.domain ?? '')));
  const names = new Set(list.map((c) => c.name));
  if (!names.has('auth_token') || !names.has('ct0')) throw new Error('cookie 里没有 auth_token / ct0，不是登录态');
  writeState({ cookies: list.map((c) => ({ name: c.name, value: c.value, domain: c.domain, path: c.path ?? '/', expires: c.expires ?? -1, httpOnly: !!c.httpOnly, secure: c.secure !== false, sameSite: ['Strict', 'Lax', 'None'].includes(c.sameSite) ? c.sameSite : 'Lax' })),
    handle: handle || readState().handle || null, need_login: false, logged_in_at: new Date().toISOString(), error: null });
  return { ok: true, handle: handle || readState().handle || null };
}
export const loggedIn = () => { const s = readState(); return Array.isArray(s.cookies) && s.cookies.length > 0 && !s.need_login; };
export const logout = () => writeState({ cookies: null, need_login: true });

// —— 服务端同步：无头打开 书签页 / 点赞页，像人一样往下滚，旁听 GraphQL 时间线响应（和油猴脚本一样零额外请求）——
const GQL_RE = /\/i\/api\/graphql\/[^/]+\/(Likes|Bookmarks|BookmarkFolderTimeline|BookmarkSearchTimeline)(\?|$)/;
const unwrapT = (r) => (r && r.__typename === 'TweetWithVisibilityResults' ? r.tweet : r);
function* walkEntries(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 12) return;
  if (Array.isArray(node)) { for (const x of node) yield* walkEntries(x, depth + 1); return; }
  if (Array.isArray(node.entries)) for (const e of node.entries) yield e;
  for (const k of Object.keys(node)) if (k !== 'entries') yield* walkEntries(node[k], depth + 1);
}
// 一份时间线响应 → { tweets: [raw…], bottom: 有没有底部游标, empty: 这页一条推都没有 }
export function collectFromTimeline(json) {
  const tweets = []; let bottom = null, count = 0;
  for (const e of walkEntries(json)) {
    const id = String(e?.entryId ?? '');
    if (id.startsWith('cursor-bottom')) bottom = e?.content?.value ?? e?.content?.itemContent?.value ?? '';
    if (!id.startsWith('tweet-')) continue;
    const r = unwrapT(e?.content?.itemContent?.tweet_results?.result);
    if (r?.rest_id || r?.legacy?.id_str) { tweets.push(r); count++; }
  }
  return { tweets, bottom, empty: count === 0 };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (a, b) => a + Math.random() * (b - a);
export async function syncX({ full = false, maxItems = 600, maxMs = 240000, launch = null, kinds = ['bookmark', 'like'], onProgress = null } = {}) {
  const st = readState();
  if (!Array.isArray(st.cookies) || !st.cookies.length || st.need_login) return { need_login: true };
  const ctx = launch ? await launch() : await launchProfile('x', { headless: true });
  const log = (m) => { onProgress?.(m); console.log('[x sync]', m); };
  const out = { account: st.handle ?? null, lists: {}, added: 0, updated: 0, blocked: null };
  try {
    await ctx.addCookies(st.cookies).catch((e) => log('塞 cookie 失败：' + e.message.split('\n')[0]));
    const page = ctx.pages()[0] ?? await ctx.newPage();
    let current = null;   // { kind, seen: Map, lastNewAt, bottom, hits }
    page.on('response', async (res) => {
      const url = res.url();
      // 只有时间线接口本身回 429/403 才算被挡；X 页面里埋点、通知那类 /i/api/ 请求在无头环境下经常 403，不能当信号
      if ((res.status() === 429 || res.status() === 403) && GQL_RE.test(url)) { out.blocked = `HTTP ${res.status()}（${url.match(/graphql\/[^/]+\/(\w+)/)?.[1] ?? 'timeline'}）`; return; }
      if (res.status() === 403 || res.status() === 429) { out.other_errors = (out.other_errors ?? 0) + 1; return; }
      if (!current || !GQL_RE.test(url) || res.status() !== 200) return;
      try {
        const got = collectFromTimeline(await res.json());
        current.hits++;
        for (const t of got.tweets) { const id = String(t.rest_id ?? t.legacy?.id_str); if (!current.seen.has(id)) { current.seen.set(id, t); current.lastNewAt = Date.now(); } }
        if (got.bottom === '' || (got.empty && got.bottom != null)) current.bottom = true;
      } catch { /* 非 JSON */ }
    });
    // 账号：书签页侧栏「个人资料」链接；拿不到就用之前记的
    const detectHandle = async () => page.evaluate(() => { const a = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]'); const h = a?.getAttribute('href')?.replace(/^\//, ''); return h && /^[A-Za-z0-9_]{1,15}$/.test(h) ? h : null; }).catch(() => null);
    const runList = async (kind, url) => {
      current = { kind, seen: new Map(), lastNewAt: Date.now(), bottom: false, hits: 0 };
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(4000 + Math.random() * 1500);
      const loggedOut = await page.evaluate(() => !!document.querySelector('[data-testid="LoginForm_Login_Button"]') || /\/i\/flow\/login|\/login/.test(location.pathname)).catch(() => false);
      if (loggedOut) { writeState({ need_login: true }); return { need_login: true }; }
      if (!out.account) { const h = await detectHandle(); if (h) { out.account = h; writeState({ handle: h }); } }
      const t0 = Date.now();
      let rounds = 0, knownStreak = 0;
      while (Date.now() - t0 < maxMs && current.seen.size < maxItems && !out.blocked) {
        await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight)).catch(() => {});
        rounds++;
        await page.waitForTimeout(1500 + Math.random() * 1500);
        if (rounds % 8 === 0) await page.waitForTimeout(5000 + Math.random() * 5000);
        if (current.bottom) break;
        if (Date.now() - current.lastNewAt > 20000) break;
        // 增量：最近抄到的 40 条全是库里已有的就停
        if (!full && current.seen.size >= 40) {
          const last = [...current.seen.keys()].slice(-40);
          const known = one(`SELECT COUNT(*) AS n FROM x_favorites WHERE tweet_id IN (${last.map(() => '?').join(',')})`, ...last)?.n ?? 0;
          knownStreak = known >= 40 ? knownStreak + 1 : 0;
          if (knownStreak >= 2) break;
        }
      }
      const list = [...current.seen.values()];
      const r = list.length ? ingestFavorites(list, { kind, account: out.account }) : { added: 0, updated: 0 };
      out.added += r.added; out.updated += r.updated;
      log(`${kind === 'like' ? '点赞' : '书签'}：抄到 ${list.length} 条，新 ${r.added}${current.bottom ? '，到底' : ''}${out.blocked ? '，' + out.blocked : ''}`);
      return { collected: list.length, added: r.added, updated: r.updated, pages: current.hits, bottom: current.bottom };
    };
    if (kinds.includes('bookmark')) { out.lists.bookmark = await runList('bookmark', 'https://x.com/i/bookmarks'); if (out.lists.bookmark?.need_login) return { need_login: true }; }
    if (kinds.includes('like') && !out.blocked) {
      if (!out.account) { await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {}); await page.waitForTimeout(3000); const h = await detectHandle(); if (h) { out.account = h; writeState({ handle: h }); } }
      if (out.account) out.lists.like = await runList('like', `https://x.com/${out.account}/likes`);
      else out.lists.like = { error: '认不出当前账号，点赞页需要用户名' };
    }
    writeState({ last_sync: new Date().toISOString(), error: out.blocked ?? null, handle: out.account ?? st.handle ?? null, last_result: { added: out.added, updated: out.updated, lists: out.lists } });
    return out;
  } finally { await ctx.close().catch(() => {}); }
}
export const TAG = 'X收藏';
export const LIKE_TAG = 'X点赞';
export const BOOKMARK_TAG = 'X书签';
export const accountTag = (handle) => `X@${String(handle).replace(/^@/, '').trim().slice(0, 30)}`;
const jarr = (s) => { try { const v = JSON.parse(s ?? '[]'); return Array.isArray(v) ? v : []; } catch { return []; } };

// —— 整形：GraphQL 的 tweet_results.result（含 TweetWithVisibilityResults 壳）或扁平化导出，都变成同一份字段 ——
const unwrap = (r) => (r?.__typename === 'TweetWithVisibilityResults' || (!r?.legacy && r?.tweet) ? r.tweet : r) ?? null;
const parseXTime = (s) => {
  if (!s) return null;
  const t = Date.parse(String(s));
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 19).replace('T', ' ') : null;
};
const bestVideo = (vi) => {
  const vs = (vi?.variants ?? []).filter((v) => /mp4/.test(v.content_type ?? '') && v.url);
  vs.sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0));
  return vs[0]?.url ?? null;
};
// 原图：pbs.twimg.com/media/XXX.jpg → pbs.twimg.com/media/XXX?format=jpg&name=orig
export const origImage = (u) => { const m = String(u ?? '').match(/^(https:\/\/pbs\.twimg\.com\/media\/[^.?]+)\.(\w+)/); return m ? `${m[1]}?format=${m[2]}&name=orig` : (u || null); };
function mediaOf(legacy) {
  const list = legacy?.extended_entities?.media ?? legacy?.entities?.media ?? [];
  return list.slice(0, MAX_MEDIA).map((m) => {
    const type = m.type === 'animated_gif' ? 'gif' : m.type === 'video' ? 'video' : 'photo';
    return { type, url: type === 'photo' ? origImage(m.media_url_https) : bestVideo(m.video_info), thumb: m.media_url_https ?? null,
      width: m.original_info?.width ?? m.sizes?.large?.w ?? null, height: m.original_info?.height ?? m.sizes?.large?.h ?? null, duration: m.video_info?.duration_millis ? Math.round(m.video_info.duration_millis / 1000) : null };
  }).filter((m) => m.url);
}
function textOf(r, legacy) {
  let text = r?.note_tweet?.note_tweet_results?.result?.text ?? legacy?.full_text ?? legacy?.text ?? '';
  // t.co 短链换成真实地址；指向自己媒体的 t.co（display 以 pic.x.com/pic.twitter.com 开头）直接去掉
  for (const u of (r?.note_tweet?.note_tweet_results?.result?.entity_set?.urls ?? legacy?.entities?.urls ?? [])) if (u.url && u.expanded_url) text = text.split(u.url).join(u.expanded_url);
  for (const m of legacy?.entities?.media ?? []) if (m.url) text = text.split(m.url).join('');
  return String(text).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
}
function userOf(r) {
  const u = r?.core?.user_results?.result ?? r?.user ?? null;
  if (!u) return { name: r?.user_name ?? r?.author ?? null, handle: r?.screen_name ?? r?.user_screen_name ?? null };
  return { name: u.legacy?.name ?? u.core?.name ?? u.name ?? null, handle: u.legacy?.screen_name ?? u.core?.screen_name ?? u.screen_name ?? null };
}
export function normalizeTweet(raw) {
  let r = unwrap(raw);
  if (!r) return null;
  // 转推：内容按原推算（url 也指原推），外层只是个壳
  const rt = unwrap(r?.legacy?.retweeted_status_result?.result);
  const retweetedBy = rt ? userOf(r) : null;
  if (rt) r = rt;
  const legacy = r.legacy ?? r;
  const id = String(r.rest_id ?? r.id_str ?? r.id ?? legacy.id_str ?? '').trim();
  if (!/^\d+$/.test(id)) return null;
  const user = userOf(r);
  const quoted = unwrap(r.quoted_status_result?.result);
  const qUser = quoted ? userOf(quoted) : null;
  const media = mediaOf(legacy);
  const flatMedia = Array.isArray(r.media) && !media.length ? r.media.map((m) => ({ type: m.type === 'animated_gif' ? 'gif' : m.type ?? 'photo', url: m.type === 'photo' || !m.type ? origImage(m.url ?? m.media_url_https) : (m.url ?? bestVideo(m.video_info)), thumb: m.thumb ?? m.media_url_https ?? null })).filter((m) => m.url) : [];
  const all = media.length ? media : flatMedia;
  return {
    tweet_id: id, url: `https://x.com/${user.handle ?? 'i'}/status/${id}`,
    author: user.name, author_handle: user.handle, created_at: parseXTime(legacy.created_at ?? r.created_at),
    text: textOf(r, legacy), media: all, cover: all[0]?.thumb ?? (all[0]?.type === 'photo' ? all[0].url : null) ?? null,
    stats: { likes: legacy.favorite_count ?? r.favorite_count ?? null, retweets: legacy.retweet_count ?? null, replies: legacy.reply_count ?? null, bookmarks: legacy.bookmark_count ?? null, views: Number(r.views?.count) || null },
    quoted: quoted ? { id: String(quoted.rest_id ?? ''), author: qUser?.name ?? null, handle: qUser?.handle ?? null, text: textOf(quoted, quoted.legacy ?? quoted) } : null,
    retweeted_by: retweetedBy?.handle ?? null, lang: legacy.lang ?? null,
  };
}
export const titleOf = (n) => (n.text.replace(/\s+/g, ' ').slice(0, 120) || `${n.author ?? n.author_handle ?? 'X'} 的推文`);
export function bodyOf(n, { kinds = [], accounts = [] } = {}) {
  return [n.text, n.quoted ? `引用 @${n.quoted.handle ?? ''}：${n.quoted.text}` : null, n.retweeted_by ? `（@${n.retweeted_by} 转推）` : null,
    `作者：${n.author ?? ''}${n.author_handle ? ' @' + n.author_handle : ''}`, n.created_at ? `发布：${n.created_at}` : null,
    n.media.length ? `媒体：${n.media.map((m) => m.type === 'photo' ? '图' : m.type === 'gif' ? '动图' : '视频').join(' ')}` : null,
    [n.stats.likes != null ? `赞 ${n.stats.likes}` : null, n.stats.retweets != null ? `转 ${n.stats.retweets}` : null, n.stats.bookmarks != null ? `收藏 ${n.stats.bookmarks}` : null].filter(Boolean).join(' · ') || null,
    kinds.length ? `我的：${kinds.map((k) => (k === 'like' ? '点赞' : '书签')).join(' + ')}` : null, accounts.length ? `账号：${accounts.map((a) => '@' + a).join(' ')}` : null].filter(Boolean).join('\n');
}
const addTags = (itemId, names) => { const cur = tagsOf('link', itemId); const next = [...new Set([...cur, ...names])]; if (next.length !== cur.length) setTags('link', itemId, next); };

// —— 入库：kind = like | bookmark；account = 当前 X 账号的 handle ——
export function ingestFavorites(list, { kind = 'bookmark', account = null, origin = 'script' } = {}) {
  const out = { received: Array.isArray(list) ? list.length : 0, added: 0, updated: 0, invalid: 0, item_ids: [] };
  const acc = account ? String(account).replace(/^@/, '').trim().slice(0, 30) : null;
  const kindTag = kind === 'like' ? LIKE_TAG : BOOKMARK_TAG;
  for (const raw of Array.isArray(list) ? list : []) {
    const n = normalizeTweet(raw);
    if (!n) { out.invalid++; continue; }
    const existing = one('SELECT item_id, liked, bookmarked, accounts_json FROM x_favorites WHERE tweet_id = ?', n.tweet_id);
    if (existing) {
      const accounts = jarr(existing.accounts_json); if (acc && !accounts.includes(acc)) accounts.push(acc);
      run(`UPDATE x_favorites SET liked = MAX(liked, ?), bookmarked = MAX(bookmarked, ?), accounts_json = ?, stats_json = ?, last_seen_at = datetime('now'),
             media_json = CASE WHEN media_json IS NULL OR media_json = '[]' THEN ? ELSE media_json END WHERE tweet_id = ?`,
        kind === 'like' ? 1 : 0, kind === 'bookmark' ? 1 : 0, JSON.stringify(accounts), JSON.stringify(n.stats), JSON.stringify(n.media), n.tweet_id);
      addTags(existing.item_id, [kindTag, ...(acc ? [accountTag(acc)] : [])]);
      out.updated++; out.item_ids.push(existing.item_id);
      continue;
    }
    const tags = [TAG, kindTag, ...(acc ? [accountTag(acc)] : [])];
    let itemId = one('SELECT id FROM items WHERE url = ? AND kind = ?', n.url, 'link')?.id ?? null;
    if (!itemId) itemId = one('SELECT id FROM items WHERE url LIKE ? AND kind = ?', `%/status/${n.tweet_id}%`, 'link')?.id ?? null;   // twitter.com 旧域名手动存过的
    if (!itemId) itemId = saveItem({ kind: 'link', url: n.url, title: titleOf(n), body: bodyOf(n, { kinds: [kind], accounts: acc ? [acc] : [] }), source: 'X', type: 'reference', tags }).id;
    else addTags(itemId, tags);
    run('UPDATE items SET image = COALESCE(image, ?), excerpt = COALESCE(excerpt, ?), source = COALESCE(source, ?) WHERE id = ?', n.cover, n.text.slice(0, 300) || null, 'X', itemId);
    run(`INSERT INTO x_favorites (tweet_id, item_id, author, author_handle, created_at, text, media_json, stats_json, liked, bookmarked, accounts_json, raw_json, media_status, origin)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      n.tweet_id, itemId, n.author, n.author_handle, n.created_at, n.text, JSON.stringify(n.media), JSON.stringify(n.stats), kind === 'like' ? 1 : 0, kind === 'bookmark' ? 1 : 0,
      JSON.stringify(acc ? [acc] : []), JSON.stringify(raw).slice(0, 20000), n.media.length ? 'pending' : 'none', origin);
    try {
      writeTextArchive(itemId, { title: titleOf(n), url: n.url, sourceLabel: `X ${kind === 'like' ? '点赞' : '书签'}`, body: bodyOf(n, { kinds: [kind], accounts: acc ? [acc] : [] }),
        meta: { source: 'X', tweet_id: n.tweet_id, url: n.url, author: n.author, author_handle: n.author_handle, created_at: n.created_at, text: n.text, media: n.media, quoted: n.quoted, stats: n.stats, kind, account: acc } });
    } catch (e) { console.warn('[x] 写文本存档失败：', e.message); }
    out.added++; out.item_ids.push(itemId);
  }
  return out;
}

// 导入 twitter-web-exporter 等工具的 JSON 导出（数组，或 {tweets:[…]} / {data:[…]}）；kind 按文件名或参数
export function importExportFile(filePath, { kind = 'bookmark', account = null } = {}) {
  if (!filePath || !existsSync(filePath)) throw new Error('文件不存在：' + filePath);
  const raw = JSON.parse(readFileSync(filePath, 'utf-8'));
  const list = Array.isArray(raw) ? raw : raw?.tweets ?? raw?.data ?? raw?.items ?? [];
  if (!Array.isArray(list)) throw new Error('认不出这个 JSON 的结构（要数组或 {tweets:[…]}）');
  const k = kind || (/like/i.test(filePath) ? 'like' : 'bookmark');
  return { file: filePath, kind: k, ...ingestFavorites(list, { kind: k, account, origin: 'import' }) };
}

// —— 媒体：服务端自己从公开 CDN 下。图存 image-NN（原图），视频 video.mp4（多个视频时第二个起存 live-NN.mp4），动图 live-NN.mp4，第一张当封面 ——
const MEDIA_LIMIT = 200 * 1024 * 1024;
async function fetchBytes(url, fetchImpl) {
  await assertSafeUrl(url);
  const res = await fetchImpl(url, { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://x.com/' }, signal: AbortSignal.timeout(120000), redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MEDIA_LIMIT) throw new Error('文件超过 200MB');
  return buf;
}
export function markMediaFailed(tweetId, error) {
  run(`UPDATE x_favorites SET attempts = attempts + 1, media_error = ?, media_status = CASE WHEN attempts + 1 >= ? AND media_status = 'pending' THEN 'failed' ELSE media_status END WHERE tweet_id = ?`,
    String(error ?? '').slice(0, 300), MAX_ATTEMPTS, String(tweetId));
  const r = one('SELECT attempts, media_status FROM x_favorites WHERE tweet_id = ?', String(tweetId));
  return { attempts: r?.attempts ?? 0, media_status: r?.media_status ?? null };
}
export async function fetchPendingMedia({ limit = 20, fetchImpl = globalThis.fetch, video = true, pauseMs = 300 } = {}) {
  const rows = q(`SELECT * FROM x_favorites WHERE media_status = 'pending' AND attempts < ? ORDER BY collected_at DESC, rowid DESC LIMIT ?`, MAX_ATTEMPTS, Number(limit) || 20);
  const out = { tried: rows.length, done: 0, failed: 0, files: 0 };
  for (const fav of rows) {
    const media = jarr(fav.media_json);
    let formats = {};
    try { formats = JSON.parse(one(`SELECT formats FROM archives WHERE item_kind = 'link' AND item_id = ?`, fav.item_id)?.formats ?? '{}'); } catch { /* 略 */ }
    const has = (name) => Object.keys(formats).some((f) => f === name || f.startsWith(name));
    const jobs = [];
    let imgIdx = 0, vidIdx = 0;
    media.forEach((m) => {
      if (m.type === 'photo') { if (!hasImage(formats, imgIdx)) jobs.push({ kind: 'image', url: m.url, index: imgIdx }); imgIdx++; }
      else if (m.type === 'video') { if (!video) return; if (vidIdx === 0 ? !has('video.mp4') : !has(`live-${String(vidIdx + 1).padStart(2, '0')}`)) jobs.push({ kind: vidIdx === 0 ? 'video' : 'live', url: m.url, index: vidIdx }); vidIdx++; }
      else { if (!has(`live-${String(vidIdx + 1).padStart(2, '0')}`)) jobs.push({ kind: 'live', url: m.url, index: vidIdx }); vidIdx++; }
    });
    const thumb = media[0]?.thumb ?? null;
    if (thumb && !has('cover.')) jobs.unshift({ kind: 'cover', url: origImage(thumb), index: 0 });
    let failed = null;
    for (const j of jobs) {
      try {
        const r = storeMediaFile(fav.item_id, { kind: j.kind, index: j.index, bytes: await fetchBytes(j.url, fetchImpl) });
        if (!r.ok) throw new Error(r.reason);
        out.files++;
      } catch (e) { failed = `${j.kind}#${j.index + 1}: ${e.message}`; break; }
      if (pauseMs) await new Promise((ok) => setTimeout(ok, pauseMs + Math.random() * pauseMs));
    }
    if (failed) { markMediaFailed(fav.tweet_id, failed); out.failed++; }
    else { run(`UPDATE x_favorites SET media_status = 'done', media_error = NULL WHERE tweet_id = ?`, fav.tweet_id); out.done++; }
  }
  return out;
}
export function favoritesStatus() {
  const c = one(`SELECT COUNT(*) AS total, SUM(liked) AS liked, SUM(bookmarked) AS bookmarked, SUM(media_status = 'done') AS media_done, SUM(media_status = 'pending') AS media_pending,
                        SUM(media_status = 'failed') AS media_failed, SUM(media_status = 'none') AS media_none, SUM(origin = 'import') AS imported, MAX(collected_at) AS last_collected_at FROM x_favorites`);
  const accounts = {};
  for (const r of q('SELECT accounts_json FROM x_favorites')) for (const a of jarr(r.accounts_json)) accounts[a] = (accounts[a] ?? 0) + 1;
  const s = readState();
  return { logged_in: loggedIn(), need_login: !!s.need_login, handle: s.handle ?? null, last_sync: s.last_sync ?? null, logged_in_at: s.logged_in_at ?? null, sync_error: s.error ?? null, last_result: s.last_result ?? null,
    total: c?.total ?? 0, liked: c?.liked ?? 0, bookmarked: c?.bookmarked ?? 0, media_done: c?.media_done ?? 0, media_pending: c?.media_pending ?? 0, media_failed: c?.media_failed ?? 0, media_none: c?.media_none ?? 0,
    imported: c?.imported ?? 0, last_collected_at: c?.last_collected_at ?? null, accounts: Object.entries(accounts).map(([name, n]) => ({ name, n })), archive_root: archiveRoot(), archive_exists: existsSync(archiveRoot()) };
}
