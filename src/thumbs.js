// 缩略图：收藏库卡片别再直接拉原图。
//
// 为什么慢：图文帖一张原图 1–5 MB，一页 60 张卡就是上百 MB，再走远程访问回家，预览半天出不全。
// Eagle / Immich / 相册类应用快的原因只有一个——预先缩好的 300–400px 小图。这里做同一件事：
//   GET /thumb/<存档里的相对路径>?w=400  →  data/thumbs/<hash>.jpg（第一次生成，之后直接命中缓存）
// 用的是 ffmpeg-static（npm 装的时候就带了对应平台的二进制），图片缩放 / 动图取首帧 / 视频抽一帧当封面
// 都是它一条命令的事，不用再加 sharp 这类原生依赖。缓存键带文件 mtime 和大小，源文件换了自动失效。
import { existsSync, mkdirSync, statSync, renameSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { archiveRoot } from './archive.js';
import { dataDir } from './db.js';

const cacheDir = () => process.env.FAVSYNC_THUMBS || path.join(dataDir(), 'thumbs');
export const THUMB_WIDTHS = [160, 240, 320, 400, 480, 640, 800, 1024];
export const snapWidth = (w) => { const n = Number(w) || 400; return THUMB_WIDTHS.reduce((best, x) => (Math.abs(x - n) < Math.abs(best - n) ? x : best), THUMB_WIDTHS[0]); };
const IMAGE_EXT = /\.(jpe?g|png|webp|gif|bmp|avif|heic)$/i;
const VIDEO_EXT = /\.(mp4|mov|m4v|webm|mkv)$/i;
export const thumbable = (file) => IMAGE_EXT.test(file) || VIDEO_EXT.test(file);

let ffmpegPath = null;
export async function ffmpegBin() {
  if (ffmpegPath !== null) return ffmpegPath || null;
  if (process.env.FAVSYNC_FFMPEG) { ffmpegPath = process.env.FAVSYNC_FFMPEG; return ffmpegPath; }
  try { const m = await import('ffmpeg-static'); const p = m.default ?? m; ffmpegPath = typeof p === 'string' && existsSync(p) ? p : ''; }
  catch { ffmpegPath = ''; }
  return ffmpegPath || null;
}

// 存档根下的相对路径 → 绝对路径；越界（..）就 null
export function resolveArchivePath(rel) {
  const base = path.resolve(archiveRoot());
  const abs = path.resolve(base, String(rel ?? '').replace(/^\/+/, ''));
  if (abs !== base && !abs.startsWith(base + path.sep)) return null;
  return abs;
}

const run = (bin, args, timeoutMs) => new Promise((ok, fail) => {
  execFile(bin, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 1 << 20 }, (err, _out, stderr) => (err ? fail(new Error((stderr || err.message).toString().split('\n').slice(-3).join(' ').slice(0, 300))) : ok()));
});

// 同一张图同时来几个请求只生成一次；整体并发限 2，别让一页 60 张卡把服务器的 CPU 吃满
const inflight = new Map();
let active = 0; const waiting = [];
const slot = () => new Promise((ok) => { if (active < 2) { active++; ok(); } else waiting.push(ok); });
const unslot = () => { const next = waiting.shift(); if (next) next(); else active--; };

