// 设置页：连接与授权（本机/远程、令牌、配对二维码、浏览器检测）→ 三张平台卡 → 定时 → 存档。
// 所有登录流程走 shell.js 的同一个弹窗组件（modalOpen）。依赖 shell.js 的全局（$ esc t toast postJson ICON btnIcon copyText）。
let WHO = { local: false, browser: null, public_url: '' };
const dyAcct = (a) => a.nickname || a.id;

// ———————————————————————— 连接与授权 ————————————————————————
let tokenShown = false, tokenData = null;
async function connPaint() {
  const el = $('#connGrid'); if (!el) return;
  try { WHO = await (await fetch('/api/auth/whoami')).json(); } catch { /* 远程无令牌时 401：WHO 保持默认 */ }
  if (WHO.local && !tokenData) { try { const r = await fetch('/api/auth/token'); if (r.ok) tokenData = await r.json(); } catch { /* 略 */ } }
  const browserRow = `<dt>${esc(t('st.browser'))}</dt><dd>${WHO.browser ? `<span class="badge ok">${WHO.browser === 'msedge' ? 'Edge' : 'Chrome'}</span><span class="meta" style="margin:0">${esc(t('st.browser.ok', { b: WHO.browser === 'msedge' ? 'Edge' : 'Chrome' }))}</span>` : `<span class="badge bad">${esc(t('st.status.none'))}</span><span class="meta" style="margin:0">${esc(t('st.browser.none'))}</span>`}</dd>`;
  const access = WHO.local
    ? `<div class="t">${ICON.server}<span>${esc(t('st.access.local'))}</span><span class="badge ok">${esc(t('st.status.ok'))}</span></div><div class="meta">${esc(t('st.access.local.sub'))}</div>
       <dl class="kv">
         <dt>${esc(t('st.token'))}</dt><dd>${tokenData ? `<code class="tok ${tokenShown ? '' : 'hidden'}" id="tokVal">${tokenShown ? esc(tokenData.token) : '••••••••••••'}</code>
           <button class="ed" onclick="tokenToggle()" title="${esc(tokenShown ? t('st.token.hide') : t('st.token.show'))}">${tokenShown ? ICON.eyeOff : ICON.eye}</button>
           <button class="ed" onclick="copyText(tokenData.token)" title="${esc(t('common.copy'))}">${ICON.copy}</button>
           ${tokenData.from_env ? `<span class="meta" style="margin:0">${esc(t('st.token.env'))}</span>` : `<button class="ed" onclick="tokenReset()" title="${esc(t('st.token.reset'))}">${ICON.refresh}<span>${esc(t('st.token.reset'))}</span></button>`}` : `<span class="meta" style="margin:0">${esc(t('common.unknown'))}</span>`}</dd>
         <dt>${esc(t('st.publicurl'))}</dt><dd><code class="tok">${esc(WHO.public_url || tokenData?.public_url || '')}</code></dd>
         ${browserRow}
       </dl>`
    : `<div class="t">${ICON.key}<span>${esc(t('st.access.remote'))}</span><span class="badge ${apiToken() ? 'ok' : 'warn'}">${esc(apiToken() ? t('st.status.ok') : t('token.need'))}</span></div><div class="meta">${esc(t('st.access.remote.sub'))} ${esc(apiToken() ? t('st.access.remote.has') : t('st.access.remote.none'))}</div>
       <div class="acts">${btnIcon('key', t('token.go'), apiToken() ? 'btn-s' : 'btn-p', 'onclick="askToken()"')}</div>
       <dl class="kv">${browserRow}</dl>`;
  const pair = WHO.local && tokenData ? `<div class="t">${ICON.phone}<span>${esc(t('st.pair'))}</span></div><div class="meta">${esc(t('st.pair.sub'))}</div>
       <div class="conn-qr">${tokenData.qr ? `<img src="${tokenData.qr}" alt="QR" onclick="pairModal()">` : ''}<div style="min-width:0"><div class="meta" style="margin:0">${esc(t('st.pair.url'))}</div><code class="tok" style="display:block;margin-top:4px">${esc(tokenData.pair_url.replace(/token=.*$/, 'token=…'))}</code>
       <div class="acts" style="margin-top:8px">${btnIcon('qr', t('st.pair.show'), 'btn-s', 'onclick="pairModal()"')}${btnIcon('copy', t('common.copy'), 'btn-s', 'onclick="copyText(tokenData.pair_url)"')}</div></div></div>`
    : `<div class="t">${ICON.phone}<span>${esc(t('st.pair'))}</span></div><div class="meta">${esc(t('st.pair.sub'))}</div><div class="meta" style="margin-top:8px">${esc(t('st.access.remote.sub'))}</div>`;
  el.innerHTML = `<div class="card">${access}</div><div class="card">${pair}</div>`;
}
function tokenToggle() { tokenShown = !tokenShown; connPaint(); }
async function tokenReset() {
  if (!(await confirmModal(t('dlg.reset.title'), t('st.token.reset.confirm'), { danger: true }))) return;
  const r = await postJson('/api/auth/token/reset', {});
  if (!r) { toast(t('st.token.reset.fail')); return; }
  tokenData = null; toast(t('st.token.reset.ok')); connPaint();
}
function pairModal() {
  if (!tokenData?.qr) return;
  modalOpen({ title: t('dlg.pair.title'), body: `<div class="qrbox"><img src="${tokenData.qr}" alt="QR"><div class="meta" style="text-align:center">${esc(t('dlg.pair.sub'))}</div></div>
    <div class="cmd"><code>${esc(tokenData.pair_url)}</code>${btnIcon('copy', t('common.copy'), 'btn-s', 'onclick="copyText(tokenData.pair_url)"')}</div>` });
}

