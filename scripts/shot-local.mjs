// 在服务所在机器上无头截一张本机页面（本机请求免鉴权）：node scripts/shot-local.mjs <path-or-url> <out.png> [width] [height] [先点的选择器]
// 页面开着 SSE 长连接，所以不能等 networkidle，等 load + 页面主体出现即可。
import { chromium } from 'playwright-core';
const [target, out, w = '1400', h = '1000', click] = process.argv.slice(2);
if (!target || !out) { console.error('用法：node scripts/shot-local.mjs /library.html?tag=x out.png [宽] [高] [选择器]'); process.exit(2); }
const url = target.startsWith('http') ? target : `http://localhost:${process.env.PORT || 3460}${target}`;
let browser = null;
for (const channel of ['chrome', 'msedge']) { try { browser = await chromium.launch({ channel, headless: true }); break; } catch { /* 下一个 */ } }
if (!browser) { console.error('没有可用的 Chrome/Edge'); process.exit(1); }
const page = await browser.newPage({ viewport: { width: Number(w), height: Number(h) } });
page.on('pageerror', (e) => console.error('页面脚本报错：', e.message));
await page.goto(url, { waitUntil: 'load', timeout: 60000 }).catch((e) => console.error('打开失败：', e.message.split('\n')[0]));
await page.waitForSelector('.eg, main.st', { timeout: 15000 }).catch(() => {});
await page.waitForTimeout(1500);
if (click) { await page.click(click, { timeout: 5000 }).catch(() => {}); await page.waitForTimeout(1200); }
await page.screenshot({ path: out });
console.log('saved', out);
await browser.close();
