// 设置页：各平台卡片的状态与按钮。依赖 shell.js 的全局（$ esc toast postJson）。
const when = (iso) => (iso ? esc(String(iso).slice(0, 16).replace('T', ' ')) : '');

// —— 油猴脚本安装：向服务要一个 24 小时有效的安装链接（脚本里带令牌，不能随便公开），然后让 Tampermonkey 接管 ——
async function installScript(name) {
  const r = await postJson('/api/userscript/install-link', { script: name });
  if (r) window.open(r.url, '_blank', 'noopener');
}

// —— 抖音：多账号 + 扫码登录（服务端无头浏览器把二维码导出来，这里轮询显示） ——
let douyinLoginTimer = null;
async function douyinAccountsPaint() {
  const el = $('#douyinAccounts'); if (!el) return;
  try {
    const d = await (await fetch('/api/douyin/accounts')).json();
    if (!d.accounts?.length) { el.textContent = '还没有账号，点下面「添加抖音账号」扫码。'; return; }
    el.innerHTML = d.accounts.map((a) => `<div class="acct">
      <b>${esc(a.nickname || a.id)}</b><span class="meta" style="margin:0">(${esc(a.id)})</span>
      ${a.logging_in ? '<span class="warn">正在扫码登录…</span>' : a.need_login ? '<span class="bad">需要重新登录</span>' : a.last_sync ? `上次同步 ${when(a.last_sync)}` : a.last_login_at ? '已登录，等下一轮同步' : '还没登录'}
      ${a.error ? `<span class="why" style="margin:0">${esc(String(a.error).slice(0, 60))}</span>` : ''}
      <button class="ed" title="扫码登录 / 重新登录" onclick="douyinLoginStart(${JSON.stringify(a.id).replace(/"/g, '&quot;')})">🔑 ${a.need_login || (!a.last_login_at && !a.nickname) ? '扫码登录' : '重新登录'}</button>
      <button class="ed" title="只同步这个号" onclick="douyinSyncNow(${JSON.stringify(a.id).replace(/"/g, '&quot;')})">⟳</button>
      ${a.id !== 'main' ? `<button class="ed" title="移除这个账号（已收的条目保留）" onclick="douyinRemove(${JSON.stringify(a.id).replace(/"/g, '&quot;')})">✕</button>` : ''}</div>`).join('');
  } catch { el.textContent = '账号列表读不到'; }
}
async function douyinLoginStart(id = null) {
  const box = $('#douyinLoginBox'); if (!box) return;
  box.style.display = ''; box.innerHTML = '<div class="meta">正在开浏览器拿二维码（10–20 秒）…</div>';
  const r = await postJson('/api/douyin/login/start', id ? { account: id } : {});
  if (!r) { box.innerHTML = '<div class="why">没能开始登录</div>'; return; }
  clearInterval(douyinLoginTimer);
  const poll = async () => {
    const s = await (await fetch('/api/douyin/login/status?account=' + encodeURIComponent(r.account))).json();
    if (s.state === 'qr' && s.qr) box.innerHTML = `<div class="meta">用<b>抖音 App</b> 扫这个码（账号 ${esc(r.account)}；二维码过期会自动换新的）</div><img class="qr" src="${s.qr}" alt="二维码"><div class="meta">扫完在手机上点确认，这里会自动变绿。</div>`;
    else if (s.state === 'logged_in') { clearInterval(douyinLoginTimer); box.innerHTML = `<div class="ok">✅ 已登录${s.nickname ? '：' + esc(s.nickname) : ''}。下一轮定时同步会带上它；也可以点「现在同步全部账号」。</div>`; douyinAccountsPaint(); setTimeout(() => { box.style.display = 'none'; }, 8000); }
    else if (s.state === 'timeout') { clearInterval(douyinLoginTimer); box.innerHTML = `<div class="why">8 分钟没扫码，已退出。<button class="btn-s" onclick="douyinLoginStart(${JSON.stringify(r.account).replace(/"/g, '&quot;')})">再来一次</button></div>`; }
    else if (s.state === 'error' || s.state === 'noqr') { clearInterval(douyinLoginTimer); box.innerHTML = `<div class="why">没拿到二维码（${esc(s.raw || s.state)}）。服务器上要装 Chrome 或 Edge；<button class="btn-s" onclick="douyinLoginStart(${JSON.stringify(r.account).replace(/"/g, '&quot;')})">重试</button></div>`; }
  };
  douyinLoginTimer = setInterval(poll, 3000); poll();
}
async function douyinSyncNow(account) {
  toast('⏳ 已开始同步（要开浏览器翻页，几分钟）');
  const r = await postJson('/api/douyin/sync', { account, mode: 'all', max_items: 300, media_limit: 20, max_ms: 180000 });
  if (r) toast(r.list?.need_login ? '⚠ 账号需要重新登录' : `✅ 同步完：新 ${r.list?.added ?? 0} 条${r.media?.files ? '，媒体 ' + r.media.files + ' 个文件' : ''}${r.media?.stopped ? '；' + r.media.stopped : ''}`);
  douyinAccountsPaint(); douyinStatusPaint();
}
async function douyinRemove(id) {
  if (!confirm(`移除账号 ${id}？它已收进来的条目和文件都保留，只是不再同步。`)) return;
  const r = await fetch('/api/douyin/accounts/' + encodeURIComponent(id), { method: 'DELETE' });
  toast(r.ok ? '已移除' : '❌ 没移除成'); douyinAccountsPaint();
}
async function douyinFixCovers() {
  toast('⏳ 正在用视频帧重做封面…');
  const r = await postJson('/api/douyin/fix-covers', { limit: 200 });
  if (r) toast(`✅ 修了 ${r.fixed} 条${r.failed ? '，失败 ' + r.failed : ''}，还剩 ${r.remaining}`);
}
async function douyinStatusPaint() {
  const el = $('#douyinStatus'); if (!el) return;
  try {
    const s = await (await fetch('/api/douyin/status')).json();
    if (!s.total) { el.textContent = '还没同步过。'; return; }
    el.innerHTML = `已收 <b>${s.total}</b> 条${s.kinds ? `（视频/图文 ${s.kinds.video || 0} · 音乐 ${s.kinds.music || 0}）` : ''} · 媒体存好 ${s.media_done}${s.media_pending ? '，待存 ' + s.media_pending : ''}${s.media_failed ? '，失败 ' + s.media_failed : ''}`
      + (s.accounts?.length ? ' · 账号：' + s.accounts.map((a) => `${esc(a.name)} ${a.n}`).join('，') : '')
      + (s.folders?.length ? ' · 收藏夹：' + s.folders.slice(0, 6).map((f) => `${esc(f.name)} ${f.n}${f.total ? '/' + f.total : ''}`).join('，') + (s.folders.length > 6 ? ` 等 ${s.folders.length} 个` : '') : '');
  } catch { el.textContent = ''; }
}

