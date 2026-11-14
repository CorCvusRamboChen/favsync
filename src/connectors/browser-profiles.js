// 持久化浏览器 profile 的共用启动器。
//
// 为什么要这一层：微博 / 抖音的服务端同步都复用 data/browser-profile 里的登录态，而 Chrome 同一个 profile
// 同一时刻只能开一个实例——定时同步和手动同步撞上时，第二个 launchPersistentContext 直接失败，以前报成
// 「本机没有可用的 Chrome/Edge」，其实只是被占着。这里给每个 profile 目录排个队：后来的等前一个 ctx.close() 再开。
//
// 多账号：抖音每个账号一个 profile 目录（data/browser-profiles/<id>），默认账号仍是 data/browser-profile，
// 和微博共用；这样第二个抖音账号的登录态不会把第一个顶掉。
import path from 'node:path';
import { dataDir } from '../db.js';

export const DEFAULT_PROFILE = 'default';
const slug = (s) => String(s ?? '').trim().replace(/[^\w.-]+/g, '_').slice(0, 40);
// profile 名 → 目录：default 就是老的共用目录；其它放 data/browser-profiles/<名>
export function profileDir(name = DEFAULT_PROFILE) {
  const n = slug(name) || DEFAULT_PROFILE;
  if (n === DEFAULT_PROFILE) return process.env.FAVSYNC_BROWSER_PROFILE || path.join(dataDir(), 'browser-profile');
  return path.join(process.env.FAVSYNC_BROWSER_PROFILES || path.join(dataDir(), 'browser-profiles'), n);
}

// 每个目录一条队列：acquire 返回 release；同目录的下一个 acquire 要等前一个 release
const queues = new Map();
export function acquireProfile(dir) {
  const prev = queues.get(dir) ?? Promise.resolve();
  let release;
  const mine = new Promise((r) => { release = r; });
  const chain = prev.then(() => mine);
  queues.set(dir, chain);
  return prev.then(() => () => { release(); if (queues.get(dir) === chain) queues.delete(dir); });
}
export const profileBusy = (dir) => queues.has(dir);

// 开一个持久 profile 的浏览器上下文：等队列 → 试 chrome / msedge → 把 close() 包一层，关掉时放锁。
// launcher 可注入（测试用假的）；headless 默认 true。
export async function launchProfile(name = DEFAULT_PROFILE, { headless = true, launcher = null, viewport = { width: 1366, height: 900 }, timeoutMs = 10 * 60000 } = {}) {
  const dir = profileDir(name);
  const pending = acquireProfile(dir);
  let timer;
  const release = await Promise.race([pending, new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('等浏览器 profile 空出来超时（上一轮同步还占着）')), timeoutMs); })])
    .catch((e) => { pending.then((rel) => rel()); throw e; })   // 超时放弃：轮到我时立刻放锁，别卡死后面的人
    .finally(() => clearTimeout(timer));
  let ctx = null, lastErr = null;
  try {
    const open = launcher ?? (async (d, opts) => {
      const { chromium } = await import('playwright-core');
      for (const channel of ['chrome', 'msedge']) {
        try { return await chromium.launchPersistentContext(d, { channel, ...opts }); } catch (e) { lastErr = e; }
      }
      throw new Error(`开不了浏览器（${lastErr?.message?.split('\n')[0] ?? '本机没有可用的 Chrome/Edge'}）`);
    });
    ctx = await open(dir, { headless, viewport, locale: 'zh-CN' });
  } catch (e) { release(); throw e; }
  const origClose = ctx.close.bind(ctx);
  let released = false;
  ctx.close = async (...a) => { try { return await origClose(...a); } finally { if (!released) { released = true; release(); } } };
  ctx.profileDir = dir;
  return ctx;
}
