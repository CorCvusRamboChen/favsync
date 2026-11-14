// X 点赞/书签：GraphQL 推文整形（长推、t.co 展开、图/视频/动图、转推、引用）、同一条推既点赞又收藏只一张卡、
// 媒体由服务端从 CDN 下（假 fetch）、导入扁平化 JSON、状态汇总。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = mkdtempSync(path.join(tmpdir(), 'x-fav-test-'));
process.env.FAVSYNC_DB = path.join(dir, 'test.db');
process.env.FAVSYNC_ARCHIVE = path.join(dir, 'archive');
const { db, one } = await import('../src/db.js');
const x = await import('../src/connectors/x-favorites.js');
const { listItems, tagsOf } = await import('../src/store.js');
after(() => { try { db.close(); } catch { /* 已关 */ } try { rmSync(dir, { recursive: true, force: true }); } catch { /* 临时目录 */ } });

const user = (handle, name) => ({ result: { __typename: 'User', legacy: { screen_name: handle, name } } });
const tweet = (id, text, { legacy: extraLegacy, ...extra } = {}) => ({ __typename: 'Tweet', rest_id: id, core: { user_results: user('karpathy', 'Andrej') }, views: { count: '12345' },
  legacy: { full_text: text, created_at: 'Wed Oct 10 20:19:24 +0000 2018', favorite_count: 10, retweet_count: 2, reply_count: 1, bookmark_count: 3, lang: 'en', entities: { urls: [], media: [] }, ...extraLegacy }, ...extra });
const photo = (id, u) => ({ type: 'photo', url: u, media_url_https: `https://pbs.twimg.com/media/${id}.jpg`, original_info: { width: 1200, height: 800 } });
const video = (u) => ({ type: 'video', url: u, media_url_https: 'https://pbs.twimg.com/ext_tw_video_thumb/1/pu/img/thumb.jpg', video_info: { duration_millis: 12000, variants: [{ content_type: 'application/x-mpegURL', url: 'https://video.twimg.com/x.m3u8' }, { content_type: 'video/mp4', bitrate: 832000, url: 'https://video.twimg.com/832.mp4' }, { content_type: 'video/mp4', bitrate: 2176000, url: 'https://video.twimg.com/2176.mp4' }] } });

test('normalizeTweet：长推文、t.co 展开、媒体地址取原图/最高码率、转推按原推、引用进 quoted', () => {
  const n = x.normalizeTweet(tweet('1001', 'Check this https://t.co/abc and pic https://t.co/pic', { legacy: { entities: { urls: [{ url: 'https://t.co/abc', expanded_url: 'https://example.com/post' }], media: [{ url: 'https://t.co/pic' }] }, extended_entities: { media: [photo('AAA', 'https://t.co/pic'), video('https://t.co/pic')] } } }));
  assert.equal(n.tweet_id, '1001'); assert.equal(n.url, 'https://x.com/karpathy/status/1001'); assert.equal(n.author_handle, 'karpathy');
  assert.equal(n.text, 'Check this https://example.com/post and pic');
  assert.equal(n.created_at, '2018-10-10 20:19:24'); assert.equal(n.stats.views, 12345); assert.equal(n.stats.bookmarks, 3);
  assert.deepEqual(n.media.map((m) => [m.type, m.url]), [['photo', 'https://pbs.twimg.com/media/AAA?format=jpg&name=orig'], ['video', 'https://video.twimg.com/2176.mp4']]);
  assert.equal(n.media[1].duration, 12);
  assert.equal(n.cover, 'https://pbs.twimg.com/media/AAA.jpg');
  // 长推：note_tweet 优先
  const long = x.normalizeTweet(tweet('1002', '短的…', { note_tweet: { note_tweet_results: { result: { text: '这是完整的长推文内容 '.repeat(3).trim(), entity_set: { urls: [] } } } } }));
  assert.match(long.text, /^这是完整的长推文内容/);
  // 转推：内容按原推，id 用原推的
  const rt = x.normalizeTweet(tweet('1003', 'RT @someone: xxx', { legacy: { retweeted_status_result: { result: tweet('900', '原推正文', { core: { user_results: user('someone', 'Some One') } }) } } }));
  assert.equal(rt.tweet_id, '900'); assert.equal(rt.author_handle, 'someone'); assert.equal(rt.retweeted_by, 'karpathy'); assert.equal(rt.text, '原推正文');
  // 引用 + 可见性壳
  const q = x.normalizeTweet({ __typename: 'TweetWithVisibilityResults', tweet: tweet('1004', '我的评论', { quoted_status_result: { result: tweet('800', '被引用的', { core: { user_results: user('q', 'Q') } }) } }) });
  assert.equal(q.tweet_id, '1004'); assert.equal(q.quoted.handle, 'q'); assert.match(x.bodyOf(q), /引用 @q：被引用的/);
  assert.equal(x.normalizeTweet({ rest_id: 'abc' }), null); assert.equal(x.normalizeTweet(null), null);
});

