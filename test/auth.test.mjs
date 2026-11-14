// 鉴权：本机免验证、远程要令牌（Bearer 或 ?token=）、推送接口只认令牌；油猴脚本安装码 24 小时多次可用；登录口令 15 分钟一次性。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = mkdtempSync(path.join(tmpdir(), 'favsync-auth-test-'));
process.env.FAVSYNC_DB = path.join(dir, 'test.db');
process.env.FAVSYNC_DATA = path.join(dir, 'data');
delete process.env.FAVSYNC_TOKEN;
const { db } = await import('../src/db.js');
const a = await import('../src/auth.js');
after(() => { try { db.close(); } catch { /* 已关 */ } try { rmSync(dir, { recursive: true, force: true }); } catch { /* 临时目录 */ } });

const req = (ip, headers = {}, query = {}, url = '/api/library') => ({ socket: { remoteAddress: ip }, headers, query, originalUrl: url, url });
const res = () => { const r = { code: 200, body: null, status(c) { r.code = c; return r; }, json(b) { r.body = b; return r; } }; return r; };

test('isLocal：回环地址直连是本机；局域网/外网不是；经反向代理转发的（带 x-forwarded-*）哪怕 socket 是回环也不是', () => {
  assert.equal(a.isLocal(req('127.0.0.1')), true);
  assert.equal(a.isLocal(req('::1')), true);
  assert.equal(a.isLocal(req('::ffff:127.0.0.1')), true);
  assert.equal(a.isLocal(req('10.0.0.8')), false);
  assert.equal(a.isLocal(req('')), false);
  assert.equal(a.isLocal(req('127.0.0.1', { 'x-forwarded-for': '10.0.0.5' })), false);
  assert.equal(a.isLocal(req('127.0.0.1', { 'x-forwarded-host': 'example.test' })), false);
  assert.equal(a.isLocal(req('127.0.0.1', { 'x-real-ip': '10.0.0.5' })), false);
});

test('令牌：没配 FAVSYNC_TOKEN 就自动生成并落盘，重读一致', () => {
  const t = a.apiToken();
  assert.ok(t.length >= 24);
  assert.ok(existsSync(path.join(dir, 'data', 'token.json')));
  assert.equal(JSON.parse(readFileSync(path.join(dir, 'data', 'token.json'), 'utf-8')).token, t);
  assert.equal(a.apiToken(), t);
});

test('authMiddleware：本机放行；远程无令牌 401；Bearer / ?token= 都认；/api/health 永远放行', () => {
  const t = a.apiToken();
  let passed = 0; const next = () => passed++;
  a.authMiddleware(req('127.0.0.1'), res(), next); assert.equal(passed, 1);
  const r1 = res(); a.authMiddleware(req('10.0.0.8'), r1, next); assert.equal(r1.code, 401); assert.equal(r1.body.need_token, true); assert.equal(passed, 1);
  a.authMiddleware(req('10.0.0.8', { authorization: 'Bearer ' + t }), res(), next); assert.equal(passed, 2);
  a.authMiddleware(req('10.0.0.8', {}, { token: t }), res(), next); assert.equal(passed, 3);
  const r2 = res(); a.authMiddleware(req('10.0.0.8', { authorization: 'Bearer nope' }), r2, next); assert.equal(r2.code, 401);
  a.authMiddleware(req('10.0.0.8', {}, {}, '/api/health'), res(), next); assert.equal(passed, 4);
});

test('needToken：推送接口本机也必须带令牌（防止任意网页往 localhost 灌数据）', () => {
  const r1 = res(); assert.equal(a.needToken(req('127.0.0.1'), r1), true); assert.equal(r1.code, 401);
  assert.equal(a.needToken(req('127.0.0.1', { authorization: 'Bearer ' + a.apiToken() }), res()), false);
  assert.equal(a.privileged(req('127.0.0.1')), true); assert.equal(a.privileged(req('10.0.0.8')), false);
});

test('安装码：发出来就有效，可多次用；乱码/空值无效；24 小时后失效', () => {
  const { code, expires_in } = a.issueInstallCode();
  assert.ok(code.length >= 12 && !/[+/=]/.test(code), 'base64url，能放进路径');
  assert.equal(expires_in, 86400);
  assert.equal(a.installCodeValid(code), true);
  assert.equal(a.installCodeValid(code), true, '不是一次性的');
  assert.equal(a.installCodeValid(code + 'x'), false);
  assert.equal(a.installCodeValid(''), false); assert.equal(a.installCodeValid(undefined), false);
  const realNow = Date.now;
  Date.now = () => realNow() + 25 * 3600 * 1000;
  try { assert.equal(a.installCodeValid(code), false, '24 小时后失效'); } finally { Date.now = realNow; }
});

test('登录口令：6 位数字、15 分钟、按站点、用一次就作废', () => {
  const { code, expires_in } = a.issueLoginTicket('x');
  assert.match(code, /^\d{6}$/); assert.equal(expires_in, 900);
  assert.equal(a.loginTicketOk('x', code), true);
  assert.equal(a.loginTicketOk('x', '000000'), false);
  assert.equal(a.loginTicketOk('weibo', code), false, '别的站不认');
  a.consumeLoginTicket('x');
  assert.equal(a.loginTicketOk('x', code), false);
  const t2 = a.issueLoginTicket('x');
  const realNow = Date.now; Date.now = () => realNow() + 16 * 60000;
  try { assert.equal(a.loginTicketOk('x', t2.code), false, '过期'); } finally { Date.now = realNow; }
});

test('配对链接：生成带 token 的收藏库地址；从地址里取 token、再把它去掉（手机扫码后地址栏不留令牌）', () => {
  const url = a.pairUrl('http://10.0.0.2:3460/', 'ab+c/d=');
  assert.equal(url, 'http://10.0.0.2:3460/library.html?token=ab%2Bc%2Fd%3D');
  assert.equal(a.tokenFromUrl(url), 'ab+c/d=');
  assert.equal(a.tokenFromUrl('/library.html?tag=x&token=%20t1%20#h'), 't1');
  assert.equal(a.tokenFromUrl('/library.html?tag=x'), null);
  assert.equal(a.tokenFromUrl('/library.html?token='), null);
  assert.equal(a.tokenFromUrl('::not a url::'), null);
  assert.equal(a.stripTokenFromUrl('/library.html?tag=x&token=t1#h'), '/library.html?tag=x#h');
  assert.equal(a.stripTokenFromUrl('/library.html?token=t1'), '/library.html');
});

test('重置令牌：旧的作废、新的落盘；环境变量指定时不能重置', () => {
  const old = a.apiToken();
  const next = a.resetToken();
  assert.ok(next && next !== old);
  assert.equal(a.apiToken(), next);
  assert.equal(JSON.parse(readFileSync(path.join(dir, 'data', 'token.json'), 'utf-8')).token, next);
  const r = res(); a.authMiddleware(req('10.0.0.8', { authorization: 'Bearer ' + old }), r, () => {}); assert.equal(r.code, 401, '旧令牌不再放行');
  process.env.FAVSYNC_TOKEN = 'fixed';
  try { assert.equal(a.tokenFromEnv(), true); assert.equal(a.resetToken(), null); assert.equal(a.apiToken(), 'fixed'); } finally { delete process.env.FAVSYNC_TOKEN; }
});
