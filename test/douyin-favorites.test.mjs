// 抖音收藏同步（服务端那一半）：aweme 整形（含动图/实况/动态封面）、入库去重 + 账号/收藏夹标签、
// 待下载媒体、媒体文件落盘与"像不像媒体"的检查、动图原样保留、失败重试上限、状态汇总。存档根指向临时目录。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = mkdtempSync(path.join(tmpdir(), 'douyin-fav-test-'));
process.env.FAVSYNC_DB = path.join(dir, 'test.db');
process.env.FAVSYNC_ARCHIVE = path.join(dir, 'archive');

const { db, one, run } = await import('../src/db.js');
const m = await import('../src/connectors/douyin-favorites.js');
const { normalizeAweme, ingestFavorites, pendingMedia, storeMedia, markMediaFailed, favoritesStatus, TAG, accountTag, folderTag } = m;
const { isAnimatedImage } = await import('../src/connectors/favorites-archive.js');
const { listItems, tagsOf } = await import('../src/store.js');

after(() => {
  try { db.close(); } catch { /* 已关 */ }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* 临时目录 */ }
});

const aweme = (id, extra = {}) => ({
  aweme_id: id, desc: '墨大图书馆的隐藏自习室 #墨尔本', create_time: 1760000000,
  author: { nickname: '小C在墨村', uid: '123' },
  video: { duration: 95000, cover: { url_list: ['https://p3-sign.douyinpic.com/c.jpg'] }, dynamic_cover: { url_list: ['https://p3-sign.douyinpic.com/c.webp'] }, play_addr: { url_list: ['https://www.douyin.com/aweme/v1/play/?video_id=v1'] } },
  statistics: { digg_count: 12, comment_count: 3, collect_count: 7, share_count: 1 }, ...extra,
});
// 图文帖（实测形状）：aweme_type 68，顶层 video.play_addr 其实是配乐 mp3；每张图 url_list 是无水印 webp/jpeg，download_url_list 是带水印的 3000x3000；实况图带 video
const PIC = { aweme_id: '7000000000000000002', desc: '图文', aweme_type: 68, media_type: 42,
  video: { play_addr: { url_list: ['https://sf11-cdn-tos.douyinstatic.com/obj/ies-music/7587041354930883374.mp3'] }, cover: { url_list: ['https://p3.douyinpic.com/pc.jpg'] } },
  images: [
    { url_list: ['https://x/1.webp', 'https://x/1.jpg'], download_url_list: ['https://x/1-orig.webp'], video: { play_addr: { url_list: ['https://x/1-live.mp4'] } }, live_photo_type: 1 },
    { url_list: ['https://x/2.jpg'] }] };
const ACC_A = { uid: '1001', nickname: '主号' }, ACC_B = { uid: '1002', nickname: '小号' };

test('normalizeAweme：标题/作者/封面/动态封面/播放地址/时长/数据；图文的原图+实况；坏条目返回 null', () => {
  const n = normalizeAweme(aweme('7000000000000000001'));
  assert.equal(n.url, 'https://www.douyin.com/video/7000000000000000001');
  assert.equal(n.author, '小C在墨村'); assert.equal(n.duration, 95);
  assert.equal(n.cover, 'https://p3-sign.douyinpic.com/c.jpg'); assert.equal(n.dynamic_cover, 'https://p3-sign.douyinpic.com/c.webp');
  assert.match(n.play_url, /aweme\/v1\/play/);
  assert.equal(n.stats.collect, 7); assert.equal(n.create_time.slice(0, 4), '2025');
  const pic = normalizeAweme(PIC);
  assert.equal(pic.is_image_post, true); assert.equal(pic.images.length, 2); assert.equal(pic.play_url, null, '图文帖的 play_addr 是配乐，不当视频'); assert.equal(pic.has_live, true);
  assert.match(pic.music_url, /ies-music.*\.mp3$/);
  assert.deepEqual(pic.variants[0], { static: 'https://x/1.jpg', original: 'https://x/1-orig.webp', live: 'https://x/1-live.mp4' }, 'jpeg 优先于 webp');
  assert.deepEqual(pic.variants[1], { static: 'https://x/2.jpg', original: null, live: null });
  // 普通视频帖但 play_addr 是 mp3（极少数）→ 也不当视频；mp3 记进 music_url
  const odd = normalizeAweme({ aweme_id: '7000000000000000099', desc: 'x', video: { play_addr: { url_list: ['https://sf3.douyinstatic.com/obj/ies-music/1.mp3'] } } });
  assert.equal(odd.play_url, null); assert.match(odd.music_url, /\.mp3$/);
  assert.equal(normalizeAweme({ desc: 'no id' }), null);
  assert.equal(normalizeAweme(null), null);
});

