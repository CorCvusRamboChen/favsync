// 缩略图：存档里的图/视频 → data/thumbs 缓存；越界路径拒绝；不支持的类型返回 null（调用方退回原图）。
// 用 ffmpeg-static 自己造一张源图（lavfi 纯色），没有 ffmpeg 的机器整组跳过。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, existsSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = mkdtempSync(path.join(tmpdir(), 'thumbs-test-'));
process.env.FAVSYNC_DB = path.join(dir, 'test.db');
process.env.FAVSYNC_ARCHIVE = path.join(dir, 'archive');
process.env.FAVSYNC_THUMBS = path.join(dir, 'thumbs');
const { db } = await import('../src/db.js');
const { thumbFor, resolveArchivePath, snapWidth, thumbable, ffmpegBin } = await import('../src/thumbs.js');
const bin = await ffmpegBin();
after(() => { try { db.close(); } catch { /* 已关 */ } try { rmSync(dir, { recursive: true, force: true }); } catch { /* 临时目录 */ } });

test('路径与参数：越界 null、宽度吸附到档位、类型判断', () => {
  assert.equal(resolveArchivePath('../x.jpg'), null);
  assert.equal(resolveArchivePath('/2026/10/a/cover.jpg'), path.join(path.resolve(process.env.FAVSYNC_ARCHIVE), '2026', '10', 'a', 'cover.jpg'));
  assert.equal(snapWidth(410), 400); assert.equal(snapWidth(0), 400); assert.equal(snapWidth(9999), 1024); assert.equal(snapWidth(170), 160);
  assert.ok(thumbable('a/video.mp4')); assert.ok(thumbable('a/image-01.webp')); assert.equal(thumbable('a/audio.mp3'), false); assert.equal(thumbable('a/readable.md'), false);
});

test('生成缩略图并缓存；不支持的类型 / 不存在的文件返回 null', { skip: !bin && '本机没有 ffmpeg-static' }, async () => {
  const src = path.join(process.env.FAVSYNC_ARCHIVE, '2026', '10', '抖音-标题 #话题-link1');
  mkdirSync(src, { recursive: true });
  execFileSync(bin, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=900x600', '-frames:v', '1', path.join(src, 'image-01.png')]);
  writeFileSync(path.join(src, 'readable.md'), '# x');
  const rel = '2026/10/抖音-标题 #话题-link1/image-01.png';
  const out = await thumbFor(rel, { width: 300 });
  assert.ok(out && existsSync(out), '有输出文件');
  assert.ok(statSync(out).size > 0 && statSync(out).size < statSync(path.join(src, 'image-01.png')).size + 50000);
  assert.ok(out.startsWith(path.join(dir, 'thumbs')), '放在缓存目录');
  const again = await thumbFor(rel, { width: 300 });
  assert.equal(again, out, '第二次命中同一个缓存文件');
  const other = await thumbFor(rel, { width: 160 });
  assert.notEqual(other, out, '不同宽度不同文件');
  // 并发请求同一张只生成一次（都拿到同一路径）
  const [p1, p2] = await Promise.all([thumbFor(rel, { width: 640 }), thumbFor(rel, { width: 640 })]);
  assert.equal(p1, p2);
  assert.equal(await thumbFor('2026/10/抖音-标题 #话题-link1/readable.md'), null);
  assert.equal(await thumbFor('2026/10/nope/image-01.png'), null);
  assert.equal(await thumbFor('../../etc/passwd.png'), null);
});
