// 抖音收藏 → 收藏库。
//
// 为什么走油猴脚本而不是服务端爬：抖音网页版的收藏列表接口要带它自己算的签名（a_bogus / msToken），
// 自己拼请求很快就会被挡，也最容易招来风控；而你平时登着抖音的浏览器里，页面自己在正常翻收藏时
// 就会把列表一页页请求回来。脚本只做三件事：旁听页面自己发出的收藏列表响应、把条目推给 FavSync、
// 再把封面和视频文件用登录态慢慢下下来传过来——不发任何额外的列表请求，节奏比人翻还慢。
//
// 只收「收藏」：listcollection（我的收藏）和 collects/video/list（某个收藏夹里的）。喜欢、历史都不碰。
// 收藏夹名、是哪个账号收藏的，都跟着条目记下来、打成标签；同一条视频被几个账号/几个夹子收藏，一张卡。
//
// 这个模块是服务端那一半：收条目（去重、入库、打标签）、记哪些还没拿到媒体文件、把文件写进存档目录
//（封面 cover.jpg、动态封面 cover-anim.webp、视频 video.mp4、图文的 image-NN（原图，动图原样）、实况 live-NN.mp4，
// 外加 readable.md + metadata.json；落盘逻辑和微博共用 favorites-archive.js）。站点哪天打不开了，这些文件还在。
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { assertSafeUrl } from '../net-guard.js';
import { db, q, one, run, dataDir } from '../db.js';
import { saveItem, setTags, tagsOf } from '../store.js';
import { archiveRoot } from '../archive.js';
import { writeTextArchive, storeMediaFile, hasImage, archiveDirOf, upsertArchive, archiveUrl } from './favorites-archive.js';
import { posterFromVideo } from '../thumbs.js';
import { launchProfile, DEFAULT_PROFILE } from './browser-profiles.js';


