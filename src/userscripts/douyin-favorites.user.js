// ==UserScript==
// @name         FavSync · 抖音收藏同步
// @namespace    favsync
// @version      0.2.2
// @description  在你已登录的抖音网页版里，把「我的收藏」（含各个收藏夹）慢慢翻一遍，推给本机的 FavSync 收藏库；封面/动图/视频也一并存到本机存档。只旁听页面自己的请求，不发任何额外接口请求，节奏比人翻还慢。只读，不改抖音上任何东西。
// @match        https://www.douyin.com/*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @connect      localhost
// @connect      127.0.0.1
// @connect      __SERVER_HOST__
// @connect      douyin.com
// @connect      douyinpic.com
// @connect      douyinvod.com
// @connect      douyinstatic.com
// @connect      byteimg.com
// @connect      bytedance.com
// @connect      ixigua.com
// @connect      *
// ==/UserScript==

// 不被封号的原则（全部写进代码）：
//   1. 零额外请求：列表、收藏夹、账号信息全是旁听页面自己发出的响应，脚本从不自己调抖音接口、不碰签名。
//   2. 翻页像人：每次滚动随机 1.8–3.5 秒，每 8 次歇 5–10 秒；每次只翻到设定的上限（默认 300 条，先试模式 20 条）。
//   3. 下载像人：封面/视频一个一个来，中间随机 1–3 秒，每 10 个歇 8–15 秒，每次最多 N 个（默认 40，先试 10）。
//   4. 一看苗头不对就停：任何抖音接口回 403/429、页面冒出验证码、连续 3 次下载失败 → 立刻停下并告诉你，不重试。
//   5. 只收「收藏」（listcollection + 收藏夹里的 collects/video/list），喜欢、历史从不碰。
// 多账号：旁听 /user/profile/self/ 拿到当前账号，推送时一并带上；换账号登录再跑一遍，同一条视频两个账号都收藏也只一张卡。
// 动图：图文帖的每张图同时记原图地址（download_url_list，动图就是动图）和实况短片地址，服务端按原样存。
(function () {
  'use strict';
  // —— 面板文案 zh / en（按浏览器语言）——
  const LANG = /^zh/i.test(navigator.language || '') ? 'zh' : 'en';
  const T = {
    "zh": {
      "title": "FavSync · 抖音收藏",
      "acct": "账号：{n}",
      "acct_none": "账号：还没认出来（进「我的」页就有）",
      "folders": " · 收藏夹 {n} 个",
      "got": "抄到 <b>{v}</b> 条视频",
      "music": " + <b>{m}</b> 首音乐",
      "pushed": " · 已推送 <b>{p}</b> 条",
      "media": " · 媒体 {ok}✓",
      "mediafail": " {f}✗",
      "stop": "停下",
      "trial": "先试 20 条",
      "start": "全部收藏",
      "push": "推送 {n} 条",
      "savemedia": "存媒体文件",
      "opt_media": "存封面/动图/图文到本机",
      "opt_video": "视频文件也存（流量大，慢）",
      "hint_ready": "页面已经在翻收藏了，点上面开始",
      "hint_open": "打开「我的 → 收藏」（视频 / 音乐 tab 都行，进收藏夹也行），再点上面开始",
      "blocked": "抖音接口回了 {s}",
      "blocked_stop": "抖音开始限流（{s}），已停下。过几个小时再来，别硬刷",
      "pushed_msg": "已推送 {p} 条（新 {a}）",
      "push_fail": "推送失败：{e}",
      "trial_msg": "先试 20 条：慢慢翻，别动这个标签页",
      "scrolling": "自动翻页中（最多 {cap} 条）…别动这个标签页",
      "captcha": "页面出现验证码，已停下。你手动过一下验证，过会儿再来",
      "cap_hit": "到 {cap} 条上限了，先停",
      "rest": "歇一下（已抄到 {n} 条）…",
      "bottom": "翻到底了",
      "idle": "15 秒没有新条目，可能到底了",
      "stopped": "已停下",
      "media_cap": "这次先存 {cap} 条媒体，下次接着存",
      "media_captcha": "页面出现验证码，媒体下载先停",
      "media_blocked": "抖音限流中（{b}），媒体下载先停。过几个小时再来",
      "media_item": "存媒体文件 {i}/{cap}：{id}",
      "media_rest": "歇一下（已存 {n} 条）…",
      "media_streak": "下载连续失败，像是被限流，先停。过几个小时再试",
      "media_done": "媒体文件：这次存好 {ok} 条",
      "media_done_fail": "，失败 {f} 条（下次重试，最多 3 次）",
      "media_err": "媒体阶段出错：{e}",
      "no_audio": "没有音频地址",
      "video_off": "设置里关了视频下载",
      "no_media": "没有可下载的媒体地址",
      "wall": " 内容像登录墙",
      "conn_fail": "连不上 FavSync（它开着吗？）",
      "bad_json": "FavSync 返回了非 JSON：{s}",
      "timeout": "FavSync 响应超时",
      "m_trial": "抖音收藏：先试 20 条",
      "m_all": "抖音收藏：全部收藏",
      "m_media": "抖音收藏：只存媒体文件",
      "m_cap": "抖音收藏：设置每次上限",
      "p_cap": "每次最多翻多少条收藏？（默认 300）",
      "p_mcap": "每次最多存多少条媒体？（默认 40）"
    },
    "en": {
      "title": "FavSync · Douyin favorites",
      "acct": "Account: {n}",
      "acct_none": "Account: not detected yet (open your profile page)",
      "folders": " · {n} folders",
      "got": "Collected <b>{v}</b> videos",
      "music": " + <b>{m}</b> songs",
      "pushed": " · pushed <b>{p}</b>",
      "media": " · media {ok}✓",
      "mediafail": " {f}✗",
      "stop": "Stop",
      "trial": "Try first 20",
      "start": "All favorites",
      "push": "Push {n}",
      "savemedia": "Save media",
      "opt_media": "Save covers / GIFs / photos locally",
      "opt_video": "Also save video files (slow, large)",
      "hint_ready": "The page is already loading favorites — click above to start",
      "hint_open": "Open Me → Collection (video or music tab, or a folder), then click above",
      "blocked": "Douyin API returned {s}",
      "blocked_stop": "Douyin is rate-limiting ({s}); stopped. Come back in a few hours",
      "pushed_msg": "Pushed {p} ({a} new)",
      "push_fail": "Push failed: {e}",
      "trial_msg": "Trying 20 items: scrolling slowly, leave this tab alone",
      "scrolling": "Auto-scrolling (up to {cap})… leave this tab alone",
      "captcha": "A captcha appeared; stopped. Solve it manually and come back later",
      "cap_hit": "Reached the {cap} limit; stopping for now",
      "rest": "Resting (collected {n})…",
      "bottom": "Reached the end",
      "idle": "Nothing new for 15 s — probably the end",
      "stopped": "Stopped",
      "media_cap": "Saved {cap} media items this round; the rest next time",
      "media_captcha": "Captcha appeared; media download paused",
      "media_blocked": "Rate-limited ({b}); media download paused. Come back in a few hours",
      "media_item": "Saving media {i}/{cap}: {id}",
      "media_rest": "Resting (saved {n})…",
      "media_streak": "Repeated download failures — looks like rate limiting, stopping. Try again in a few hours",
      "media_done": "Media: saved {ok} this round",
      "media_done_fail": ", {f} failed (retried next time, up to 3)",
      "media_err": "Media phase error: {e}",
      "no_audio": "no audio URL",
      "video_off": "video download disabled in settings",
      "no_media": "no downloadable media URL",
      "wall": " looks like a login wall",
      "conn_fail": "Cannot reach FavSync (is it running?)",
      "bad_json": "FavSync returned non-JSON: {s}",
      "timeout": "FavSync timed out",
      "m_trial": "Douyin favorites: try first 20",
      "m_all": "Douyin favorites: all",
      "m_media": "Douyin favorites: save media only",
      "m_cap": "Douyin favorites: set limits",
      "p_cap": "Max favorites per run? (default 300)",
      "p_mcap": "Max media items per run? (default 40)"
    }
  };
  const L = (k, v) => { let s = (T[LANG] && T[LANG][k]) || T.zh[k] || k; if (v) for (const [a, b] of Object.entries(v)) s = s.split('{' + a + '}').join(String(b)); return s; };
  const SERVER = '__SERVER__';
  const TOKEN = '__TOKEN__';
  const W = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  const LIST_RE = /\/aweme\/v1\/web\/aweme\/listcollection\/|\/aweme\/v1\/web\/collects\/video\/list\//;
  const FOLDERS_RE = /\/aweme\/v1\/web\/collects\/list\//;
  const MUSIC_RE = /\/aweme\/v1\/web\/music\/(listcollection|collection|collect)/;
  const PROFILE_RE = /\/aweme\/v1\/web\/user\/profile\/self\//;
  const ANY_API_RE = /\/aweme\/v1\/web\//;
  const rand = (a, b) => a + Math.random() * (b - a);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const cfg = (k, d) => { try { const v = GM_getValue(k); return v == null ? d : v; } catch { return d; } };

  // —— 1. 旁听 ——
  const seen = new Map();          // aweme_id → aweme（去重）
  const musicSeen = new Map();     // music id → music（收藏页「音乐」tab）
  const pendingMusic = [];
  const pendingPush = [];          // 还没推给 FavSync的
  const folderName = new Map();    // collects_id → 收藏夹名
  const folderOf = new Map();      // aweme_id → Set(收藏夹名)
  let account = null;              // {uid, nickname}
  let hasMore = true, lastNewAt = Date.now(), pushed = 0, listHits = 0, blocked = null, cap = cfg('fs_cap', 300);
  function absorbList(text, url) {
    let d; try { d = JSON.parse(text); } catch { return; }
    const list = d?.aweme_list ?? d?.data?.aweme_list ?? null;
    if (!Array.isArray(list)) return;
    listHits++;
    if (d.has_more === 0 || d.has_more === false) hasMore = false;
    const cid = (String(url).match(/collects_id=(\d+)/) ?? [])[1];
    let fresh = 0;
    for (const a of list) {
      const id = String(a?.aweme_id ?? '');
      if (!id) continue;
      if (cid) { const name = folderName.get(cid) ?? (`收藏夹 ${cid}`); if (!folderOf.has(id)) folderOf.set(id, new Set()); folderOf.get(id).add(name); }
      if (seen.has(id)) continue;
      seen.set(id, a); pendingPush.push(a); fresh++;
    }
    if (fresh) lastNewAt = Date.now();
    paint();
    if (pendingPush.length >= 20) pushBatch();
  }
  function absorbMusic(text) {
    let d; try { d = JSON.parse(text); } catch { return; }
    const list = d?.mc_list ?? d?.music_list ?? null;
    if (!Array.isArray(list)) return;
    listHits++;
    if (d.has_more === 0 || d.has_more === false) hasMore = false;
    let fresh = 0;
    for (const mu of list) { const id = String(mu?.id_str ?? mu?.mid ?? mu?.id ?? ''); if (!id || musicSeen.has(id)) continue; musicSeen.set(id, mu); pendingMusic.push(mu); fresh++; }
    if (fresh) lastNewAt = Date.now();
    paint();
    if (pendingMusic.length >= 20) pushBatch();
  }
  function absorbFolders(text) {
    let d; try { d = JSON.parse(text); } catch { return; }
    const list = d?.collects_list ?? d?.data?.collects_list ?? d?.collects ?? null;
    if (!Array.isArray(list)) return;
    for (const f of list) { const id = String(f?.collects_id ?? f?.id ?? ''); const name = f?.collects_name ?? f?.name ?? f?.title; if (id && name) folderName.set(id, String(name)); }
    paint();
  }
  function accountFromDom() {
    if (account?.nickname || !/\/user\/self/.test(location.href)) return;
    const nick = document.querySelector('[data-e2e="user-info-nickname"], h1')?.textContent?.trim();
    if (nick) { account = { uid: account?.uid ?? null, nickname: nick }; paint(); }
  }
  function absorbProfile(text) {
    let d; try { d = JSON.parse(text); } catch { return; }
    const u = d?.user ?? d?.data?.user;
    if (u && (u.uid || u.nickname)) { account = { uid: String(u.uid ?? u.sec_uid ?? ''), nickname: String(u.nickname ?? '') }; paint(); }
  }
  function sniff(url, status, text) {
    if ((status === 403 || status === 429) && ANY_API_RE.test(url)) { blocked = L('blocked', { s: status }); stopScroll(L('blocked_stop', { s: status })); return; }
    if (!text) return;
    if (LIST_RE.test(url)) absorbList(text, url);
    else if (MUSIC_RE.test(url)) absorbMusic(text);
    else if (FOLDERS_RE.test(url)) absorbFolders(text);
    else if (PROFILE_RE.test(url)) absorbProfile(text);
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
  // #nocaptcha-container 是常驻的 0×0 iframe，看得见的才算真弹了验证码
  const captchaShowing = () => [...document.querySelectorAll('[id*="captcha" i], [class*="captcha" i], [class*="verify-" i]')].some((el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 50 && r.height > 50 && cs.display !== 'none' && cs.visibility !== 'hidden'; });

  // —— 2. 和 FavSync 通信 ——
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
    if (!pendingPush.length && !pendingMusic.length) return;
    const items = pendingPush.splice(0, pendingPush.length);
    const music = pendingMusic.splice(0, pendingMusic.length);
    const folders = {};
    for (const a of items) { const s = folderOf.get(String(a.aweme_id)); if (s?.size) folders[String(a.aweme_id)] = [...s]; }
    try {
      const r = await api('POST', '/api/douyin/push', { items, music, account, folders });
      pushed += r.added + r.updated;
      say(L('pushed_msg', { p: pushed, a: r.added }) + (account?.nickname ? ' · ' + account.nickname : ''));
    } catch (e) { pendingPush.unshift(...items); pendingMusic.unshift(...music); say(L('push_fail', { e: e.message }), true); }
    paint();
  }

  // —— 3. 像人一样往下翻 ——
  let scrolling = false, scrollRounds = 0;
  function scrollMore() {
    const cards = document.querySelectorAll('[data-e2e="user-post-item"], li[class*="item"], div[class*="video-card"]');
    const last = cards[cards.length - 1];
    if (last) last.scrollIntoView({ block: 'end', behavior: 'smooth' });
    W.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' });
    for (const el of document.querySelectorAll('[class*="scroll"], main, [data-e2e="scroll-list"]')) { try { el.scrollTop = el.scrollHeight; } catch { /* 略 */ } }
  }
  async function startScroll(trial = false) {
    if (scrolling) return;
    cap = trial ? 20 : cfg('fs_cap', 300);
    scrolling = true; blocked = null; scrollRounds = 0; lastNewAt = Date.now();
    say(trial ? L('trial_msg') : L('scrolling', { cap }));
    paint();
    while (scrolling) {
      if (captchaShowing()) { stopScroll(L('captcha')); break; }
      if (seen.size + musicSeen.size >= cap) { stopScroll(L('cap_hit', { cap })); break; }
      scrollMore();
      scrollRounds++;
      await sleep(rand(1800, 3500));
      if (scrollRounds % 8 === 0) { say(L('rest', { n: seen.size })); await sleep(rand(5000, 10000)); }
      if (!scrolling) break;
      if (!hasMore) { stopScroll(L('bottom')); break; }
      if (Date.now() - lastNewAt > 15000) { stopScroll(L('idle')); break; }
    }
    await pushBatch();
    if (!blocked) await mediaPhase(trial ? 10 : null);
    paint();
  }
  function stopScroll(msg) { scrolling = false; if (msg) say(msg); paint(); }

  // —— 4. 媒体文件：封面 / 动态封面 / 视频 / 图文原图 / 实况短片，用登录态一个一个下，传回 FavSync 存档 ——
  const wantMedia = () => cfg('fs_media', true);
  const wantVideo = () => cfg('fs_video', true);
  let mediaRunning = false, mediaDone = 0, mediaFail = 0;
  function download(url) {
    return new Promise((resolve, reject) => GM_xmlhttpRequest({
      method: 'GET', url, responseType: 'arraybuffer', timeout: 180000,
      headers: { Referer: 'https://www.douyin.com/', Accept: '*/*' },
      onload: (r) => (r.status === 200 && r.response?.byteLength ? resolve(r.response) : reject(new Error('HTTP ' + r.status))),
      onerror: () => reject(new Error('下载失败')), ontimeout: () => reject(new Error('下载超时')),
    }));
  }
  const put = async (id, kind, url, index) => {
    if (!url) return false;
    const r = await api('POST', `/api/douyin/media/${id}?kind=${kind}${index != null ? '&index=' + index : ''}`, await download(url));
    if (r.suspicious) throw new Error(kind + L('wall'));
    await sleep(rand(1000, 3000));
    return true;
  };
  async function mediaPhase(capOverride = null) {
    if (!wantMedia() || mediaRunning) return;
    const mediaCap = capOverride ?? cfg('fs_media_cap', 40);
    mediaRunning = true;
    let streak = 0, count = 0;
    try {
      outer: for (let round = 0; round < 100; round++) {
        const { items } = await api('GET', '/api/douyin/pending?limit=6');
        if (!items?.length) break;
        for (const it of items) {
          if (count >= mediaCap) { say(L('media_cap', { cap: mediaCap })); break outer; }
          if (captchaShowing()) { say(L('media_captcha'), true); break outer; }
          if (blocked) { say(L('media_blocked', { b: blocked }), true); streak = 99; break outer; }
          say(L('media_item', { i: count + 1, cap: mediaCap, id: it.aweme_id }));
          try {
            await put(it.aweme_id, 'cover', it.cover_url);
            if (it.kind === 'music') { if (it.play_url) await put(it.aweme_id, 'audio', it.play_url); else await api('POST', `/api/douyin/media/${it.aweme_id}/failed`, { error: L('no_audio') }); mediaDone++; streak = 0; count++; paint(); continue; }
            await put(it.aweme_id, 'anim', it.dynamic_cover_url);
            if (it.play_url) {
              if (wantVideo()) await put(it.aweme_id, 'video', it.play_url);
              else await api('POST', `/api/douyin/media/${it.aweme_id}/failed`, { error: L('video_off') });
            } else {
              const vs = it.variants?.length ? it.variants : (it.images ?? []).map((u) => ({ static: u }));
              for (let i = 0; i < vs.length; i++) {
                // 原图优先（动图就是动图）；原图拿不到再用页面显示的那张
                try { await put(it.aweme_id, 'image', vs[i].original ?? vs[i].static, i); }
                catch (e) { if (vs[i].original && vs[i].static) await put(it.aweme_id, 'image', vs[i].static, i); else throw e; }
                if (vs[i].live) { try { await put(it.aweme_id, 'live', vs[i].live, i); } catch { /* 实况是加分项 */ } }
              }
              if (!vs.length) await api('POST', `/api/douyin/media/${it.aweme_id}/failed`, { error: L('no_media') });
            }
            mediaDone++; streak = 0;
          } catch (e) {
            mediaFail++; streak++;
            await api('POST', `/api/douyin/media/${it.aweme_id}/failed`, { error: e.message }).catch(() => {});
            if (/HTTP (403|429)/.test(e.message) || streak >= 3) { say(L('media_streak'), true); break outer; }
          }
          count++;
          if (count % 10 === 0) { say(L('media_rest', { n: count })); await sleep(rand(8000, 15000)); }
          paint();
        }
      }
      if (streak < 3 && !blocked) say(L('media_done', { ok: mediaDone }) + (mediaFail ? L('media_done_fail', { f: mediaFail }) : ''));
    } catch (e) { say(L('media_err', { e: e.message }), true); }
    finally { mediaRunning = false; paint(); }
  }

  // —— 5. 右下角的小面板 ——
  let box, msg = '', bad = false;
  const onFavPage = () => /showTab=favorite_collection|\/user\/self|\/collection/.test(location.href) || seen.size > 0;
  function say(m, isBad = false) { msg = m; bad = isBad; paint(); }
  function paint() {
    if (!document.body) return;
    if (!onFavPage()) { if (box) box.style.display = 'none'; return; }
    if (!box) {
      box = document.createElement('div');
      box.id = 'fs-douyin';
      box.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:999999;width:272px;background:rgba(20,20,22,.92);color:#fafafa;font:12.5px/1.5 system-ui,sans-serif;border-radius:10px;padding:10px 12px;box-shadow:0 6px 24px rgba(0,0,0,.4);backdrop-filter:blur(8px)';
      document.body.appendChild(box);
    }
    box.style.display = '';
    const btn = (label, fn, primary) => `<button data-fn="${fn}" style="border:0;border-radius:6px;padding:5px 9px;cursor:pointer;font-size:12px;${primary ? 'background:#fafafa;color:#000' : 'background:rgba(255,255,255,.14);color:#fafafa'}">${label}</button>`;
    const folders = new Set(); for (const s of folderOf.values()) for (const f of s) folders.add(f);
    box.innerHTML = `<div style="font-weight:600;margin-bottom:2px">${L('title')}</div>
      <div style="opacity:.75;font-size:11.5px">${account?.nickname ? L('acct', { n: account.nickname }) : L('acct_none')}${folders.size ? L('folders', { n: folders.size }) : ''}</div>
      <div style="opacity:.8;margin-top:2px">${L('got', { v: seen.size })}${musicSeen.size ? L('music', { m: musicSeen.size }) : ''}${L('pushed', { p: pushed })}${mediaDone || mediaFail ? L('media', { ok: mediaDone }) + (mediaFail ? L('mediafail', { f: mediaFail }) : '') : ''}</div>
      <div style="margin:6px 0;display:flex;gap:6px;flex-wrap:wrap">${scrolling ? btn(L('stop'), 'stop') : btn(L('trial'), 'trial', true) + btn(L('start'), 'start')}${(pendingPush.length + pendingMusic.length) && !scrolling ? btn(L('push', { n: pendingPush.length + pendingMusic.length }), 'push') : ''}${!scrolling && !mediaRunning ? btn(L('savemedia'), 'media') : ''}</div>
      <label style="display:flex;gap:6px;align-items:center;opacity:.85"><input type="checkbox" data-fn="media-toggle" ${wantMedia() ? 'checked' : ''}> ${L('opt_media')}</label>
      <label style="display:flex;gap:6px;align-items:center;opacity:.85"><input type="checkbox" data-fn="video-toggle" ${wantVideo() ? 'checked' : ''}> ${L('opt_video')}</label>
      <div style="margin-top:6px;color:${bad ? '#ff9a8a' : 'rgba(250,250,250,.7)'}">${msg || (listHits ? L('hint_ready') : L('hint_open'))}</div>`;
    box.querySelectorAll('[data-fn]').forEach((el) => {
      const fn = el.dataset.fn;
      if (fn === 'media-toggle') el.onchange = () => GM_setValue('fs_media', el.checked);
      else if (fn === 'video-toggle') el.onchange = () => GM_setValue('fs_video', el.checked);
      else el.onclick = () => ({ trial: () => startScroll(true), start: () => startScroll(false), stop: () => stopScroll(L('stopped')), push: pushBatch, media: () => mediaPhase() })[fn]?.();
    });
  }
  const boot = () => { paint(); setInterval(() => { accountFromDom(); paint(); }, 4000); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
  try {
    GM_registerMenuCommand(L('m_trial'), () => startScroll(true));
    GM_registerMenuCommand(L('m_all'), () => startScroll(false));
    GM_registerMenuCommand(L('m_media'), () => mediaPhase());
    GM_registerMenuCommand(L('m_cap'), () => { const v = Number(prompt(L('p_cap'), String(cfg('fs_cap', 300)))); if (v > 0) GM_setValue('fs_cap', v); const m = Number(prompt(L('p_mcap'), String(cfg('fs_media_cap', 40)))); if (m > 0) GM_setValue('fs_media_cap', m); });
  } catch { /* 略 */ }
})();
