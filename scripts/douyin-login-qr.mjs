// 在没有显示器的机器上登录抖音：无头打开 douyin.com，把登录二维码存成图片（人拿手机扫），
// 然后每 3 秒看一眼登录态，登上了就退出；二维码过期了就刷新再存一张。登录态留在共用的持久 profile 里
//（data/browser-profile，和存档/定时同步用的是同一个），之后服务端的抖音同步就能无头跑。
//   node scripts/douyin-login-qr.mjs [输出目录] [--profile <名>]
//     → 写 <目录>/douyin-qr.png（二维码）、douyin-page.png（整页），状态写到 douyin-login.status
//   --profile：第二个抖音账号用自己的 profile（data/browser-profiles/<名>），登录态不会把第一个号顶掉；不给就是共用的默认 profile
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { profileDir as profileDirOf } from '../src/connectors/browser-profiles.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
const profileDir = profileDirOf(flag('--profile') || 'default');
const outDir = argv.find((a, i) => !a.startsWith('--') && argv[i - 1] !== '--profile') || path.join(process.env.FAVSYNC_DATA || path.join(root, 'data'), 'douyin-login', 'manual');
mkdirSync(profileDir, { recursive: true });
mkdirSync(outDir, { recursive: true });
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const status = (s) => writeFileSync(path.join(outDir, 'douyin-login.status'), s);

let ctx = null;
for (const channel of ['chrome', 'msedge']) {
  try { ctx = await chromium.launchPersistentContext(profileDir, { channel, headless: true, viewport: { width: 1280, height: 900 }, locale: 'zh-CN' }); break; } catch (e) { log(channel, '起不来：', e.message.split('\n')[0]); }
}
if (!ctx) { console.error('没有可用的 Chrome/Edge'); status('error:no-browser'); process.exit(1); }
const page = ctx.pages()[0] ?? await ctx.newPage();
const loggedIn = async () => {
  const cookies = await ctx.cookies('https://www.douyin.com').catch(() => []);
  return cookies.some((c) => c.name === 'LOGIN_STATUS' && c.value === '1') || cookies.some((c) => c.name === 'sessionid' && c.value);
};
await page.goto('https://www.douyin.com/user/self?showTab=favorite_collection', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch((e) => log('goto:', e.message.split('\n')[0]));
await page.waitForTimeout(4000);
if (await loggedIn()) { log('已经是登录状态，不用扫码'); status('logged_in'); await ctx.close(); process.exit(0); }

// 二维码：优先直接把元素里的图拿出来（img 的 data: 地址 / canvas.toDataURL），拿不到再截图。每一步失败都写日志。
async function shootQr(tag) {
  try { await page.screenshot({ path: path.join(outDir, 'douyin-page.png'), timeout: 15000, animations: 'disabled' }); log('整页截图 ok'); }
  catch (e) { log('整页截图失败：', e.message.split('\n')[0]); }
  const found = await page.evaluate(() => {
    const els = [...document.querySelectorAll('img, canvas')].map((el) => { const r = el.getBoundingClientRect(); return { el, x: r.x, y: r.y, w: r.width, h: r.height }; })
      .filter((b) => b.w >= 120 && b.w <= 460 && Math.abs(b.w - b.h) < 14 && b.y >= 0 && b.h > 0);
    els.sort((a, b) => b.w - a.w);
    const best = els[0]; if (!best) return null;
    let data = null;
    try {
      if (best.el.tagName === 'CANVAS') data = best.el.toDataURL('image/png');
      else if (best.el.src?.startsWith('data:image')) data = best.el.src;
    } catch { /* 跨域 canvas 导不出来 */ }
    return { x: best.x, y: best.y, w: best.w, h: best.h, tag: best.el.tagName, src: best.el.src ? String(best.el.src).slice(0, 80) : null, data };
  }).catch((e) => { log('找二维码元素失败：', e.message.split('\n')[0]); return null; });
  if (!found) { log(`没找到二维码元素 (${tag})`); status(`noqr:${tag}:${Date.now()}`); return; }
  log(`二维码元素 ${found.tag} ${Math.round(found.w)}px ${found.src ? found.src : ''}`);
  if (found.data) {
    writeFileSync(path.join(outDir, 'douyin-qr.png'), Buffer.from(found.data.split(',')[1], 'base64'));
    log(`二维码已直接导出 (${tag})`);
  } else {
    try {
      await page.screenshot({ path: path.join(outDir, 'douyin-qr.png'), timeout: 15000, animations: 'disabled',
        clip: { x: Math.max(0, found.x - 12), y: Math.max(0, found.y - 12), width: found.w + 24, height: found.h + 24 } });
      log(`二维码已截图 (${tag})`);
    } catch (e) { log('二维码截图失败：', e.message.split('\n')[0]); }
  }
  status(`qr:${tag}:${Date.now()}`);
}
await shootQr('first');
let lastQrSrc = await page.evaluate(() => [...document.querySelectorAll('img')].find((el) => el.src?.startsWith('data:image') && Math.abs(el.width - el.height) < 14 && el.width >= 120)?.src ?? null).catch(() => null);

// 等扫码：最多 8 分钟；每 3 秒看登录态；二维码过期（页面出现"刷新"/"已失效"）就点一下刷新再截
const t0 = Date.now();
let refreshes = 0;
while (Date.now() - t0 < 8 * 60000) {
  await page.waitForTimeout(3000);
  if (await loggedIn()) {
    await page.waitForTimeout(2500);
    const name = await page.evaluate(() => document.querySelector('[data-e2e="user-info-nickname"], h1')?.textContent?.trim() ?? '').catch(() => '');
    log('登录成功' + (name ? `：${name}` : ''));
    status('logged_in' + (name ? ':' + name : ''));
    await ctx.close(); process.exit(0);
  }
  // 抖音每隔一会儿会自己换一张新码（或者标成失效）：图变了就重新导出；标成失效就点刷新
  const now = await page.evaluate(() => {
    const els = [...document.querySelectorAll('img')].filter((el) => el.src?.startsWith('data:image') && Math.abs(el.width - el.height) < 14 && el.width >= 120);
    return { src: els[0]?.src ?? null, expired: /二维码已失效|已过期|点击刷新|刷新二维码|重新获取/.test(document.body.innerText || '') };
  }).catch(() => ({ src: null, expired: false }));
  if (now.expired && refreshes < 8) {
    refreshes++;
    const btn = await page.$('text=/刷新|重新获取/').catch(() => null);
    if (btn) await btn.click().catch(() => {}); else await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForTimeout(3000);
    await shootQr('refresh' + refreshes);
  } else if (now.src && now.src !== lastQrSrc) {
    lastQrSrc = now.src;
    refreshes++;
    await shootQr('refresh' + refreshes);
  }
}
log('8 分钟内没扫码，退出');
status('timeout');
await ctx.close(); process.exit(2);
