// ==UserScript==
// @name         FavSync · X 点赞/书签同步
// @namespace    favsync
// @version      0.1.0
// @description  在你已登录的 x.com 里，把「点赞」和「书签」慢慢翻一遍，推给 FavSync 收藏库；零额外请求，只旁听页面自己加载时间线的响应。
// @match        https://x.com/*
// @match        https://twitter.com/*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @connect      localhost
// @connect      127.0.0.1
// @connect      __SERVER_HOST__
// @connect      *
// ==/UserScript==

// 原则（和抖音脚本一样）：
//   1. 零额外请求：只旁听页面自己发的 GraphQL 响应（Likes / Bookmarks / BookmarkFolderTimeline），脚本不调 X 的任何接口。
//   2. 翻页像人：每次滚动随机 1.5–3 秒，每 8 次歇 5–10 秒，每次最多 N 条（默认 500）。
//   3. 一看苗头不对就停：接口回 429/403、页面让你重新登录 → 停下并告诉你。
//   4. 图片视频不在浏览器里下：X 的 CDN 是公开的，服务器自己去下，所以脚本只推文字和地址，很轻。
(function () {
  'use strict';
  const SERVER = '__SERVER__';
  const TOKEN = '__TOKEN__';
  const W = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  const GQL_RE = /\/i\/api\/graphql\/[^/]+\/(Likes|Bookmarks|BookmarkFolderTimeline|BookmarkSearchTimeline)(\?|$)/;
  const ANY_API_RE = /\/i\/api\//;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rand = (a, b) => a + Math.random() * (b - a);
  const cfg = (k, d) => { try { const v = GM_getValue(k); return v == null ? d : v; } catch { return d; } };

  // —— 1. 旁听时间线响应 ——
  const seen = new Map();          // tweet_id → raw tweet result
  const kindOf = new Map();        // tweet_id → Set('like'|'bookmark')
  const pending = [];              // 待推送 [{raw, kind}]
  let account = null, hits = 0, lastNewAt = 0, blocked = null, pushed = 0, hasMore = true, cap = cfg('fs_x_cap', 500);
  const unwrap = (r) => (r && r.__typename === 'TweetWithVisibilityResults' ? r.tweet : r);
  function* walkEntries(node, depth = 0) {
    if (!node || typeof node !== 'object' || depth > 12) return;
    if (Array.isArray(node)) { for (const x of node) yield* walkEntries(x, depth + 1); return; }
    if (Array.isArray(node.entries)) for (const e of node.entries) yield e;
    for (const k of Object.keys(node)) if (k !== 'entries') yield* walkEntries(node[k], depth + 1);
  }
  function absorb(url, text) {
    let d; try { d = JSON.parse(text); } catch { return; }
    const kind = /\/Likes/.test(url) ? 'like' : 'bookmark';
    let fresh = 0, total = 0, cursorBottom = false;
    for (const e of walkEntries(d)) {
      const id = String(e?.entryId ?? '');
      if (id.startsWith('cursor-bottom')) { cursorBottom = true; const v = e?.content?.value ?? ''; if (!v) hasMore = false; }
      if (!id.startsWith('tweet-')) continue;
      const r = unwrap(e?.content?.itemContent?.tweet_results?.result);
      const tid = r?.rest_id ?? r?.legacy?.id_str; if (!tid) continue;
      total++;
      if (!seen.has(tid)) { seen.set(tid, r); fresh++; }
      const ks = kindOf.get(tid) ?? new Set(); if (!ks.has(kind)) { ks.add(kind); kindOf.set(tid, ks); pending.push({ raw: r, kind }); }
    }
    hits++;
    if (fresh) lastNewAt = Date.now();
    if (total === 0 && cursorBottom) hasMore = false;
    if (!account) accountFromPage();
    if (pending.length >= 25) pushBatch();
    paint();
  }
  function sniff(url, status, text) {
    if ((status === 429 || status === 403) && ANY_API_RE.test(url)) { blocked = `X 接口回了 ${status}`; stopScroll('X 开始限流（' + status + '），已停下。过一会儿再来'); return; }
    if (text && GQL_RE.test(url)) absorb(url, text);
  }
  const xo = W.XMLHttpRequest.prototype.open, xs = W.XMLHttpRequest.prototype.send;
  W.XMLHttpRequest.prototype.open = function (m, url) { this.__fs_url = String(url ?? ''); return xo.apply(this, arguments); };
  W.XMLHttpRequest.prototype.send = function () {
    const u = this.__fs_url ?? '';
    if (ANY_API_RE.test(u)) this.addEventListener('load', () => { try { sniff(u, this.status, this.responseText); } catch { /* 略 */ } });
    return xs.apply(this, arguments);
  };
  const f0 = W.fetch;
  W.fetch = function (input, init) {
    const p = f0.apply(this, arguments);
    try {
      const url = typeof input === 'string' ? input : input?.url ?? '';
      if (ANY_API_RE.test(url)) p.then((res) => { try { res.clone().text().then((t) => sniff(url, res.status, t)).catch(() => {}); } catch { /* 略 */ } });
    } catch { /* 略 */ }
    return p;
  };
  // 当前账号：点赞页地址就是 /<handle>/likes；书签页从侧栏「个人资料」链接或头像里认
  function accountFromPage() {
    const m = location.pathname.match(/^\/([A-Za-z0-9_]{1,15})\/likes/);
    if (m) { account = m[1]; return; }
    const a = document.querySelector('a[data-testid="AppTabBar_Profile_Link"], a[aria-label="Profile"], a[aria-label="个人资料"]');
    const h = a?.getAttribute('href')?.replace(/^\//, '');
    if (h && /^[A-Za-z0-9_]{1,15}$/.test(h)) account = h;
  }

  // —— 2. 和 FavSync 通信 ——
  function api(method, path, body) {
    return new Promise((resolve, reject) => GM_xmlhttpRequest({
      method, url: SERVER + path, timeout: 120000,
      headers: { Authorization: 'Bearer ' + TOKEN, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      data: body ? JSON.stringify(body) : undefined,
      onload: (r) => { try { resolve(JSON.parse(r.responseText)); } catch { reject(new Error('FavSync 返回了非 JSON：' + r.status)); } },
      onerror: () => reject(new Error('连不上 FavSync（它开着吗？）')), ontimeout: () => reject(new Error('FavSync 响应超时')),
    }));
  }
  let pushing = false;
  async function pushBatch() {
    if (pushing || !pending.length) return;
    pushing = true;
    const batch = pending.splice(0, pending.length);
    const byKind = { like: [], bookmark: [] };
    for (const b of batch) byKind[b.kind].push(b.raw);
    try {
      for (const kind of ['like', 'bookmark']) {
        if (!byKind[kind].length) continue;
        const r = await api('POST', '/api/x/push', { items: byKind[kind], kind, account });
        pushed += (r.added ?? 0) + (r.updated ?? 0);
      }
      say(`已推送 ${pushed} 条${account ? ' · 账号 @' + account : ''}`);
    } catch (e) { pending.unshift(...batch); say('推送失败：' + e.message, true); }
    finally { pushing = false; paint(); }
  }

  // —— 3. 像人一样往下翻 ——
  let scrolling = false, rounds = 0;
  const onListPage = () => /\/likes(\?|$)|\/i\/bookmarks/.test(location.pathname);
  async function startScroll() {
    if (scrolling) return;
    if (!onListPage()) { say('先打开 x.com/你的用户名/likes 或 x.com/i/bookmarks', true); return; }
    cap = cfg('fs_x_cap', 500); scrolling = true; blocked = null; rounds = 0; lastNewAt = Date.now(); hasMore = true;
    say(`自动翻页中（最多 ${cap} 条）…别动这个标签页`); paint();
    while (scrolling) {
      if (document.querySelector('[data-testid="LoginForm_Login_Button"], a[href="/login"][data-testid]')) { stopScroll('页面让你登录，先登一下再来'); break; }
      if (seen.size >= cap) { stopScroll(`到 ${cap} 条上限了，先停（油猴菜单可改）`); break; }
      W.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' });
      rounds++;
      await sleep(rand(1500, 3000));
      if (rounds % 8 === 0) { say(`歇一下（已抄到 ${seen.size} 条）…`); await sleep(rand(5000, 10000)); }
      if (!scrolling) break;
      if (!hasMore) { stopScroll('翻到底了'); break; }
      if (Date.now() - lastNewAt > 20000) { stopScroll('20 秒没有新条目，可能到底了'); break; }
    }
    await pushBatch();
    paint();
  }
  function stopScroll(m) { scrolling = false; if (m) say(m); paint(); }

  // —— 4. 右下角的小面板 ——
  let box, msg = '', bad = false;
  function say(m, isBad = false) { msg = m; bad = isBad; paint(); }
  function paint() {
    if (!document.body) return;
    const show = onListPage() || seen.size > 0;
    if (!show) { if (box) box.style.display = 'none'; return; }
    if (!box) {
      box = document.createElement('div'); box.id = 'fs-x';
      box.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:999999;width:260px;background:rgba(20,20,22,.92);color:#fafafa;font:12.5px/1.5 system-ui,sans-serif;border-radius:10px;padding:10px 12px;box-shadow:0 8px 30px rgba(0,0,0,.4)';
      document.body.appendChild(box);
    }
    box.style.display = '';
    const btn = (label, fn, primary) => `<button data-fn="${fn}" style="border:0;border-radius:6px;padding:5px 9px;cursor:pointer;font-size:12px;${primary ? 'background:#fafafa;color:#000' : 'background:rgba(255,255,255,.14);color:#fafafa'}">${label}</button>`;
    const likes = [...kindOf.values()].filter((s) => s.has('like')).length, bms = [...kindOf.values()].filter((s) => s.has('bookmark')).length;
    box.innerHTML = `<div style="font-weight:600;margin-bottom:2px">FavSync · X 点赞 / 书签</div>
      <div style="opacity:.75;font-size:11.5px">${account ? '账号：@' + account : '账号：还没认出来（点赞页地址里有）'}</div>
      <div style="opacity:.8;margin-top:2px">抄到 点赞 <b>${likes}</b> · 书签 <b>${bms}</b> · 已推送 <b>${pushed}</b>${pending.length ? ` · 待推 ${pending.length}` : ''}</div>
      <div style="margin:6px 0;display:flex;gap:6px;flex-wrap:wrap">${scrolling ? btn('停下', 'stop') : btn('自动翻到底', 'start', true)}${pending.length ? btn('推送', 'push') : ''}</div>
      <div style="margin-top:4px;color:${bad ? '#ff9a8a' : 'rgba(250,250,250,.7)'}">${msg || (hits ? '页面已经在加载列表，点「自动翻到底」，或者自己慢慢滚也行' : '打开「点赞」或「书签」页，它一加载我就开始记')}</div>`;
    box.querySelectorAll('[data-fn]').forEach((el) => { el.onclick = () => ({ start: startScroll, stop: () => stopScroll('已停下'), push: pushBatch })[el.dataset.fn]?.(); });
  }
  const boot = () => { paint(); setInterval(() => { if (!account) accountFromPage(); paint(); }, 4000); setInterval(() => { if (pending.length) pushBatch(); }, 15000); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
  try {
    GM_registerMenuCommand('X 点赞/书签：自动翻到底', startScroll);
    GM_registerMenuCommand('X 点赞/书签：设置每次上限', () => { const v = Number(prompt('每次最多翻多少条？（默认 500）', String(cfg('fs_x_cap', 500)))); if (v > 0) GM_setValue('fs_x_cap', v); });
  } catch { /* 略 */ }
})();
