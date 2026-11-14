// 两个页面（/library.html 收藏库、/settings.html 设置）共用的一小撮东西：
// 语言、访问令牌的 fetch 包装、$/esc、toast、主题、弹窗组件、内联图标、实时刷新。
// 普通脚本，定义的是全局；必须排在 i18n.js 之后、页面自己的脚本之前。

// —— URL 参数：?token= 是手机配对链接带来的令牌（存起来后从地址栏去掉）；?lang= / ?theme= 方便分享和截图 ——
(() => {
  try {
    const u = new URL(location.href);
    const tok = u.searchParams.get('token');
    if (tok && tok.trim()) { localStorage.setItem('favsync_token', tok.trim()); u.searchParams.delete('token'); history.replaceState(null, '', u.pathname + u.search + u.hash); }
    const lang = u.searchParams.get('lang'); if (lang === 'zh' || lang === 'en') localStorage.setItem('fs_lang', lang);
    const theme = u.searchParams.get('theme'); if (['light', 'dark', 'auto'].includes(theme)) localStorage.setItem('favsync_theme', theme);
  } catch { /* 隐私模式没有 localStorage */ }
})();

// —— 语言：fs_lang，没有就按 navigator.language ——
const fsLang = () => { try { const v = localStorage.getItem('fs_lang'); if (v === 'zh' || v === 'en') return v; } catch { /* 略 */ } return /^zh/i.test(navigator.language || '') ? 'zh' : 'en'; };
const LANG = fsLang();
document.documentElement.lang = LANG === 'zh' ? 'zh-CN' : 'en';
function t(key, vars) {
  const dict = globalThis.FS_I18N?.[LANG] ?? {};
  let s = dict[key] ?? globalThis.FS_I18N?.zh?.[key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
  return s;
}
function setLang(l) { try { localStorage.setItem('fs_lang', l); } catch { /* 略 */ } location.reload(); }
// 静态 HTML 里的 data-i18n / data-i18n-title / data-i18n-ph 在 DOMContentLoaded 时替换
function applyI18n(root = document) {
  for (const el of root.querySelectorAll('[data-i18n]')) el.innerHTML = t(el.dataset.i18n);
  for (const el of root.querySelectorAll('[data-i18n-title]')) el.title = t(el.dataset.i18nTitle);
  for (const el of root.querySelectorAll('[data-i18n-ph]')) el.placeholder = t(el.dataset.i18nPh);
  const title = document.querySelector('title[data-i18n-doc]'); if (title) document.title = t(title.dataset.i18nDoc) + ' · FavSync';
}

// —— 访问令牌：远程访问时存在 localStorage，所有 /api 请求自动带上（本机不需要）——
const apiToken = () => { try { return localStorage.getItem('favsync_token') || ''; } catch { return ''; } };
const _fetch = window.fetch.bind(window);
let _askedToken = false;
window.fetch = (input, init = {}) => {
  const url = typeof input === 'string' ? input : input?.url ?? '';
  if (url.startsWith('/api') && apiToken()) init = { ...init, headers: { ...(init.headers || {}), Authorization: 'Bearer ' + apiToken() } };
  return _fetch(input, init).then(async (r) => {
    if (r.status === 401 && url.startsWith('/api')) {
      const d = await r.clone().json().catch(() => ({}));
      if (d.need_token && !_askedToken) { _askedToken = true; showTokenBar(); }
    }
    return r;
  });
};
function showTokenBar() {
  if (document.getElementById('tokenBar')) return;
  const bar = document.createElement('div');
  bar.id = 'tokenBar'; bar.className = 'token-bar';
  bar.innerHTML = `<span>${ICON.key} ${esc(t('token.need'))}</span><button class="btn-p" onclick="askToken()">${esc(t('token.go'))}</button>`;
  document.body.prepend(bar);
}
function askToken() {
  const v = prompt(t('token.ask'), apiToken());
  if (v === null) return;
  try { localStorage.setItem('favsync_token', v.trim()); } catch { /* 隐私模式 */ }
  location.reload();
}

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtWhen = (iso) => (iso ? String(iso).slice(0, 16).replace('T', ' ') : '');
function toast(msg) {
  const el = $('#toast'); if (!el) return;
  el.textContent = msg; el.style.display = 'block';
  clearTimeout(toast._t); toast._t = setTimeout(() => (el.style.display = 'none'), 2600);
}
async function postJson(url, body, method = 'POST') {
  const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  const d = await r.json().catch(() => ({ error: 'HTTP ' + r.status }));
  if (!r.ok) { toast('⚠ ' + (d.error || r.status)); return null; }
  return d;
}
async function copyText(s) { try { await navigator.clipboard.writeText(s); toast(t('common.copied')); } catch { prompt(t('common.copy'), s); } }

// —— 主题：light / dark / auto（跟随系统）——
const themeChoice = () => { try { return localStorage.getItem('favsync_theme') || 'auto'; } catch { return 'auto'; } };
const _darkMq = matchMedia('(prefers-color-scheme: dark)');
const applyTheme = () => { const c = themeChoice(); document.documentElement.setAttribute('data-theme', c === 'auto' ? (_darkMq.matches ? 'dark' : 'light') : c); };
applyTheme();
_darkMq.addEventListener?.('change', applyTheme);
function cycleTheme() { const next = { auto: 'light', light: 'dark', dark: 'auto' }[themeChoice()]; try { localStorage.setItem('favsync_theme', next); } catch { /* 略 */ } applyTheme(); toast(t('app.theme') + ': ' + t('app.theme.' + next)); }

// —— 内联图标（线条风格，currentColor；不用表情）——
const _ic = (d) => `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICON = {
  key: _ic('<circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6"/><path d="m15.5 7.5 3 3L22 7l-3-3"/>'),
  qr: _ic('<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3zM20 14v3M17 20h3M14 20h.01"/>'),
  copy: _ic('<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>'),
  refresh: _ic('<path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/>'),
  sync: _ic('<path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/>'),
  logout: _ic('<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>'),
  script: _ic('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="m10 13-2 2 2 2"/><path d="m14 13 2 2-2 2"/>'),
  monitor: _ic('<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>'),
  phone: _ic('<rect x="5" y="2" width="14" height="20" rx="2"/><path d="M12 18h.01"/>'),
  upload: _ic('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5"/><path d="M12 3v12"/>'),
  download: _ic('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>'),
  folder: _ic('<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>'),
  image: _ic('<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/>'),
  film: _ic('<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M7 3v18M17 3v18M3 7.5h4M3 12h18M3 16.5h4M17 7.5h4M17 16.5h4"/>'),
  music: _ic('<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>'),
  check: _ic('<path d="M20 6 9 17l-5-5"/>'),
  x: _ic('<path d="M18 6 6 18M6 6l12 12"/>'),
  alert: _ic('<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4M12 17h.01"/>'),
  clock: _ic('<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>'),
  play: _ic('<path d="m6 3 14 9-14 9z" fill="currentColor"/>'),
  expand: _ic('<path d="m15 3 6 0 0 6M9 21l-6 0 0-6M21 3l-7 7M3 21l7-7"/>'),
  external: _ic('<path d="M15 3h6v6M10 14 21 3M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"/>'),
  trash: _ic('<path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>'),
  edit: _ic('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>'),
  settings: _ic('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/>'),
  library: _ic('<path d="m16 6 4 14M12 6v14M8 8v12M4 4v16"/>'),
  sun: _ic('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'),
  globe: _ic('<circle cx="12" cy="12" r="10"/><path d="M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20M2 12h20"/>'),
  archive: _ic('<rect x="2" y="3" width="20" height="5" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8M10 12h4"/>'),
  server: _ic('<rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/><path d="M6 6h.01M6 18h.01"/>'),
  link: _ic('<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>'),
  eye: _ic('<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>'),
  eyeOff: _ic('<path d="M9.9 4.2A10.9 10.9 0 0 1 12 4c6.5 0 10 8 10 8a18 18 0 0 1-2.2 3.2M6.6 6.6A18 18 0 0 0 2 12s3.5 8 10 8a10.9 10.9 0 0 0 5.4-1.4"/><path d="m2 2 20 20"/>'),
  heart: _ic('<path d="M19 14c1.5-1.5 3-3.2 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.8 0-3 .9-4.5 2.5C10.5 3.9 9.3 3 7.5 3A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4 3 5.5l7 7Z"/>'),
  // 平台标志（简化的单色图形）
  douyin: _ic('<path d="M15 3c.4 2.6 2 4.3 4.5 4.6v3.2a8 8 0 0 1-4.5-1.4V15a5.5 5.5 0 1 1-5.5-5.5c.3 0 .7 0 1 .1v3.3a2.3 2.3 0 1 0 1.3 2.1V3Z" fill="currentColor" stroke="none"/>'),
  xlogo: _ic('<path d="M4 3h4.5l4 5.6L17.3 3H20l-6.2 7.2L21 21h-4.5l-4.4-6.1L6.8 21H4l6.7-7.8Z" fill="currentColor" stroke="none"/>'),
  weibo: _ic('<path d="M10.5 19.5c-4 .4-7.5-1.5-7.8-4.2-.3-2.7 2.7-5.3 6.7-5.7 4-.4 7.5 1.5 7.8 4.2.3 2.7-2.7 5.3-6.7 5.7Z"/><path d="M14.5 7.5c1.3-.3 2.6 0 3.4 1 .7.8.9 2 .6 3.1"/><path d="M15.5 3.5c2.3-.4 4.6.3 6 2 1.3 1.6 1.6 3.8 1 5.8"/><circle cx="9.5" cy="14.5" r="1.2" fill="currentColor" stroke="none"/>'),
};
const btnIcon = (icon, label, cls = 'btn-s', attrs = '') => `<button class="${cls} ico" ${attrs}>${ICON[icon] ?? ''}<span>${esc(label)}</span></button>`;

// —— 弹窗组件：一个 #fsModal，各处复用（抖音二维码 / X 口令 / 脚本安装 / 配对二维码 / 二次确认）——
function modalOpen({ title, body, wide = false, onClose = null }) {
  let m = document.getElementById('fsModal');
  if (!m) { m = document.createElement('div'); m.id = 'fsModal'; m.className = 'fs-modal'; m.onclick = (e) => { if (e.target === m) modalClose(); }; document.body.appendChild(m); }
  m.innerHTML = `<div class="box ${wide ? 'wide' : ''}" role="dialog" aria-modal="true"><div class="hd"><h3>${esc(title)}</h3><button class="ed xbtn" onclick="modalClose()" title="${esc(t('common.close'))}">${ICON.x}</button></div><div class="bd" id="fsModalBody">${body}</div></div>`;
  m.classList.add('on'); document.body.style.overflow = 'hidden';
  modalOpen._onClose = onClose;
  return m.querySelector('#fsModalBody');
}
function modalBody(html) { const b = document.getElementById('fsModalBody'); if (b) b.innerHTML = html; return b; }
function modalClose() { const m = document.getElementById('fsModal'); if (!m) return; m.classList.remove('on'); m.innerHTML = ''; document.body.style.overflow = ''; const f = modalOpen._onClose; modalOpen._onClose = null; f?.(); }
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && document.getElementById('fsModal')?.classList.contains('on')) { e.stopImmediatePropagation(); modalClose(); } }, true);
// 二次确认（代替 window.confirm，深浅主题一致）
function confirmModal(title, text, { danger = false } = {}) {
  return new Promise((resolve) => {
    modalOpen({ title, body: `<p class="meta" style="font-size:13px;margin:0 0 14px">${esc(text)}</p><div class="row end"><button class="btn-s" id="cmNo">${esc(t('common.cancel'))}</button><button class="${danger ? 'btn-danger' : 'btn-p'}" id="cmYes">${esc(t('common.confirm'))}</button></div>`, onClose: () => resolve(false) });
    $('#cmNo').onclick = () => modalClose();
    $('#cmYes').onclick = () => { modalOpen._onClose = null; modalClose(); resolve(true); };
  });
}

// —— 页头右侧：语言 / 主题 / 另一页 ——
function headerTools(current) {
  const other = current === 'library' ? ['settings', '/settings.html', t('app.settings')] : ['library', '/library.html', t('app.library')];
  return `<button class="hb" onclick="setLang('${LANG === 'zh' ? 'en' : 'zh'}')" title="中文 / English">${ICON.globe}<span>${LANG === 'zh' ? 'EN' : '中'}</span></button>
    <button class="hb" onclick="cycleTheme()" title="${esc(t('app.theme'))}">${ICON.sun}<span class="hide-sm">${esc(t('app.theme'))}</span></button>
    <a class="hb" href="${other[1]}">${ICON[other[0]]}<span>${esc(other[2])}</span></a>`;
}

// —— 实时刷新（SSE）：同步进了新东西 / 媒体落盘 → 重画；断线指数退避重连，重连成功后补一次刷新 ——
function connectLive(onChange) {
  let es = null, retry = 0, timer = null;
  const open = () => {
    es = new EventSource('/api/events' + (apiToken() ? '?token=' + encodeURIComponent(apiToken()) : ''));
    es.addEventListener('hello', () => { if (retry) onChange(); retry = 0; });
    es.addEventListener('change', () => { clearTimeout(timer); timer = setTimeout(onChange, 800); });
    es.onerror = () => { es.close(); setTimeout(open, Math.min(30000, 1000 * 2 ** Math.min(retry++, 5))); };
  };
  open();
}
document.addEventListener('DOMContentLoaded', () => { applyI18n(); const h = document.getElementById('hdrTools'); if (h) h.innerHTML = headerTools(h.dataset.page); });