test('ingest：入库 + 标签（抖音收藏 / 账号 / 收藏夹）+ 文本存档；第二个账号再推同一条只加标签不建卡；收藏夹名并集', () => {
  const r = ingestFavorites([aweme('7000000000000000001'), PIC, { bogus: 1 }], { account: ACC_A, folders: { '7000000000000000001': ['学习', '墨尔本'] } });
  assert.deepEqual([r.received, r.added, r.updated, r.invalid, r.account], [3, 2, 0, 1, '主号']);
  const items = listItems({ limit: 50 }).filter((i) => i.source === '抖音');
  assert.equal(items.length, 2);
  const it = items.find((i) => i.url.endsWith('0001'));
  assert.equal(it.title, '墨大图书馆的隐藏自习室 #墨尔本');
  assert.equal(it.image, 'https://p3-sign.douyinpic.com/c.jpg');
  const tags = tagsOf('link', it.item_id);
  assert.ok(tags.includes(TAG) && tags.includes(accountTag('主号')) && tags.includes(folderTag('学习')) && tags.includes(folderTag('墨尔本')));
  assert.equal(items.find((i) => i.url.endsWith('0002')).title, '图文');
  const arc = one(`SELECT dir, status FROM archives WHERE item_kind = 'link' AND item_id = ?`, it.item_id);
  assert.equal(arc.status, 'done', '文本已经落盘就算存下来了，后台不会再去抓登录墙');
  const md = readFileSync(path.join(process.env.FAVSYNC_ARCHIVE, arc.dir, 'readable.md'), 'utf-8');
  assert.match(md, /作者：小C在墨村/); assert.match(md, /收藏账号：主号/); assert.match(md, /收藏夹：学习、墨尔本/);
  const again = ingestFavorites([aweme('7000000000000000001', { video: { cover: { url_list: ['https://new/cover.jpg'] }, play_addr: { url_list: ['https://new/play'] } } })],
    { account: ACC_B, folders: { '7000000000000000001': ['小号的夹子'] } });
  assert.deepEqual([again.added, again.updated], [0, 1]);
  assert.equal(listItems({ limit: 50 }).filter((i) => i.source === '抖音').length, 2);
  const row = one('SELECT play_url, accounts_json, folders_json, account_name FROM douyin_favorites WHERE aweme_id = ?', '7000000000000000001');
  assert.equal(row.play_url, 'https://new/play'); assert.equal(row.account_name, '主号', '第一个账号保留');
  assert.deepEqual(JSON.parse(row.accounts_json), ['主号', '小号']);
  assert.deepEqual(JSON.parse(row.folders_json).sort(), ['墨尔本', '学习', '小号的夹子'].sort());
  const tags2 = tagsOf('link', it.item_id);
  assert.ok(tags2.includes(accountTag('小号')) && tags2.includes(folderTag('小号的夹子')));
});

test('以前手动捕获过同一条链接 → 复用那张卡，并补上标签', () => {
  run(`INSERT INTO items (url, title, kind, source) VALUES ('https://www.douyin.com/video/7000000000000000003', '手动存的', 'link', '抖音')`);
  const r = ingestFavorites([aweme('7000000000000000003')], { account: ACC_A });
  assert.equal(r.added, 1);
  assert.equal(one(`SELECT COUNT(*) AS n FROM items WHERE url = 'https://www.douyin.com/video/7000000000000000003'`).n, 1);
  const id = one(`SELECT id FROM items WHERE url = 'https://www.douyin.com/video/7000000000000000003'`).id;
  assert.ok(tagsOf('link', id).includes(accountTag('主号')));
});

