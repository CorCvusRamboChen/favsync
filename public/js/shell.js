// 两个页面（/library.html 收藏库、/settings.html 设置）共用的一小撮东西：
// 访问令牌的 fetch 包装、$/esc、toast、主题、实时刷新。普通脚本，定义的是全局；必须排在页面自己的脚本前面。

// —— 访问令牌：远程访问时存在 localStorage，所有 /api 请求自动带上（本机不需要）——
const apiToken = () => { try { return localStorage.getItem('favsync_token') || ''; } catch { return ''; } };
const _fetch = window.fetch.bind(window);
window.fetch = (input, init = {}) => {
  const url = typeof input === 'string' ? input : input?.url ?? '';
  if (url.startsWith('/api') && apiToken()) init = { ...init, headers: { ...(init.headers || {}), Authorization: 'Bearer ' + apiToken() } };
  return _fetch(input, init).then(async (r) => {
    if (r.status === 401 && url.startsWith('/api')) {
      const d = await r.clone().json().catch(() => ({}));
      if (d.need_token && !document.getElementById('tokenAsk')) askToken();
    }
    return r;
  });
};
function askToken() {
  const t = prompt('这台设备不是服务器本机，需要访问令牌（在服务器上打开设置页 → 远程访问 里能看到）：', apiToken());
  if (t === null) return;
  try { localStorage.setItem('favsync_token', t.trim()); } catch { /* 隐私模式 */ }
  location.reload();
}

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function toast(msg) {
  const t = $('#toast'); if (!t) return;
  t.textContent = msg; t.style.display = 'block';
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.style.display = 'none'), 2600);
}
async function postJson(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  const d = await r.json().catch(() => ({ error: 'HTTP ' + r.status }));
  if (!r.ok) { toast('⚠ ' + (d.error || r.status)); return null; }
  return d;
}

// —— 主题：light / dark / auto（跟随系统）——
const themeChoice = () => { try { return localStorage.getItem('favsync_theme') || 'auto'; } catch { return 'auto'; } };
const _darkMq = matchMedia('(prefers-color-scheme: dark)');
const applyTheme = () => { const c = themeChoice(); document.documentElement.setAttribute('data-theme', c === 'auto' ? (_darkMq.matches ? 'dark' : 'light') : c); };
applyTheme();
_darkMq.addEventListener?.('change', applyTheme);
function cycleTheme() { const next = { auto: 'light', light: 'dark', dark: 'auto' }[themeChoice()]; try { localStorage.setItem('favsync_theme', next); } catch { /* 略 */ } applyTheme(); toast('主题：' + { auto: '跟随系统', light: '浅色', dark: '深色' }[next]); }

// —— 实时刷新（SSE）：同步进了新东西 / 媒体落盘 → 重画 ——
function connectLive(onChange) {
  let es = null, retry = 0, timer = null;
  const open = () => {
    es = new EventSource('/api/events' + (apiToken() ? '?token=' + encodeURIComponent(apiToken()) : ''));
    es.addEventListener('hello', () => { retry = 0; });
    es.addEventListener('change', () => { clearTimeout(timer); timer = setTimeout(onChange, 800); });   // 一轮媒体落盘会连发很多条，合并一下
    es.onerror = () => { es.close(); setTimeout(open, Math.min(30000, 1000 * 2 ** Math.min(retry++, 5))); };
  };
  open();
}
