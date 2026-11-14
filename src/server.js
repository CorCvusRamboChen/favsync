// FavSync 的 HTTP 层：收藏库页面、设置页、油猴脚本分发、各平台的推送/同步/媒体接口、缩略图、存档静态目录。
import express from 'express';
import path from 'node:path';
import { readFileSync, rmSync, mkdirSync, openSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { projectRoot, dataDir } from './db.js';
import { listItems, stats as libraryStats, listTags, setTags, itemView, updateItem, removeItem } from './store.js';
import { archiveRoot, setArchiveRoot, archiveStatus, archivesFor, writeIndex } from './archive.js';
import { flagAnimatedImages } from './connectors/favorites-archive.js';
import { thumbHandler } from './thumbs.js';
import { authMiddleware, needToken, privileged, isLocal, apiToken, issueInstallCode, installCodeValid } from './auth.js';
import { addClient, broadcast, clientCount } from './events.js';
import * as douyin from './connectors/douyin-favorites.js';
import * as weibo from './connectors/weibo-favorites.js';
import * as x from './connectors/x-favorites.js';
import { runSocialSync, socialStatus, SITES as SOCIAL_SITES, writeState as writeSocialState } from './connectors/social-sync.js';
import { createBackgroundJobs } from './background-jobs.js';

// 进程级兜底：某个库的一次网络抖动不该让定时同步整个停摆。打印得很吵，而不是静悄悄咽下去。
for (const ev of ['uncaughtException', 'unhandledRejection']) {
  process.on(ev, (err) => { console.error(`\n[!!] 未处理的 ${ev}，服务继续运行（这条应该被当成 bug 查）：`); console.error(err?.stack ?? err); });
}

const PORT = Number(process.env.PORT) || 3460;
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.get('/', (_req, res) => res.sendFile(path.join(projectRoot, 'public', 'library.html')));
app.use(express.static(path.join(projectRoot, 'public'), { index: false }));
// 缩略图与存档目录：路径本身就是存档里的相对路径，不走令牌（手机上 <img> 带不了 Authorization）
app.use('/thumb', thumbHandler());
app.use('/archive', (req, res, next) => express.static(archiveRoot(), { index: 'index.html', dotfiles: 'deny', fallthrough: false })(req, res, next));

const wrap = (handler, status = 400, { log = false } = {}) => async (req, res) => {
  try { await handler(req, res); }
  catch (e) { if (log) console.error(e); res.status(status).json({ error: e.message }); }
};
const forbid = (res, msg = '只能在服务器本机操作，或带访问令牌') => res.status(403).json({ error: msg });

app.use('/api', authMiddleware);
app.get('/api/health', (_req, res) => res.json({ ok: true, name: 'favsync', clients: clientCount() }));
app.get('/api/auth/whoami', (req, res) => res.json({ local: isLocal(req), auth: req.auth }));
// 令牌只给本机看（远程设备要先拿到它才能连进来，所以只能在服务器上看/复制）
app.get('/api/auth/token', (req, res) => (isLocal(req) ? res.json({ token: apiToken(), public_url: publicUrl() }) : forbid(res, '令牌只能在服务器本机查看')));

// —— SSE：页面实时刷新 ——
app.get('/api/events', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders?.();
  const off = addClient(res);
  req.on('close', off);
});