// ———————————————————————— 平台卡公共件 ————————————————————————
const badge = (kind, text) => `<span class="badge ${kind}">${esc(text)}</span>`;
const statLine = (label, value) => (value ? `<div><span class="l">${esc(label)}</span> ${value}</div>` : '');
const mediaLine = (s) => [t('st.media', { done: s.media_done ?? 0 }), s.media_pending ? t('st.media.pending', { n: s.media_pending }) : null, s.media_failed ? t('st.media.failed', { n: s.media_failed }) : null].filter(Boolean).join(' · ');
let SOCIAL = null;
// 远程没带令牌时所有 /api 都是 401：统一返回 null，各卡片显示"需要令牌"，不要拿错误 JSON 当状态用
async function getJson(url) { try { const r = await fetch(url); if (!r.ok) return null; return await r.json(); } catch { return null; } }
async function loadSocial() { SOCIAL = await getJson('/api/social/status'); return SOCIAL; }
const needTokenCard = (el) => { el.innerHTML = `<div class="meta">${ICON.key} ${esc(t('token.need'))}</div><div class="acts">${btnIcon('key', t('token.go'), 'btn-p', 'onclick="askToken()"')}</div>`; };
const schedToggle = (site) => `<label><input type="checkbox" ${SOCIAL?.sites?.[site]?.enabled ? 'checked' : ''} onchange="socialSetting({ ${site}_enabled: this.checked })"> ${esc(t('st.auto'))}</label>`;
const needBrowser = () => (WHO.browser ? '' : `<div class="why">${ICON.alert} ${esc(t('st.browser.none'))}</div>`);