test('媒体：待下载带动态封面和图的三种地址；封面落盘后预览改指本地；动态封面/实况是加分项；视频落盘标 done；HTML 冒充视频被拒', () => {
  const pend = pendingMedia(10);
  assert.equal(pend.length, 3);
  const p1 = pend.find((p) => p.aweme_id === '7000000000000000001');
  assert.equal(p1.dynamic_cover_url, 'https://p3-sign.douyinpic.com/c.webp');
  const p2 = pend.find((p) => p.aweme_id === '7000000000000000002');
  assert.equal(p2.variants[0].live, 'https://x/1-live.mp4');
  const id = '7000000000000000001';
  const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2000, 1)]);
  const c = storeMedia(id, { kind: 'cover', bytes: jpg });
  assert.equal(c.ok, true); assert.equal(c.file, 'cover.jpg'); assert.equal(c.complete, false);
  const item = one('SELECT image FROM items WHERE id = ?', one('SELECT item_id FROM douyin_favorites WHERE aweme_id = ?', id).item_id);
  assert.equal(item.image, `/archive/${c.dir.split("/").map(encodeURIComponent).join("/")}/cover.jpg`, "路径按段编码（中文、# 都要能过）");
  // 动态封面：动态 WebP（VP8X + ANIM 位）原样存成 cover-anim.webp，并识别为动图
  const animWebp = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBPVP8X'), Buffer.from([10, 0, 0, 0, 0x02, 0, 0, 0]), Buffer.alloc(1200, 0)]);
  const a = storeMedia(id, { kind: 'anim', bytes: animWebp });
  assert.equal(a.file, 'cover-anim.webp'); assert.equal(a.animated, true); assert.equal(a.complete, false);
  assert.equal(isAnimatedImage(jpg), false);
  const html = Buffer.from('<html>请登录</html>'.repeat(5000));
  const bad = storeMedia(id, { kind: 'video', bytes: html });
  assert.equal(bad.ok, false); assert.equal(bad.suspicious, true); assert.equal(bad.attempts, 1);
  const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypmp42'), Buffer.alloc(70 * 1024, 7)]);
  const v = storeMedia(id, { kind: 'video', bytes: mp4 });
  assert.equal(v.ok, true); assert.equal(v.complete, true);
  assert.equal(one('SELECT media_status FROM douyin_favorites WHERE aweme_id = ?', id).media_status, 'done');
  assert.ok(existsSync(path.join(process.env.FAVSYNC_ARCHIVE, v.dir, 'video.mp4')));
  const formats = JSON.parse(one(`SELECT formats FROM archives WHERE item_kind = 'link' AND item_id = ?`, one('SELECT item_id FROM douyin_favorites WHERE aweme_id = ?', id).item_id).formats);
  assert.ok(formats['readable.md'] && formats['cover.jpg'] && formats['cover-anim.webp'] && formats['video.mp4']);
  // 图文：第 1 张原图是 GIF 动图 → image-01.gif；实况短片 live-01.mp4；两张都到了才 done
  const gif = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(600, 0), Buffer.from('NETSCAPE2.0'), Buffer.alloc(100, 0)]);
  const g = storeMedia('7000000000000000002', { kind: 'image', index: 0, bytes: gif });
  assert.equal(g.file, 'image-01.gif'); assert.equal(g.animated, true); assert.equal(g.complete, false);
  const lv = storeMedia('7000000000000000002', { kind: 'live', index: 0, bytes: mp4 });
  assert.equal(lv.file, 'live-01.mp4'); assert.equal(lv.complete, false);
  const g2 = storeMedia('7000000000000000002', { kind: 'image', index: 1, bytes: jpg });
  assert.equal(g2.file, 'image-02.jpg'); assert.equal(g2.complete, true);
  assert.equal(pendingMedia(10).length, 1);
  assert.throws(() => storeMedia('1', { kind: 'video', bytes: mp4 }), /不在抖音收藏/);
  assert.throws(() => storeMedia(id, { kind: 'wat', bytes: mp4 }), /kind/);
});