test('ingestFavorites：点赞和书签同一条推只一张卡、两个标签；多账号累加；再推一次是 updated 不重复', () => {
  const raw = tweet('2001', 'hello world', { legacy: { extended_entities: { media: [photo('BBB')] } } });
  const r1 = x.ingestFavorites([raw, tweet('2002', 'second')], { kind: 'like', account: 'alice' });
  assert.equal(r1.added, 2);
  const r2 = x.ingestFavorites([raw], { kind: 'bookmark', account: 'bob' });
  assert.equal(r2.updated, 1); assert.equal(r2.added, 0);
  const items = listItems({ tag: x.TAG });
  assert.equal(items.length, 2);
  const card = items.find((i) => i.url.endsWith('/2001'));
  assert.ok(card.tags.includes(x.LIKE_TAG) && card.tags.includes(x.BOOKMARK_TAG) && card.tags.includes('X@alice') && card.tags.includes('X@bob'));
  assert.equal(card.source, 'X'); assert.equal(card.image, 'https://pbs.twimg.com/media/BBB.jpg');
  const row = one('SELECT liked, bookmarked, accounts_json, media_status FROM x_favorites WHERE tweet_id = ?', '2001');
  assert.equal(row.liked, 1); assert.equal(row.bookmarked, 1); assert.deepEqual(JSON.parse(row.accounts_json), ['alice', 'bob']); assert.equal(row.media_status, 'pending');
  assert.equal(one('SELECT media_status FROM x_favorites WHERE tweet_id = ?', '2002').media_status, 'none', '没媒体的直接 none');
  const st = x.favoritesStatus();
  assert.equal(st.total, 2); assert.equal(st.liked, 2); assert.equal(st.bookmarked, 1); assert.deepEqual(st.accounts.map((a) => a.name).sort(), ['alice', 'bob']);
  assert.ok(existsSync(path.join(process.env.FAVSYNC_ARCHIVE)), '文本存档已落盘');
});

test('fetchPendingMedia：封面 + 原图 + 最高码率视频从 CDN 下；失败计次，三次封顶', async () => {
  x.ingestFavorites([tweet('3001', 'vid', { legacy: { extended_entities: { media: [video(), photo('CCC')] } } })], { kind: 'bookmark' });
  const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(2048)]);
  const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(20 * 1024)]);
  const urls = [];
  const fetchImpl = async (u) => { urls.push(u); return { ok: true, status: 200, arrayBuffer: async () => (/mp4/.test(u) ? mp4 : jpg) }; };
  const r = await x.fetchPendingMedia({ fetchImpl, pauseMs: 0 });
  assert.equal(r.done, 2, '3001 和上个测试留下的 2001 都补了'); assert.equal(r.files, 5);
  assert.deepEqual(urls.slice(0, 3), ['https://pbs.twimg.com/ext_tw_video_thumb/1/pu/img/thumb.jpg', 'https://video.twimg.com/2176.mp4', 'https://pbs.twimg.com/media/CCC?format=jpg&name=orig']);
  const formats = JSON.parse(one(`SELECT formats FROM archives WHERE item_kind = 'link' AND item_id = (SELECT item_id FROM x_favorites WHERE tweet_id = '3001')`).formats);
  assert.ok(formats['video.mp4'] && formats['image-01.jpg'] && formats['cover.jpg'], JSON.stringify(formats));
  assert.equal(one('SELECT media_status FROM x_favorites WHERE tweet_id = ?', '3001').media_status, 'done');
  x.ingestFavorites([tweet('3002', 'bad', { legacy: { extended_entities: { media: [photo('DDD')] } } })], { kind: 'like' });
  const bad = async () => ({ ok: false, status: 404 });
  for (let i = 0; i < 3; i++) await x.fetchPendingMedia({ fetchImpl: bad, pauseMs: 0 });
  const row = one('SELECT media_status, attempts, media_error FROM x_favorites WHERE tweet_id = ?', '3002');
  assert.equal(row.attempts, 3); assert.equal(row.media_status, 'failed'); assert.match(row.media_error, /404/);
  assert.equal((await x.fetchPendingMedia({ fetchImpl: bad, pauseMs: 0 })).tried, 0, '封顶后不再试');
});

test('importExportFile：扁平化导出（id / full_text / screen_name / media）也认，按文件名猜点赞', () => {
  const f = path.join(dir, 'twitter-likes.json');
  writeFileSync(f, JSON.stringify([{ id: '4001', full_text: 'flat one', screen_name: 'flatuser', user_name: 'Flat', created_at: '2024-01-02T03:04:05.000Z', favorite_count: 5, media: [{ type: 'photo', url: 'https://pbs.twimg.com/media/EEE.jpg' }] }, { id: 'nope' }]));
  const r = x.importExportFile(f, { kind: null, account: 'alice' });
  assert.equal(r.kind, 'like'); assert.equal(r.added, 1); assert.equal(r.invalid, 1);
  const card = listItems({ tag: x.LIKE_TAG }).find((i) => i.url.endsWith('/4001'));
  assert.ok(card); assert.equal(card.title, 'flat one'); assert.ok(tagsOf('link', card.item_id).includes('X@alice'));
  assert.equal(JSON.parse(one('SELECT media_json FROM x_favorites WHERE tweet_id = ?', '4001').media_json)[0].url, 'https://pbs.twimg.com/media/EEE?format=jpg&name=orig');
  assert.equal(x.favoritesStatus().imported, 1);
  assert.throws(() => x.importExportFile(path.join(dir, 'missing.json')), /不存在/);
});
