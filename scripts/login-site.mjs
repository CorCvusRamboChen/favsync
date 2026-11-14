// 一次性登录微博 / 抖音：在服务器上拉起**带界面**的 Chrome/Edge（持久化 profile = data/browser-profile），
// 你自己在窗口里登录；脚本每 2 秒看一眼登录态，登上了就关窗口、通知 FavSync 立刻做一次全量同步。
// 以后服务端定时同步就用这份登录态，无头跑。
// 服务器没有屏幕的话：抖音用 scripts/douyin-login-qr.mjs 扫码；X 用 scripts/login-x.mjs 在别的电脑上登。
//   node scripts/login-site.mjs weibo | douyin
import { chromium } from 'playwright-core';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const site = process.argv[2];
const SITES = {
  weibo: { url: 'https://weibo.com/', check: () => !!(window.$CONFIG?.uid ?? window.$CONFIG?.user?.idstr), label: '微博' },
  douyin: { url: 'https://www.douyin.com/user/self?showTab=favorite_collection', check: () => /LOGIN_STATUS=1/.test(document.cookie) || !!document.querySelector('[data-e2e="user-info"], [data-e2e="user-detail"]'), label: '抖音' },
};
const cfg = SITES[site];
if (!cfg) { console.error('用法：node scripts/login-site.mjs weibo|douyin'); process.exit(2); }
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const profileDir = process.env.FAVSYNC_BROWSER_PROFILE || path.join(process.env.FAVSYNC_DATA || path.join(root, 'data'), 'browser-profile');
const PORT = process.env.PORT || 3460;

let ctx = null;
for (const channel of ['chrome', 'msedge']) {
  try { ctx = await chromium.launchPersistentContext(profileDir, { channel, headless: false, viewport: null, args: ['--start-maximized'] }); break; } catch { /* 下一个 */ }
}
if (!ctx) { console.error('没找到本机 Chrome/Edge'); process.exit(1); }
const page = ctx.pages()[0] ?? await ctx.newPage();
await page.goto(cfg.url, { waitUntil: 'domcontentloaded' }).catch(() => {});
console.log(`请在打开的窗口里登录${cfg.label}。登录完成后窗口会自动关闭（最多等 10 分钟）。`);
let ok = false;
for (let i = 0; i < 300 && !ok; i++) {
  await page.waitForTimeout(2000);
  try { ok = await page.evaluate(cfg.check); } catch { /* 页面在跳转 */ }
  if (ctx.pages().length === 0) break;
}
await ctx.close().catch(() => {});
if (!ok) { console.log('没有检测到登录，下次再试。'); process.exit(1); }
console.log(`${cfg.label}已登录，通知 FavSync 做一次全量同步…`);
try {
  const r = await fetch(`http://localhost:${PORT}/api/social/sync`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sites: [site], full: true, force: true }) });
  console.log(await r.text());
} catch (e) { console.log('FavSync 没开着？启动后在设置页手动点一次同步即可。', e.message); }