test('服务端用浏览器登录态下媒体：按顺序存封面/动态封面/视频/原图/实况，节奏可控；403 立刻停并记失败', async () => {
  const PIC2 = { aweme_id: '7000000000000000005', desc: '第二个图文', aweme_type: 68, images: [{ url_list: ['https://x/a.gif'], download_url_list: ['https://x/a-orig.gif'] }],
    video: { play_addr: { url_list: ['https://sf11-cdn-tos.douyinstatic.com/obj/ies-music/bgm.mp3'] } } };
  ingestFavorites([aweme('7000000000000000004'), PIC2], { account: ACC_A });
  const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2000, 1)]);
  const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypmp42'), Buffer.alloc(70 * 1024, 7)]);
  const gif = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(600, 0), Buffer.from('NETSCAPE2.0'), Buffer.alloc(100, 0)]);
  run('UPDATE douyin_favorites SET attempts = 3 WHERE aweme_id = ?', '7000000000000000003');   // 上个测试剩下的那条先让开
  const got = [];
  const mp3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(9000, 0)]);
  const fakeLaunch = async () => ({
    request: { get: async (url) => { got.push(url); const body = /\.mp3/.test(url) ? mp3 : /play|live/.test(url) ? mp4 : /gif/.test(url) ? gif : jpg; return { status: () => 200, ok: () => true, body: async () => body }; } },
    close: async () => {},
  });
  const r = await m.fetchPendingMediaWithBrowser({ limit: 10, launch: fakeLaunch, pause: [0, 0] });
  assert.equal(r.tried, 2); assert.equal(r.done, 2); assert.equal(r.failed, 0); assert.equal(r.stopped, null);
  assert.ok(got.includes('https://p3-sign.douyinpic.com/c.jpg') && got.includes('https://p3-sign.douyinpic.com/c.webp') && got.includes('https://www.douyin.com/aweme/v1/play/?video_id=v1'));
  assert.ok(got.includes('https://x/a.gif') && !got.includes('https://x/a-orig.gif'), '无水印的展示图优先，拿到了就不下带水印的原图');
  assert.ok(got.some((u) => u.endsWith('bgm.mp3')), '图文帖的配乐顺手存成 audio');
  assert.equal(one('SELECT media_status FROM douyin_favorites WHERE aweme_id = ?', '7000000000000000004').media_status, 'done');
  const dir5 = one(`SELECT dir FROM archives WHERE item_kind = 'link' AND item_id = ?`, one('SELECT item_id FROM douyin_favorites WHERE aweme_id = ?', '7000000000000000005').item_id).dir;
  assert.ok(existsSync(path.join(process.env.FAVSYNC_ARCHIVE, dir5, 'image-01.gif')), '动图原样存成 gif');
  assert.ok(existsSync(path.join(process.env.FAVSYNC_ARCHIVE, dir5, 'audio.mp3')), '配乐存成 audio.mp3');
  assert.equal(one('SELECT media_status FROM douyin_favorites WHERE aweme_id = ?', '7000000000000000005').media_status, 'done');
  // 限流：第一个请求就 403 → 记失败、立刻停
  ingestFavorites([aweme('7000000000000000006')], { account: ACC_A });
  const r2 = await m.fetchPendingMediaWithBrowser({ limit: 10, pause: [0, 0], launch: async () => ({ request: { get: async () => ({ status: () => 403, ok: () => false, body: async () => Buffer.alloc(0) }) }, close: async () => {} }) });
  assert.equal(r2.failed, 1); assert.match(r2.stopped, /限流/);
  assert.equal(one('SELECT attempts FROM douyin_favorites WHERE aweme_id = ?', '7000000000000000006').attempts, 1);
  run(`DELETE FROM douyin_favorites WHERE aweme_id IN ('7000000000000000004','7000000000000000005','7000000000000000006')`);
  run('UPDATE douyin_favorites SET attempts = 0 WHERE aweme_id = ?', '7000000000000000003');
});

