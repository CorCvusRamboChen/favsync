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
    if (!uid) throw new Error('没拿到你的 uid（在微博首页登录后再试）');
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
        say(`翻第 ${page} 页…已抄到 ${seen.size}${total != null ? ' / ' + total : ''} 条`);
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
      say(`翻完了：${seen.size} 条，已推送 ${pushed} 条`);
      await mediaPhase();
    } catch (e) { say('出错：' + e.message, true); }
    finally { running = null; paint(); }
  }

  // —— 和 FavSync 通信 ——
  function api(method, path, body) {
    return new Promise((resolve, reject) => GM_xmlhttpRequest({
      method, url: SERVER + path, timeout: 120000,
      headers: { Authorization: 'Bearer ' + TOKEN, ...(body instanceof ArrayBuffer ? { 'Content-Type': 'application/octet-stream' } : body ? { 'Content-Type': 'application/json' } : {}) },
      data: body instanceof ArrayBuffer ? body : body ? JSON.stringify(body) : undefined,
      onload: (r) => { try { resolve(JSON.parse(r.responseText)); } catch { reject(new Error('FavSync 返回了非 JSON：' + r.status)); } },
      onerror: () => reject(new Error('连不上 FavSync（它开着吗？）')), ontimeout: () => reject(new Error('FavSync 响应超时')),
    }));
  }
  async function pushBatch() {
    if (!pendingPush.length) return;
    const items = pendingPush.splice(0, pendingPush.length);
    try { const r = await api('POST', '/api/weibo/push', { items }); pushed += r.added + r.updated; }
    catch (e) { pendingPush.unshift(...items); say('推送失败：' + e.message, true); }
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
          say(`存媒体文件 ${mediaDone + 1}：${it.weibo_id}`);
          try {
            if (it.need_images) {
              if (it.cover_url) await api('POST', `/api/weibo/media/${it.weibo_id}?kind=cover`, await download(it.cover_url));
              for (let i = 0; i < (it.images?.length ?? 0); i++) await api('POST', `/api/weibo/media/${it.weibo_id}?kind=image&index=${i}`, await download(it.images[i]));
            }
            if (it.need_video && it.play_url) {
              const r = await api('POST', `/api/weibo/media/${it.weibo_id}?kind=video`, await download(it.play_url));
              if (r.suspicious) throw new Error('视频内容像登录墙');
            } else if (it.need_video) await api('POST', `/api/weibo/media/${it.weibo_id}/failed`, { error: '没有视频直链' });
            mediaDone++;
          } catch (e) { mediaFail++; await api('POST', `/api/weibo/media/${it.weibo_id}/failed`, { error: e.message }).catch(() => {}); }
          paint();
        }
      }
      say(`媒体文件：存好 ${mediaDone} 条${mediaFail ? `，失败 ${mediaFail} 条（下次重试，最多 3 次）` : ''}`);
    } catch (e) { say('媒体阶段出错：' + e.message, true); }
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
    box.innerHTML = `<div style="font-weight:600;margin-bottom:4px">FavSync · 微博收藏</div>
      <div style="opacity:.8">抄到 <b>${seen.size}</b>${total != null ? ' / ' + total : ''} 条 · 已推送 <b>${pushed}</b> 条${mediaDone || mediaFail ? ` · 媒体 ${mediaDone}✓${mediaFail ? ' ' + mediaFail + '✗' : ''}` : ''}</div>
      <div style="margin:6px 0;display:flex;gap:6px;flex-wrap:wrap">${running ? btn('⏸ 停下', 'stop') : btn('▶ 全部翻完并同步', 'start', true)}${pendingPush.length ? btn(`⬆ 推送 ${pendingPush.length} 条`, 'push') : ''}${!running && !mediaRunning ? btn('存媒体文件', 'media') : ''}</div>
      <label style="display:flex;gap:6px;align-items:center;opacity:.85"><input type="checkbox" data-fn="media-toggle" ${wantMedia() ? 'checked' : ''}> 同时把图片/视频存到本机</label>
      <div style="margin-top:6px;color:${bad ? '#ff9a8a' : 'rgba(250,250,250,.7)'}">${msg || '在微博任意页面点上面开始，它自己一页页翻你的收藏'}</div>`;
    box.querySelectorAll('[data-fn]').forEach((el) => {
      const fn = el.dataset.fn;
      if (fn === 'media-toggle') el.onchange = () => GM_setValue('fs_media', el.checked);
      else el.onclick = () => ({ start: crawlAll, stop: () => { running = null; say('已停下'); }, push: pushBatch, media: mediaPhase })[fn]?.();
    });
  }
  const boot = () => { paint(); setInterval(paint, 4000); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
  try {
    GM_registerMenuCommand('微博收藏：全部翻完并同步', () => { GM_setValue('fs_always', true); crawlAll(); });
    GM_registerMenuCommand('微博收藏：显示面板', () => { GM_setValue('fs_always', true); paint(); });
  } catch { /* 略 */ }
})();