// ———————————————————————— 抖音 ————————————————————————
async function douyinPaint() {
  const el = $('#plat-douyin'); if (!el) return;
  const s = await getJson('/api/douyin/status'), ac = await getJson('/api/douyin/accounts');
  if (!s || !ac) return needTokenCard(el);
  const accts = ac.accounts ?? [];
  // 已登录 = 在服务器上扫过码（或同步过）且登录态没过期；只在推送里出现过的昵称不算登录
  const loggedIn = accts.filter((a) => (a.last_login_at || a.last_sync) && !a.need_login);
  const bad = accts.filter((a) => a.need_login);
  const st = accts.some((a) => a.logging_in) ? badge('busy', t('st.status.syncing')) : bad.length && bad.length === accts.length ? badge('bad', t('st.status.bad')) : !loggedIn.length ? badge('', t('st.status.none')) : bad.length ? badge('warn', t('st.status.partial')) : badge('ok', t('st.status.ok'));
  const soc = SOCIAL?.sites?.douyin ?? {};
  const last = soc.last_sync ? t('st.last', { t: fmtWhen(soc.last_sync) }) + (soc.last_result ? ' · ' + t('st.last.result', { n: soc.last_result.added }) : '') : t('st.last.none');
  const acctRows = accts.length ? accts.map((a) => `<div class="acct"><b title="${esc(a.id)}">${esc(dyAcct(a))}</b>
      ${a.logging_in ? `<span class="warn">${esc(t('st.dy.logging'))}</span>` : a.need_login ? `<span class="bad">${esc(t('st.dy.need'))}</span>` : a.last_sync ? `<span class="meta">${esc(t('st.last', { t: fmtWhen(a.last_sync) }))}</span>` : a.last_login_at ? `<span class="meta">${esc(t('st.dy.waiting'))}</span>` : `<span class="meta">${esc(t('st.dy.notyet'))}</span>`}
      ${a.error ? `<span class="why" style="margin:0">${esc(String(a.error).slice(0, 50))}</span>` : ''}<span class="sp"></span>
      <button class="ed" title="${esc(a.need_login || (!a.last_login_at && !a.nickname) ? t('st.dy.login') : t('st.dy.relogin'))}" onclick="douyinLogin(${JSON.stringify(a.id).replace(/"/g, '&quot;')})">${ICON.qr}</button>
      <button class="ed" title="${esc(t('st.dy.sync.one'))}" onclick="douyinSync(${JSON.stringify(a.id).replace(/"/g, '&quot;')})">${ICON.sync}</button>
      ${a.id !== 'main' ? `<button class="ed" title="${esc(t('st.dy.remove'))}" onclick="douyinRemove(${JSON.stringify(a.id).replace(/"/g, '&quot;')})">${ICON.trash}</button>` : ''}</div>`).join('') : `<div class="meta">${esc(t('st.dy.accounts.none'))}</div>`;
  el.innerHTML = `<div class="hd"><div class="logo">${ICON.douyin}</div><div class="name">${esc(t('st.dy.title'))}${st}</div></div>
    <div class="sub">${esc(t('st.dy.sub'))}</div>
    <div class="stat"><div>${esc(last)}${soc.error ? ` · <span class="warn">${esc(soc.error)}</span>` : ''}</div>${s.total ? `<div>${esc(t('st.collected', { n: s.total }))} · ${esc(t('st.dy.kinds', { v: s.kinds?.video ?? 0, m: s.kinds?.music ?? 0 }))}</div><div>${esc(mediaLine(s))}</div>` : ''}
      ${s.folders?.length ? `<div class="meta" style="margin:0">${esc(t('st.dy.folders', { list: s.folders.slice(0, 5).map((f) => `${f.name} ${f.n}${f.total ? '/' + f.total : ''}`).join('，') + (s.folders.length > 5 ? ' ' + t('st.dy.folders.more', { n: s.folders.length - 5 }) : '') }))}</div>` : ''}</div>
    <div class="meta" style="margin-top:10px;font-weight:600">${esc(t('st.dy.accounts'))}</div><div class="accts">${acctRows}</div>
    ${needBrowser()}
    <div class="primary">${btnIcon('qr', accts.length ? t('st.dy.add') : t('st.dy.login'), 'btn-p', 'onclick="douyinLogin()"')}</div>
    <div class="secondary">${btnIcon('sync', t('st.sync.now'), 'btn-s', 'onclick="douyinSync(\'all\')"')}${btnIcon('image', t('st.dy.fix'), 'btn-s', `title="${esc(t('st.dy.fix.title'))}" onclick="douyinFixCovers()"`)}${btnIcon('script', t('st.script'), 'btn-s', 'onclick="scriptModal(\'douyin\')"')}${schedToggle('douyin')}</div>`;
}
let douyinLoginTimer = null;
async function douyinLogin(id = null) {
  clearInterval(douyinLoginTimer);
  modalOpen({ title: t('dlg.dy.title'), body: `<div class="qrbox"><div class="st"><span class="spin"></span>${esc(t('dlg.dy.starting'))}</div></div>`, onClose: () => clearInterval(douyinLoginTimer) });
  const r = await postJson('/api/douyin/login/start', id ? { account: id } : {});
  if (!r) { modalBody(`<div class="badline">${ICON.alert} ${esc(t('common.failed'))}</div>`); return; }
  const again = `<div class="row end" style="margin-top:10px">${btnIcon('refresh', t('dlg.dy.again'), 'btn-s', `onclick="douyinLogin(${JSON.stringify(r.account).replace(/"/g, '&quot;')})"`)}</div>`;
  const poll = async () => {
    const s = await (await fetch('/api/douyin/login/status?account=' + encodeURIComponent(r.account))).json();
    if (s.state === 'qr' && s.qr) modalBody(`<div class="qrbox"><img src="${s.qr}" alt="QR"><div class="st"><span class="spin"></span>${esc(t('dlg.dy.wait'))} · ${esc(t('dlg.dy.scan'))}（${esc(t('dlg.dy.account', { id: r.account }))}）</div><div class="meta" style="text-align:center">${esc(t('dlg.dy.confirm'))}<br>${esc(t('dlg.dy.refresh'))}</div></div>`);
    else if (s.state === 'logged_in') { clearInterval(douyinLoginTimer); modalBody(`<div class="qrbox"><div class="okline">${ICON.check} ${esc(t('dlg.dy.ok', { name: s.nickname ? '：' + s.nickname : '' }))}</div></div><div class="row end">${btnIcon('sync', t('dlg.dy.syncnow'), 'btn-p', `onclick="modalClose();douyinSync(${JSON.stringify(r.account).replace(/"/g, '&quot;')})"`)}</div>`); douyinPaint(); }
    else if (s.state === 'timeout') { clearInterval(douyinLoginTimer); modalBody(`<div class="badline">${ICON.clock} ${esc(t('dlg.dy.timeout'))}</div>${again}`); }
    else if (s.state === 'error' || s.state === 'noqr') { clearInterval(douyinLoginTimer); modalBody(`<div class="badline">${ICON.alert} ${esc(t('dlg.dy.error', { raw: s.raw || s.state }))}</div>${again}`); }
  };
  douyinLoginTimer = setInterval(poll, 3000); poll();
}
async function douyinSync(account) {
  toast(t('sync.started'));
  const r = await postJson('/api/douyin/sync', { account, mode: 'all', max_items: 300, media_limit: 20, max_ms: 180000 });
  if (r) toast(r.list?.need_login ? t('sync.need') : t('sync.ok', { n: r.list?.added ?? 0 }) + (r.media?.files ? t('sync.files', { n: r.media.files }) : '') + (r.media?.stopped ? '；' + r.media.stopped : ''));
  refreshAll();
}
async function douyinRemove(id) {
  if (!(await confirmModal(t('st.dy.remove'), t('st.dy.remove.confirm', { id }), { danger: true }))) return;
  const r = await fetch('/api/douyin/accounts/' + encodeURIComponent(id), { method: 'DELETE' });
  toast(r.ok ? t('st.dy.removed') : t('common.failed')); douyinPaint();
}
async function douyinFixCovers() {
  const r = await postJson('/api/douyin/fix-covers', { limit: 200 });
  if (r) toast(t('st.dy.fix.ok', { fixed: r.fixed, failed: r.failed ? t('st.dy.fix.failed', { n: r.failed }) : '', remaining: r.remaining }));
}

