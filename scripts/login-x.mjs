// 在有屏幕的电脑上登录 X（Twitter），把登录 cookie 发给跑着 FavSync 的服务器（X 没有扫码登录，服务器往往没屏幕）。
//   node scripts/login-x.mjs --server https://your-server.example:3460 --code 123456
// 口令（code）在设置页「X 点赞 + 书签」卡片 →「用电脑浏览器登录」里拿，15 分钟有效、只能用一次。
// 流程：弹出真 Chrome（独立 profile，不碰你平时的）→ 你在里面登录 X → 脚本看到登录态就把 cookie 发过去 → 服务器立刻开始同步。
import { chromium } from 'playwright-core';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';

const argv = process.argv.slice(2);
const flag = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
const server = (flag('--server') || process.env.FAVSYNC_URL || 'http://localhost:3460').replace(/\/+$/, '');
const code = flag('--code') || process.env.FAVSYNC_LOGIN_CODE;
if (!code) { console.error('缺 --code：到设置页「X 点赞 + 书签」卡片 →「用电脑浏览器登录」拿口令'); process.exit(2); }
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const profile = path.join(process.env.FAVSYNC_DATA || path.join(root, 'data'), 'browser-profiles', 'x-login');
mkdirSync(profile, { recursive: true });
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

let ctx = null;
for (const channel of ['chrome', 'msedge']) {
  try { ctx = await chromium.launchPersistentContext(profile, { channel, headless: false, viewport: null, locale: 'zh-CN', args: ['--disable-blink-features=AutomationControlled'] }); break; }
  catch (e) { log(channel, '起不来：', e.message.split('\n')[0]); }
}
if (!ctx) { console.error('本机没有 Chrome / Edge'); process.exit(1); }
const page = ctx.pages()[0] ?? await ctx.newPage();
await page.goto('https://x.com/i/flow/login', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
log('浏览器已打开：请在窗口里登录 X。登录完不用关，脚本会自己收尾。');

const t0 = Date.now();
while (Date.now() - t0 < 15 * 60000) {
  await page.waitForTimeout(3000);
  const cookies = await ctx.cookies(['https://x.com', 'https://twitter.com']).catch(() => []);
  const names = new Set(cookies.map((c) => c.name));
  if (!names.has('auth_token') || !names.has('ct0')) continue;
  // 页面上有「个人资料」入口才算真登录
  const handle = await page.evaluate(() => { const a = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]'); const h = a?.getAttribute('href')?.replace(/^\//, ''); return h && /^[A-Za-z0-9_]{1,15}$/.test(h) ? h : null; }).catch(() => null);
  if (!handle && !/x\.com\/home/.test(page.url())) continue;
  log('看到登录态' + (handle ? '（@' + handle + '）' : '') + '，发给服务器…');
  try {
    const res = await fetch(`${server}/x-login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, handle, cookies: cookies.filter((c) => /(^|\.)(x|twitter)\.com$/.test(c.domain)) }) });
    const d = await res.json().catch(() => ({}));
    if (!res.ok || d.error) { log('服务器没收：', d.error || res.status); if (/口令/.test(String(d.error))) { await ctx.close(); process.exit(3); } await page.waitForTimeout(5000); continue; }
    log('✅ 已登录 X，服务器开始同步书签和点赞。可以关掉这个窗口了。');
    await page.waitForTimeout(1500);
    await ctx.close(); process.exit(0);
  } catch (e) { log('发送失败：', e.message.split('\n')[0], '（5 秒后再试）'); await page.waitForTimeout(5000); }
}
log('15 分钟没登录，退出'); await ctx.close(); process.exit(2);
