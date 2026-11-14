// ==UserScript==
// @name         FavSync · 微博收藏同步
// @namespace    favsync
// @version      0.1.1
// @description  在你已登录的微博网页版里，把「我的收藏」一页页翻完，推给本机的 FavSync 收藏库；图片和视频文件也一并存到本机存档。只读，不改微博上任何东西。
// @match        https://weibo.com/*
// @match        https://www.weibo.com/*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @connect      localhost
// @connect      127.0.0.1
// @connect      __SERVER_HOST__
// @connect      weibo.com
// @connect      sinaimg.cn
// @connect      weibocdn.com
// @connect      video.weibo.com
// @connect      *
// ==/UserScript==

// 微博网页版的收藏接口不要签名，只要登录 cookie + XSRF 头，所以脚本可以自己一页页请求：
//   GET /ajax/favorites/all_fav?uid=<我的uid>&page=<n>&with_total=true → { data:{ status:[mblog…], total_number } }（2026-10 前是 { data:[mblog…], total_number }）
// 同时也"旁听"页面自己发出的收藏响应（你手动翻收藏时顺手就同步了）。
// 参考了 Chilfish/Weibo-archiver 对这个接口和 mblog 字段的整理（pic_infos / page_info / retweeted_status），没有搬代码。
(function () {
  'use strict';
  // —— 面板文案 zh / en（按浏览器语言）——
  const LANG = /^zh/i.test(navigator.language || '') ? 'zh' : 'en';
  const T = {
    "zh": {
      "title": "FavSync · 微博收藏",
      "got": "抄到 <b>{n}</b>{total} 条 · 已推送 <b>{p}</b> 条",
      "media": " · 媒体 {ok}✓",
      "mediafail": " {f}✗",
      "stop": "停下",
      "start": "全部翻完并同步",
      "push": "推送 {n} 条",
      "savemedia": "存媒体文件",
      "opt_media": "同时把图片/视频存到本机",
      "hint": "在微博任意页面点上面开始，它自己一页页翻你的收藏",
      "no_uid": "没拿到你的 uid（在微博首页登录后再试）",
      "page": "翻第 {p} 页…已抄到 {n}{total} 条",
      "done": "翻完了：{n} 条，已推送 {p} 条",
      "err": "出错：{e}",
      "push_fail": "推送失败：{e}",
      "media_item": "存媒体文件 {i}：{id}",
      "wall": "视频内容像登录墙",
      "no_video": "没有视频直链",
      "media_done": "媒体文件：存好 {ok} 条",
      "media_done_fail": "，失败 {f} 条（下次重试，最多 3 次）",
      "media_err": "媒体阶段出错：{e}",
      "stopped": "已停下",
      "conn_fail": "连不上 FavSync（它开着吗？）",
      "bad_json": "FavSync 返回了非 JSON：{s}",
      "timeout": "FavSync 响应超时",
      "m_all": "微博收藏：全部翻完并同步",
      "m_show": "微博收藏：显示面板"
    },
    "en": {
      "title": "FavSync · Weibo favorites",
      "got": "Collected <b>{n}</b>{total} · pushed <b>{p}</b>",
      "media": " · media {ok}✓",
      "mediafail": " {f}✗",
      "stop": "Stop",
      "start": "Sync all",
      "push": "Push {n}",
      "savemedia": "Save media",
      "opt_media": "Also save images / videos locally",
      "hint": "Click above on any weibo.com page; it pages through your favorites by itself",
      "no_uid": "Could not read your uid (sign in on the Weibo home page first)",
      "page": "Page {p}… collected {n}{total}",
      "done": "Done: {n} items, pushed {p}",
      "err": "Error: {e}",
      "push_fail": "Push failed: {e}",
      "media_item": "Saving media {i}: {id}",
      "wall": "video looks like a login wall",
      "no_video": "no video URL",
      "media_done": "Media: saved {ok}",
      "media_done_fail": ", {f} failed (retried next time, up to 3)",
      "media_err": "Media phase error: {e}",
      "stopped": "Stopped",
      "conn_fail": "Cannot reach FavSync (is it running?)",
      "bad_json": "FavSync returned non-JSON: {s}",
      "timeout": "FavSync timed out",
      "m_all": "Weibo favorites: sync all",
      "m_show": "Weibo favorites: show panel"
    }
  };
  const L = (k, v) => { let s = (T[LANG] && T[LANG][k]) || T.zh[k] || k; if (v) for (const [a, b] of Object.entries(v)) s = s.split('{' + a + '}').join(String(b)); return s; };
  const SERVER = '__SERVER__';
  const TOKEN = '__TOKEN__';
  const W = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  const LIST_RE = /\/ajax\/favorites\/all_fav/;

  const seen = new Map();
  const pendingPush = [];
  let pushed = 0, total = null, running = null, listHits = 0;
  function absorb(json) {
    // 2026-10 起接口是 { data: { status: [...], total_number } }，之前是 { data: [...], total_number }
    const d = json?.data;
    const list = Array.isArray(d) ? d : Array.isArray(d?.status) ? d.status : Array.isArray(json?.list) ? json.list : null;
    if (!Array.isArray(list)) return 0;
    listHits++;
    const t = d?.total_number ?? json?.total_number;
    if (Number.isFinite(Number(t))) total = Number(t);
    let fresh = 0;
    for (const m of list) {
      const id = String(m?.idstr ?? m?.id ?? '');
      if (!id || seen.has(id)) continue;
      seen.set(id, m); pendingPush.push(m); fresh++;
    }
    paint();
    if (pendingPush.length >= 20) pushBatch();
    return fresh;
  }
  // 旁听页面自己的请求
  const xo = W.XMLHttpRequest.prototype.open, xs = W.XMLHttpRequest.prototype.send;
  W.XMLHttpRequest.prototype.open = function (m, url) { this.__fs_url = String(url ?? ''); return xo.apply(this, arguments); };
  W.XMLHttpRequest.prototype.send = function () {
    if (LIST_RE.test(this.__fs_url ?? '')) this.addEventListener('load', () => { try { absorb(JSON.parse(this.responseText)); } catch { /* 略 */ } });
    return xs.apply(this, arguments);
  };
  const f0 = W.fetch;
  W.fetch = function (input, init) {
    const p = f0.apply(this, arguments);
    try { const url = typeof input === 'string' ? input : input?.url ?? ''; if (LIST_RE.test(url)) p.then((res) => res.clone().json().then(absorb).catch(() => {})); } catch { /* 略 */ }
    return p;
  };

  // —— 自己翻：uid 从页面配置拿，XSRF 从 cookie 拿 ——
  const cookie = (k) => (document.cookie.match(new RegExp('(?:^|; )' + k + '=([^;]*)')) ?? [])[1];
  // uid：微博网页版把登录用户放在 window.$CONFIG；拿不到就从页面里"我的主页"链接 /u/<uid> 猜
  const myUid = () => W.$CONFIG?.uid ?? W.$CONFIG?.user?.idstr ?? W.$CONFIG?.user?.id
    ?? (document.querySelector('a[href*="/u/"]')?.getAttribute('href')?.match(/\/u\/(\d{5,})/) ?? [])[1] ?? null;
  async function fetchPage(page) {
    const uid = myUid();
    if (!uid) throw new Error(L('no_uid'));
    const res = await f0(`https://weibo.com/ajax/favorites/all_fav?uid=${encodeURIComponent(uid)}&page=${page}&with_total=true`, {
      credentials: 'include', headers: { 'X-XSRF-TOKEN': cookie('XSRF-TOKEN') ?? '', 'X-Requested-With': 'XMLHttpRequest', Accept: 'application/json' } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }
  async function crawlAll() {
    if (running) return;
    running = true; paint();
    try {
      let page = 1, empty = 0;
      while (running && page < 2000) {
        say(L('page', { p: page, n: seen.size, total: total != null ? ' / ' + total : '' }));
        const json = await fetchPage(page);
        const list = json?.data ?? [];
        const fresh = absorb(json);
        if (!list.length) break;
        if (!fresh && ++empty >= 3) break;   // 连续三页全是已经抄过的，说明到头了
        if (total != null && seen.size >= total) break;
        page++;
        await new Promise((r) => setTimeout(r, 900 + Math.random() * 600));   // 别太急
      }
      await pushBatch();
      say(L('done', { n: seen.size, p: pushed }));
      await mediaPhase();
    } catch (e) { say(L('err', { e: e.message }), true); }
    finally { running = null; paint(); }
  }

  // —— 和 FavSync 通信 ——
  function api(method, path, body) {
    return new Promise((resolve, reject) => GM_xmlhttpRequest({
      method, url: SERVER + path, timeout: 120000,
      headers: { Authorization: 'Bearer ' + TOKEN, ...(body instanceof ArrayBuffer ? { 'Content-Type': 'application/octet-stream' } : body ? { 'Content-Type': 'application/json' } : {}) },
      data: body instanceof ArrayBuffer ? body : body ? JSON.stringify(body) : undefined,
      onload: (r) => { try { resolve(JSON.parse(r.responseText)); } catch { reject(new Error(L('bad_json', { s: r.status }))); } },
      onerror: () => reject(new Error(L('conn_fail'))), ontimeout: () => reject(new Error(L('timeout'))),
    }));
  }
  async function pushBatch() {
    if (!pendingPush.length) return;
    const items = pendingPush.splice(0, pendingPush.length);
    try { const r = await api('POST', '/api/weibo/push', { items }); pushed += r.added + r.updated; }
    catch (e) { pendingPush.unshift(...items); say(L('push_fail', { e: e.message }), true); }
    paint();
  }

  // —— 媒体：图和视频用登录态下好传回去 ——
  const wantMedia = () => GM_getValue('fs_media', true);
  let mediaRunning = false, mediaDone = 0, mediaFail = 0;
  function download(url) {
    return new Promise((resolve, reject) => GM_xmlhttpRequest({
      method: 'GET', url, responseType: 'arraybuffer', timeout: 180000, headers: { Referer: 'https://weibo.com/', Accept: '*/*' },
      onload: (r) => (r.status === 200 && r.response?.byteLength ? resolve(r.response) : reject(new Error('HTTP ' + r.status))),
      onerror: () => reject(new Error('下载失败')), ontimeout: () => reject(new Error('下载超时')),
    }));
  }
  async function mediaPhase() {
    if (!wantMedia() || mediaRunning) return;
    mediaRunning = true;
    try {
      for (let round = 0; round < 300; round++) {
        const { items } = await api('GET', '/api/weibo/pending?limit=6');
        if (!items?.length) break;
        for (const it of items) {
          say(L('media_item', { i: mediaDone + 1, id: it.weibo_id }));
          try {
            if (it.need_images) {
              if (it.cover_url) await api('POST', `/api/weibo/media/${it.weibo_id}?kind=cover`, await download(it.cover_url));
              for (let i = 0; i < (it.images?.length ?? 0); i++) await api('POST', `/api/weibo/media/${it.weibo_id}?kind=image&index=${i}`, await download(it.images[i]));
            }
            if (it.need_video && it.play_url) {
              const r = await api('POST', `/api/weibo/media/${it.weibo_id}?kind=video`, await download(it.play_url));
              if (r.suspicious) throw new Error(L('wall'));
            } else if (it.need_video) await api('POST', `/api/weibo/media/${it.weibo_id}/failed`, { error: L('no_video') });
            mediaDone++;
          } catch (e) { mediaFail++; await api('POST', `/api/weibo/media/${it.weibo_id}/failed`, { error: e.message }).catch(() => {}); }
          paint();
        }
      }
      say(L('media_done', { ok: mediaDone }) + (mediaFail ? L('media_done_fail', { f: mediaFail }) : ''));
    } catch (e) { say(L('media_err', { e: e.message }), true); }
    finally { mediaRunning = false; paint(); }
  }

  // —— 面板 ——
  let box, msg = '', bad = false;
  const onFavPage = () => /\/fav\b|favorites|collect/i.test(location.href) || seen.size > 0 || listHits > 0;
  function say(m, isBad = false) { msg = m; bad = isBad; paint(); }
  function paint() {
    if (!document.body) return;
    if (!onFavPage() && !GM_getValue('fs_always', false)) { if (box) box.style.display = 'none'; return; }
    if (!box) {
      box = document.createElement('div'); box.id = 'fs-weibo';
      box.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:999999;width:260px;background:rgba(20,20,22,.92);color:#fafafa;font:12.5px/1.5 system-ui,sans-serif;border-radius:10px;padding:10px 12px;box-shadow:0 6px 24px rgba(0,0,0,.4);backdrop-filter:blur(8px)';
      document.body.appendChild(box);
    }
    box.style.display = '';
    const btn = (label, fn, primary) => `<button data-fn="${fn}" style="border:0;border-radius:6px;padding:5px 9px;cursor:pointer;font-size:12px;${primary ? 'background:#fafafa;color:#000' : 'background:rgba(255,255,255,.14);color:#fafafa'}">${label}</button>`;
    box.innerHTML = `<div style="font-weight:600;margin-bottom:4px">${L('title')}</div>
      <div style="opacity:.8">${L('got', { n: seen.size, total: total != null ? ' / ' + total : '', p: pushed })}${mediaDone || mediaFail ? L('media', { ok: mediaDone }) + (mediaFail ? L('mediafail', { f: mediaFail }) : '') : ''}</div>
      <div style="margin:6px 0;display:flex;gap:6px;flex-wrap:wrap">${running ? btn(L('stop'), 'stop') : btn(L('start'), 'start', true)}${pendingPush.length ? btn(L('push', { n: pendingPush.length }), 'push') : ''}${!running && !mediaRunning ? btn(L('savemedia'), 'media') : ''}</div>
      <label style="display:flex;gap:6px;align-items:center;opacity:.85"><input type="checkbox" data-fn="media-toggle" ${wantMedia() ? 'checked' : ''}> ${L('opt_media')}</label>
      <div style="margin-top:6px;color:${bad ? '#ff9a8a' : 'rgba(250,250,250,.7)'}">${msg || L('hint')}</div>`;
    box.querySelectorAll('[data-fn]').forEach((el) => {
      const fn = el.dataset.fn;
      if (fn === 'media-toggle') el.onchange = () => GM_setValue('fs_media', el.checked);
      else el.onclick = () => ({ start: crawlAll, stop: () => { running = null; say(L('stopped')); }, push: pushBatch, media: mediaPhase })[fn]?.();
    });
  }
  const boot = () => { paint(); setInterval(paint, 4000); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
  try {
    GM_registerMenuCommand(L('m_all'), () => { GM_setValue('fs_always', true); crawlAll(); });
    GM_registerMenuCommand(L('m_show'), () => { GM_setValue('fs_always', true); paint(); });
  } catch { /* 略 */ }
})();