// —— 收藏库 ——
app.get('/api/library', (req, res) => {
  const items = archivesFor(listItems({ kind: req.query.kind, tag: req.query.tag, exclude_tag: req.query.exclude_tag, source: req.query.source, media: req.query.media, q: req.query.q, limit: req.query.limit, offset: req.query.offset }));
  res.json({ stats: libraryStats(), tags: listTags(), items });
});
app.get('/api/library/items/:id', (req, res) => { const it = itemView(req.params.id); it ? res.json(archivesFor([it])[0]) : res.status(404).json({ error: '没有这条' }); });
app.patch('/api/library/items/:id', wrap((req, res) => { if (!itemView(req.params.id)) return res.status(404).json({ error: '没有这条' }); res.json(updateItem(req.params.id, { title: req.body?.title, note: req.body?.note })); broadcast('change', { tool: 'item' }); }));
app.delete('/api/library/items/:id', wrap((req, res) => { if (!privileged(req)) return forbid(res); res.json(removeItem(req.params.id)); broadcast('change', { tool: 'item' }); }));
app.post('/api/library/tags', wrap((req, res) => {
  const id = Number(req.body?.item_id); if (!itemView(id)) return res.status(404).json({ error: '没有这条' });
  const tags = Array.isArray(req.body?.tags) ? req.body.tags : String(req.body?.tags ?? '').split(/[,，]/);
  res.json({ item_id: id, tags: setTags('link', id, tags) }); broadcast('change', { tool: 'tags' });
}));
app.get('/api/archive', (_req, res) => res.json(archiveStatus()));
app.post('/api/archive/root', wrap((req, res) => { if (!privileged(req)) return forbid(res); res.json({ root: setArchiveRoot(String(req.body?.root ?? '').trim() || null) }); }));
app.post('/api/archive/index', wrap((_req, res) => res.json(writeIndex()), 500));
app.post('/api/archive/flag-anim', wrap((req, res) => { if (!privileged(req)) return forbid(res); res.json(flagAnimatedImages({ limit: Math.min(Number(req.body?.limit) || 5000, 50000) })); }, 500));