db.exec(`
CREATE TABLE IF NOT EXISTS douyin_favorites (
  aweme_id TEXT PRIMARY KEY,
  item_id INTEGER NOT NULL REFERENCES items(id),
  author TEXT,
  author_uid TEXT,
  create_time TEXT,
  cover_url TEXT,
  play_url TEXT,
  images_json TEXT,              -- 图文帖的图片地址列表（静态）
  duration INTEGER,              -- 秒
  stats_json TEXT,
  raw_json TEXT,
  media_status TEXT NOT NULL DEFAULT 'pending',   -- pending / done / failed
  media_error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  collected_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);
for (const col of ['account_uid TEXT', 'account_name TEXT', 'accounts_json TEXT', 'folders_json TEXT', 'dynamic_cover_url TEXT', 'variants_json TEXT', "kind TEXT NOT NULL DEFAULT 'video'", 'music_json TEXT', 'music_url TEXT', 'last_seen_at TEXT', 'cover_fixed INTEGER NOT NULL DEFAULT 0']) {
  try { db.exec(`ALTER TABLE douyin_favorites ADD COLUMN ${col}`); } catch { /* 已存在 */ }
}

const MAX_ATTEMPTS = 3;
export const TAG = '抖音收藏';
export const accountTag = (name) => `抖音@${String(name).trim().slice(0, 30)}`;
export const folderTag = (name) => `抖音夹·${String(name).trim().slice(0, 30)}`;
export const MUSIC_TAG = '抖音音乐';

// —— 多账号：每个抖音账号一个浏览器 profile，登录态互不覆盖。注册表 data/douyin-accounts.json ——
// 老安装没有这个文件：默认 profile 里登着的那个号就是 main，名字取库里出现最多的昵称。
const ACCOUNTS_FILE = () => process.env.FAVSYNC_DOUYIN_ACCOUNTS || path.join(dataDir(), 'douyin-accounts.json');
export function listAccounts() {
  let list = [];
  try { const v = JSON.parse(readFileSync(ACCOUNTS_FILE(), 'utf-8')).accounts; if (Array.isArray(v)) list = v; } catch { list = []; }
  if (!list.length) {
    const nick = one('SELECT account_name AS n, COUNT(*) AS c FROM douyin_favorites WHERE account_name IS NOT NULL GROUP BY n ORDER BY c DESC LIMIT 1')?.n ?? null;
    list = [{ id: 'main', profile: DEFAULT_PROFILE, nickname: nick, added_at: null }];
  }
  return list;
}
const saveAccounts = (list) => { mkdirSync(path.dirname(ACCOUNTS_FILE()), { recursive: true }); writeFileSync(ACCOUNTS_FILE(), JSON.stringify({ accounts: list }, null, 2)); return list; };
const cleanId = (id) => String(id ?? '').trim().replace(/[^\w.-]+/g, '_').slice(0, 40);
export function upsertAccount({ id, nickname, uid, profile, ...rest }) {
  id = cleanId(id); if (!id) throw new Error('账号 id 不能空');
  const list = listAccounts();
  const cur = list.find((a) => a.id === id);
  const next = { ...(cur ?? { id, profile: profile ?? (id === 'main' ? DEFAULT_PROFILE : id), added_at: new Date().toISOString() }), ...rest };
  if (nickname) next.nickname = String(nickname).trim().slice(0, 40);
  if (uid) next.uid = String(uid);
  if (profile) next.profile = profile;
  if (cur) Object.assign(cur, next); else list.push(next);
  saveAccounts(list);
  return next;
}
export function removeAccount(id) { return saveAccounts(listAccounts().filter((a) => a.id !== cleanId(id))); }
export const newAccountId = () => { const ids = new Set(listAccounts().map((a) => a.id)); for (let i = 2; i < 100; i++) if (!ids.has(`dy${i}`)) return `dy${i}`; return `dy${Date.now()}`; };
export const profileOf = (accountId) => { if (!accountId) return DEFAULT_PROFILE; const a = listAccounts().find((x) => x.id === cleanId(accountId)); return a?.profile ?? (cleanId(accountId) === 'main' ? DEFAULT_PROFILE : cleanId(accountId)); };
const accountNick = (accountId) => (accountId ? listAccounts().find((x) => x.id === cleanId(accountId))?.nickname ?? null : null);
// 第一个账号（老 profile）也负责库里早期没记账号名的那些条
const isPrimary = (accountId) => !accountId || listAccounts()[0]?.id === cleanId(accountId);
// 认抖音链接 / 从链接里取 aweme_id（手动存过的同一条视频要能和同步进来的合成一张卡）
export function isDouyinUrl(url) { try { const h = new URL(url).hostname; return /(^|\.)(douyin|iesdouyin)\.com$/.test(h); } catch { return false; } }
export function parseAwemeId(url) { const m = String(url ?? '').match(/\/video\/(\d{6,})|[?&]modal_id=(\d{6,})/); return m ? (m[1] ?? m[2]) : null; }
const musicUrl = (id) => `https://www.douyin.com/music/${id}`;
const videoUrl = (id) => `https://www.douyin.com/video/${id}`;
const firstUrl = (x) => (Array.isArray(x?.url_list) && x.url_list.find((u) => typeof u === 'string' && u.startsWith('http'))) || null;
const jarr = (s) => { try { const v = JSON.parse(s ?? '[]'); return Array.isArray(v) ? v : []; } catch { return []; } };

// 页面响应里的一条 aweme → 我们关心的字段。纯函数，fixture 可测；字段不在就留空，不抛。
// 图文帖每张图记三种地址：static（页面显示用）、original（download_url_list，原图——动图就是动图）、live（实况/动图的短片）。
export function normalizeAweme(a) {
  const id = String(a?.aweme_id ?? a?.awemeId ?? '').trim();
  if (!/^\d{6,}$/.test(id)) return null;
  const v = a.video ?? {};
  const imgList = Array.isArray(a.images) ? a.images : Array.isArray(a.image_list) ? a.image_list : Array.isArray(a.image_post_info?.images) ? a.image_post_info.images : [];
  const isImagePost = a.aweme_type === 68 || a.media_type === 42 || a.is_slides === true || imgList.length > 0;
  const playCandidates = [v.play_addr, v.play_addr_h264, v.play_addr_265, ...(Array.isArray(v.bit_rate) ? v.bit_rate.map((b) => b?.play_addr) : [])];
  const topPlay = playCandidates.map(firstUrl).find(Boolean) ?? null;
  const looksAudio = (u) => /ies-music|\.mp3(\?|$)|\/obj\/ies-music/i.test(String(u ?? ''));
  // 图文帖的 video.play_addr 是配乐；真·视频帖才是视频
  const play_url = isImagePost || looksAudio(topPlay) ? null : topPlay;
  const music_url = (isImagePost && topPlay) ? topPlay : (looksAudio(topPlay) ? topPlay : (firstUrl(a.music?.play_url) ?? null));
  const pickStatic = (img) => (img?.url_list ?? []).find((u) => /\.jpe?g(\?|$)/i.test(u)) ?? firstUrl(img);
  const variants = imgList.map((img) => ({
    static: pickStatic(img),
    original: firstUrl({ url_list: img?.download_url_list }) ?? firstUrl(img?.origin) ?? null,
    live: firstUrl(img?.video?.play_addr) ?? firstUrl(img?.video?.play_addr_h264) ?? firstUrl(img?.video?.download_addr) ?? null,
  })).filter((x) => x.static || x.original);
  const images = variants.map((x) => x.static ?? x.original);
  const st = a.statistics ?? {};
  const createdSec = Number(a.create_time);
  return {
    aweme_id: id,
    url: videoUrl(id),
    desc: String(a.desc ?? '').trim(),
    author: String(a.author?.nickname ?? '').trim(),
    author_uid: a.author?.uid != null ? String(a.author.uid) : null,
    create_time: Number.isFinite(createdSec) && createdSec > 0 ? new Date(createdSec * 1000).toISOString() : null,
    // origin_cover 是完整画幅（竖屏 360x640 / 横屏 640x360，~tplv-dy-360p）；cover 是 323:430 居中裁过的，竖屏视频上下都被切掉
    cover: firstUrl(v.origin_cover) ?? firstUrl(v.cover) ?? images[0] ?? null,
    dynamic_cover: firstUrl(v.dynamic_cover) ?? firstUrl(v.animated_cover) ?? null,
    play_url, music_url,
    images,
    variants,
    is_image_post: isImagePost && !play_url,
    has_live: variants.some((x) => x.live),
    duration: Number.isFinite(Number(v.duration)) ? Math.round(Number(v.duration) / 1000) : null,
    stats: { digg: Number(st.digg_count) || 0, comment: Number(st.comment_count) || 0, collect: Number(st.collect_count) || 0, share: Number(st.share_count) || 0 },
  };
}

// 收藏的音乐（收藏页「音乐」tab，接口 music/listcollection 的 mc_list）→ 我们关心的字段。字段名按网页版/移动端常见形状兼容。
export function normalizeMusic(m) {
  const id = String(m?.id_str ?? m?.mid ?? m?.id ?? '').trim();
  if (!/^\d{4,}$/.test(id)) return null;
  const dur = Number(m.duration);
  return {
    music_id: id, url: musicUrl(id),
    title: String(m.title ?? m.music_name ?? '').trim() || '（无题）',
    author: String(m.author ?? m.owner_nickname ?? m.author_name ?? '').trim(),
    album: String(m.album ?? '').trim() || null,
    duration: Number.isFinite(dur) && dur > 0 ? Math.round(dur > 10000 ? dur / 1000 : dur) : null,   // 有的接口给毫秒
    play_url: firstUrl(m.play_url) ?? firstUrl(m.play_url_h264) ?? null,
    cover: firstUrl(m.cover_hd) ?? firstUrl(m.cover_large) ?? firstUrl(m.cover_medium) ?? firstUrl(m.cover_thumb) ?? null,
    is_original: !!m.is_original, user_count: Number(m.user_count) || 0,
  };
}
const musicTitle = (n) => `🎵 ${n.title}${n.author ? ' · ' + n.author : ''}`.slice(0, 120);
const musicBody = (n, acc) => [`${n.author ? '作者：' + n.author : ''}${n.album ? '　专辑：' + n.album : ''}`.trim() || null,
  n.duration != null ? `时长 ${fmtDur(n.duration)}` : null, n.is_original ? '原声' : null, n.user_count ? `${n.user_count} 人用过` : null,
  acc?.nickname ? `收藏账号：${acc.nickname}` : null].filter(Boolean).join('\n');
// 收藏的音乐入库：和视频同一张表（aweme_id = music_<id>，kind = music），卡片来源「抖音」、标签「抖音收藏」「抖音音乐」「抖音@昵称」
export function ingestMusic(list, { account = null } = {}) {
  const acc = cleanAccount(account);
  const out = { received: Array.isArray(list) ? list.length : 0, added: 0, updated: 0, invalid: 0, item_ids: [] };
  for (const raw of Array.isArray(list) ? list : []) {
    const n = normalizeMusic(raw);
    if (!n) { out.invalid++; continue; }
    const key = `music_${n.music_id}`;
    const existing = one('SELECT item_id, accounts_json FROM douyin_favorites WHERE aweme_id = ?', key);
    if (existing) {
      const accounts = jarr(existing.accounts_json);
      if (acc?.nickname && !accounts.includes(acc.nickname)) accounts.push(acc.nickname);
      run('UPDATE douyin_favorites SET play_url = COALESCE(?, play_url), cover_url = COALESCE(?, cover_url), music_json = ?, accounts_json = ? WHERE aweme_id = ?',
        n.play_url, n.cover, JSON.stringify(raw).slice(0, 20000), JSON.stringify(accounts), key);
      if (acc?.nickname) addTags(existing.item_id, [accountTag(acc.nickname)]);
      out.updated++; out.item_ids.push(existing.item_id);
      continue;
    }
    const tags = [TAG, MUSIC_TAG, ...(acc?.nickname ? [accountTag(acc.nickname)] : [])];
    let itemId = one('SELECT id FROM items WHERE url = ? AND kind = ?', n.url, 'link')?.id ?? null;
    if (!itemId) itemId = saveItem({ kind: 'link', url: n.url, title: musicTitle(n), body: musicBody(n, acc), source: '抖音', type: 'reference', tags }).id;
    else addTags(itemId, tags);
    run('UPDATE items SET image = COALESCE(image, ?), excerpt = COALESCE(excerpt, ?), source = COALESCE(source, ?) WHERE id = ?', n.cover, musicBody(n, acc).slice(0, 300) || null, '抖音', itemId);
    run(`INSERT INTO douyin_favorites (aweme_id, item_id, author, cover_url, play_url, images_json, variants_json, duration, stats_json, raw_json, account_uid, account_name, accounts_json, folders_json, kind, music_json)
         VALUES (?,?,?,?,?,'[]','[]',?,'{}',?,?,?,?,'[]','music',?)`,
      key, itemId, n.author, n.cover, n.play_url, n.duration, JSON.stringify(raw).slice(0, 20000), acc?.uid ?? null, acc?.nickname ?? null, JSON.stringify(acc?.nickname ? [acc.nickname] : []), JSON.stringify(raw).slice(0, 20000));
    try {
      writeTextArchive(itemId, { title: musicTitle(n), url: n.url, sourceLabel: '抖音收藏 · 音乐', body: musicBody(n, acc),
        meta: { source: '抖音', kind: 'music', music_id: n.music_id, url: n.url, title: n.title, author: n.author, album: n.album, duration: n.duration, play_url: n.play_url, cover_url: n.cover, account: acc } });
    } catch (e) { console.warn('[douyin] 写音乐文本存档失败：', e.message); }
    out.added++; out.item_ids.push(itemId);
  }
  return out;
}

const fmtDur = (s) => s == null ? '' : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
function bodyOf(n, { account = null, folders = [] } = {}) {
  return [n.author ? `作者：${n.author}` : null, n.desc || null,
    n.duration != null ? `时长 ${fmtDur(n.duration)}` : (n.is_image_post ? `图文 · ${n.images.length} 张${n.has_live ? '（含实况/动图）' : ''}` : null),
    `👍 ${n.stats.digg} · 💬 ${n.stats.comment} · ⭐ ${n.stats.collect}`,
    n.create_time ? `发布于 ${n.create_time.slice(0, 10)}` : null,
    account?.nickname ? `收藏账号：${account.nickname}` : null,
    folders.length ? `收藏夹：${folders.join('、')}` : null].filter(Boolean).join('\n');
}
const titleOf = (n) => (n.desc.replace(/\s+/g, ' ').slice(0, 120)) || (n.author ? `${n.author} 的抖音${n.is_image_post ? '图文' : '视频'}` : '抖音视频');
const cleanAccount = (acc) => {
  if (!acc || typeof acc !== 'object') return null;
  const uid = acc.uid != null ? String(acc.uid).trim().slice(0, 40) : null, nickname = String(acc.nickname ?? '').trim().slice(0, 40);
  return uid || nickname ? { uid, nickname } : null;
};
const addTags = (itemId, names) => {
  const cur = tagsOf('link', itemId);
  const next = [...new Set([...cur, ...names.filter(Boolean)])];
  if (next.length !== cur.length) setTags('link', itemId, next);
};

// 脚本推来的一批条目：新的入库 + 打标签 + 写文本存档；已有的刷新封面/播放地址（会过期）、并上新的账号/收藏夹。
// account = {uid, nickname}（这批是哪个抖音账号的收藏）；folders = { aweme_id: [收藏夹名…] }。
export function ingestFavorites(list, { account = null, folders = {} } = {}) {
  const acc = cleanAccount(account);
  const out = { received: Array.isArray(list) ? list.length : 0, added: 0, updated: 0, invalid: 0, item_ids: [], account: acc?.nickname ?? null };
  for (const raw of Array.isArray(list) ? list : []) {
    const n = normalizeAweme(raw);
    if (!n) { out.invalid++; continue; }
    const myFolders = [...new Set((Array.isArray(folders?.[n.aweme_id]) ? folders[n.aweme_id] : []).map((f) => String(f).trim()).filter(Boolean))];
    const existing = one('SELECT item_id, accounts_json, folders_json, account_uid FROM douyin_favorites WHERE aweme_id = ?', n.aweme_id);
    if (existing) {
      const accounts = jarr(existing.accounts_json);
      if (acc?.nickname && !accounts.includes(acc.nickname)) accounts.push(acc.nickname);
      const fold = [...new Set([...jarr(existing.folders_json), ...myFolders])];
      run(`UPDATE douyin_favorites SET cover_url = COALESCE(?, cover_url), dynamic_cover_url = COALESCE(?, dynamic_cover_url), play_url = ?, music_url = COALESCE(?, music_url),
             images_json = ?, variants_json = ?, stats_json = ?, raw_json = ?, accounts_json = ?, folders_json = ?,
             account_uid = COALESCE(account_uid, ?), account_name = COALESCE(account_name, ?), last_seen_at = datetime('now') WHERE aweme_id = ?`,
        n.cover, n.dynamic_cover, n.play_url, n.music_url, JSON.stringify(n.images), JSON.stringify(n.variants), JSON.stringify(n.stats), JSON.stringify(raw).slice(0, 20000),
        JSON.stringify(accounts), JSON.stringify(fold), acc?.uid ?? null, acc?.nickname ?? null, n.aweme_id);
      addTags(existing.item_id, [...(acc?.nickname ? [accountTag(acc.nickname)] : []), ...myFolders.map(folderTag)]);
      out.updated++; out.item_ids.push(existing.item_id);
      continue;
    }
    // 以前可能手动存过同一条链接，复用那条，别出现两张卡
    const tags = [TAG, ...(acc?.nickname ? [accountTag(acc.nickname)] : []), ...myFolders.map(folderTag)];
    let itemId = one('SELECT id FROM items WHERE url = ? AND kind = ?', n.url, 'link')?.id ?? null;
    if (!itemId) itemId = saveItem({ kind: 'link', url: n.url, title: titleOf(n), body: bodyOf(n, { account: acc, folders: myFolders }), source: '抖音', type: 'reference', tags }).id;
    else addTags(itemId, tags);
    run('UPDATE items SET image = COALESCE(image, ?), excerpt = COALESCE(excerpt, ?), source = COALESCE(source, ?) WHERE id = ?', n.cover, n.desc.slice(0, 300) || null, '抖音', itemId);
    run(`INSERT INTO douyin_favorites (aweme_id, item_id, author, author_uid, create_time, cover_url, dynamic_cover_url, play_url, music_url, images_json, variants_json, duration, stats_json, raw_json,
           account_uid, account_name, accounts_json, folders_json, last_seen_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, datetime('now'))`,
      n.aweme_id, itemId, n.author, n.author_uid, n.create_time, n.cover, n.dynamic_cover, n.play_url, n.music_url, JSON.stringify(n.images), JSON.stringify(n.variants), n.duration,
      JSON.stringify(n.stats), JSON.stringify(raw).slice(0, 20000), acc?.uid ?? null, acc?.nickname ?? null, JSON.stringify(acc?.nickname ? [acc.nickname] : []), JSON.stringify(myFolders));
    try {
      writeTextArchive(itemId, { title: titleOf(n), url: n.url, sourceLabel: '抖音收藏', body: bodyOf(n, { account: acc, folders: myFolders }),
        meta: { source: '抖音', aweme_id: n.aweme_id, url: n.url, title: titleOf(n), desc: n.desc, author: n.author, author_uid: n.author_uid,
          create_time: n.create_time, duration: n.duration, stats: n.stats, cover_url: n.cover, dynamic_cover_url: n.dynamic_cover, play_url: n.play_url,
          images: n.images, image_variants: n.variants, account: acc, folders: myFolders } });
    } catch (e) { console.warn('[douyin] 写文本存档失败：', e.message); }
    out.added++; out.item_ids.push(itemId);
  }
  return out;
}

// 还没拿到媒体文件的：脚本会在浏览器里用登录态下载，再传回来。每条带全部地址，脚本按顺序试。
export function pendingMedia(limit = 8, { accountName = null, includeUnassigned = true } = {}) {
  // 按账号筛：这条是哪个号收藏的，就用哪个号的登录态去下（accounts_json 里有的也算）；没记账号名的老条目归第一个账号
  const acctWhere = accountName ? `AND (account_name = ? OR accounts_json LIKE ?${includeUnassigned ? ' OR account_name IS NULL' : ''})` : '';
  const acctParams = accountName ? [accountName, `%${JSON.stringify(String(accountName)).slice(1, -1)}%`] : [];
  return q(`SELECT aweme_id, item_id, kind, cover_url, dynamic_cover_url, play_url, music_url, images_json, variants_json, attempts FROM douyin_favorites
            WHERE media_status = 'pending' AND attempts < ? ${acctWhere} ORDER BY collected_at DESC, rowid DESC LIMIT ?`, MAX_ATTEMPTS, ...acctParams, Number(limit) || 8)
    .map((r) => {
      const variants = jarr(r.variants_json);
      const images = jarr(r.images_json);
      return { aweme_id: r.aweme_id, item_id: r.item_id, kind: r.kind ?? 'video', cover_url: r.cover_url, dynamic_cover_url: r.dynamic_cover_url, play_url: r.play_url, music_url: r.music_url, images,
        variants: variants.length ? variants : images.map((u) => ({ static: u, original: null, live: null })), attempts: r.attempts };
    });
}

// kind：video / cover / anim（动态封面）/ image（第 index 张，原图）/ live（第 index 张的实况短片）
export function storeMedia(awemeId, { kind, index = 0, bytes }) {
  const fav = one('SELECT * FROM douyin_favorites WHERE aweme_id = ?', String(awemeId));
  if (!fav) throw new Error('这条不在抖音收藏里');
  const r = storeMediaFile(fav.item_id, { kind, index, bytes });
  if (!r.ok) return { ok: false, suspicious: true, ...markMediaFailed(awemeId, r.reason) };
  // 什么时候算"媒体齐了"：视频帖拿到 video.mp4；图文帖拿齐所有图。动态封面、实况短片是加分项，不卡 done
  const images = jarr(fav.images_json);
  const complete = fav.kind === 'music' ? Object.keys(r.formats).some((f) => f.startsWith('audio.'))
    : fav.play_url ? !!r.formats['video.mp4'] : images.length ? images.every((_, i) => hasImage(r.formats, i)) : true;
  if (complete) run(`UPDATE douyin_favorites SET media_status = 'done', media_error = NULL WHERE aweme_id = ?`, fav.aweme_id);
  // 视频到手了而封面是裁过的那种：用视频帧重做一张完整画幅的（异步，不挡）
  if (kind === 'video' && isCroppedCover(fav.cover_url) && !fav.cover_fixed) coverFromVideo(fav.aweme_id).catch(() => {});
  return { ok: true, file: r.file, dir: r.dir, complete, animated: !!r.animated };
}
export const isCroppedCover = (u) => /cropcenter/.test(String(u ?? ''));
// 用本地 video.mp4 挑一帧写成 cover.jpg（覆盖裁过的），卡片封面随之换；缩略图缓存按 mtime 自动失效
export async function coverFromVideo(awemeId) {
  const fav = one('SELECT item_id FROM douyin_favorites WHERE aweme_id = ?', String(awemeId));
  if (!fav) return false;
  const rel = archiveDirOf(fav.item_id); if (!rel) return false;
  const abs = path.join(archiveRoot(), rel);
  const video = path.join(abs, 'video.mp4'); if (!existsSync(video)) return false;
  const out = path.join(abs, 'cover.jpg');
  if (!(await posterFromVideo(video, out))) return false;
  upsertArchive(fav.item_id, rel, { 'cover.jpg': statSync(out).size });
  run('UPDATE items SET image = ? WHERE id = ?', archiveUrl(rel, 'cover.jpg'), fav.item_id);
  run('UPDATE douyin_favorites SET cover_fixed = 1 WHERE aweme_id = ?', String(awemeId));
  return true;
}
// 一次性：把已经下好视频、封面却是裁过的那批补成完整画幅
export async function fixCroppedCovers({ limit = 100 } = {}) {
  const rows = q(`SELECT f.aweme_id FROM douyin_favorites f JOIN archives a ON a.item_kind = 'link' AND a.item_id = f.item_id
                  WHERE f.cover_fixed = 0 AND f.cover_url LIKE '%cropcenter%' AND a.formats LIKE '%"video.mp4"%' ORDER BY f.collected_at DESC LIMIT ?`, Number(limit) || 100);
  const out = { tried: rows.length, fixed: 0, failed: 0 };
  for (const r of rows) { if (await coverFromVideo(r.aweme_id)) out.fixed++; else { out.failed++; run('UPDATE douyin_favorites SET cover_fixed = -1 WHERE aweme_id = ?', r.aweme_id); } }
  out.remaining = one(`SELECT COUNT(*) AS n FROM douyin_favorites f JOIN archives a ON a.item_kind = 'link' AND a.item_id = f.item_id WHERE f.cover_fixed = 0 AND f.cover_url LIKE '%cropcenter%' AND a.formats LIKE '%"video.mp4"%'`)?.n ?? 0;
  return out;
}
export function markMediaFailed(awemeId, error) {
  run(`UPDATE douyin_favorites SET attempts = attempts + 1, media_error = ?,
         media_status = CASE WHEN attempts + 1 >= ? THEN 'failed' ELSE media_status END WHERE aweme_id = ?`, String(error ?? '').slice(0, 300), MAX_ATTEMPTS, String(awemeId));
  const r = one('SELECT attempts, media_status FROM douyin_favorites WHERE aweme_id = ?', String(awemeId));
  return { attempts: r?.attempts ?? 0, media_status: r?.media_status ?? null };
}

// 封面：douyinpic 带 Referer 就能从服务端直接下（视频不行，要登录态，留给脚本）。节奏放慢：一条一条，中间歇一下。
export async function fetchPendingCovers({ limit = 40, fetchImpl = globalThis.fetch, pauseMs = 400 } = {}) {
  const rows = q(`SELECT f.aweme_id, f.item_id, f.cover_url FROM douyin_favorites f
                  WHERE f.cover_url IS NOT NULL AND f.attempts < ? AND NOT EXISTS (
                    SELECT 1 FROM archives a WHERE a.item_kind = 'link' AND a.item_id = f.item_id AND a.formats LIKE '%"cover.%')
                  ORDER BY f.collected_at DESC LIMIT ?`, MAX_ATTEMPTS, Number(limit) || 40);
  const out = { tried: rows.length, done: 0, failed: 0 };
  for (const r of rows) {
    try {
      await assertSafeUrl(r.cover_url);
      const res = await fetchImpl(r.cover_url, { headers: { Referer: 'https://www.douyin.com/', 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      const s = storeMediaFile(r.item_id, { kind: 'cover', bytes: buf });
      if (!s.ok) throw new Error(s.reason);
      out.done++;
    } catch (e) { markMediaFailed(r.aweme_id, `cover: ${e.message}`); out.failed++; }
    if (pauseMs) await new Promise((ok) => setTimeout(ok, pauseMs + Math.random() * pauseMs));
  }
  return out;
}

// —— 服务端定时同步（默认关）：无头打开已登录 profile 里的收藏页，旁听列表响应 + 自动滚 ——
// 和油猴脚本做的事一样，只是不需要你开着浏览器。但无头浏览器是抖音风控最爱抓的，所以默认不自动跑，
// 只有你在设置里明确打开才会进定时任务；跑的时候节奏和脚本一样慢，碰到验证码/限流立刻停。
// profile 由账号决定（profileOf）：同一个目录同时只开一个实例，撞上了排队等，不再报"没有 Chrome"
const launchShared = (headless = true, profile = DEFAULT_PROFILE) => launchProfile(profile, { headless });
const LIST_RE = /\/aweme\/v1\/web\/aweme\/listcollection\/|\/aweme\/v1\/web\/collects\/video\/list\//;
const MUSIC_RE = /\/aweme\/v1\/web\/music\/(listcollection|collection|collect)/;
const PROFILE_RE = /\/aweme\/v1\/web\/user\/profile\/self\//;
export async function syncFavorites({ full = false, maxMs = 150000, maxItems = 300, headless = true, launch = launchShared, withMusic = true, account = null } = {}) {
  const ctx = await launch(headless, profileOf(account));
  try {
    const page = ctx.pages()[0] ?? await ctx.newPage();
    const seen = new Map(), music = new Map();
    let hasMore = true, lastNewAt = Date.now(), hits = 0, blocked = null, account = null;
    page.on('response', async (res) => {
      const url = res.url();
      if (res.status() === 403 || res.status() === 429) { if (/\/aweme\/v1\/web\//.test(url)) blocked = `HTTP ${res.status()}`; return; }
      if (PROFILE_RE.test(url)) { try { const d = await res.json(); const u = d?.user ?? d?.data?.user; if (u?.nickname || u?.uid) account = { uid: u.uid != null ? String(u.uid) : (account?.uid ?? null), nickname: String(u.nickname ?? account?.nickname ?? '') }; } catch { /* 略 */ } return; }
      if (MUSIC_RE.test(url)) { try { const d = await res.json(); const list = d?.mc_list ?? d?.music_list; if (Array.isArray(list)) { hits++; if (d.has_more === 0 || d.has_more === false) hasMore = false; for (const mu of list) { const id = String(mu?.id_str ?? mu?.mid ?? mu?.id ?? ''); if (id && !music.has(id)) { music.set(id, mu); lastNewAt = Date.now(); } } } } catch { /* 略 */ } return; }
      if (!LIST_RE.test(url)) return;
      try {
        const d = await res.json();
        const list = d?.aweme_list; if (!Array.isArray(list)) return;
        hits++;
        if (d.has_more === 0 || d.has_more === false) hasMore = false;
        for (const a of list) { const id = String(a?.aweme_id ?? ''); if (id && !seen.has(id)) { seen.set(id, a); lastNewAt = Date.now(); } }
      } catch { /* 非 JSON */ }
    });
    await page.goto('https://www.douyin.com/user/self?showTab=favorite_collection', { waitUntil: 'domcontentloaded', timeout: 45000 });
    const t0 = Date.now();
    await page.waitForTimeout(4000);
    const loggedIn = await page.evaluate(() => /LOGIN_STATUS=1/.test(document.cookie)).catch(() => false);
    if (!loggedIn && !hits) return { need_login: true };
    if (!account) { const nick = await page.evaluate(() => document.querySelector('[data-e2e="user-info-nickname"], h1')?.textContent?.trim() ?? '').catch(() => ''); if (nick) account = { uid: null, nickname: nick }; }
    while (Date.now() - t0 < maxMs && seen.size < maxItems && !blocked) {
      const captcha = await page.evaluate(() => [...document.querySelectorAll('[id*="captcha" i], [class*="captcha" i], [class*="verify-" i]')].some((el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 50 && r.height > 50 && cs.display !== 'none' && cs.visibility !== 'hidden'; })).catch(() => false);
      if (captcha) { blocked = '出现验证码'; break; }
      await page.evaluate(() => {
        const cards = document.querySelectorAll('[data-e2e="user-post-item"], li[class*="item"]');
        cards[cards.length - 1]?.scrollIntoView({ block: 'end' });
        window.scrollTo(0, document.documentElement.scrollHeight);
        for (const el of document.querySelectorAll('[class*="scroll"], main')) { try { el.scrollTop = el.scrollHeight; } catch { /* 略 */ } }
      }).catch(() => {});
      await page.waitForTimeout(1800 + Math.random() * 1600);
      if (!hasMore) break;
      if (Date.now() - lastNewAt > 15000) break;
      // 增量：抄到的全是已有的，再翻两轮没新的就停
      if (!full && seen.size >= 40) {
        const last20 = [...seen.keys()].slice(-20);
        const known = one('SELECT COUNT(*) AS n FROM douyin_favorites WHERE aweme_id IN (' + last20.map(() => '?').join(',') + ')', ...last20)?.n ?? 0;
        if (known >= 20) break;
      }
    }
    // 音乐：收藏页里点「音乐」tab 再翻一轮（选择器会变，找不到就跳过）
    let musicResult = null;
    if (withMusic && !blocked) {
      try {
        const tab = page.locator('text=/^音乐$/').first();
        if (await tab.count()) {
          await tab.click({ timeout: 5000 }); hasMore = true; lastNewAt = Date.now();
          const t1 = Date.now();
          while (Date.now() - t1 < Math.min(maxMs, 90000) && music.size < maxItems && !blocked) {
            await page.evaluate(() => { window.scrollTo(0, document.documentElement.scrollHeight); for (const el of document.querySelectorAll('[class*="scroll"], main')) { try { el.scrollTop = el.scrollHeight; } catch { /* 略 */ } } }).catch(() => {});
            await page.waitForTimeout(1800 + Math.random() * 1600);
            if (!hasMore || Date.now() - lastNewAt > 15000) break;
          }
          if (music.size) { const mr = ingestMusic([...music.values()], { account }); musicResult = { collected: music.size, added: mr.added, updated: mr.updated }; }
          else musicResult = { collected: 0, note: '点了音乐 tab 但没旁听到列表（接口名可能变了）' };
        } else musicResult = { collected: 0, note: '没找到「音乐」tab' };
      } catch (e) { musicResult = { error: e.message.split('\n')[0] }; }
    }
    if (!seen.size && !music.size) return hits ? { added: 0, updated: 0, pages: hits, blocked, music: musicResult } : (blocked ? { error: `抖音限流：${blocked}` } : { need_login: true });
    const r = seen.size ? ingestFavorites([...seen.values()], { account }) : { added: 0, updated: 0 };
    return { added: r.added, updated: r.updated, pages: hits, collected: seen.size, has_more: hasMore, account: account?.nickname ?? null, blocked, music: musicResult };
  } finally { await ctx.close().catch(() => {}); }
}

// —— 服务端自己下媒体：用已登录的持久 profile。Playwright 的 request 上下文自带浏览器 cookie、不受 CORS 限制。
// 节奏和脚本一样：一个一个来、随机歇、403/429 或连续 3 次失败立刻停。
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (a, b) => a + Math.random() * (b - a);
// 抖音直链有有效期：视频 CDN 路径里 32 位哈希后面那段 8 位十六进制是过期时间（秒）；图床用 x-expires 参数（秒）。
// 过了期再去下必 403，还和限流长得一样——所以先看一眼，过期的跳过不计失败，等下一次列表/收藏夹同步把地址刷新
export function urlExpiry(u) {
  if (!u) return null;
  const s = String(u);
  const m = s.match(/\/[0-9a-f]{32}\/([0-9a-f]{8})\//);
  if (m) return parseInt(m[1], 16) * 1000;
  const x = s.match(/[?&]x-expires=(\d{9,13})/);
  if (x) { const n = Number(x[1]); return n > 1e12 ? n : n * 1000; }
  return null;
}
export const urlExpired = (u, now = Date.now()) => { const e = urlExpiry(u); return e != null && e < now + 60000; };
const mainMediaUrl = (it) => (it.kind === 'music' ? it.play_url : it.play_url ?? it.variants?.[0]?.static ?? it.variants?.[0]?.original ?? null);
export async function fetchPendingMediaWithBrowser({ limit = 10, video = true, launch = launchShared, pause = [1000, 3000], onProgress = null, account = null } = {}) {
  // 多拿几倍：把直链已过期的筛掉再取 limit 条；全过期就一条也不开浏览器，调用方看 stale 决定去刷新列表
  const all = pendingMedia(limit * 4, { accountName: accountNick(account), includeUnassigned: isPrimary(account) });
  const stale = all.filter((it) => urlExpired(mainMediaUrl(it)));
  const items = all.filter((it) => !urlExpired(mainMediaUrl(it))).slice(0, limit);
  const out = { tried: items.length, done: 0, failed: 0, files: 0, stopped: null, account: account ?? null, stale: stale.length, pending_seen: all.length };
  if (!items.length) return out;
  const ctx = await launch(true, profileOf(account));
  try {
    const get = async (url) => {
      const res = await ctx.request.get(url, { headers: { Referer: 'https://www.douyin.com/', Accept: '*/*' }, timeout: 120000, maxRedirects: 5 });
      if (res.status() === 403 || res.status() === 429) throw Object.assign(new Error(`HTTP ${res.status()}`), { blocked: true });
      if (!res.ok()) throw new Error(`HTTP ${res.status()}`);
      return Buffer.from(await res.body());
    };
    // 存一个文件；storeMedia 判定"不像媒体"时它自己已经记过失败，这里只往上抛
    const put = async (id, kind, url, index = 0) => {
      if (!url) return false;
      const r = storeMedia(id, { kind, index, bytes: await get(url) });
      if (!r.ok) throw Object.assign(new Error(`${kind} 不像媒体文件（可能是登录墙）`), { marked: true });
      out.files++;
      await sleep(jitter(pause[0], pause[1]));
      return true;
    };
    let streak = 0, n = 0;
    for (const it of items) {
      n++; onProgress?.(`媒体 ${n}/${items.length}：${it.aweme_id}`);
      try {
        await put(it.aweme_id, 'cover', it.cover_url);
        if (it.kind === 'music') { if (it.play_url) await put(it.aweme_id, 'audio', it.play_url); else markMediaFailed(it.aweme_id, '没有音频地址'); out.done++; streak = 0; continue; }
        await put(it.aweme_id, 'anim', it.dynamic_cover_url);
        if (it.play_url) {
          if (video) await put(it.aweme_id, 'video', it.play_url);
          else markMediaFailed(it.aweme_id, '这次没开视频下载');
        } else {
          const vs = it.variants?.length ? it.variants : [];
          for (let i = 0; i < vs.length; i++) {
            // 无水印的展示图优先；拿不到再用 download_url_list（带水印的 3000x3000）
            try { await put(it.aweme_id, 'image', vs[i].static ?? vs[i].original, i); }
            catch (e) { if (e.blocked) throw e; if (vs[i].static && vs[i].original) await put(it.aweme_id, 'image', vs[i].original, i); else throw e; }
            if (vs[i].live) { try { await put(it.aweme_id, 'live', vs[i].live, i); } catch (e) { if (e.blocked) throw e; /* 实况是加分项 */ } }
          }
          if (it.music_url) { try { await put(it.aweme_id, 'audio', it.music_url); } catch (e) { if (e.blocked) throw e; /* 配乐是加分项 */ } }
          if (!vs.length) markMediaFailed(it.aweme_id, '没有可下载的媒体地址');
        }
        out.done++; streak = 0;
      } catch (e) {
        out.failed++; streak++;
        if (!e.marked) markMediaFailed(it.aweme_id, e.message);
        if (e.blocked || streak >= 3) { out.stopped = e.blocked ? `抖音限流（${e.message}），停下` : '连续失败 3 次，停下'; break; }
      }
      if (n % 10 === 0) await sleep(jitter(8000, 15000));
    }
  } finally { await ctx.close().catch(() => {}); }
  return out;
}

// —— 收藏夹：实测流程（2026-10-18）——
// 收藏页点「收藏夹」tab → 页面自己请求 /collects/list/（10 个一页，collects_id_str / collects_name / total_number）
// 和每个夹子的预览 /collects/video/list/?collects_id=X&cursor=0&count=10；点夹子名字（文字节点，y>150）在页内打开夹子，
// 立刻追加 cursor=10,20，之后每滚一下加 10；夹子视图没有 history，回网格要重新打开 tab 的地址。
db.exec(`
CREATE TABLE IF NOT EXISTS douyin_folders (
  collects_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  total_number INTEGER NOT NULL DEFAULT 0,
  cover_url TEXT,
  collected INTEGER NOT NULL DEFAULT 0,
  last_synced_at TEXT
);`);
const FOLDER_TAB_URL = 'https://www.douyin.com/user/self?showSubTab=favorite_folder&showTab=favorite_collection';
const FOLDER_LIST_RE = /\/aweme\/v1\/web\/collects\/list\//;
const FOLDER_ITEMS_RE = /\/aweme\/v1\/web\/collects\/video\/list\//;
const captchaVisible = (page) => page.evaluate(() => [...document.querySelectorAll('[id*="captcha" i], [class*="captcha" i], [class*="verify-" i]')].some((el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 50 && r.height > 50 && cs.display !== 'none' && cs.visibility !== 'hidden'; })).catch(() => false);
const scrollDown = (page) => page.evaluate(() => { window.scrollTo(0, document.documentElement.scrollHeight); for (const el of document.querySelectorAll('[class*="scroll"], main')) { try { el.scrollTop = el.scrollHeight; } catch { /* 略 */ } } }).catch(() => {});

export async function syncFolders({ maxFolders = 60, maxMs = 900000, headless = true, launch = launchShared, onlyNames = null, onProgress = null, account = null } = {}) {
  const ctx = await launch(headless, profileOf(account));
  const t0 = Date.now();
  const log = (m) => { onProgress?.(m); console.log('[douyin folders]', m); };
  try {
    const page = ctx.pages()[0] ?? await ctx.newPage();
    const folders = new Map();            // collects_id → { id, name, n, cover }
    const seen = new Map();               // aweme_id → aweme
    const folderOf = new Map();           // aweme_id → Set(name)
    const perFolder = new Map();          // collects_id → { got: Set(aweme_id), hasMore, lastNewAt }
    let account = null, blocked = null, folderListHasMore = true;
    page.on('response', async (res) => {
      const url = res.url();
      if ((res.status() === 403 || res.status() === 429) && /\/aweme\/v1\/web\//.test(url)) { blocked = `HTTP ${res.status()}`; return; }
      if (PROFILE_RE.test(url)) { try { const d = await res.json(); const u = d?.user ?? d?.data?.user; if (u?.nickname || u?.uid) account = { uid: u.uid != null ? String(u.uid) : (account?.uid ?? null), nickname: String(u.nickname ?? account?.nickname ?? '') }; } catch { /* 略 */ } return; }
      if (FOLDER_LIST_RE.test(url)) {
        try { const d = await res.json(); for (const f of d?.collects_list ?? []) { const id = String(f.collects_id_str ?? f.collects_id); if (!folders.has(id)) folders.set(id, { id, name: String(f.collects_name ?? '').trim() || `收藏夹 ${id}`, n: Number(f.total_number) || 0, cover: f.collects_cover?.url_list?.[0] ?? null }); } folderListHasMore = !!d?.has_more; } catch { /* 略 */ }
        return;
      }
      if (FOLDER_ITEMS_RE.test(url)) {
        const cid = (url.match(/collects_id=(\d+)/) ?? [])[1]; if (!cid) return;
        try {
          const d = await res.json(); const list = d?.aweme_list; if (!Array.isArray(list)) return;
          const st = perFolder.get(cid) ?? { got: new Set(), hasMore: true, lastNewAt: Date.now() }; perFolder.set(cid, st);
          if (d.has_more === 0 || d.has_more === false) st.hasMore = false;
          for (const a of list) {
            const id = String(a?.aweme_id ?? ''); if (!id) continue;
            if (!st.got.has(id)) { st.got.add(id); st.lastNewAt = Date.now(); }
            if (!seen.has(id)) seen.set(id, a);
            if (!folderOf.has(id)) folderOf.set(id, new Set()); folderOf.get(id).add(cid);
          }
        } catch { /* 略 */ }
      }
    });
    const openGrid = async () => {
      await page.goto(FOLDER_TAB_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForTimeout(5000 + Math.random() * 1500);
      // 夹子多于 30 个时网格要往下滚才会继续请求 collects/list
      for (let i = 0; i < 6 && folderListHasMore; i++) { await scrollDown(page); await page.waitForTimeout(1800 + Math.random() * 1200); }
    };
    await openGrid();
    const loggedIn = await page.evaluate(() => /LOGIN_STATUS=1/.test(document.cookie)).catch(() => false);
    if (!loggedIn && !folders.size) return { need_login: true };
    if (!account) { const nick = await page.evaluate(() => document.querySelector('[data-e2e="user-info-nickname"], h1')?.textContent?.trim() ?? '').catch(() => ''); if (nick) account = { uid: null, nickname: nick }; }
    const all = [...folders.values()];
    for (const f of all) run(`INSERT INTO douyin_folders (collects_id, name, total_number, cover_url) VALUES (?,?,?,?) ON CONFLICT(collects_id) DO UPDATE SET name = excluded.name, total_number = excluded.total_number, cover_url = COALESCE(excluded.cover_url, douyin_folders.cover_url)`, f.id, f.name, f.n, f.cover);
    log(`${all.length} 个收藏夹：${all.map((f) => `${f.name}(${f.n})`).join(' ')}`);
    const todo = all.filter((f) => !onlyNames || onlyNames.includes(f.name)).slice(0, maxFolders);
    const report = [];
    let first = true;
    for (const f of todo) {
      if (blocked || Date.now() - t0 > maxMs) break;
      const st = perFolder.get(f.id);
      const prior = one('SELECT collected FROM douyin_folders WHERE collects_id = ?', f.id)?.collected ?? 0;
      // 预览那 10 条已经等于全部的夹子、或上次已经翻完的，不用点进去
      if (st && (!st.hasMore || st.got.size >= f.n)) { report.push({ name: f.name, n: f.n, collected: st.got.size, note: '预览已覆盖' }); continue; }
      if (prior >= f.n && f.n > 0) { report.push({ name: f.name, n: f.n, collected: prior, note: '上次已翻完' }); continue; }
      if (!first) await openGrid();
      first = false;
      if (await captchaVisible(page)) { blocked = '出现验证码'; break; }
      // 点夹子名字：网格卡片按 collects/list 的顺序排，同名夹子按出现序号区分；tab 栏里的同名字在 DOM 里排在网格前面，
      // 所以只在"看起来是卡片"的文字节点（p 标签优先）里按序号取，先 scrollIntoView 再点，别管它在不在视口里。
      const occurrence = all.filter((x) => x.name === f.name).findIndex((x) => x.id === f.id);
      const pt = await page.evaluate(({ name, occurrence }) => {
        const nodes = [...document.querySelectorAll('p, span, div, h3, h4')].filter((e) => e.children.length === 0 && e.textContent.trim() === name);
        const cards = nodes.filter((e) => e.tagName === 'P');
        const pool = cards.length ? cards : nodes.filter((e) => e.getBoundingClientRect().y > 150 || e.getBoundingClientRect().y < 0);
        const el = pool[occurrence] ?? pool[pool.length - 1]; if (!el) return null;
        el.scrollIntoView({ block: 'center' });
        const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, pool: pool.length };
      }, { name: f.name, occurrence }).catch(() => null);
      if (!pt) { report.push({ name: f.name, n: f.n, collected: st?.got.size ?? 0, note: '网格里没找到这个名字' }); continue; }
      await page.waitForTimeout(600);
      await page.mouse.click(pt.x, pt.y).catch(() => {});
      await page.waitForTimeout(3500 + Math.random() * 1500);
      log(`进「${f.name}」(${f.n})…`);
      const fs0 = perFolder.get(f.id) ?? { got: new Set(), hasMore: true, lastNewAt: Date.now() }; perFolder.set(f.id, fs0);
      const tf = Date.now();
      while (!blocked && Date.now() - t0 < maxMs && Date.now() - tf < 240000) {
        const cur = perFolder.get(f.id);
        if (!cur.hasMore || cur.got.size >= f.n) break;
        if (Date.now() - cur.lastNewAt > 15000) break;
        if (await captchaVisible(page)) { blocked = '出现验证码'; break; }
        await scrollDown(page);
        await page.waitForTimeout(1800 + Math.random() * 1700);
      }
      const got = perFolder.get(f.id)?.got.size ?? 0;
      run('UPDATE douyin_folders SET collected = ?, last_synced_at = datetime(\'now\') WHERE collects_id = ?', got, f.id);
      report.push({ name: f.name, n: f.n, collected: got });
      log(`「${f.name}」抄到 ${got}/${f.n}`);
      await page.waitForTimeout(2500 + Math.random() * 2500);   // 夹子之间歇一下
    }
    // 入库：夹子 id → 名字
    const foldersByAweme = {};
    for (const [aid, set] of folderOf) foldersByAweme[aid] = [...set].map((cid) => folders.get(cid)?.name ?? `收藏夹 ${cid}`);
    const r = seen.size ? ingestFavorites([...seen.values()], { account, folders: foldersByAweme }) : { added: 0, updated: 0 };
    return { folders: all.length, visited: report.length, added: r.added, updated: r.updated, collected: seen.size, account: account?.nickname ?? null, blocked, report, ms: Date.now() - t0 };
  } finally { await ctx.close().catch(() => {}); }
}

// —— 全部账号跑一轮：每个号 收藏列表（含音乐）→ 各收藏夹；哪个号登录态过期了记 need_login，其它号照跑。
// 定时任务（social-sync）调的就是它。syncers 可注入（测试）。
export async function syncAllAccounts({ full = false, maxMs = 150000, maxItems = 300, withMusic = true, withFolders = true, foldersMaxMs = 600000, maxFolders = 80, accounts = null, onProgress = null, syncers = null } = {}) {
  const S = syncers ?? { favorites: syncFavorites, folders: syncFolders };
  const all = accounts ?? listAccounts();
  const todo = all.filter((a) => !a.need_login || full);
  const out = { added: 0, updated: 0, pages: 0, accounts: [] };
  for (const a of todo) {
    const now = new Date().toISOString();
    const rec = { id: a.id, nickname: a.nickname ?? null };
    try {
      const r = await S.favorites({ full, maxMs, maxItems, withMusic, account: a.id });
      rec.list = r;
      if (r?.need_login) { upsertAccount({ id: a.id, need_login: true, last_attempt: now }); out.accounts.push(rec); continue; }
      out.added += r?.added ?? 0; out.updated += r?.updated ?? 0; out.pages += r?.pages ?? 0;
      if (withFolders && !r?.blocked && !r?.error) {
        const f = await S.folders({ maxFolders, maxMs: foldersMaxMs, account: a.id, onProgress });
        rec.folders = f; out.added += f?.added ?? 0; out.updated += f?.updated ?? 0;
      }
      rec.nickname = r?.account ?? rec.folders?.account ?? rec.nickname;
      upsertAccount({ id: a.id, nickname: rec.nickname, need_login: false, last_sync: now, last_attempt: now, error: r?.blocked ?? r?.error ?? null });
    } catch (e) { rec.error = e.message; upsertAccount({ id: a.id, last_attempt: now, error: String(e.message ?? e).slice(0, 200) }); }
    out.accounts.push(rec);
  }
  // 全都要重新登录才算 need_login（social-sync 会据此停下来等人）
  out.need_login = all.length > 0 && (!todo.length || out.accounts.every((r) => r.list?.need_login));
  return out;
}
export async function fetchPendingMediaAllAccounts({ limit = 40, video = true, onProgress = null, fetcher = fetchPendingMediaWithBrowser } = {}) {
  const accts = listAccounts().filter((a) => !a.need_login);
  const out = { tried: 0, done: 0, failed: 0, files: 0, stopped: null, accounts: [] };
  const per = Math.max(1, Math.ceil(limit / Math.max(1, accts.length)));
  for (const a of accts) {
    const r = await fetcher({ limit: per, video, onProgress, account: a.id });
    out.tried += r.tried; out.done += r.done; out.failed += r.failed; out.files += r.files; out.accounts.push({ id: a.id, ...r });
    if (r.stopped) { out.stopped = r.stopped; break; }
  }
  return out;
}

export function favoritesStatus() {
  const c = one(`SELECT COUNT(*) AS total, SUM(media_status = 'done') AS media_done, SUM(media_status = 'pending') AS media_pending,
                        SUM(media_status = 'failed') AS media_failed, MAX(collected_at) AS last_collected_at FROM douyin_favorites`);
  const accounts = q(`SELECT COALESCE(account_name, '（未知账号）') AS name, COUNT(*) AS n, MAX(collected_at) AS last FROM douyin_favorites GROUP BY name ORDER BY n DESC`);
  const kinds = Object.fromEntries(q(`SELECT COALESCE(kind, 'video') AS k, COUNT(*) AS n FROM douyin_favorites GROUP BY k`).map((r) => [r.k, r.n]));
  const folderCount = {};
  for (const r of q('SELECT folders_json FROM douyin_favorites WHERE folders_json IS NOT NULL')) for (const f of jarr(r.folders_json)) folderCount[f] = (folderCount[f] ?? 0) + 1;
  // 夹子表里有总数，能看出"抄到 / 总共"
  for (const f of q('SELECT name, total_number, collected FROM douyin_folders')) if (!(f.name in folderCount)) folderCount[f.name] = 0;
  const totals = Object.fromEntries(q('SELECT name, MAX(total_number) AS n FROM douyin_folders GROUP BY name').map((f) => [f.name, f.n]));
  return { total: c?.total ?? 0, media_done: c?.media_done ?? 0, media_pending: c?.media_pending ?? 0, media_failed: c?.media_failed ?? 0,
    last_collected_at: c?.last_collected_at ?? null, kinds, accounts, profiles: listAccounts(), folders: Object.entries(folderCount).map(([name, n]) => ({ name, n, total: totals[name] ?? null })).sort((a, b) => (b.total ?? b.n) - (a.total ?? a.n)),
    archive_root: archiveRoot(), archive_exists: existsSync(archiveRoot()) };
}
