// 微博收藏：两种来源的整形（Weibo-archiver 导出 / 网页版 mblog）、时间解析、入库去重与文本存档、
// 导出文件导入、服务端自己下图（fetch 用假的）、脚本传媒体、失败上限、状态汇总。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = mkdtempSync(path.join(tmpdir(), 'weibo-fav-test-'));
process.env.FAVSYNC_DB = path.join(dir, 'test.db');
process.env.FAVSYNC_ARCHIVE = path.join(dir, 'archive');

const { db, one, run } = await import('../src/db.js');
const m = await import('../src/connectors/weibo-favorites.js');
const { normalizeWeibo, parseWeiboTime, titleOf, ingestFavorites, importExportFile, pendingMedia, storeMedia, markMediaFailed, fetchPendingMedia, favoritesStatus, mergeDuplicateCards, TAG } = m;
const { listItems, tagsOf, saveItem } = await import('../src/store.js');

after(() => {
  try { db.close(); } catch { /* 已关 */ }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* 临时目录 */ }
});

// Weibo-archiver 导出格式
const EXP = {
  id: '4805000000000001', mblogid: 'M1abc', createdAt: 'Fri Aug 19 17:53:53 +0800 2022', source: '微博轻享版', text: '墨尔本租房避坑指南 http://t.cn/xx',
  imgs: ['https://ww4.sinaimg.cn/large/a.jpg', 'https://ww2.sinaimg.cn/large/b.jpg'], favBy: '5216977151', repostsCount: 3, commentsCount: 4, likesCount: 5,
  user: { uid: '1392951763', name: '墨村小助手', avatar: 'https://x/av.jpg' }, regionName: '发布于 广东',
};
const EXP_RT = { id: '4805000000000002', mblogid: 'M1rt', createdAt: 'Mon Jan 04 16:40:10 +0800 2016', text: '//@某人:转发微博', imgs: [], favBy: '1',
  user: { uid: '2', name: '转发者' }, retweet: { id: '4', mblogid: 'orig', text: '拯救色废终极法宝', imgs: ['https://ww1.sinaimg.cn/large/c.jpg'], user: { uid: '3', name: '原画人' } },
  card: { link: 'https://weibo.com/ttarticle/p/show?id=1', title: '文章', img: 'https://ww3.sinaimg.cn/cover.jpg', desc: '封面' } };
const EXP_DEAD = { id: '4805000000000003', mblogid: 'dead', createdAt: 'Mon Jan 04 16:40:10 +0800 2016', text: '抱歉，此微博已被作者删除。查看帮助：http://t.cn/Rfd3rQV', imgs: [], favBy: '1' };
// 网页版 mblog
const RAW = { id: 4805000000000004, idstr: '4805000000000004', mblogid: 'RawX', created_at: 'Sat Apr 23 22:09:59 +0800 2016', text: '<a href="/n/x">#科普#</a> T细胞<br/>杀死癌细胞', text_raw: '#科普# T细胞\n杀死癌细胞',
  user: { id: 5097174964, idstr: '5097174964', screen_name: '科普君' }, pic_ids: ['p1'], pic_infos: { p1: { large: { url: 'https://wx1.sinaimg.cn/large/p1.jpg' }, largest: { url: 'https://wx1.sinaimg.cn/largest/p1.jpg' } } },
  page_info: { type: 'video', page_title: '科普视频', page_pic: 'https://wx1.sinaimg.cn/pic.jpg', page_url: 'https://video.weibo.com/show?fid=1034:abc', media_info: { stream_url: 'https://f.video.weibocdn.com/sd.mp4', mp4_720p_mp4: 'https://f.video.weibocdn.com/hd.mp4' } },
  reposts_count: 9185, comments_count: 1118, attitudes_count: 4562, region_name: '发布于 北京' };

test('时间：微博的 "Mon Jan 04 16:40:10 +0800 2016" 正确换算成 UTC', () => {
  assert.equal(parseWeiboTime('Mon Jan 04 16:40:10 +0800 2016'), '2016-01-04T08:40:10.000Z');
  assert.equal(parseWeiboTime('垃圾'), null);
});

