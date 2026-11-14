// 媒体类型（照苹果相册）：按存档目录里实际有的文件分 视频 / 图文 / 实况 / 动图 / 音频 / 仅文字；
// 动态 WebP 存成 image-NN.anim.webp，老文件 flagAnimatedImages 补标。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = mkdtempSync(path.join(tmpdir(), 'media-types-test-'));
process.env.FAVSYNC_DB = path.join(dir, 'test.db');
process.env.FAVSYNC_ARCHIVE = path.join(dir, 'archive');
const { db, one } = await import('../src/db.js');
const { saveItem, listItems, mediaTypeCounts, MEDIA_TYPES } = await import('../src/store.js');
const { writeTextArchive, storeMediaFile, flagAnimatedImages, archiveDirOf } = await import('../src/connectors/favorites-archive.js');
const { archiveRoot } = await import('../src/archive.js');
after(() => { try { db.close(); } catch { /* 已关 */ } try { rmSync(dir, { recursive: true, force: true }); } catch { /* 临时目录 */ } });

// 像那么回事的字节：mp4 / jpg / 动态 webp / 静态 webp / mp3
const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(70 * 1024)]);
const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(1024)]);
const webp = (animated) => { const b = Buffer.alloc(2048); b.write('RIFF', 0, 'latin1'); b.write('WEBP', 8, 'latin1'); b.write('VP8X', 12, 'latin1'); b[20] = animated ? 0x02 : 0x00; return b; };
const mp3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(9 * 1024)]);
const mk = (title) => { const id = saveItem({ kind: 'link', url: 'https://x.test/' + title, title, source: '抖音' }).id; writeTextArchive(id, { title, url: 'https://x.test/' + title, sourceLabel: '测试', body: '正文', meta: {} }); return id; };

test('按文件分类：视频 / 图文 / 实况 / 动图 / 音频 / 仅文字，计数与筛选一致', () => {
  const v = mk('视频帖'); storeMediaFile(v, { kind: 'video', bytes: mp4 });
  const p = mk('图文帖'); storeMediaFile(p, { kind: 'image', index: 0, bytes: jpg }); storeMediaFile(p, { kind: 'image', index: 1, bytes: webp(true) }); storeMediaFile(p, { kind: 'live', index: 0, bytes: mp4 });
  const s = mk('静态图文'); storeMediaFile(s, { kind: 'image', index: 0, bytes: webp(false) });
  const m = mk('音乐'); storeMediaFile(m, { kind: 'audio', bytes: mp3 }); storeMediaFile(m, { kind: 'cover', bytes: jpg });
  mk('纯文字微博');
  const c = mediaTypeCounts();
  assert.deepEqual(c, { video: 1, image: 2, live: 1, anim: 1, music: 0, audio: 1, text: 1 });
  assert.ok(existsSync(path.join(archiveRoot(), archiveDirOf(p), 'image-02.anim.webp')), '动态 WebP 带 .anim. 后缀');
  assert.ok(existsSync(path.join(archiveRoot(), archiveDirOf(s), 'image-01.webp')), '静态 WebP 不带');
  const titles = (media) => listItems({ media }).map((i) => i.title).sort();
  assert.deepEqual(titles('video'), ['视频帖']); assert.deepEqual(titles('image'), ['图文帖', '静态图文']); assert.deepEqual(titles('live'), ['图文帖']);
  assert.deepEqual(titles('anim'), ['图文帖']); assert.deepEqual(titles('audio'), ['音乐']); assert.deepEqual(titles('text'), ['纯文字微博']);
  assert.equal(listItems({ media: 'nope' }).length, 5, '不认识的类型不筛');
  assert.equal(Object.keys(MEDIA_TYPES).length, 7);
});

test('flagAnimatedImages：早先按 image-NN.webp 存下来的动图补标成 .anim.webp，formats 跟着改，幂等', () => {
  const o = mk('老动图帖'); storeMediaFile(o, { kind: 'image', index: 0, bytes: webp(true) });
  // 模拟老版本：文件名没有 .anim.
  const abs = path.join(archiveRoot(), archiveDirOf(o));
  renameSync(path.join(abs, 'image-01.anim.webp'), path.join(abs, 'image-01.webp'));
  db.exec(`UPDATE archives SET formats = replace(formats, 'image-01.anim.webp', 'image-01.webp') WHERE item_id = ${o}`);
  assert.equal(listItems({ media: 'anim' }).length, 1, '补标前只有上一条');
  const r = flagAnimatedImages();
  assert.equal(r.flagged, 1); assert.ok(r.checked >= 2);
  assert.ok(existsSync(path.join(abs, 'image-01.anim.webp')));
  assert.ok(JSON.parse(one('SELECT formats FROM archives WHERE item_id = ?', o).formats)['image-01.anim.webp']);
  assert.equal(listItems({ media: 'anim' }).length, 2);
  assert.equal(flagAnimatedImages().flagged, 0, '再跑一遍没有可改的');
});