// ———————————————————————— X ————————————————————————
async function xPaint() {
  const el = $('#plat-x'); if (!el) return;
  const s = await getJson('/api/x/status'); if (!s) return needTokenCard(el);
  const st = s.syncing ? badge('busy', t('st.status.syncing')) : s.logged_in ? badge('ok', t('st.status.ok') + (s.handle ? ' @' + s.handle : '')) : s.need_login ? badge('bad', t('st.status.bad')) : badge('', t('st.status.none'));
  const last = s.last_sync ? t('st.last', { t: fmtWhen(s.last_sync) }) + (s.last_result ? ' · ' + t('st.last.result', { n: s.last_result.added }) : '') : t('st.last.none');
  el.innerHTML = `<div class="hd"><div class="logo">${ICON.xlogo}</div><div class="name">${esc(t('st.x.title'))}${st}</div></div>
    <div class="sub">${esc(t('st.x.sub'))}</div>
    <div class="stat"><div>${esc(last)}${s.sync_error ? ` · <span class="warn">${esc(s.sync_error)}</span>` : ''}</div>${s.total ? `<div>${esc(t('st.collected', { n: s.total }))} · ${esc(t('st.x.liked', { n: s.liked }))} · ${esc(t('st.x.bookmarked', { n: s.bookmarked }))}</div><div>${esc(mediaLine(s))}</div>` : ''}
      ${s.accounts?.length ? `<div class="meta" style="margin:0">${s.accounts.map((a) => '@' + esc(a.name) + ' ' + a.n).join('，')}</div>` : ''}</div>
    ${needBrowser()}
    <div class="primary">${btnIcon('monitor', s.logged_in ? t('st.x.relogin') : t('st.x.login'), 'btn-p', 'onclick="xLogin()"')}</div>
    <div class="secondary">${btnIcon('sync', t('st.sync.now'), 'btn-s', 'onclick="xSync()"')}${btnIcon('script', t('st.script.backup'), 'btn-s', 'onclick="scriptModal(\'x\')"')}${s.logged_in ? btnIcon('logout', t('st.logout'), 'btn-s', 'onclick="xLogout()"') : ''}${schedToggle('x')}</div>
    <div class="meta" style="margin-top:8px">${t('st.x.import', { api: '<code>POST /api/x/import {path, kind}</code>' })}</div>`;
}
let xLoginTimer = null, xCountdown = null;
async function xLogin() {
  clearInterval(xLoginTimer); clearInterval(xCountdown);
  modalOpen({ title: t('dlg.x.title'), wide: true, body: `<div class="qrbox"><div class="st"><span class="spin"></span>${esc(t('common.loading'))}</div></div>`, onClose: () => { clearInterval(xLoginTimer); clearInterval(xCountdown); } });
  const tk = await postJson('/api/x/ticket', {});
  if (!tk) { modalBody(`<div class="badline">${ICON.alert} ${esc(t('common.failed'))}</div>`); return; }
  const cmd = `node scripts/login-x.mjs --server ${location.origin} --code ${tk.code}`;
  const exp = tk.expires_at ? Date.parse(tk.expires_at) : Date.now() + (tk.expires_in ?? 900) * 1000;
  modalBody(`<div class="meta">${esc(t('dlg.x.sub'))}</div>
    <div class="bigcode" id="xCode">${esc(tk.code)}</div><div class="meta" style="text-align:center" id="xExp"></div>
    <div class="cmd"><code id="xCmd">${esc(cmd)}</code>${btnIcon('copy', t('common.copy'), 'btn-s', 'onclick="copyText($(\'#xCmd\').textContent)"')}</div>
    <div class="meta">${esc(t('dlg.x.server'))}</div>
    <div class="st" id="xState" style="margin-top:10px;display:flex;align-items:center;gap:8px"><span class="spin"></span>${esc(t('dlg.x.wait'))}</div>`);
  const tick = () => {
    const left = Math.max(0, exp - Date.now()); const m = Math.floor(left / 60000), sec = Math.floor(left % 60000 / 1000);
    const el = $('#xExp'); if (!el) { clearInterval(xCountdown); return; }
    if (!left) { clearInterval(xCountdown); clearInterval(xLoginTimer); el.innerHTML = `<span class="bad">${esc(t('dlg.x.expired'))}</span> ${btnIcon('refresh', t('dlg.x.renew'), 'btn-s', 'onclick="xLogin()"')}`; $('#xState')?.remove(); return; }
    el.textContent = t('dlg.x.expire', { m, s: String(sec).padStart(2, '0') });
  };
  tick(); xCountdown = setInterval(tick, 1000);
  xLoginTimer = setInterval(async () => {
    const s = await (await fetch('/api/x/status')).json();
    const st = $('#xState'); if (!st) { clearInterval(xLoginTimer); return; }
    if (s.logged_in && s.logged_in_at && Date.now() - Date.parse(s.logged_in_at) < 20 * 60000) { clearInterval(xLoginTimer); clearInterval(xCountdown); st.innerHTML = `<span class="okline">${ICON.check} ${esc(t('dlg.x.ok', { h: s.handle ? ' @' + s.handle : '' }))}</span>`; $('#xExp')?.remove(); xPaint(); }
  }, 3000);
}
async function xSync() {
  toast(t('sync.started'));
  const r = await postJson('/api/x/sync', {});
  if (r) toast(r.need_login ? t('st.x.sync.need') : r.skipped ? t('st.x.sync.busy') : t('st.x.sync.ok', { n: r.added ?? 0 }) + (r.blocked ? '，' + r.blocked : ''));
  refreshAll();
}
async function xLogout() { if (!(await confirmModal(t('st.logout'), t('st.x.logout.confirm'), { danger: true }))) return; if (await postJson('/api/x/logout', {})) { toast(t('st.x.logout.ok')); refreshAll(); } }

