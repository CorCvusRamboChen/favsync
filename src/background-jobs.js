// 后台任务：每个任务是 {name, start(), stop()}。server.js 启动时全部 start()；FAVSYNC_NO_JOBS=1 可整体关掉（测试、排查时用）。
import { fetchPendingMedia as fetchWeiboMedia, favoritesStatus as weiboStatus } from './connectors/weibo-favorites.js';
import { fetchPendingMedia as fetchXMedia, favoritesStatus as xStatus } from './connectors/x-favorites.js';
import { runSocialSync, readState as socialState, isEnabled as socialEnabled, SITES as SOCIAL_SITES } from './connectors/social-sync.js';
import { broadcast } from './events.js';

// 定时任务的通用形状：延迟一下跑第一次，然后按固定间隔重复
export function intervalJob(name, fn, intervalMs, { initialDelayMs = 0 } = {}) {
  let timer = null, initialTimer = null;
  const run = () => fn().catch((e) => console.error(`[${name}]`, e.message));
  return {
    name,
    start() { initialTimer = setTimeout(() => { run(); timer = setInterval(run, intervalMs); }, initialDelayMs); },
    stop() { clearTimeout(initialTimer); clearInterval(timer); },
  };
}

// 微博收藏的图：导入旧文件 / 脚本推送之后还没下好的，服务端自己带 Referer 慢慢补（每 5 分钟一批 60 条）
export function weiboMediaJob() {
  return intervalJob('weibo-media', async () => {
    if (!weiboStatus().media_pending) return;
    const r = await fetchWeiboMedia({ limit: 60 });
    if (r.tried) { console.log(`[weibo-media] 补图 ${r.done} 条成功 / ${r.failed} 条失败，${r.files} 个文件`); broadcast('change', { tool: 'weibo_media' }); }
  }, 5 * 60000, { initialDelayMs: 60000 });
}
// X 点赞/书签的图和视频：服务端自己从公开 CDN 慢慢补（每 5 分钟一批 40 条）
export function xMediaJob() {
  return intervalJob('x-media', async () => {
    if (!xStatus().media_pending) return;
    const r = await fetchXMedia({ limit: 40 });
    if (r.tried) { console.log(`[x-media] 补媒体 ${r.done} 条成功 / ${r.failed} 条失败，${r.files} 个文件`); broadcast('change', { tool: 'x_media' }); }
  }, 5 * 60000, { initialDelayMs: 90000 });
}
// 常态化同步：每 12 小时把登录过的站翻一遍（need_login 的跳过；微博要先登录过一次，抖音/X 有登录态就跑）。
// 间隔可用 FAVSYNC_SYNC_HOURS 改；抖音媒体在 after 阶段每轮补 40 条。
export function socialSyncJob() {
  const hours = Number(process.env.FAVSYNC_SYNC_HOURS) || 12;
  return intervalJob('social-sync', async () => {
    const st = socialState();
    const sites = SOCIAL_SITES.filter((k) => socialEnabled(k, st) && !st[k]?.need_login && (st[k]?.last_sync || k === 'douyin' || k === 'x'));
    if (!sites.length) return;
    const r = await runSocialSync({ sites });
    if (!r.skipped) { console.log('[social-sync]', JSON.stringify(r.sites).slice(0, 600)); broadcast('change', { tool: 'social_sync' }); }
  }, hours * 3600000, { initialDelayMs: 10 * 60000 });
}

export function createBackgroundJobs() { return [weiboMediaJob(), xMediaJob(), socialSyncJob()]; }