test('normalize：导出格式 → 正文/作者/图/地区/链接；转发 + 卡片；已失效；网页版 mblog → text_raw/最大图/视频直链', () => {
  const a = normalizeWeibo(EXP);
  assert.equal(a.url, 'https://weibo.com/1392951763/M1abc'); assert.equal(a.author, '墨村小助手'); assert.equal(a.region, '广东');
  assert.deepEqual(a.images, EXP.imgs); assert.equal(a.cover, EXP.imgs[0]); assert.equal(a.unavailable, false);
  assert.equal(titleOf(a), '墨尔本租房避坑指南');
  const b = normalizeWeibo(EXP_RT);
  assert.equal(b.retweet.author, '原画人'); assert.deepEqual(b.images, ['https://ww1.sinaimg.cn/large/c.jpg']); assert.equal(b.cover, 'https://ww3.sinaimg.cn/cover.jpg');
  assert.equal(titleOf(b), '@原画人：拯救色废终极法宝'); assert.equal(b.link_url, 'https://weibo.com/ttarticle/p/show?id=1');
  const c = normalizeWeibo(EXP_DEAD);
  assert.equal(c.unavailable, true); assert.match(titleOf(c), /^（已失效的微博）/); assert.equal(c.url, 'https://weibo.com/detail/4805000000000003');
  const d = normalizeWeibo(RAW);
  assert.equal(d.text, '#科普# T细胞\n杀死癌细胞'); assert.equal(d.author, '科普君'); assert.equal(d.url, 'https://weibo.com/5097174964/RawX');
  assert.deepEqual(d.images, ['https://wx1.sinaimg.cn/largest/p1.jpg']); assert.equal(d.play_url, 'https://f.video.weibocdn.com/hd.mp4');
  assert.equal(d.cover, 'https://wx1.sinaimg.cn/pic.jpg'); assert.equal(d.stats.likes, 4562); assert.equal(d.region, '北京');
  assert.equal(normalizeWeibo({ text: 'no id' }), null);
});

test('ingest：入库 + 标签 + 文本存档；没图的 media_status=none；有视频直链的 video_status=pending；重复只刷新', () => {
  const r = ingestFavorites([EXP, EXP_RT, EXP_DEAD, RAW, { nope: 1 }]);
  assert.deepEqual([r.received, r.added, r.updated, r.invalid], [5, 4, 0, 1]);
  const items = listItems({ limit: 50 }).filter((i) => i.source === '微博');
  assert.equal(items.length, 4);
  const it = items.find((i) => i.url.endsWith('M1abc'));
  assert.ok(tagsOf('link', it.item_id).includes(TAG)); assert.equal(it.image, EXP.imgs[0]);
  assert.equal(one('SELECT media_status FROM weibo_favorites WHERE weibo_id = ?', EXP_DEAD.id).media_status, 'none');
  assert.equal(one('SELECT video_status FROM weibo_favorites WHERE weibo_id = ?', RAW.idstr).video_status, 'pending');
  assert.equal(one('SELECT unavailable FROM weibo_favorites WHERE weibo_id = ?', EXP_DEAD.id).unavailable, 1);
  const arc = one(`SELECT dir, status FROM archives WHERE item_kind = 'link' AND item_id = ?`, it.item_id);
  assert.equal(arc.status, 'done');
  assert.match(readFileSync(path.join(process.env.FAVSYNC_ARCHIVE, arc.dir, 'readable.md'), 'utf-8'), /作者：@墨村小助手（广东）/);
  const again = ingestFavorites([EXP]);
  assert.deepEqual([again.added, again.updated], [0, 1]);
  assert.equal(listItems({ limit: 50 }).filter((i) => i.source === '微博').length, 4);
});

