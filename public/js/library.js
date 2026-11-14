// 收藏库视图。布局参照 Eagle 的素材管理器：左边筛选（媒体类型 / 来源 / 标签），中间**预览优先**的瀑布流，
// 右边检视器——点一张卡，元数据、标签、本地媒体、存档文件全在右边。开源对应物：TagStudio 的三栏、karakeep 的 Masonry / Grid / List 切换。
// 预览图的来源顺序：本地封面（存档目录里的 cover.*）→ 站外封面地址 → 图文第一张 → 视频抽帧 → 正文文字卡 → 站点首字母色块。
// 依赖 shell.js 的全局（$ esc toast postJson）和页面定义的 render()。
const libFilter = { tag: null, source: null, q: '', media: null };
// 媒体类型（照相册 App 的「媒体类型」分法）：按存档目录里实际有的文件分，服务端 MEDIA_TYPES 同一张表
const LIB_MEDIA = { video: { icon: '🎬', label: '视频' }, image: { icon: '🖼', label: '图文' }, live: { icon: '📸', label: '实况' }, anim: { icon: '🌀', label: '动图' }, music: { icon: '🎵', label: '音乐' }, audio: { icon: '🔊', label: '配乐' }, text: { icon: '📝', label: '仅文字 / 待下载' } };
const LIB_SOURCE = { 抖音: '♪', 微博: 'W', X: '𝕏' };
const LIB_DEAD_TAG = '已失效';          // 原站已删的收藏默认藏起来（微博同步打的标签）
let libShowDead = localStorage.getItem('lib_show_dead') === '1';
const LIB_PAGE = 60;
function libQuery(offset = 0) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(libFilter)) if (v) p.set(k, v);
  if (!libShowDead && libFilter.tag !== LIB_DEAD_TAG) p.set('exclude_tag', LIB_DEAD_TAG);
  p.set('limit', String(LIB_PAGE));
  if (offset) p.set('offset', String(offset));
  return p;
}
function libToggleDead() { libShowDead = !libShowDead; localStorage.setItem('lib_show_dead', libShowDead ? '1' : '0'); render(); }
// 再拿一页接在后面：只重画网格那一块，别让整页跳回顶部
let libLoading = false;
async function libLoadMore() {
  if (libLoading || !libData) return;
  libLoading = true;
  const btn = $('#libMore button'); if (btn) { btn.disabled = true; btn.textContent = '加载中…'; }
  try {
    const d = await (await fetch('/api/library?' + libQuery(libData.items.length))).json();
    const got = d.items ?? [];
    libData.items.push(...got);
    const vm = shapeLibrary(libData);
    const grid = document.querySelector('.eg-grid');
    if (grid) grid.insertAdjacentHTML('beforeend', got.map((i) => libCard(i, vm)).join(''));
    const more = $('#libMore'); if (more) more.outerHTML = libMoreHtml(vm);
    const h = document.querySelector('.eg-bar h2 .meta'); if (h) h.textContent = `${vm.items.length}${vm.hasFilter ? ' 条' : ' / ' + vm.stats.total + ' 条'}`;
  } finally { libLoading = false; libWatchMore(); }
}
function libMoreHtml(vm) {
  const full = vm.items.length >= LIB_PAGE && vm.items.length % LIB_PAGE === 0;
  return `<div id="libMore" style="text-align:center;padding:16px 0 6px">${full ? `<button class="btn-s" onclick="libLoadMore()">加载更多（已显示 ${vm.items.length} 条）</button>` : (vm.items.length ? `<span class="meta">到底了 · ${vm.items.length} 条</span>` : '')}</div>`;
}
function libWatchMore() {
  const el = $('#libMore button'); if (!el || !('IntersectionObserver' in window)) return;
  const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) { io.disconnect(); libLoadMore(); } }, { root: document.querySelector('body.pg main'), rootMargin: '400px' });
  io.observe(el);
}
let libView = localStorage.getItem('lib_view') || 'masonry';   // masonry | grid | list
let libSize = localStorage.getItem('lib_size') || 'm';           // s | m | l：卡片宽度
const LIB_SIZE_W = { s: 150, m: 196, l: 260 };
function libSetSize(v) { libSize = v; localStorage.setItem('lib_size', v); const g = document.querySelector('.eg-grid'); if (g) g.style.setProperty('--card-w', LIB_SIZE_W[v] + 'px'); document.querySelectorAll('.eg-sizeseg button').forEach((b) => b.classList.toggle('on', b.dataset.v === v)); }
// 标签太多就按来源分组：抖音收藏夹（几十个）、抖音账号、X 账号、来源/状态、其它。组可折叠，折叠状态记住。
const LIB_TAG_GROUPS = [
  { key: 'dyf', label: '抖音收藏夹', test: (t) => t.startsWith('抖音夹·'), strip: '抖音夹·' },
  { key: 'dya', label: '抖音账号', test: (t) => t.startsWith('抖音@'), strip: '抖音@' },
  { key: 'xa', label: 'X 账号', test: (t) => t.startsWith('X@'), strip: 'X@' },
  { key: 'src', label: '来源 / 状态', test: (t) => /^(抖音收藏|抖音音乐|微博收藏|X收藏|X点赞|X书签|已失效)$/.test(t) },
  { key: 'other', label: '其它标签', test: () => true },
];
const libTagOpen = (() => { try { return JSON.parse(localStorage.getItem('lib_taggroups') || '{"src":true,"other":true}'); } catch { return { src: true, other: true }; } })();
function libToggleTagGroup(key) { libTagOpen[key] = !libTagOpen[key]; localStorage.setItem('lib_taggroups', JSON.stringify(libTagOpen)); render(); }
function libTagGroupsHtml(vm) {
  const a = vm.active; const used = new Set();
  const groups = LIB_TAG_GROUPS.map((g) => ({ ...g, tags: vm.tags.filter((t) => !used.has(t.name) && g.test(t.name) && used.add(t.name)) })).filter((g) => g.tags.length);
  const chip = (t, strip) => `<button class="eg-tag ${a.tag === t.name ? 'on' : ''}" title="${esc(t.name)}" onclick="libSet('tag', ${a.tag === t.name ? 'null' : JSON.stringify(t.name).replace(/"/g, '&quot;')})"><span>${esc(strip ? t.name.slice(strip.length) : t.name)}</span><i>${t.count}</i></button>`;
  return groups.map((g) => {
    const open = !!libTagOpen[g.key] || g.tags.some((t) => t.name === a.tag);
    const total = g.tags.reduce((n, t) => n + t.count, 0);
    return `<div class="eg-tg"><div class="eg-tg-h" onclick="libToggleTagGroup('${g.key}')"><span class="ic">${open ? '▾' : '▸'}</span><span class="lb">${g.label}</span><span class="n" title="${g.tags.length} 个标签 · 共 ${total} 条">${total}</span></div>
      ${open ? `<div class="eg-tags">${g.tags.map((t) => chip(t, g.strip)).join('')}</div>` : ''}</div>`;
  }).join('') || '<span class="meta" style="padding:0 8px">同步进来后标签出现在这里</span>';
}
// 本地媒体：这张卡有没有下好的视频/音频/图，点开用哪个文件
function libMediaFile(i) {
  const fs = i.archive?.files ?? [];
  if (fs.includes('video.mp4')) return { file: 'video.mp4', kind: '🎬 视频' };
  const live = fs.find((f) => /^live-\d+\.mp4$/.test(f)); const img = fs.find((f) => /^image-\d+\./.test(f)); const aud = fs.find((f) => /^audio\./.test(f));
  const anim = fs.some((f) => /^image-\d+\.(anim\.webp|gif|anim\.gif)$/.test(f));
  if (img) return { file: img, kind: live ? '🖼 图文 · 实况' : anim ? '🌀 动图' : '🖼 图文' };
  if (aud) return { file: aud, kind: '🎵 音频' };
  return null;
}
function libOpenLocal(ev, key) { ev?.stopPropagation?.(); const i = libData?.items?.find((x) => libKey(x) === key); if (!i) return; if (libMediaFile(i) || i.image || (i.archive?.files ?? []).some((f) => /^(cover|image-)/.test(f))) libLightbox(i); else if (i.url) window.open(i.url, '_blank'); }
// —— 内置放大播放器（lightbox）：视频直接播、图文左右翻、音乐带封面播；都是本地存档文件，站点没了照样放 ——
let libLb = null;   // { item, imgs, idx }
function libLightbox(i) {
  const files = i.archive?.files ?? [];
  const vids = files.filter((f) => f === 'video.mp4' || /^live-\d+\.mp4$/.test(f));
  const imgs = files.filter((f) => /^image-\d+\./.test(f)).sort();
  const auds = files.filter((f) => /^audio\./.test(f));
  const cover = files.find((f) => /^cover\./.test(f));
  libLb = { item: i, imgs, idx: 0, vids, auds, cover };
  let box = document.getElementById('libLightbox');
  if (!box) { box = document.createElement('div'); box.id = 'libLightbox'; box.className = 'eg-lb'; box.onclick = (e) => { if (e.target === box) libLightboxClose(); }; document.body.appendChild(box); }
  box.innerHTML = libLightboxHtml();
  box.classList.add('on');
  document.body.style.overflow = 'hidden';
  box.querySelector('video, audio')?.play?.().catch(() => {});
}
function libLightboxHtml() {
  const { item: i, imgs, idx, vids, auds, cover } = libLb;
  const u = (f) => esc(libArchiveUrl(i, f));
  const poster = cover ? u(cover) : (i.image ? esc(i.image) : '');
  let stage;
  if (vids.includes('video.mp4')) stage = `<video controls autoplay playsinline preload="metadata" src="${u('video.mp4')}" ${poster ? `poster="${poster}"` : ''}></video>`;
  else if (imgs.length) {
    const f = imgs[idx]; const live = vids.find((v) => v === f.replace(/^image-(\d+)\..*$/, 'live-$1.mp4'));
    stage = (live ? `<video controls autoplay loop muted playsinline src="${u(live)}" poster="${u(f)}"></video>` : `<img src="${u(f)}" alt="">`)
      + (imgs.length > 1 ? `<button class="nav prev" onclick="libLightboxStep(-1)">‹</button><button class="nav next" onclick="libLightboxStep(1)">›</button><span class="cnt">${idx + 1} / ${imgs.length}${live ? ' · 实况' : ''}</span>` : '');
  } else if (auds.length) stage = `<div class="aud">${poster ? `<img src="${poster}" alt="">` : '<div class="disc">🎵</div>'}<audio controls autoplay src="${u(auds[0])}"></audio></div>`;
  else if (poster) stage = `<img src="${poster}" alt="">`;
  else stage = '<div class="eg-empty"><b>▦</b>这条还没有本地媒体文件</div>';
  const strip = imgs.length > 1 ? `<div class="strip">${imgs.map((f, k) => `<img src="${esc(libThumb(libArchiveUrl(i, f), 160))}" class="${k === idx ? 'on' : ''}" onclick="libLightboxGo(${k})" alt="">`).join('')}</div>` : '';
  const cur = vids.includes('video.mp4') ? 'video.mp4' : imgs[idx] ?? auds[0] ?? cover;
  return `<div class="eg-lb-box">
    <div class="eg-lb-stage">${stage}</div>${strip}
    <div class="eg-lb-bar"><div class="t" title="${esc(i.title)}">${esc(i.title)}</div>
      ${auds.length && !vids.includes('video.mp4') && imgs.length ? `<audio controls preload="none" src="${u(auds[0])}" title="配乐"></audio>` : ''}
      ${cur ? `<a class="btn-s" href="${u(cur)}" target="_blank" rel="noopener">⤓ 原文件</a>` : ''}
      ${i.url ? `<a class="btn-s" href="${esc(i.url)}" target="_blank" rel="noopener">↗ 原链接</a>` : ''}
      <button class="btn-s" onclick="libLightboxClose()">✕ 关闭</button></div>
  </div>`;
}
function libLightboxStep(d) { if (!libLb?.imgs.length) return; libLb.idx = (libLb.idx + d + libLb.imgs.length) % libLb.imgs.length; document.getElementById('libLightbox').innerHTML = libLightboxHtml(); }
function libLightboxGo(k) { if (!libLb) return; libLb.idx = k; document.getElementById('libLightbox').innerHTML = libLightboxHtml(); }
function libLightboxClose() { const box = document.getElementById('libLightbox'); if (!box) return; box.querySelector('video, audio')?.pause?.(); box.classList.remove('on'); box.innerHTML = ''; libLb = null; document.body.style.overflow = ''; }
document.addEventListener('keydown', (e) => { if (!libLb) return; if (e.key === 'Escape') { e.stopImmediatePropagation(); libLightboxClose(); } else if (e.key === 'ArrowLeft') libLightboxStep(-1); else if (e.key === 'ArrowRight') libLightboxStep(1); }, true);
let libSelected = null;    // 'link:id'
let libData = null;        // 最近一次 /api/library 的结果（检视器从这里取条目）