// —— X：口令 + 电脑端登录脚本 ——
async function xStatusPaint() {
  const el = $('#xStatus'); if (!el) return;
  try {
    const s = await (await fetch('/api/x/status')).json();
    const login = s.logged_in ? `<span class="ok">已登录${s.handle ? ' @' + esc(s.handle) : ''}</span>${s.last_sync ? '，上次同步 ' + when(s.last_sync) : '，还没同步过'}${s.syncing ? '，⏳ 正在同步' : ''}${s.sync_error ? '，<span class="warn">' + esc(s.sync_error) + '</span>' : ''}` : s.need_login ? '<span class="bad">登录失效，重新登一下</span>' : '服务器还没登录 X';
    el.innerHTML = login + (s.total ? `<br>已收 <b>${s.total}</b> 条（点赞 ${s.liked} · 书签 ${s.bookmarked}）· 媒体存好 ${s.media_done}${s.media_pending ? '，待存 ' + s.media_pending : ''}${s.media_failed ? '，失败 ' + s.media_failed : ''}${s.accounts?.length ? ' · 账号：' + s.accounts.map((a) => '@' + esc(a.name) + ' ' + a.n).join('，') : ''}` : '');
  } catch { el.textContent = ''; }
}
let xLoginTimer = null;
async function xLoginStart() {
  const box = $('#xLoginBox'); if (!box) return;
  box.style.display = ''; box.innerHTML = '<div class="meta">正在生成口令…</div>';
  const t = await postJson('/api/x/ticket', {});
  if (!t) { box.innerHTML = '<div class="why">没拿到口令</div>'; return; }
  const cmd = `node scripts/login-x.mjs --server ${location.origin} --code ${t.code}`;
  box.innerHTML = `<div class="meta">在<b>有屏幕的电脑</b>上（FavSync 项目目录里，装过依赖）运行这一条，会弹出一个 Chrome 窗口，照常登录 X，登完它自己把登录态发回来：</div>
    <div class="cmd"><code id="xLoginCmd">${esc(cmd)}</code><button class="btn-s" onclick="navigator.clipboard.writeText($('#xLoginCmd').textContent).then(()=>toast('已复制'))">复制</button></div>
    <div class="meta">口令 <b>${t.code}</b>，15 分钟有效、只能用一次。服务器地址如果不是浏览器里看到的这个，把 --server 换成服务器的公网/内网地址。</div><div class="meta" id="xLoginState" style="margin-top:6px">等待登录…</div>`;
  clearInterval(xLoginTimer);
  xLoginTimer = setInterval(async () => {
    const s = await (await fetch('/api/x/status')).json();
    const st = $('#xLoginState'); if (!st) { clearInterval(xLoginTimer); return; }
    if (s.logged_in && s.logged_in_at && Date.now() - Date.parse(s.logged_in_at) < 20 * 60000) { clearInterval(xLoginTimer); st.innerHTML = '<span class="ok">已登录，正在同步书签和点赞…</span>'; xStatusPaint(); }
  }, 3000);
}
async function xSyncNow() {
  toast('⏳ 开始同步 X（要开浏览器翻页，几分钟）');
  const r = await postJson('/api/x/sync', {});
  if (r) toast(r.need_login ? '⚠ 服务器还没登录 X' : r.skipped ? '上一轮还在跑' : `✅ 新 ${r.added ?? 0} 条${r.blocked ? '，' + r.blocked : ''}`);
  xStatusPaint();
}
async function xLogout() { if (!confirm('清掉服务器上的 X 登录态？已收的条目不受影响。')) return; if (await postJson('/api/x/logout', {})) { toast('已退出'); xStatusPaint(); } }

