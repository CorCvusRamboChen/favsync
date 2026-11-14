// 抖音接口的真实形状（2026-10 实测）：收藏视频 listcollection 的 aweme_list、音乐 music/listcollection 的 mc_list、
// 图文帖 aweme_type 68、直链有效期；外加链接识别。全是纯函数，不碰数据库。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAweme, normalizeMusic, isDouyinUrl, parseAwemeId, urlExpiry, isCroppedCover } from '../src/connectors/douyin-favorites.js';

test('isDouyinUrl 认 douyin.com / v.douyin.com / iesdouyin.com，不认长得像的域名', () => {
  assert.equal(isDouyinUrl('https://www.douyin.com/video/7123456789012345678'), true);
  assert.equal(isDouyinUrl('https://v.douyin.com/abc123/'), true);
  assert.equal(isDouyinUrl('https://www.iesdouyin.com/share/video/712345/'), true);
  assert.equal(isDouyinUrl('https://douyin.com.evil.test/video/1'), false);
  assert.equal(isDouyinUrl('https://notdouyin.com/video/1'), false);
  assert.equal(isDouyinUrl('not a url'), false);
});

test('parseAwemeId：/video/<id> 或 ?modal_id=<id>', () => {
  assert.equal(parseAwemeId('https://www.douyin.com/video/7123456789012345678'), '7123456789012345678');
  assert.equal(parseAwemeId('https://www.douyin.com/jingxuan?modal_id=7123456789012345678'), '7123456789012345678');
  assert.equal(parseAwemeId('https://www.douyin.com/discover'), null);
});

test('视频帖：字段不全也不抛；aweme_id 不像数字就 null；封面优先 origin_cover；时长毫秒→秒', () => {
  const n = normalizeAweme({ aweme_id: '7000000000000000001', desc: '  标题 #话题 ', create_time: 1760000000, author: { nickname: 'A', uid: 7 },
    video: { duration: 61500, cover: { url_list: ['https://p3.douyinpic.com/a~tplv-dy-cropcenter:323:430.jpeg'] }, origin_cover: { url_list: ['https://p3.douyinpic.com/b~tplv-dy-360p.jpeg'] }, play_addr: { url_list: ['https://v5.zjcdn.com/x/'] } } });
  assert.equal(n.desc, '标题 #话题'); assert.equal(n.author_uid, '7'); assert.equal(n.duration, 62);
  assert.equal(n.cover, 'https://p3.douyinpic.com/b~tplv-dy-360p.jpeg'); assert.equal(isCroppedCover(n.cover), false);
  assert.equal(n.is_image_post, false); assert.deepEqual(n.images, []);
  assert.equal(normalizeAweme({ aweme_id: 'abc' }), null);
  assert.equal(normalizeAweme({ aweme_id: '7000000000000000002' }).play_url, null, '没有 video 字段也能整形');
});

test('图文帖（aweme_type 68）：顶层 play_addr 是配乐；每张图 static 优先 jpeg、original 用 download_url_list；实况带 live', () => {
  const pic = normalizeAweme({ aweme_id: '7000000000000000003', aweme_type: 68, desc: '图文',
    video: { play_addr: { url_list: ['https://sf.douyinstatic.com/obj/ies-music/1.mp3'] } },
    images: [{ url_list: ['https://x/1.webp', 'https://x/1.jpg'], download_url_list: ['https://x/1-o.webp'], video: { play_addr: { url_list: ['https://x/1-live.mp4'] } } }, { url_list: ['https://x/2.webp'] }] });
  assert.equal(pic.is_image_post, true); assert.equal(pic.play_url, null); assert.match(pic.music_url, /\.mp3$/);
  assert.deepEqual(pic.variants, [{ static: 'https://x/1.jpg', original: 'https://x/1-o.webp', live: 'https://x/1-live.mp4' }, { static: 'https://x/2.webp', original: null, live: null }]);
  assert.equal(pic.has_live, true); assert.equal(pic.cover, 'https://x/1.jpg', '图文没封面就用第一张图');
});

test('音乐（mc_list）：id_str / title / author / play_url / cover_hd；毫秒时长换秒；坏条目 null', () => {
  const m = normalizeMusic({ id_str: '7300000000000000001', title: '歌', author: '人', album: '', duration: 226, play_url: { url_list: ['https://sf.douyinstatic.com/obj/ies-music/x.mp3'] }, cover_hd: { url_list: ['https://p3.douyinpic.com/m.jpg'] }, is_original: true, user_count: 12 });
  assert.equal(m.url, 'https://www.douyin.com/music/7300000000000000001'); assert.equal(m.album, null); assert.equal(m.is_original, true); assert.equal(m.user_count, 12);
  assert.equal(normalizeMusic({ mid: '1234567', duration: 226000 }).duration, 226);
  assert.equal(normalizeMusic({ title: 'x' }), null);
});

test('直链有效期：CDN 路径里的 8 位十六进制秒、图床 x-expires；没有就 null', () => {
  assert.equal(urlExpiry(`https://v5.zjcdn.com/${'a'.repeat(32)}/6ad4dcce/video/tos/x/`), 0x6ad4dcce * 1000);
  assert.equal(urlExpiry('https://p3-pc-sign.douyinpic.com/a.jpeg?x-expires=1792800000&x-signature=s'), 1792800000000);
  assert.equal(urlExpiry('https://lf9-music.douyinstatic.com/obj/ies-music/1.mp3'), null);
});