const libKey = (i) => `${i.item_kind}:${i.item_id}`;
const libHost = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } };
const libHue = (s) => { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
const libArchiveUrl = (i, file) => (i.archive?.dir ? `/archive/${i.archive.dir.split('/').map(encodeURIComponent).join('/')}/${encodeURIComponent(file)}` : null);
// 缩略图：存档里的图/视频走 /thumb/...?w=（服务端 ffmpeg 缩好缓存），卡片不再拉几 MB 的原图；站外图原样
const LIB_THUMB_W = { s: 320, m: 400, l: 640 };
const libThumb = (src, w) => (src && src.startsWith('/archive/') ? '/thumb/' + src.slice('/archive/'.length) + '?w=' + (w || LIB_THUMB_W[libSize] || 400) : src);
// 图加载失败的退路：缩略图 → 原图 → 色块
function libImgErr(img) {
  const step = Number(img.dataset.step || 0);
  const next = step === 0 ? img.dataset.full : null;
  img.dataset.step = String(step + 1);
  if (next && next !== img.getAttribute('src')) { img.src = next; return; }
  img.parentNode.className = 'eg-thumb glyph'; img.remove();
}
// 预览：决定一张卡用什么当"图"。返回 {type:'img'|'text'|'glyph', ...}
function libPreview(i, w) {
  const files = i.archive?.files ?? [];
  if (i.image) return { type: 'img', src: libThumb(i.image, w), full: i.image };
  const local = files.find((f) => /^cover\./.test(f)) ?? files.find((f) => /^image-01\./.test(f)) ?? (files.includes('video.mp4') ? 'video.mp4' : null);
  if (local) { const full = libArchiveUrl(i, local); return { type: 'img', src: libThumb(full, w), full: local === 'video.mp4' ? null : full }; }
  // 纯文字的微博/帖子：没图就把正文摆出来当"图"，比一个站点首字母有用得多
  if (i.excerpt || i.body) return { type: 'text', text: String(i.excerpt || i.body).slice(0, 320) };
  const host = libHost(i.url) || (i.source ?? '');
  return { type: 'glyph', glyph: (LIB_SOURCE[i.source] ?? host[0] ?? '•').toUpperCase(), sub: host, hue: libHue(host) };
}
function libPreviewHtml(i, big = false) {
  const p = libPreview(i, big ? 800 : undefined);
  if (p.type === 'img') {
    // no-referrer：图床认 Referer 防盗链，本地封面还没补下来之前先直连显示
    return `<div class="eg-thumb" style="--h:${libHue(i.source ?? i.url ?? '')}"><img src="${esc(p.src)}" loading="lazy" decoding="async" referrerpolicy="no-referrer" alt="" data-full="${esc(p.full && p.full !== p.src ? p.full : '')}" onerror="libImgErr(this)"></div>`;
  }
  if (p.type === 'text') return `<div class="eg-thumb text">${esc(p.text || '（空）')}</div>`;
  return `<div class="eg-thumb glyph" style="--h:${p.hue}">${esc(p.glyph)}${p.sub && !big ? `<small>${esc(p.sub)}</small>` : ''}</div>`;
}

function shapeLibrary(d) {
  libData = d;
  const st = d.stats ?? { by_source: {}, total: 0, media_types: {} };
  const a = { ...libFilter };
  const selected = libSelected ? (d.items ?? []).find((i) => libKey(i) === libSelected) ?? null : null;
  if (libSelected && !selected) libSelected = null;
  const current = a.tag ? `#${a.tag}` : a.media ? (LIB_MEDIA[a.media]?.icon + ' ' + LIB_MEDIA[a.media]?.label) : a.source ? a.source : a.q ? `搜「${a.q}」` : '全部';
  return {
    stats: st, tags: d.tags ?? [], items: d.items ?? [], active: a, current, selected,
    sources: Object.entries(st.by_source ?? {}).filter(([, n]) => n > 0).sort((x, y) => y[1] - x[1]),
    hasFilter: !!(a.tag || a.source || a.q || a.media), view: libView,
    deadCount: (d.tags ?? []).find((t) => t.name === LIB_DEAD_TAG)?.count ?? 0, showDead: libShowDead,
  };
}

function libCard(i, vm) {
  const sel = libSelected === libKey(i);
  const when = (i.created_at || '').slice(0, 10);
  const src = i.source || libHost(i.url);
  const media = libMediaFile(i);
  return `<div class="eg-card ${sel ? 'sel' : ''}" data-key="${esc(libKey(i))}" onclick="libSelect(this.dataset.key)" ondblclick="libOpenLocal(event, this.dataset.key)">
    ${libPreviewHtml(i)}
    <span class="eg-kind">${media ? media.kind : '🔗 ' + esc(src || '链接')}</span>
    ${media || i.image ? `<button class="eg-play" title="${media ? '放大播放 / 查看（' + esc(media.file) + '）' : '放大查看封面'}" onclick="libOpenLocal(event, ${JSON.stringify(libKey(i)).replace(/"/g, '&quot;')})">${media && !/^(🖼)/.test(media.kind) ? '▶' : '⤢'}</button>` : ''}
    ${i.archive?.status === 'done' ? '<span class="eg-badge" title="已存档：站点挂了也还在">\u{1F4E5}</span>' : ''}
    <div class="eg-body">
      <div class="eg-title">${esc(i.title)}</div>
      <div class="eg-meta">${[src, when].filter(Boolean).map(esc).join(' · ')}</div>
      ${i.tags.length ? `<div class="eg-chips">${i.tags.slice(0, 3).map((t) => `<span>${esc(t)}</span>`).join('')}${i.tags.length > 3 ? `<span>+${i.tags.length - 3}</span>` : ''}</div>` : ''}
    </div></div>`;
}

function libRail(vm) {
  const a = vm.active;
  const nav = (on, icon, label, count, onclick) =>
    `<div class="eg-nav ${on ? 'on' : ''}" onclick="${onclick}"><span class="ic">${icon}</span><span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${label}</span>${count != null ? `<span class="n">${count}</span>` : ''}</div>`;
  return `<aside class="eg-rail">
    <section>
      <input class="f q" id="libQ" value="${esc(a.q || '')}" placeholder="搜标题、正文…" onkeydown="if(event.key==='Enter')libSet('q', this.value)">
      ${vm.hasFilter ? `<div class="eg-nav" onclick="libClear()"><span class="ic">✕</span>清除筛选</div>` : ''}
      <h5>来源</h5>
      ${nav(!a.source, '▦', '全部', vm.stats.total, "libSet('source', null)")}
      ${vm.sources.map(([s, n]) => nav(a.source === s, LIB_SOURCE[s] ?? '•', esc(s), n, `libSet('source', ${a.source === s ? 'null' : JSON.stringify(s).replace(/"/g, '&quot;')})`)).join('')}
      ${vm.deadCount ? nav(vm.showDead, vm.showDead ? '\u{1F441}' : '\u{1F648}', vm.showDead ? '已失效的也显示' : '已失效的已隐藏', vm.deadCount, 'libToggleDead()') : ''}
    </section>
    <section>
      <h5>媒体类型</h5>
      ${Object.entries(LIB_MEDIA).filter(([k]) => (vm.stats.media_types?.[k] ?? 0) > 0).map(([k, m]) => nav(a.media === k, m.icon, m.label, vm.stats.media_types[k], `libSet('media', ${a.media === k ? 'null' : JSON.stringify(k).replace(/"/g, '&quot;')})`)).join('') || '<div class="eg-nav" style="cursor:default;opacity:.6">媒体文件下到本地后出现</div>'}
    </section>
    <section>
      <h5>标签</h5>
      ${libTagGroupsHtml(vm)}
    </section>
    <section><div id="arcBox" class="eg-arc">存档状态检查中…</div></section>
  </aside>`;
}

function libInspector(i) {
  if (!i) return `<aside class="eg-insp"><div class="eg-empty"><b>▦</b>点一张卡片看详情<br>▶ 或双击放大播放 · Esc 关闭</div></aside>`;
  const jsStr = (v) => esc(JSON.stringify(v)).replace(/'/g, '&#39;');
  const arc = i.archive;
  const files = (arc?.files ?? []).filter((f) => f !== 'metadata.json');
  const fileLabel = { 'readable.md': '正文 .md', 'video.mp4': '视频', 'audio.mp3': '音频', 'audio.m4a': '音频', 'cover.jpg': '封面', 'cover.webp': '封面', 'cover-anim.webp': '动态封面', 'cover-anim.jpg': '动态封面' };
  // 存档里的媒体直接在面板里播：视频 / 实况短片 / 音频 / 动图 / 图文的图，都是本地文件，站点没了照样放
  const u = (f) => esc(libArchiveUrl(i, f));
  const vids = files.filter((f) => f === 'video.mp4' || /^live-\d+\.mp4$/.test(f));
  const auds = files.filter((f) => /^audio\./.test(f));
  const anim = files.find((f) => /^cover-anim\./.test(f));
  const imgs = files.filter((f) => /^image-\d+\./.test(f));
  const mediaHtml = (vids.length || auds.length || anim || imgs.length) ? `<div class="eg-sec"><h5>媒体（本地文件）</h5><div class="eg-media">
      ${vids.map((f) => `<video controls preload="metadata" src="${u(f)}" ${anim && f === 'video.mp4' ? `poster="${u(anim)}"` : ''}></video>${/^live/.test(f) ? '<div class="meta">实况 / 动图短片</div>' : ''}`).join('')}
      ${auds.map((f) => `<audio controls preload="none" src="${u(f)}"></audio>`).join('')}
      ${anim && !vids.length ? `<img src="${u(anim)}" alt="动态封面" title="动态封面（动图原样保存）">` : ''}
      ${imgs.length ? `<div class="eg-imgs">${imgs.map((f) => `<a href="${u(f)}" target="_blank" title="点开原图"><img src="${esc(libThumb(libArchiveUrl(i, f), 240))}" loading="lazy" decoding="async" alt="" onerror="this.onerror=null;this.src='${u(f)}'"></a>`).join('')}</div>` : ''}
    </div></div>` : '';
  const edBtn = (field, current, label) => `<button class="ed" title="编辑" onclick="libEditField(${i.item_id}, ${jsStr(field)}, ${jsStr(current ?? '')}, ${jsStr(label)})">✏️</button>`;
  return `<aside class="eg-insp">
    <div class="pv">${libPreviewHtml(i, true)}<button class="x" onclick="libSelect(null)" title="关闭">✕</button>${libMediaFile(i) || i.image ? `<button class="eg-play big" title="放大播放 / 查看" onclick="libOpenLocal(event, ${jsStr(libKey(i))})">${libMediaFile(i) && !/^🖼/.test(libMediaFile(i).kind) ? '▶' : '⤢'}</button>` : ''}</div>
    <div class="bd">
      <h3>${i.url ? `<a href="${esc(i.url)}" target="_blank" rel="noopener">${esc(i.title)}</a>` : esc(i.title)} ${edBtn('title', i.title, '标题')}</h3>
      ${i.source ? `<span class="tag">${esc(i.source)}</span>` : ''}
      ${arc?.status === 'done' ? '<span class="tag active">\u{1F4E5} 已存档</span>' : arc?.status === 'failed' ? `<span class="tag blocked" title="${esc(arc.error ?? '')}">存档失败</span>` : ''}
      <dl class="eg-kv">
        ${i.url ? `<dt>链接</dt><dd><a href="${esc(i.url)}" target="_blank" rel="noopener">${esc(i.url)}</a></dd>` : ''}
        <dt>收进来</dt><dd>${esc((i.created_at || '').slice(0, 16).replace('T', ' '))}</dd>
        ${arc?.dir ? `<dt>目录</dt><dd title="${esc(arc.dir)}">${esc(arc.dir)}</dd>` : ''}
      </dl>
      <div class="eg-sec"><h5>备注 ${edBtn('note', i.note, '备注（为什么存它）')}</h5>
        <div class="eg-note">${i.note ? esc(i.note) : '<span class="meta" style="margin:0">（没写）</span>'}</div></div>
      ${i.body ? `<div class="eg-sec"><h5>正文</h5><div class="eg-excerpt">${esc(i.body)}</div></div>` : ''}
      <div class="eg-sec"><h5>标签 <button class="ed" onclick="libEditTags(${i.item_id}, ${jsStr(i.tags.join(', '))})">✏️</button></h5>
        <div class="eg-chips">${i.tags.map((t) => `<span style="cursor:pointer" onclick="libSet('tag', ${jsStr(t)})">${esc(t)}</span>`).join('') || '<span class="meta" style="margin:0">还没打标签</span>'}</div></div>
      ${mediaHtml}
      <div class="eg-sec"><h5>存档文件</h5>
        <div class="eg-files">${files.map((f) => `<a href="${esc(libArchiveUrl(i, f))}" target="_blank" rel="noopener">${fileLabel[f] ?? esc(f.replace(/^image-(\d+)\..*$/, '图 $1').replace(/^live-(\d+)\.mp4$/, '实况 $1'))}</a>`).join('') || '<span class="meta" style="margin:0">还没有本地文件——媒体会在后台慢慢补</span>'}</div>
        ${arc?.archived_at ? `<div class="meta">存于 ${esc(arc.archived_at.slice(0, 16).replace('T', ' '))}</div>` : ''}</div>
      <div class="acts">
        ${i.url ? `<a class="btn-s" style="text-decoration:none;display:inline-flex;align-items:center" href="${esc(i.url)}" target="_blank" rel="noopener">↗ 打开原文</a>` : ''}
        <button class="btn-s" onclick="libRemove(${i.item_id})" title="只删这条记录，硬盘上的文件不动">🗑 移出收藏库</button>
      </div>
    </div></aside>`;
}

function htmlLibrary(vm) {
  const seg = (v, icon, title) => `<button class="${vm.view === v ? 'on' : ''}" title="${title}" onclick="libSetView('${v}')">${icon}</button>`;
  return `<div class="eg ${vm.selected ? 'has-sel' : ''}">
    ${libRail(vm)}
    <section class="eg-stage">
      <div class="eg-bar">
        <h2>\u{1F4DA} ${esc(vm.current)}<span class="meta">${vm.items.length}${vm.hasFilter ? ' 条' : ' / ' + vm.stats.total + ' 条'}</span></h2>
        <div class="sp"></div>
        <div class="eg-seg eg-sizeseg" title="卡片大小"><button data-v="s" class="${libSize === 's' ? 'on' : ''}" onclick="libSetSize('s')">小</button><button data-v="m" class="${libSize === 'm' ? 'on' : ''}" onclick="libSetSize('m')">中</button><button data-v="l" class="${libSize === 'l' ? 'on' : ''}" onclick="libSetSize('l')">大</button></div>
        <div class="eg-seg">${seg('masonry', '▤', '瀑布流')}${seg('grid', '▦', '网格')}${seg('list', '☰', '列表')}</div>
      </div>
      <div class="eg-grid ${vm.view}" style="--card-w:${LIB_SIZE_W[libSize]}px">${vm.items.map((i) => libCard(i, vm)).join('')
        || `<div class="eg-empty" style="column-span:all"><b>\u{1F4DA}</b>${vm.hasFilter ? '这个筛选下没有东西' : '这里还没有东西。去 <a href="/settings.html">设置</a> 登录抖音 / 微博 / X，或者安装油猴脚本，收藏就会自己进来。'}</div>`}</div>
      ${libMoreHtml(vm)}
    </section>
    ${libInspector(vm.selected)}
  </div>`;
}

// —— 交互：选中只换检视器和卡片的高亮，不整页重渲染（瀑布流重排会跳） ——
function libSelect(key) {
  libSelected = key || null;
  const eg = document.querySelector('.eg'); if (!eg || !libData) return;
  eg.querySelectorAll('.eg-card').forEach((c) => c.classList.toggle('sel', c.dataset.key === libSelected));
  const vm = shapeLibrary(libData);
  eg.querySelector('.eg-insp').outerHTML = libInspector(vm.selected);
  eg.classList.toggle('has-sel', !!vm.selected);
}
function libSetView(v) { libView = v; localStorage.setItem('lib_view', v); render(); }
async function libSet(key, value) { libFilter[key] = value === '' ? null : value; await render(); }
async function libClear() { Object.assign(libFilter, { tag: null, source: null, q: '', media: null }); await render(); }
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && libSelected && !libLb) libSelect(null); });

async function libEditField(id, field, current, label) {
  const v = prompt(label, current ?? '');
  if (v === null || v === (current ?? '')) return;
  const r = await fetch(`/api/library/items/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ [field]: v }) });
  if (r.ok) { toast('✅ 已修改'); await render(); } else toast('⚠ 没改成');
}
async function libEditTags(itemId, current) {
  const next = prompt('标签（逗号分隔，清空即删除全部）：', current);
  if (next === null) return;
  if (await postJson('/api/library/tags', { item_id: itemId, tags: next })) { toast('\u{1F3F7} 标签已更新'); await render(); }
}
async function libRemove(id) {
  if (!confirm('把这条从收藏库移出？只删数据库里的记录，存档目录里的文件原样保留。下次同步如果它还在平台收藏里，会再进来。')) return;
  const r = await fetch(`/api/library/items/${id}`, { method: 'DELETE' });
  if (r.ok) { toast('已移出（文件保留）'); libSelected = null; await render(); } else toast('⚠ ' + ((await r.json().catch(() => ({}))).error || r.status));
}