// —— 微博 ——
async function weiboStatusPaint() {
  const el = $('#weiboStatus'); if (!el) return;
  try {
    const s = await (await fetch('/api/weibo/status')).json();
    if (!s.total) { el.textContent = '还没同步过。'; return; }
    el.innerHTML = `已收 <b>${s.total}</b> 条（导入 ${s.imported} · 已失效 ${s.unavailable}）· 图存好 ${s.media_done}${s.media_pending ? '，待补 ' + s.media_pending : ''}${s.media_failed ? '，失败 ' + s.media_failed : ''} · 视频 ${s.video_done}${s.video_pending ? '，待下 ' + s.video_pending + '（要油猴脚本）' : ''}${s.fetching ? ' · ⏳ 正在补图' : ''}`;
  } catch { el.textContent = ''; }
}
async function weiboImport(btn) {
  btn.disabled = true;
  try {
    const r = await postJson('/api/weibo/import', { path: $('#weiboImportPath').value, include_own: $('#weiboImportOwn').checked });
    if (r) toast(`✅ 导入 ${r.added} 条新收藏，${r.updated} 条已有${r.media_fetch_started ? '；图片正在后台补全' : ''}`);
    weiboStatusPaint();
  } finally { btn.disabled = false; }
}
async function weiboFetchNow() { const r = await postJson('/api/weibo/media/fetch', { limit: 40 }); if (r) toast(`补图：成功 ${r.done} / 失败 ${r.failed}，${r.files} 个文件`); weiboStatusPaint(); }