// ———————————————————————— 微博 ————————————————————————
async function weiboPaint() {
  const el = $('#plat-weibo'); if (!el) return;
  const s = await getJson('/api/weibo/status'); if (!s) return needTokenCard(el);
  const soc = SOCIAL?.sites?.weibo ?? {};
  const st = s.fetching || SOCIAL?.running ? badge('busy', t('st.status.syncing')) : soc.need_login ? badge('bad', t('st.status.bad')) : soc.last_sync ? badge('ok', t('st.status.ok')) : badge('', t('st.status.none'));
  const last = soc.last_sync ? t('st.last', { t: fmtWhen(soc.last_sync) }) + (soc.last_result ? ' · ' + t('st.last.result', { n: soc.last_result.added }) : '') : t('st.last.none');
  el.innerHTML = `<div class="hd"><div class="logo">${ICON.weibo}</div><div class="name">${esc(t('st.wb.title'))}${st}</div></div>
    <div class="sub">${esc(t('st.wb.sub'))}</div>
    <div class="stat"><div>${esc(last)}${soc.error ? ` · <span class="warn">${esc(soc.error)}</span>` : ''}</div>${s.total ? `<div>${esc(t('st.collected', { n: s.total }))} · ${esc(t('st.wb.imported', { n: s.imported }))} · ${esc(t('st.wb.dead', { n: s.unavailable }))}</div><div>${esc(mediaLine(s))} · ${esc(t('st.wb.video', { n: s.video_done }))}${s.video_pending ? ' · ' + esc(t('st.wb.video.pending', { n: s.video_pending })) : ''}</div>` : ''}</div>
    <div class="imp"><input class="f" id="weiboImportPath" placeholder="${esc(t('st.wb.import.path'))}"></div>
    <label class="meta" style="display:inline-flex;align-items:center;gap:5px;margin-top:6px"><input type="checkbox" id="weiboImportOwn"> ${esc(t('st.wb.import.own'))}</label>
    <div class="primary">${btnIcon('upload', t('st.wb.import'), 'btn-p', 'onclick="weiboImport(this)"')}${btnIcon('script', t('st.script'), 'btn-s', 'onclick="scriptModal(\'weibo\')"')}</div>
    <div class="secondary">${btnIcon('monitor', t('st.wb.login'), 'btn-s', `title="${esc(t('st.wb.login.title'))}" onclick="socialLogin('weibo')"`)}${btnIcon('download', t('st.wb.fetch'), 'btn-s', 'onclick="weiboFetch()"')}${schedToggle('weibo')}</div>`;
}
async function weiboImport(btn) {
  btn.disabled = true;
  try {
    const r = await postJson('/api/weibo/import', { path: $('#weiboImportPath').value, include_own: $('#weiboImportOwn').checked });
    if (r) toast(t('st.wb.import.ok', { added: r.added, updated: r.updated }) + (r.media_fetch_started ? t('st.wb.import.media') : ''));
    refreshAll();
  } finally { btn.disabled = false; }
}
async function weiboFetch() { const r = await postJson('/api/weibo/media/fetch', { limit: 40 }); if (r) toast(t('st.wb.fetch.ok', { done: r.done, failed: r.failed, files: r.files })); weiboPaint(); }
async function socialLogin(site) { const r = await postJson('/api/social/login', { site }); if (r) toast(t('st.wb.login.started')); }