// —— 存档状态（左栏底部）——
async function loadArchive() {
  const box = $('#arcBox'); if (!box) return;
  try {
    const a = await (await fetch('/api/archive')).json();
    const mb = (n) => (n > 1073741824 ? (n / 1073741824).toFixed(2) + ' GB' : n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(0, Math.round(n / 1024)) + ' KB');
    const pct = a.total ? Math.round(a.done / a.total * 100) : 0;
    box.innerHTML = `<div>\u{1F4E5} <b>存档</b> ${a.done}/${a.total} · ${mb(a.bytes)}</div>
      <div class="bar"><i style="width:${pct}%"></i></div>
      <div class="acts">
        ${a.exists ? `<a class="btn-s" style="text-decoration:none;display:inline-flex;align-items:center" href="/archive/" target="_blank" rel="noopener">打开目录</a>` : ''}
        <button class="btn-s" onclick="arcIndex()" title="在存档根目录生成纯静态的 index.html，不跑 FavSync 也能翻">生成索引页</button>
        <button class="ed" onclick="arcSetRoot(${JSON.stringify(a.root).replace(/"/g, '&quot;')})" title="${esc(a.root)}">改目录</button></div>
      <div style="margin-top:6px;opacity:.8" title="${esc(a.root)}">目录放进云盘，站点被封也不丢。</div>`;
  } catch (e) { box.innerHTML = `<div class="why">存档状态读取失败：${esc(e.message)}</div>`; }
}
async function arcIndex() { const r = await postJson('/api/archive/index', {}); if (r) toast(`✅ 索引页已生成（${r.count} 条）：${r.index}`); }
async function arcSetRoot(current) {
  const root = prompt('存档目录（指向云盘同步的文件夹，留空恢复默认 ~/FavSync/archive）。注意：改目录不会搬已有文件。', current);
  if (root === null) return;
  const r = await postJson('/api/archive/root', { root: root.trim() });
  if (r) { toast('✅ 存档目录：' + r.root); loadArchive(); }
}