// —— 常态化同步 ——
async function socialLogin(site) { const r = await postJson('/api/social/login', { site }); if (r) toast('🪟 ' + r.message); }
async function socialSync(full) {
  const r = await postJson('/api/social/sync', { full, force: true });
  if (r) toast('⏳ 已开始，要开浏览器翻页，几分钟后看状态');
  setTimeout(socialStatusPaint, 8000);
}
async function socialSetting(patch) { const r = await postJson('/api/social/settings', patch); if (r) toast('✅ 已保存'); socialStatusPaint(); }
async function socialStatusPaint() {
  const el = $('#socialStatus'); if (!el) return;
  try {
    const s = await (await fetch('/api/social/status')).json();
    const line = (name, st, fav) => `<b>${name}</b> ${fav.total} 条${fav.media_pending ? `（${fav.media_pending} 条媒体还在补）` : ''} · ${st.need_login ? '<span class="bad">需要重新登录</span>' : st.last_sync ? '上次定时同步 ' + when(st.last_sync) + (st.last_result ? `，新 ${st.last_result.added} 条` : '') : '还没登录过（脚本/导入照常可用）'}${st.error ? ` · <span class="warn">${esc(st.error)}</span>` : ''}${st.enabled ? '' : '（定时未开）'}`;
    el.innerHTML = [line('抖音', s.sites.douyin, s.douyin), line('微博', s.sites.weibo, s.weibo), line('X', s.sites.x, s.x)].join('<br>') + (s.running ? '<br>⏳ 正在同步…' : '');
    for (const site of ['douyin', 'weibo', 'x']) { const cb = $('#en_' + site); if (cb) cb.checked = !!s.sites[site].enabled; }
  } catch { el.textContent = '状态读不到'; }
}

// —— 存档 / 令牌 ——
async function archivePaint() {
  const el = $('#archiveStatus'); if (!el) return;
  try {
    const a = await (await fetch('/api/archive')).json();
    const mb = (n) => (n > 1073741824 ? (n / 1073741824).toFixed(2) + ' GB' : (n / 1048576).toFixed(1) + ' MB');
    el.innerHTML = `目录 <code>${esc(a.root)}</code>${a.exists ? '' : '（还没建）'}<br>已存 <b>${a.done}</b> / ${a.total} 条 · ${mb(a.bytes)}${a.failed ? ` · <span class="warn">${a.failed} 条失败</span>` : ''}`;
  } catch { el.textContent = '读不到'; }
}
async function arcSetRootFromSettings() {
  const a = await (await fetch('/api/archive')).json();
  const root = prompt('存档目录（指向云盘同步的文件夹，留空恢复默认 ~/FavSync/archive）。注意：改目录不会搬已有文件。', a.root);
  if (root === null) return;
  if (await postJson('/api/archive/root', { root: root.trim() })) { toast('✅ 已改'); archivePaint(); }
}
async function arcIndexFromSettings() { const r = await postJson('/api/archive/index', {}); if (r) toast(`✅ 索引页已生成（${r.count} 条）：${r.index}`); }
async function arcFlagAnim() { const r = await postJson('/api/archive/flag-anim', {}); if (r) toast(`检查 ${r.checked} 张，补标 ${r.flagged} 张${r.missing ? '，缺文件 ' + r.missing : ''}`); }
async function tokenPaint() {
  const el = $('#tokenBox'); if (!el) return;
  const r = await fetch('/api/auth/token');
  if (!r.ok) { el.innerHTML = '这台设备不是服务器本机，令牌只能在服务器上看。' + (apiToken() ? ' 本机已保存令牌。' : ' <button class="btn-s" onclick="askToken()">填写令牌</button>'); return; }
  const d = await r.json();
  el.innerHTML = `访问令牌：<code id="tok" style="user-select:all">${esc(d.token)}</code> <button class="btn-s" onclick="navigator.clipboard.writeText($('#tok').textContent).then(()=>toast('已复制'))">复制</button><br>脚本推送地址（FAVSYNC_PUBLIC_URL）：<code>${esc(d.public_url)}</code>`;
}

douyinStatusPaint(); douyinAccountsPaint(); xStatusPaint(); weiboStatusPaint(); socialStatusPaint(); archivePaint(); tokenPaint();
connectLive(() => { douyinStatusPaint(); xStatusPaint(); weiboStatusPaint(); socialStatusPaint(); archivePaint(); });