// —— 油猴脚本分发 ——
// 脚本文件里带着访问令牌，所以不能随便公开：本机直接下；别的机器用设置页生成的安装链接（24 小时安装码）。
const publicUrl = () => (process.env.FAVSYNC_PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');
const USERSCRIPTS = { douyin: 'douyin-favorites.user.js', weibo: 'weibo-favorites.user.js', x: 'x-favorites.user.js' };
const INSTALL_REFUSED = '只能在服务器本机安装，或者用设置页生成的安装链接（带 24 小时安装码）';
app.post('/api/userscript/install-link', (req, res) => {
  const file = USERSCRIPTS[String(req.body?.script ?? '')];
  if (!file) return res.status(400).json({ error: 'script 只能是 douyin / weibo / x' });
  const { code, expires_in } = issueInstallCode();
  res.json({ url: `${publicUrl()}/install/${code}/${file}`, expires_in });
});
for (const file of Object.values(USERSCRIPTS)) {
  app.get([`/${file}`, `/install/:code/${file}`], (req, res) => {
    if (!(isLocal(req) || installCodeValid(req.params?.code))) return res.status(403).type('text/plain').send(INSTALL_REFUSED);
    const src = readFileSync(path.join(projectRoot, 'src', 'userscripts', file), 'utf-8')
      .replaceAll('__SERVER_HOST__', new URL(publicUrl()).hostname).replaceAll('__SERVER__', publicUrl()).replaceAll('__TOKEN__', apiToken());
    res.type('application/javascript; charset=utf-8').set('Cache-Control', 'no-store').send(src);
  });
}

// —— 抖音 ——
app.post('/api/douyin/push', express.json({ limit: '25mb' }), wrap((req, res) => {
  if (needToken(req, res)) return;
  const r = douyin.ingestFavorites(req.body?.items ?? [], { account: req.body?.account ?? null, folders: req.body?.folders ?? {} });
  if (Array.isArray(req.body?.music) && req.body.music.length) { const mr = douyin.ingestMusic(req.body.music, { account: req.body?.account ?? null }); r.music = { received: mr.received, added: mr.added, updated: mr.updated, invalid: mr.invalid }; r.added += mr.added; r.updated += mr.updated; }
  if (r.added || r.updated) broadcast('change', { tool: 'douyin_push' });
  res.json(r);
}, 400, { log: true }));
app.get('/api/douyin/pending', (req, res) => { if (needToken(req, res)) return; res.json({ items: douyin.pendingMedia(Math.min(Number(req.query.limit) || 6, 20)) }); });
app.post('/api/douyin/media/:awemeId', express.raw({ type: 'application/octet-stream', limit: '400mb' }), wrap((req, res) => {
  if (needToken(req, res)) return;
  const r = douyin.storeMedia(req.params.awemeId, { kind: String(req.query.kind ?? ''), index: Number(req.query.index) || 0, bytes: req.body });
  if (r.ok) broadcast('change', { tool: 'douyin_media' });
  res.json(r);
}));
app.post('/api/douyin/media/:awemeId/failed', (req, res) => { if (needToken(req, res)) return; res.json(douyin.markMediaFailed(req.params.awemeId, String(req.body?.error ?? '浏览器下载失败'))); });
app.get('/api/douyin/status', (_req, res) => res.json(douyin.favoritesStatus()));
// 服务端自己同步（无头 Chrome + 各账号的登录态）：翻 max_items 条，再下 media_limit 条媒体。要跑几分钟。
let douyinSyncRunning = false;
app.post('/api/douyin/sync', wrap(async (req, res) => {
  if (!privileged(req)) return forbid(res);
  if (douyinSyncRunning) return res.status(409).json({ error: '上一轮还在跑' });
  douyinSyncRunning = true;
  try {
    const b = req.body ?? {};
    const maxItems = Math.min(Number(b.max_items) || 20, 500);
    const acct = b.account ? String(b.account) : 'all';
    const accts = acct === 'all' ? douyin.listAccounts().filter((a) => !a.need_login || b.full === true).map((a) => a.id) : [acct];
    const maxMs = Math.min(Number(b.max_ms) || 150000, 900000);
    const foldersOpts = { maxFolders: Math.min(Number(b.max_folders) || 60, 200), maxMs: Math.min(Number(b.max_ms) || 900000, 1800000), onlyNames: Array.isArray(b.folders) ? b.folders : null };
    const perAccount = async (fn) => { const out = { accounts: [], added: 0, updated: 0 }; for (const id of accts) { const r = await fn(id); out.accounts.push({ id, ...r }); out.added += r?.added ?? 0; out.updated += r?.updated ?? 0; if (r?.need_login) douyin.upsertAccount({ id, need_login: true }); } out.need_login = out.accounts.length > 0 && out.accounts.every((r) => r.need_login); return out; };
    // skip_list：只补媒体，不翻收藏页（少一次风控机会）；mode=folders：逐个收藏夹翻；mode=all：列表+音乐+收藏夹
    const list = b.skip_list === true ? { skipped: true }
      : b.mode === 'folders' ? await perAccount((id) => douyin.syncFolders({ ...foldersOpts, account: id }))
      : b.mode === 'all' ? await douyin.syncAllAccounts({ full: b.full === true, maxItems, maxMs, withMusic: b.with_music !== false, foldersMaxMs: foldersOpts.maxMs, maxFolders: foldersOpts.maxFolders, accounts: douyin.listAccounts().filter((a) => accts.includes(a.id)) })
      : await perAccount((id) => douyin.syncFavorites({ full: b.full === true, maxItems, maxMs, withMusic: b.with_music !== false, account: id }));
    let media = null;
    if (!list?.need_login && !list?.error && (Number(b.media_limit) ?? 10) > 0) {
      const mediaLimit = Math.min(Number(b.media_limit) || 10, 200);
      media = acct === 'all' ? await douyin.fetchPendingMediaAllAccounts({ limit: mediaLimit, video: b.video !== false }) : await douyin.fetchPendingMediaWithBrowser({ limit: mediaLimit, video: b.video !== false, account: acct });
    }
    if (list?.added || media?.files) broadcast('change', { tool: 'douyin_sync' });
    res.json({ list, media, status: douyin.favoritesStatus() });
  } finally { douyinSyncRunning = false; }
}, 500));
app.post('/api/douyin/fix-covers', wrap(async (req, res) => { if (!privileged(req)) return forbid(res); const r = await douyin.fixCroppedCovers({ limit: Math.min(Number(req.body?.limit) || 100, 2000) }); if (r.fixed) broadcast('change', { tool: 'douyin_media' }); res.json(r); }, 500));
// 多账号：注册表 + 网页里扫码登录（服务端无头浏览器把二维码导出来，手机抖音扫；每个账号独立 profile）
const douyinLogins = new Map();
const douyinLoginDir = (id) => path.join(dataDir(), 'douyin-login', id);
app.get('/api/douyin/accounts', (_req, res) => res.json({ accounts: douyin.listAccounts().map((a) => ({ ...a, logging_in: douyinLogins.get(a.id)?.child?.exitCode === null })) }));
app.delete('/api/douyin/accounts/:id', (req, res) => (privileged(req) ? res.json({ accounts: douyin.removeAccount(req.params.id) }) : forbid(res)));
app.post('/api/douyin/login/start', wrap(async (req, res) => {
  if (!privileged(req)) return forbid(res);
  const id = req.body?.account ? String(req.body.account).replace(/[^\w.-]+/g, '_').slice(0, 40) : douyin.newAccountId();
  if (!id) return res.status(400).json({ error: '账号 id 不对' });
  const cur = douyinLogins.get(id);
  if (cur && cur.child.exitCode === null) return res.json({ started: true, account: id, already: true });
  const profile = douyin.profileOf(id);
  douyin.upsertAccount({ id, profile });
  const dir = douyinLoginDir(id);
  rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
  const log = openSync(path.join(dir, 'login.log'), 'a');
  const child = spawn(process.execPath, [path.join(projectRoot, 'scripts', 'douyin-login-qr.mjs'), dir, '--profile', profile], { cwd: projectRoot, stdio: ['ignore', log, log], windowsHide: true, env: { ...process.env } });
  douyinLogins.set(id, { child, dir, started_at: Date.now() });
  res.json({ started: true, account: id, profile });
}, 500));
app.get('/api/douyin/login/status', (req, res) => {
  const id = String(req.query.account ?? '').replace(/[^\w.-]+/g, '_').slice(0, 40);
  if (!id) return res.status(400).json({ error: '缺 account' });
  const dir = douyinLoginDir(id);
  let status = 'starting';
  try { status = readFileSync(path.join(dir, 'douyin-login.status'), 'utf-8').trim() || 'starting'; } catch { /* 还没写 */ }
  const [head, a, b] = status.split(':');
  const state = ['logged_in', 'qr', 'timeout', 'error', 'noqr'].includes(head) ? head : 'starting';
  const running = douyinLogins.get(id)?.child?.exitCode === null;
  let nickname = null;
  if (state === 'logged_in') { nickname = a || null; douyin.upsertAccount({ id, nickname: nickname ?? undefined, need_login: false, last_login_at: new Date().toISOString() }); }
  let qr = null;
  if (state === 'qr') { try { qr = 'data:image/png;base64,' + readFileSync(path.join(dir, 'douyin-qr.png')).toString('base64'); } catch { /* 还没导出 */ } }
  res.json({ account: id, state: !running && state === 'starting' ? 'error' : state, nickname, qr, qr_at: state === 'qr' ? Number(b) || null : null, running, raw: status });
});

// —— 微博 ——
app.post('/api/weibo/push', express.json({ limit: '25mb' }), wrap((req, res) => {
  if (needToken(req, res)) return;
  const r = weibo.ingestFavorites(req.body?.items ?? []);
  if (r.added || r.updated) broadcast('change', { tool: 'weibo_push' });
  res.json(r);
}, 400, { log: true }));
let weiboFetchRunning = false;
const weiboFetchLoop = async (rounds = 40) => {   // 服务端下图：每轮 20 条，后台慢慢补，不阻塞请求
  if (weiboFetchRunning) return;
  weiboFetchRunning = true;
  try { for (let i = 0; i < rounds; i++) { const r = await weibo.fetchPendingMedia({ limit: 20 }); if (!r.tried) break; broadcast('change', { tool: 'weibo_media' }); } }
  catch (e) { console.error('[weibo media]', e.message); }
  finally { weiboFetchRunning = false; }
};
app.post('/api/weibo/import', wrap((req, res) => {
  if (!isLocal(req)) return forbid(res, '只能在服务器本机导入本机文件');
  const r = weibo.importExportFile(req.body?.path, { include_own: req.body?.include_own === true });
  if (r.added) broadcast('change', { tool: 'weibo_import' });
  res.json({ ...r, media_fetch_started: r.added > 0 });
  if (r.added) weiboFetchLoop(60);
}, 400, { log: true }));
app.post('/api/weibo/media/fetch', wrap(async (req, res) => { if (!privileged(req)) return forbid(res); res.json(await weibo.fetchPendingMedia({ limit: Math.min(Number(req.body?.limit) || 20, 100) })); }, 500));
app.get('/api/weibo/pending', (req, res) => { if (needToken(req, res)) return; res.json({ items: weibo.pendingMedia(Math.min(Number(req.query.limit) || 6, 20)) }); });
app.post('/api/weibo/media/:weiboId', express.raw({ type: 'application/octet-stream', limit: '400mb' }), wrap((req, res) => {
  if (needToken(req, res)) return;
  const r = weibo.storeMedia(req.params.weiboId, { kind: String(req.query.kind ?? ''), index: Number(req.query.index) || 0, bytes: req.body });
  if (r.ok) broadcast('change', { tool: 'weibo_media' });
  res.json(r);
}));
app.post('/api/weibo/media/:weiboId/failed', (req, res) => { if (needToken(req, res)) return; res.json(weibo.markMediaFailed(req.params.weiboId, String(req.body?.error ?? '浏览器下载失败'))); });
app.get('/api/weibo/status', (_req, res) => res.json({ ...weibo.favoritesStatus(), fetching: weiboFetchRunning }));

// —— X（Twitter）——
let xFetchRunning = false;
const xFetchLoop = async (rounds = 40) => {
  if (xFetchRunning) return;
  xFetchRunning = true;
  try { for (let i = 0; i < rounds; i++) { const r = await x.fetchPendingMedia({ limit: 20 }); if (!r.tried) break; broadcast('change', { tool: 'x_media' }); } }
  catch (e) { console.error('[x media]', e.message); }
  finally { xFetchRunning = false; }
};
app.post('/api/x/push', express.json({ limit: '25mb' }), wrap((req, res) => {
  if (needToken(req, res)) return;
  const kind = req.body?.kind === 'like' ? 'like' : 'bookmark';
  const r = x.ingestFavorites(req.body?.items ?? [], { kind, account: req.body?.account ?? null });
  if (r.added || r.updated) broadcast('change', { tool: 'x_push' });
  res.json(r);
  if (r.added) xFetchLoop(20);
}, 400, { log: true }));
app.post('/api/x/import', wrap((req, res) => {
  if (!isLocal(req)) return forbid(res, '只能在服务器本机导入本机文件');
  const r = x.importExportFile(req.body?.path, { kind: req.body?.kind ?? null, account: req.body?.account ?? null });
  if (r.added) broadcast('change', { tool: 'x_import' });
  res.json({ ...r, media_fetch_started: r.added > 0 });
  if (r.added) xFetchLoop(60);
}, 400, { log: true }));
app.post('/api/x/media/fetch', wrap(async (req, res) => { if (!privileged(req)) return forbid(res); res.json(await x.fetchPendingMedia({ limit: Math.min(Number(req.body?.limit) || 20, 100), video: req.body?.video !== false })); }, 500));
app.get('/api/x/status', (_req, res) => res.json({ ...x.favoritesStatus(), fetching: xFetchRunning, syncing: xSyncRunning }));
// 电脑端登录：设置页拿口令 → scripts/login-x.mjs 弹 Chrome 登录 → 凭口令把 cookie 投到 /x-login（不在 /api 下）→ 立刻同步一轮
app.post('/api/x/ticket', (req, res) => (privileged(req) ? res.json(x.issueTicket()) : forbid(res)));
let xSyncRunning = false;
const xSyncOnce = async (opts = {}) => {
  if (xSyncRunning) return { skipped: true, reason: '上一轮还在跑' };
  xSyncRunning = true;
  try {
    const r = await x.syncX(opts);
    if (r?.need_login) writeSocialState({ x: { need_login: true } }); else if (!r?.skipped) writeSocialState({ x: { need_login: false, last_sync: new Date().toISOString() } });
    if (r?.added || r?.updated) broadcast('change', { tool: 'x_sync' });
    if (r?.added) xFetchLoop(40);
    return r;
  } finally { xSyncRunning = false; }
};
app.post('/x-login', express.json({ limit: '256kb' }), wrap((req, res) => {
  if (!x.ticketOk(req.body?.code)) return res.status(403).json({ error: '口令不对或过期了，回设置页再拿一个' });
  const r = x.setCookies(req.body?.cookies, { handle: req.body?.handle ?? null });
  x.consumeTicket();
  writeSocialState({ x: { need_login: false } });
  broadcast('change', { tool: 'x_login' });
  res.json(r);
  xSyncOnce({ full: true }).catch((e) => console.error('[x sync]', e.message));
}, 403));
app.post('/api/x/sync', wrap(async (req, res) => { if (!privileged(req)) return forbid(res); res.json(await xSyncOnce({ full: req.body?.full === true, maxItems: Math.min(Number(req.body?.max_items) || 600, 5000), maxMs: Math.min(Number(req.body?.max_ms) || 240000, 900000) })); }, 500));
app.post('/api/x/logout', (req, res) => { if (!privileged(req)) return forbid(res); x.logout(); writeSocialState({ x: { need_login: true } }); res.json({ ok: true }); });

// —— 常态化同步（定时） ——
app.get('/api/social/status', (_req, res) => res.json({ ...socialStatus(), weibo: weibo.favoritesStatus(), douyin: douyin.favoritesStatus(), x: x.favoritesStatus() }));
app.post('/api/social/sync', wrap(async (req, res) => {
  if (!privileged(req)) return forbid(res);
  const sites = Array.isArray(req.body?.sites) ? req.body.sites.filter((s) => SOCIAL_SITES.includes(s)) : SOCIAL_SITES;
  res.json({ started: true, sites });   // 要开浏览器翻页，可能几分钟，不让请求挂着
  runSocialSync({ sites, full: req.body?.full === true, force: req.body?.force === true })
    .then((r) => { console.log('[social-sync]', JSON.stringify(r).slice(0, 600)); broadcast('change', { tool: 'social_sync' }); })
    .catch((e) => console.error('[social-sync]', e.message));
}, 500));
app.post('/api/social/settings', wrap((req, res) => {
  if (!privileged(req)) return forbid(res);
  for (const site of SOCIAL_SITES) if (req.body?.[`${site}_enabled`] !== undefined) writeSocialState({ [site]: { enabled: req.body[`${site}_enabled`] === true } });
  res.json(socialStatus());
}));
// 在服务器上弹出带界面的浏览器登录（服务器得有屏幕）；没屏幕用抖音扫码 / X 电脑端登录
app.post('/api/social/login', wrap(async (req, res) => {
  if (!isLocal(req)) return forbid(res, '只能在服务器本机操作（浏览器窗口要开在服务器上）');
  const site = String(req.body?.site ?? '');
  if (!['weibo', 'douyin'].includes(site)) return res.status(400).json({ error: 'site 只能是 weibo / douyin' });
  const child = spawn(process.execPath, [path.join(projectRoot, 'scripts', 'login-site.mjs'), site], { cwd: projectRoot, detached: true, stdio: 'ignore', windowsHide: false, env: { ...process.env, PORT: String(PORT) } });
  child.unref();
  res.json({ started: true, message: '浏览器窗口已打开，登录后会自动关闭并开始全量同步' });
}, 500));

app.use('/api', (_req, res) => res.status(404).json({ error: '没有这个接口' }));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[favsync] http://localhost:${PORT}  收藏库 /library.html  设置 /settings.html`);
  console.log(`[favsync] 数据目录 ${dataDir()}  存档目录 ${archiveRoot()}${existsSync(archiveRoot()) ? '' : '（还没建，第一条收藏进来时自动建）'}`);
  if (process.env.FAVSYNC_NO_JOBS !== '1') for (const job of createBackgroundJobs()) job.start();
});