// ———————————————————————— 油猴脚本安装弹窗 ————————————————————————
async function scriptModal(name) {
  const label = { douyin: t('st.dy.title'), weibo: t('st.wb.title'), x: t('st.x.title') }[name];
  modalOpen({ title: t('dlg.script.title', { p: label }), wide: true, body: `<div class="qrbox"><div class="st"><span class="spin"></span>${esc(t('common.loading'))}</div></div>` });
  const r = await postJson('/api/userscript/install-link', { script: name });
  if (!r) { modalBody(`<div class="badline">${ICON.alert} ${esc(t('common.failed'))}</div>`); return; }
  modalBody(`<div class="meta">${esc(t('dlg.script.sub'))}</div>
    <div class="meta" style="margin-top:8px;font-weight:600">${esc(t('dlg.script.link'))}</div>
    <div class="cmd"><code id="scriptUrl">${esc(r.url)}</code>${btnIcon('copy', t('common.copy'), 'btn-s', 'onclick="copyText($(\'#scriptUrl\').textContent)"')}</div>
    <div class="row end">${btnIcon('external', t('dlg.script.open'), 'btn-p', `onclick="window.open(${JSON.stringify(r.url).replace(/"/g, '&quot;')}, '_blank', 'noopener')"`)}</div>
    <div class="meta" style="margin-top:12px;font-weight:600">${esc(t('dlg.script.steps'))}</div>
    <ol><li>${esc(t('dlg.script.s1'))}</li><li>${esc(t('dlg.script.s2'))}</li><li>${esc(t('dlg.script.s3.' + name))}</li></ol>
    <div class="meta" style="margin-top:10px">${ICON.alert} ${esc(t('dlg.script.note'))}</div>`);
}

// ———————————————————————— 定时 / 存档 ————————————————————————
async function schedPaint() {
  const el = $('#schedCard'); if (!el) return;
  if (!SOCIAL?.sites) return needTokenCard(el);
  const hours = SOCIAL.hours ?? 12;
  const line = (name, site, fav) => { const st = SOCIAL.sites[site] ?? {}; return `<div><b>${esc(name)}</b> ${esc(t('st.collected', { n: fav?.total ?? 0 }))}${fav?.media_pending ? esc(t('st.sched.mediapending', { n: fav.media_pending })) : ''} · ${st.need_login ? `<span class="bad">${esc(t('st.status.bad'))}</span>` : st.last_sync ? esc(t('st.last', { t: fmtWhen(st.last_sync) })) + (st.last_result ? '，' + esc(t('st.last.result', { n: st.last_result.added })) : '') : esc(t('st.sched.nologin'))}${st.error ? ` · <span class="warn">${esc(st.error)}</span>` : ''}${st.enabled ? '' : ' ' + esc(t('st.sched.off'))}</div>`; };
  el.innerHTML = `<div class="t">${ICON.clock}<span>${esc(t('st.sched', { h: hours }))}</span>${SOCIAL.running ? badge('busy', t('st.sched.running')) : ''}</div>
    <div class="sub">${esc(t('st.sched.sub'))}</div>
    <div class="lines">${line(t('st.dy.title'), 'douyin', SOCIAL.douyin)}${line(t('st.wb.title'), 'weibo', SOCIAL.weibo)}${line(t('st.x.title'), 'x', SOCIAL.x)}</div>
    <div class="acts">${btnIcon('sync', t('st.sched.inc'), 'btn-p', 'onclick="socialSync(false)"')}${btnIcon('refresh', t('st.sched.full'), 'btn-s', 'onclick="socialSync(true)"')}</div>`;
}
async function socialSync(full) { const r = await postJson('/api/social/sync', { full, force: true }); if (r) toast(t('st.sched.started')); setTimeout(refreshAll, 8000); }
async function socialSetting(patch) { const r = await postJson('/api/social/settings', patch); if (r) toast(t('common.saved')); refreshAll(); }
async function archivePaint() {
  const el = $('#archiveCard'); if (!el) return;
  try {
    const a = await getJson('/api/archive'); if (!a) return needTokenCard(el);
    const size = a.bytes > 1073741824 ? (a.bytes / 1073741824).toFixed(2) + ' GB' : (a.bytes / 1048576).toFixed(1) + ' MB';
    el.innerHTML = `<div class="t">${ICON.archive}<span>${esc(t('st.archive'))}</span></div><div class="meta">${esc(t('st.archive.sub'))}</div>
      <div class="meta" style="margin-top:10px">${esc(t('st.archive.dir'))} <code>${esc(a.root)}</code>${a.exists ? '' : ' ' + esc(t('st.archive.missing'))}<br>${esc(t('st.archive.count', { done: a.done, total: a.total, size }))}${a.failed ? ` · <span class="warn">${esc(t('st.archive.failed', { n: a.failed }))}</span>` : ''}</div>
      <div class="acts">${btnIcon('folder', t('arc.root'), 'btn-s', 'onclick="arcSetRoot()"')}${btnIcon('link', t('st.archive.index'), 'btn-s', 'onclick="arcIndex()"')}${btnIcon('image', t('st.archive.flag'), 'btn-s', `title="${esc(t('st.archive.flag.title'))}" onclick="arcFlagAnim()"`)}${a.exists ? `<a class="btn-s ico" href="/archive/" target="_blank" rel="noopener">${ICON.external}<span>${esc(t('arc.open'))}</span></a>` : ''}</div>`;
  } catch { el.innerHTML = `<div class="meta">${esc(t('common.unknown'))}</div>`; }
}
async function arcSetRoot() {
  const a = await (await fetch('/api/archive')).json();
  const root = prompt(t('arc.root.prompt'), a.root);
  if (root === null) return;
  if (await postJson('/api/archive/root', { root: root.trim() })) { toast(t('common.saved')); archivePaint(); }
}
async function arcIndex() { const r = await postJson('/api/archive/index', {}); if (r) toast(t('arc.index.ok', { n: r.count, p: r.index })); }
async function arcFlagAnim() { const r = await postJson('/api/archive/flag-anim', {}); if (r) toast(t('st.archive.flag.ok', { checked: r.checked, flagged: r.flagged })); }

async function refreshAll() { await loadSocial(); douyinPaint(); xPaint(); weiboPaint(); schedPaint(); archivePaint(); }
document.addEventListener('DOMContentLoaded', () => { connPaint(); refreshAll(); connectLive(refreshAll); });
