// 常态化保存：服务端自己定时去拉微博/抖音的收藏，不依赖你开着浏览器、装着脚本。
//
// 原理：复用服务器上那个持久化浏览器 profile（data/browser-profile）。
// 你在里面登录一次微博/抖音，之后服务端每 12 小时无头打开一次，站在已登录页面里把收藏翻一遍
//（微博直接调 /ajax/favorites/all_fav；抖音打开收藏页旁听列表响应），新收藏入库，图片顺手补全。
// 登录态过期了就记 need_login，设置页会亮出来让你再登一次；不会反复用过期态去撞。
//
// 状态文件 data/social-sync.json：{ weibo: {last_sync, last_result, need_login, error}, douyin: {...} }
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { dataDir } from '../db.js';

const STATE_FILE = () => process.env.FAVSYNC_SOCIAL_SYNC || path.join(dataDir(), 'social-sync.json');
export const SITES = ['weibo', 'douyin', 'x'];
// 定时任务默认跑哪些：三个站都默认开。抖音这边节奏和油猴脚本一样慢（随机等、碰到 403/验证码立刻停），
// 每 12 小时一次是"人每天翻两次收藏"的量级；真被限流也只是这一轮停下，下一轮再来。不想跑可以在设置里关。
export const DEFAULT_ENABLED = { weibo: true, douyin: true, x: true };
export const isEnabled = (site, st = readState()) => (st[site]?.enabled ?? DEFAULT_ENABLED[site] ?? false);

export function readState() {
  try { return JSON.parse(readFileSync(STATE_FILE(), 'utf-8')); } catch { return {}; }
}
export function writeState(patch) {
  const cur = readState();
  const next = { ...cur };
  for (const [site, v] of Object.entries(patch)) next[site] = { ...(cur[site] ?? {}), ...v };
  mkdirSync(path.dirname(STATE_FILE()), { recursive: true });
  writeFileSync(STATE_FILE(), JSON.stringify(next, null, 2));
  return next;
}

// 同步器注入：真实的在 weibo-favorites / douyin-favorites 里；测试传假的
const defaultSyncers = async () => ({
  weibo: (await import('./weibo-favorites.js')).syncFavorites,
  douyin: (await import('./douyin-favorites.js')).syncAllAccounts,   // 每个账号：收藏列表（含音乐）→ 各收藏夹
  x: (await import('./x-favorites.js')).syncX,                      // 书签页 + 点赞页，cookie 由电脑端登录脚本投递
});
const defaultAfter = async () => {
  const w = await import('./weibo-favorites.js');
  const d = await import('./douyin-favorites.js');
  // 抖音的媒体（封面 / 视频 / 图文原图 / 音频）用各账号自己的登录态在浏览器里下；每轮 40 条，剩下的下一轮接着
  const x = await import('./x-favorites.js');
  return async () => ({ weibo_images: await w.fetchPendingMedia({ limit: 60 }), douyin_media: await d.fetchPendingMediaAllAccounts({ limit: 40 }), x_media: await x.fetchPendingMedia({ limit: 40 }) });
};

let running = null;
export const isRunning = () => !!running;
// 跑一轮：每个站独立 try，一个失败不影响另一个；full=true 翻到底，否则增量（碰到已有的就停）
export async function runSocialSync({ sites = SITES, full = false, syncers = null, after = null, force = false } = {}) {
  if (running) return { skipped: true, reason: '上一轮还在跑' };
  running = (async () => {
    const S = syncers ?? await defaultSyncers();
    const out = { sites: {}, started_at: new Date().toISOString() };
    for (const site of sites) {
      const st = readState()[site] ?? {};
      if (st.need_login && !force) { out.sites[site] = { skipped: true, reason: 'need_login' }; continue; }
      const t0 = Date.now();
      try {
        const r = await S[site]({ full });
        if (r?.need_login) writeState({ [site]: { need_login: true, last_attempt: new Date().toISOString(), error: null } });
        else writeState({ [site]: { need_login: false, last_sync: new Date().toISOString(), last_attempt: new Date().toISOString(), error: null,
          last_result: { added: r?.added ?? 0, updated: r?.updated ?? 0, pages: r?.pages ?? null, ms: Date.now() - t0 } } });
        out.sites[site] = r;
      } catch (e) {
        writeState({ [site]: { last_attempt: new Date().toISOString(), error: String(e.message ?? e).slice(0, 300) } });
        out.sites[site] = { error: e.message };
      }
    }
    try { out.media = await (after ?? await defaultAfter())(); } catch (e) { out.media = { error: e.message }; }
    return out;
  })();
  try { return await running; } finally { running = null; }
}
export function socialStatus() {
  const st = readState();
  return { running: !!running, sites: Object.fromEntries(SITES.map((s) => [s, { need_login: !!st[s]?.need_login, enabled: isEnabled(s, st), last_sync: st[s]?.last_sync ?? null,
    last_attempt: st[s]?.last_attempt ?? null, error: st[s]?.error ?? null, last_result: st[s]?.last_result ?? null }])) };
}
