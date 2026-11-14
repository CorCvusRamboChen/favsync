// 鉴权，尽量简单：
//   - 本机（127.0.0.1 直连、没有反向代理头）免鉴权，桌面上用起来和普通本地应用一样。
//   - 远程（手机、局域网、内网穿透）带一个访问令牌：Authorization: Bearer <token> 或 ?token=<token>。
//     令牌来自 FAVSYNC_TOKEN；没配就第一次启动时随机生成一个，存 data/token.json。
//   - 油猴脚本推送接口只认令牌（哪怕请求来自本机）：否则任何网页都能往 localhost 灌假数据。
//   - 两种一次性口令：油猴脚本安装码（24 小时，可多次用，放在 /install/<code>/xxx.user.js 的路径里，
//     Tampermonkey 只认 .user.js 结尾的地址）；登录口令（15 分钟、用一次，电脑端登录脚本凭它把 cookie 投回来）。
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { dataDir } from './db.js';

const tokenFile = () => path.join(dataDir(), 'token.json');
let cached = null;
export function apiToken() {
  if (process.env.FAVSYNC_TOKEN) return process.env.FAVSYNC_TOKEN;
  if (cached) return cached;
  try { cached = JSON.parse(readFileSync(tokenFile(), 'utf-8')).token; } catch { cached = null; }
  if (!cached) {
    cached = randomBytes(24).toString('base64url');
    mkdirSync(path.dirname(tokenFile()), { recursive: true });
    writeFileSync(tokenFile(), JSON.stringify({ token: cached, issued_at: new Date().toISOString() }, null, 2));
  }
  return cached;
}
const safeEq = (a, b) => { const x = Buffer.from(String(a ?? '')), y = Buffer.from(String(b ?? '')); return x.length === y.length && x.length > 0 && timingSafeEqual(x, y); };
export const tokenOf = (req) => (req.headers?.authorization ?? '').replace(/^Bearer\s+/i, '') || (req.query?.token ? String(req.query.token) : '');
export const hasToken = (req) => safeEq(tokenOf(req), apiToken());

// "是不是就在这台电脑上操作"。反向代理转发来的请求 socket 地址是回环地址，但一定带 x-forwarded-* 这类头，
// 据此识别"这是转发来的，不是本机"。伪造这些头只会让判定更严格，所以这个方向是安全的。
export function isLocal(req) {
  const h = req.headers ?? {};
  if (h['x-forwarded-for'] || h['x-forwarded-host'] || h['x-real-ip'] || h['forwarded']) return false;
  const ip = req.socket?.remoteAddress ?? '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

// /api 下的中间件：本机放行；远程要令牌。
export function authMiddleware(req, res, next) {
  const url = req.originalUrl || req.url;
  if (url.startsWith('/api/health')) return next();
  if (hasToken(req)) { req.auth = 'token'; return next(); }
  if (isLocal(req)) { req.auth = 'local'; return next(); }
  res.status(401).json({ error: '需要访问令牌（FAVSYNC_TOKEN / data/token.json），在设置页能看到', need_token: true });
}
// 推送类接口：必须带令牌（本机也要）
export function needToken(req, res) {
  if (hasToken(req)) return false;
  res.status(401).json({ error: '这个接口只认访问令牌' });
  return true;
}
// 高权限动作（开浏览器窗口、读本机文件、删账号）：本机或令牌
export const privileged = (req) => isLocal(req) || hasToken(req);

// —— 油猴脚本安装码：24 小时、可多次用、内存 ——
const installCodes = new Map();
const INSTALL_TTL = 24 * 3600 * 1000;
export function issueInstallCode() {
  const code = randomBytes(9).toString('base64url');
  for (const [c, exp] of installCodes) if (exp < Date.now()) installCodes.delete(c);
  installCodes.set(code, Date.now() + INSTALL_TTL);
  return { code, expires_in: INSTALL_TTL / 1000 };
}
export function installCodeValid(code) {
  const exp = installCodes.get(String(code ?? ''));
  if (!exp) return false;
  if (exp < Date.now()) { installCodes.delete(String(code)); return false; }
  return true;
}

// —— 登录口令：15 分钟、一次性、按站点 ——
const tickets = new Map();   // site -> { code, exp }
const TICKET_TTL = 15 * 60000;
export function issueLoginTicket(site) {
  const code = String(Math.floor(100000 + Math.random() * 900000));
  tickets.set(site, { code, exp: Date.now() + TICKET_TTL });
  return { code, expires_in: TICKET_TTL / 1000 };
}
export function loginTicketOk(site, code) {
  const t = tickets.get(site);
  return !!t && t.exp >= Date.now() && safeEq(code, t.code);
}
export const consumeLoginTicket = (site) => tickets.delete(site);
