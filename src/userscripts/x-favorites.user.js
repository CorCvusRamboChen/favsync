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
  // —— 面板文案 zh / en（按浏览器语言）——
  const LANG = /^zh/i.test(navigator.language || '') ? 'zh' : 'en';
  const T = {
    "zh": {
      "title": "FavSync · X 点赞 / 书签",
      "acct": "账号：@{h}",
      "acct_none": "账号：还没认出来（点赞页地址里有）",
      "got": "抄到 点赞 <b>{l}</b> · 书签 <b>{b}</b> · 已推送 <b>{p}</b>",
      "pending": " · 待推 {n}",
      "stop": "停下",
      "start": "自动翻到底",
      "push": "推送",
      "hint_ready": "页面已经在加载列表，点「自动翻到底」，或者自己慢慢滚也行",
      "hint_open": "打开「点赞」或「书签」页，它一加载我就开始记",
      "blocked": "X 接口回了 {s}",
      "blocked_stop": "X 开始限流（{s}），已停下。过一会儿再来",
      "pushed_msg": "已推送 {p} 条",
      "push_fail": "推送失败：{e}",
      "open_first": "先打开 x.com/你的用户名/likes 或 x.com/i/bookmarks",
      "scrolling": "自动翻页中（最多 {cap} 条）…别动这个标签页",
      "login": "页面让你登录，先登一下再来",
      "cap_hit": "到 {cap} 条上限了，先停（油猴菜单可改）",
      "rest": "歇一下（已抄到 {n} 条）…",
      "bottom": "翻到底了",
      "idle": "20 秒没有新条目，可能到底了",
      "stopped": "已停下",
      "conn_fail": "连不上 FavSync（它开着吗？）",
      "bad_json": "FavSync 返回了非 JSON：{s}",
      "timeout": "FavSync 响应超时",
      "m_start": "X 点赞/书签：自动翻到底",
      "m_cap": "X 点赞/书签：设置每次上限",
      "p_cap": "每次最多翻多少条？（默认 500）"
    },
    "en": {
      "title": "FavSync · X likes / bookmarks",
      "acct": "Account: @{h}",
      "acct_none": "Account: not detected yet (it is in the likes page URL)",
      "got": "Collected likes <b>{l}</b> · bookmarks <b>{b}</b> · pushed <b>{p}</b>",
      "pending": " · {n} queued",
      "stop": "Stop",
      "start": "Auto-scroll",
      "push": "Push",
      "hint_ready": "The timeline is loading — click Auto-scroll, or scroll yourself",
      "hint_open": "Open your Likes or Bookmarks page; collection starts as soon as it loads",
      "blocked": "X API returned {s}",
      "blocked_stop": "X is rate-limiting ({s}); stopped. Come back later",
      "pushed_msg": "Pushed {p}",
      "push_fail": "Push failed: {e}",
      "open_first": "Open x.com/<you>/likes or x.com/i/bookmarks first",
      "scrolling": "Auto-scrolling (up to {cap})… leave this tab alone",
      "login": "The page asks you to sign in — do that first",
      "cap_hit": "Reached the {cap} limit; stopping (change it in the Tampermonkey menu)",
      "rest": "Resting (collected {n})…",
      "bottom": "Reached the end",
      "idle": "Nothing new for 20 s — probably the end",
      "stopped": "Stopped",
      "conn_fail": "Cannot reach FavSync (is it running?)",
      "bad_json": "FavSync returned non-JSON: {s}",
      "timeout": "FavSync timed out",
      "m_start": "X likes/bookmarks: auto-scroll",
      "m_cap": "X likes/bookmarks: set limit",
      "p_cap": "Max items per run? (default 500)"
    }
  };
  const L = (k, v) => { let s = (T[LANG] && T[LANG][k]) || T.zh[k] || k; if (v) for (const [a, b] of Object.entries(v)) s = s.split('{' + a + '}').join(String(b)); return s; };
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
    if ((status === 429 || status === 403) && ANY_API_RE.test(url)) { blocked = L('blocked', { s: status }); stopScroll(L('blocked_stop', { s: status })); return; }
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
      onload: (r) => { try { resolve(JSON.parse(r.responseText)); } catch { reject(new Error(L('bad_json', { s: r.status }))); } },
      onerror: () => reject(new Error(L('conn_fail'))), ontimeout: () => reject(new Error(L('timeout'))),
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
      say(L('pushed_msg', { p: pushed }) + (account ? ' · @' + account : ''));
    } catch (e) { pending.unshift(...batch); say(L('push_fail', { e: e.message }), true); }
    finally { pushing = false; paint(); }
  }

  // —— 3. 像人一样往下翻 ——
  let scrolling = false, rounds = 0;
  const onListPage = () => /\/likes(\?|$)|\/i\/bookmarks/.test(location.pathname);
  async function startScroll() {
    if (scrolling) return;
    if (!onListPage()) { say(L('open_first'), true); return; }
    cap = cfg('fs_x_cap', 500); scrolling = true; blocked = null; rounds = 0; lastNewAt = Date.now(); hasMore = true;
    say(L('scrolling', { cap })); paint();
    while (scrolling) {
      if (document.querySelector('[data-testid="LoginForm_Login_Button"], a[href="/login"][data-testid]')) { stopScroll(L('login')); break; }
      if (seen.size >= cap) { stopScroll(L('cap_hit', { cap })); break; }
      W.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' });
      rounds++;
      await sleep(rand(1500, 3000));
      if (rounds % 8 === 0) { say(L('rest', { n: seen.size })); await sleep(rand(5000, 10000)); }
      if (!scrolling) break;
      if (!hasMore) { stopScroll(L('bottom')); break; }
      if (Date.now() - lastNewAt > 20000) { stopScroll(L('idle')); break; }
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
    box.innerHTML = `<div style="font-weight:600;margin-bottom:2px">${L('title')}</div>
      <div style="opacity:.75;font-size:11.5px">${account ? L('acct', { h: account }) : L('acct_none')}</div>
      <div style="opacity:.8;margin-top:2px">${L('got', { l: likes, b: bms, p: pushed })}${pending.length ? L('pending', { n: pending.length }) : ''}</div>
      <div style="margin:6px 0;display:flex;gap:6px;flex-wrap:wrap">${scrolling ? btn(L('stop'), 'stop') : btn(L('start'), 'start', true)}${pending.length ? btn(L('push'), 'push') : ''}</div>
      <div style="margin-top:4px;color:${bad ? '#ff9a8a' : 'rgba(250,250,250,.7)'}">${msg || (hits ? L('hint_ready') : L('hint_open'))}</div>`;
    box.querySelectorAll('[data-fn]').forEach((el) => { el.onclick = () => ({ start: startScroll, stop: () => stopScroll(L('stopped')), push: pushBatch })[el.dataset.fn]?.(); });
  }
  const boot = () => { paint(); setInterval(() => { if (!account) accountFromPage(); paint(); }, 4000); setInterval(() => { if (pending.length) pushBatch(); }, 15000); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
  try {
    GM_registerMenuCommand(L('m_start'), startScroll);
    GM_registerMenuCommand(L('m_cap'), () => { const v = Number(prompt(L('p_cap'), String(cfg('fs_x_cap', 500)))); if (v > 0) GM_setValue('fs_x_cap', v); });
  } catch { /* 略 */ }
})();