// 返回缓存文件的绝对路径；不支持的类型 / 没有 ffmpeg / 生成失败 → null（调用方退回原图）
export async function thumbFor(rel, { width = 400 } = {}) {
  const abs = resolveArchivePath(rel);
  if (!abs || !thumbable(abs) || !existsSync(abs)) return null;
  const st = statSync(abs);
  if (!st.isFile()) return null;
  const w = snapWidth(width);
  const key = createHash('sha1').update(`${abs}|${w}|${Math.floor(st.mtimeMs)}|${st.size}`).digest('hex');
  const out = path.join(cacheDir(), key.slice(0, 2), `${key}.jpg`);
  if (existsSync(out)) return out;
  if (inflight.has(out)) return inflight.get(out);
  const job = (async () => {
    const bin = await ffmpegBin();
    if (!bin) return null;
    mkdirSync(path.dirname(out), { recursive: true });
    const tmp = `${out}.${process.pid}.${Date.now()}.tmp.jpg`;
    const vf = `scale='min(${w},iw)':-2`;   // 比目标还小的图不放大
    const isVideo = VIDEO_EXT.test(abs);
    await slot();
    try {
      try {
        await run(bin, ['-hide_banner', '-loglevel', 'error', '-y', ...(isVideo ? ['-ss', '1'] : []), '-i', abs, '-frames:v', '1', '-vf', vf, '-q:v', '4', tmp], 30000);
      } catch (e) {
        // 不到 1 秒的短视频 -ss 1 会空：退回第 0 帧再试一次
        if (!isVideo) throw e;
        await run(bin, ['-hide_banner', '-loglevel', 'error', '-y', '-i', abs, '-frames:v', '1', '-vf', vf, '-q:v', '4', tmp], 30000);
      }
      if (!existsSync(tmp) || !statSync(tmp).size) throw new Error('没有输出');
      renameSync(tmp, out);
      return out;
    } catch (e) {
      try { rmSync(tmp, { force: true }); } catch { /* 略 */ }
      console.warn('[thumb] 生成失败：', path.basename(abs), e.message);
      return null;
    } finally { unslot(); inflight.delete(out); }
  })();
  inflight.set(out, job);
  return job;
}

// 从视频里取一张完整画幅的封面（抖音接口给的 cover 是 323:430 居中裁过的，竖屏视频上下都没了）
export async function posterFromVideo(absVideo, absOut, { width = 720 } = {}) {
  const bin = await ffmpegBin();
  if (!bin || !existsSync(absVideo)) return false;
  const tmp = `${absOut}.${process.pid}.tmp.jpg`;
  try {
    await run(bin, ['-hide_banner', '-loglevel', 'error', '-y', '-ss', '0.5', '-i', absVideo, '-frames:v', '1', '-vf', `thumbnail=40,scale='min(${width},iw)':-2`, '-q:v', '3', tmp], 60000);
    if (!existsSync(tmp) || !statSync(tmp).size) throw new Error('没有输出');
    renameSync(tmp, absOut);
    return true;
  } catch (e) { try { rmSync(tmp, { force: true }); } catch { /* 略 */ } console.warn('[thumb] 视频取帧失败：', e.message); return false; }
}

// Express 处理器：挂在 /thumb 下，req.path 就是存档里的相对路径（URL 已解码）
export function thumbHandler() {
  return async (req, res) => {
    const rel = decodeURIComponent(req.path).replace(/^\/+/, '');
    const abs = resolveArchivePath(rel);
    if (!abs) return res.status(400).json({ error: '路径不对' });
    if (!existsSync(abs)) return res.status(404).json({ error: '没有这个文件' });
    const original = `/archive/${rel.split('/').map(encodeURIComponent).join('/')}`;
    if (!thumbable(abs)) return res.redirect(302, original);
    try {
      const out = await thumbFor(rel, { width: req.query.w });
      if (!out) return res.redirect(302, original);
      // 缓存键里带了 mtime+size，内容变了 URL 不变也会重新生成；浏览器这边尽管长期缓存，一年
      res.set({ 'Cache-Control': 'public, max-age=31536000, immutable', 'Content-Type': 'image/jpeg' });
      res.sendFile(out);
    } catch (e) { res.status(500).json({ error: e.message }); }
  };
}

// 预热：给最近的 N 个存档目录先把常用尺寸做出来（后台任务、启动后慢慢跑），用户打开页面时就都是命中
export async function warmThumbs(files, { width = 400, limit = 200 } = {}) {
  let made = 0, skipped = 0;
  for (const rel of files.slice(0, limit)) {
    const r = await thumbFor(rel, { width });
    if (r) made++; else skipped++;
  }
  return { made, skipped };
}