test('收藏的音乐：整形、入库（标签 抖音音乐）、待下载带 kind、音频落盘即 done、文件头检查', async () => {
  const MU = { id_str: '7300000000000000001', title: '夜曲', author: '周杰伦', album: '十一月的萧邦', duration: 226, is_original: false, user_count: 1200,
    play_url: { url_list: ['https://sf3-cdn-tos.douyinstatic.com/obj/ies-music/x.mp3'] }, cover_hd: { url_list: ['https://p3.douyinpic.com/m.jpg'] } };
  const n = m.normalizeMusic(MU);
  assert.equal(n.url, 'https://www.douyin.com/music/7300000000000000001'); assert.equal(n.duration, 226); assert.equal(n.author, '周杰伦');
  assert.equal(m.normalizeMusic({ id: 123456, duration: 226000 }).duration, 226, '毫秒换成秒');
  assert.equal(m.normalizeMusic({ title: 'x' }), null);
  const r = m.ingestMusic([MU, { nope: 1 }], { account: ACC_A });
  assert.deepEqual([r.added, r.updated, r.invalid], [1, 0, 1]);
  const card = listItems({ limit: 50 }).find((i) => i.url === n.url);
  assert.equal(card.title, '🎵 夜曲 · 周杰伦');
  const tags = tagsOf('link', card.item_id);
  assert.ok(tags.includes(TAG) && tags.includes(m.MUSIC_TAG) && tags.includes(accountTag('主号')));
  assert.equal(m.ingestMusic([MU], { account: ACC_B }).updated, 1);
  assert.ok(tagsOf('link', card.item_id).includes(accountTag('小号')));
  const pend = pendingMedia(20).find((p) => p.aweme_id === 'music_7300000000000000001');
  assert.equal(pend.kind, 'music'); assert.match(pend.play_url, /\.mp3$/);
  const html = Buffer.from('<html>login</html>'.repeat(1000));
  assert.equal(storeMedia('music_7300000000000000001', { kind: 'audio', bytes: html }).ok, false, 'HTML 不是音频');
  const mp3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(9000, 0)]);
  const a = storeMedia('music_7300000000000000001', { kind: 'audio', bytes: mp3 });
  assert.equal(a.file, 'audio.mp3'); assert.equal(a.complete, true);
  assert.equal(one(`SELECT media_status FROM douyin_favorites WHERE aweme_id = 'music_7300000000000000001'`).media_status, 'done');
  const m4a = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypM4A '), Buffer.alloc(9000, 1)]);
  assert.equal(m.MUSIC_TAG, '抖音音乐');
  const { MAGIC } = await import('../src/connectors/favorites-archive.js');
  assert.equal(MAGIC.audio(m4a), true); assert.equal(MAGIC.audio(Buffer.concat([Buffer.from([0xff, 0xfb]), Buffer.alloc(9000)])), true); assert.equal(MAGIC.audio(html), false);
  assert.equal(favoritesStatus().kinds.music, 1);
  run(`DELETE FROM douyin_favorites WHERE aweme_id = 'music_7300000000000000001'`);
});

test('失败三次就不再排队；状态汇总按账号和收藏夹', () => {
  const id = '7000000000000000003';
  markMediaFailed(id, 'x'); markMediaFailed(id, 'y');
  assert.equal(one('SELECT media_status FROM douyin_favorites WHERE aweme_id = ?', id).media_status, 'pending');
  assert.equal(markMediaFailed(id, 'z').media_status, 'failed');
  assert.ok(!pendingMedia(10).some((p) => p.aweme_id === id));
  const s = favoritesStatus();
  assert.deepEqual([s.total, s.media_done, s.media_pending, s.media_failed], [3, 2, 0, 1]);
  assert.deepEqual(s.accounts.map((a) => [a.name, a.n]), [['主号', 3]]);
  assert.ok(s.folders.some((f) => f.name === '学习' && f.n === 1));
  assert.equal(s.archive_root, path.resolve(process.env.FAVSYNC_ARCHIVE));
});