test('同一条原文只一张卡：两条转发 + 原文本身 → 共用一张；自己那句是"转发/mark"时标题用原文', () => {
  const ORIG = { ...EXP, id: '4900000000000001', mblogid: 'orig1', text: '原文：建筑背景你这么画！！', imgs: [] };
  const RT1 = { id: '4900000000000002', mblogid: 'rt1', createdAt: EXP.createdAt, text: 'mark', imgs: [], favBy: '1', user: { uid: '7', name: '甲' }, retweet: { id: '4900000000000001', mblogid: 'orig1', text: '原文：建筑背景你这么画！！', imgs: [], user: { uid: '1392951763', name: '墨村小助手' } } };
  const RT2 = { ...RT1, id: '4900000000000003', mblogid: 'rt2', text: '//@乙:学习了', user: { uid: '8', name: '乙' } };
  const before = listItems({ limit: 500 }).length;
  const r = ingestFavorites([RT1, ORIG, RT2]);
  assert.equal(r.added, 3);
  assert.equal(listItems({ limit: 500 }).length, before + 1, '三条收藏只多一张卡');
  const ids = new Set(['4900000000000001', '4900000000000002', '4900000000000003'].map((id) => one('SELECT item_id FROM weibo_favorites WHERE weibo_id = ?', id).item_id));
  assert.equal(ids.size, 1);
  assert.equal(titleOf(normalizeWeibo(RT1)), '@墨村小助手：原文：建筑背景你这么画！！');
  assert.equal(titleOf(normalizeWeibo(RT2)), '@墨村小助手：原文：建筑背景你这么画！！');
  assert.equal(titleOf(normalizeWeibo({ ...RT1, text: '这个画法我试过，确实好用' })), '这个画法我试过，确实好用', '自己说了实质内容就用自己的');
  // 旧数据里已经各建了卡的，合并函数能收回来
  const dupItem = saveItem({ kind: 'link', url: 'https://weibo.com/9/dup', title: 'dup', source: '微博' }).id;
  run(`INSERT INTO weibo_favorites (weibo_id, item_id, origin_id) VALUES ('4900000000000004', ?, '4900000000000001')`, dupItem);
  assert.equal(mergeDuplicateCards(), 1);
  assert.equal(one('SELECT COUNT(*) AS n FROM items WHERE id = ?', dupItem).n, 0);
  assert.equal(one(`SELECT item_id FROM weibo_favorites WHERE weibo_id = '4900000000000004'`).item_id, [...ids][0]);
});

test('导入 Weibo-archiver 导出文件：只要 favorites；include_own 时自己的微博也进来；坏文件报错', () => {
  const f = path.join(dir, 'weibo-data-x.json');
  writeFileSync(f, JSON.stringify({ user: { name: '昵称' }, weibo: [{ ...EXP, id: '4805000000000009', mblogid: 'own' }], favorites: [EXP, { ...EXP_RT, id: '4805000000000005', mblogid: 'M5' }], followings: [] }));
  const r = importExportFile(f);
  assert.deepEqual([r.added, r.updated, r.favorites, r.own_posts, r.user], [1, 1, 2, 1, '昵称']);
  const r2 = importExportFile(f, { include_own: true });
  assert.deepEqual([r2.added, r2.updated], [1, 2]);
  assert.equal(one('SELECT origin FROM weibo_favorites WHERE weibo_id = ?', '4805000000000005').origin, 'import');
  assert.throws(() => importExportFile(path.join(dir, 'nope.json')), /不存在/);
  writeFileSync(path.join(dir, 'bad.json'), '{"x":1}');
  assert.throws(() => importExportFile(path.join(dir, 'bad.json')), /favorites/);
});

test('服务端自己下图：sinaimg 带 Referer；全部落盘 → done；登录墙 HTML 被拒 → 记失败', async () => {
  const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(3000, 1)]);
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, referer: init.headers.Referer });
    if (url.includes('cover.jpg')) return { ok: true, arrayBuffer: async () => Buffer.from('<html>login</html>'.repeat(100)) };
    return { ok: true, arrayBuffer: async () => jpg };
  };
  const r = await fetchPendingMedia({ limit: 50, fetchImpl });
  assert.ok(r.tried >= 3);
  assert.ok(calls.every((c) => c.referer === 'https://weibo.com/'));
  const a = one('SELECT media_status FROM weibo_favorites WHERE weibo_id = ?', EXP.id);
  assert.equal(a.media_status, 'done');
  const dirA = one(`SELECT dir FROM archives WHERE item_kind = 'link' AND item_id = ?`, one('SELECT item_id FROM weibo_favorites WHERE weibo_id = ?', EXP.id).item_id).dir;
  assert.ok(existsSync(path.join(process.env.FAVSYNC_ARCHIVE, dirA, 'image-02.jpg')));
  assert.equal(one('SELECT image FROM items WHERE id = ?', one('SELECT item_id FROM weibo_favorites WHERE weibo_id = ?', EXP.id).item_id).image, `/archive/${dirA.split("/").map(encodeURIComponent).join("/")}/cover.jpg`);
  const b = one('SELECT media_status, attempts, media_error FROM weibo_favorites WHERE weibo_id = ?', EXP_RT.id);
  assert.equal(b.media_status, 'pending'); assert.equal(b.attempts, 1); assert.match(b.media_error, /cover#1/);
});

