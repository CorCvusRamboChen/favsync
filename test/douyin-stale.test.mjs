// 抖音直链有效期：视频 CDN 路径里的 8 位十六进制 / 图床 x-expires；过期的待下媒体跳过不计失败、不开浏览器。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = mkdtempSync(path.join(tmpdir(), 'douyin-stale-test-'));
process.env.FAVSYNC_DB = path.join(dir, 'test.db');
process.env.FAVSYNC_ARCHIVE = path.join(dir, 'archive');
process.env.FAVSYNC_DOUYIN_ACCOUNTS = path.join(dir, 'accounts.json');
const { db, one } = await import('../src/db.js');
const d = await import('../src/connectors/douyin-favorites.js');
after(() => { try { db.close(); } catch { /* 已关 */ } try { rmSync(dir, { recursive: true, force: true }); } catch { /* 临时目录 */ } });

test('urlExpiry：CDN 路径时间戳、x-expires 参数、没有有效期的返回 null', () => {
  const v = 'https://v5-dy-ov-experiment.zjcdn.com/2a331a4eb3b0ef1fb96c8a7121173496/6ad4dcce/video/tos/cn/tos-cn-ve-15/ocfW/?a=6383&ch=42';
  assert.equal(d.urlExpiry(v), 0x6ad4dcce * 1000);
  assert.equal(d.urlExpired(v, 0x6ad4dcce * 1000 - 3600000), false);
  assert.equal(d.urlExpired(v, 0x6ad4dcce * 1000 + 1), true);
  assert.equal(d.urlExpired(v, 0x6ad4dcce * 1000 - 30000), true, '一分钟内到期也算过期（下载要时间）');
  const img = 'https://p3-pc-sign.douyinpic.com/tos-cn-i-0813/abc~tplv-dy-cropcenter:323:430.jpeg?lk3s=138a59ce&x-expires=1792800000&x-signature=xx';
  assert.equal(d.urlExpiry(img), 1792800000000);
  assert.equal(d.urlExpiry('https://lf9-music-east.douyinstatic.com/obj/ies-music-hj/7682725928853654329.mp3'), null);
  assert.equal(d.urlExpired(null), false);
});

test('fetchPendingMediaWithBrowser：全是过期直链 → 一条不试、不开浏览器、attempts 不变，stale 报出来', async () => {
  const expired = (id) => ({ aweme_id: id, desc: '过期', create_time: 1760000000, author: { nickname: 'x', uid: '1' },
    video: { duration: 1000, cover: { url_list: ['https://p3-sign.douyinpic.com/c.jpg'] }, play_addr: { url_list: [`https://v5.zjcdn.com/${'a'.repeat(32)}/5f000000/video/tos/${id}/`] } }, statistics: {} });
  const fresh = (id) => ({ ...expired(id), video: { ...expired(id).video, play_addr: { url_list: [`https://v5.zjcdn.com/${'b'.repeat(32)}/7fffffff/video/tos/${id}/`] } } });
  d.ingestFavorites([expired('7100000000000000001'), expired('7100000000000000002')]);
  let launched = 0;
  const r = await d.fetchPendingMediaWithBrowser({ limit: 5, launch: async () => { launched++; throw new Error('不该开'); } });
  assert.equal(launched, 0); assert.equal(r.tried, 0); assert.equal(r.stale, 2); assert.equal(r.pending_seen, 2);
  assert.equal(one('SELECT attempts FROM douyin_favorites WHERE aweme_id = ?', '7100000000000000001').attempts, 0);
  // 有一条新鲜的：只拿它去下（假浏览器直接报限流，证明进到了下载阶段）
  d.ingestFavorites([fresh('7100000000000000003')]);
  const ctx = { request: { get: async () => ({ status: () => 403, ok: () => false, body: async () => Buffer.alloc(0) }) }, close: async () => {} };
  const r2 = await d.fetchPendingMediaWithBrowser({ limit: 5, launch: async () => ctx, pause: [0, 0] });
  assert.equal(r2.tried, 1); assert.equal(r2.stale, 2); assert.match(r2.stopped, /403/);
});

test('normalizeAweme：封面优先 origin_cover（完整画幅），没有才用裁过的 cover；isCroppedCover 认 cropcenter', () => {
  const a = { aweme_id: '7100000000000000009', desc: 'x', create_time: 1760000000, author: { nickname: 'x', uid: '1' },
    video: { duration: 1000, cover: { url_list: ['https://p3.douyinpic.com/a~tplv-dy-cropcenter:323:430.jpeg'] }, origin_cover: { url_list: ['https://p3.douyinpic.com/b~tplv-dy-360p.jpeg'] }, play_addr: { url_list: ['https://v5.zjcdn.com/x/'] } } };
  assert.equal(d.normalizeAweme(a).cover, 'https://p3.douyinpic.com/b~tplv-dy-360p.jpeg');
  delete a.video.origin_cover;
  assert.equal(d.normalizeAweme(a).cover, 'https://p3.douyinpic.com/a~tplv-dy-cropcenter:323:430.jpeg');
  assert.equal(d.isCroppedCover(a.video.cover.url_list[0]), true); assert.equal(d.isCroppedCover('https://p3.douyinpic.com/b~tplv-dy-360p.jpeg'), false);
});