test('脚本传媒体：视频落盘 → video_status done；图和视频都齐才 complete；三次失败封顶', () => {
  const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypmp42'), Buffer.alloc(70 * 1024, 7)]);
  // RAW 的图上一个测试里服务端已经下好了，只差视频
  assert.ok(pendingMedia(50).some((p) => p.weibo_id === RAW.idstr && p.need_video && !p.need_images));
  const v = storeMedia(RAW.idstr, { kind: 'video', bytes: mp4 });
  assert.equal(v.ok, true); assert.equal(v.complete, true);
  assert.equal(one('SELECT video_status FROM weibo_favorites WHERE weibo_id = ?', RAW.idstr).video_status, 'done');
  assert.ok(!pendingMedia(50).some((p) => p.weibo_id === RAW.idstr));
  // EXP_RT 的封面上次是登录墙，图还没齐：封面到了还不算齐，图也到了才算
  const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(3000, 1)]);
  const c = storeMedia(EXP_RT.id, { kind: 'cover', bytes: jpg });
  assert.equal(c.complete, false, '图还没到');
  const last = storeMedia(EXP_RT.id, { kind: 'image', index: 0, bytes: jpg });
  assert.equal(last.complete, true);
  assert.equal(one('SELECT media_status FROM weibo_favorites WHERE weibo_id = ?', EXP_RT.id).media_status, 'done');
  run(`UPDATE weibo_favorites SET media_status = 'pending', attempts = 1 WHERE weibo_id = ?`, EXP_RT.id);
  markMediaFailed(EXP_RT.id, 'a'); markMediaFailed(EXP_RT.id, 'b');
  assert.equal(one('SELECT media_status FROM weibo_favorites WHERE weibo_id = ?', EXP_RT.id).media_status, 'failed');
  assert.throws(() => storeMedia('1', { kind: 'video', bytes: mp4 }), /不在微博收藏/);
  const s = favoritesStatus();
  assert.equal(s.total, 10); assert.equal(s.unavailable, 1); assert.equal(s.video_done, 1); assert.ok(s.imported >= 2);
});

test('收藏接口两种返回格式都认：旧 { data:[…], total_number }，2026-10 起 { data:{ status:[…], total_number } }；认不出来要说出来', () => {
  const { favoritesPage } = m;
  assert.deepEqual(favoritesPage({ data: [RAW], total_number: 5 }), { list: [RAW], total: 5, recognized: true });
  assert.deepEqual(favoritesPage({ ok: 1, data: { status: [RAW], total_number: 887 } }), { list: [RAW], total: 887, recognized: true });
  assert.deepEqual(favoritesPage({ ok: 1, data: { status: [] } }), { list: [], total: null, recognized: true });
  assert.equal(favoritesPage({ ok: 1, data: { items: [RAW] } }).recognized, false);
});

test('服务端同步：新格式真的能把收藏读进来；格式不认识时报错而不是"0 条新收藏"', async () => {
  const { syncFavorites } = m;
  const NEW = { ...RAW, id: 4805000000000099, idstr: '4805000000000099', mblogid: 'NewFmt' };
  const fakeLaunch = (pages) => async () => ({
    pages: () => [{
      goto: async () => {}, waitForTimeout: async () => {}, url: () => 'https://weibo.com/',
      evaluate: async (fn, arg) => (arg === undefined ? 5216977151 : pages[arg.p - 1] ?? { ok: 1, data: { status: [] } }),
    }],
    close: async () => {},
  });
  const r = await syncFavorites({ full: true, launch: fakeLaunch([{ ok: 1, data: { status: [NEW], total_number: 1 } }]) });
  assert.equal(r.added, 1); assert.equal(r.pages, 1); assert.equal(r.total, 1);
  assert.ok(one('SELECT 1 FROM weibo_favorites WHERE weibo_id = ?', '4805000000000099'));
  await assert.rejects(syncFavorites({ full: true, launch: fakeLaunch([{ ok: 1, data: { items: [] } }]) }), /返回格式变了/);
});
