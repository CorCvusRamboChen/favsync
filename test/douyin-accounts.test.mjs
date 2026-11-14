// 抖音多账号：注册表（老安装自动得到 main）、按账号筛待下媒体、last_seen_at（防删：原站没了这里不删）、
// 全账号同步的调度（哪个号登录态过期只记它自己）、影音库的音乐列表。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = mkdtempSync(path.join(tmpdir(), 'douyin-acct-test-'));
process.env.FAVSYNC_DB = path.join(dir, 'test.db');
process.env.FAVSYNC_ARCHIVE = path.join(dir, 'archive');
process.env.FAVSYNC_DOUYIN_ACCOUNTS = path.join(dir, 'accounts.json');

const { db, one } = await import('../src/db.js');
const d = await import('../src/connectors/douyin-favorites.js');
after(() => { try { db.close(); } catch { /* 已关 */ } try { rmSync(dir, { recursive: true, force: true }); } catch { /* 临时目录 */ } });

const aweme = (id, extra = {}) => ({
  aweme_id: id, desc: '测试视频 #标签', create_time: 1760000000, author: { nickname: '作者', uid: '1' },
  video: { duration: 10000, cover: { url_list: ['https://p3-sign.douyinpic.com/c.jpg'] }, play_addr: { url_list: ['https://www.douyin.com/aweme/v1/play/?video_id=' + id] } },
  statistics: { digg_count: 1 }, ...extra,
});

test('注册表：没有文件时默认一个 main（昵称取库里最多的）；增删改；新 id 不撞', () => {
  d.ingestFavorites([aweme('7000000000000000001'), aweme('7000000000000000002')], { account: { uid: '9', nickname: '主号' } });
  const list = d.listAccounts();
  assert.equal(list.length, 1); assert.equal(list[0].id, 'main'); assert.equal(list[0].nickname, '主号'); assert.equal(list[0].profile, 'default');
  assert.equal(existsSync(process.env.FAVSYNC_DOUYIN_ACCOUNTS), false, '只读不落盘');
  const id = d.newAccountId(); assert.equal(id, 'dy2');
  d.upsertAccount({ id, nickname: '小号' });
  assert.equal(d.listAccounts().length, 2); assert.equal(d.profileOf('dy2'), 'dy2'); assert.equal(d.profileOf('main'), 'default'); assert.equal(d.profileOf(null), 'default');
  d.upsertAccount({ id: 'dy2', need_login: true, last_attempt: 'x' });
  assert.equal(d.listAccounts()[1].need_login, true); assert.equal(d.listAccounts()[1].nickname, '小号', '没传昵称不覆盖');
  assert.equal(d.newAccountId(), 'dy3');
  d.removeAccount('dy2');
  assert.equal(d.listAccounts().length, 1);
  assert.throws(() => d.upsertAccount({ id: '' }), /不能空/);
});

test('pendingMedia 按账号筛：第一个号带上没记账号的老条目，第二个号只拿自己的', () => {
  d.ingestFavorites([aweme('7000000000000000003')], { account: { uid: '8', nickname: '小号' } });
  d.ingestFavorites([aweme('7000000000000000004')]);   // 没有账号信息（油猴脚本早期版本）
  const main = d.pendingMedia(20, { accountName: '主号', includeUnassigned: true }).map((x) => x.aweme_id).sort();
  assert.deepEqual(main, ['7000000000000000001', '7000000000000000002', '7000000000000000004']);
  const second = d.pendingMedia(20, { accountName: '小号', includeUnassigned: false }).map((x) => x.aweme_id);
  assert.deepEqual(second, ['7000000000000000003']);
  // 同一条被两个号收藏：accounts_json 里有就算
  d.ingestFavorites([aweme('7000000000000000001')], { account: { uid: '8', nickname: '小号' } });
  assert.ok(d.pendingMedia(20, { accountName: '小号', includeUnassigned: false }).some((x) => x.aweme_id === '7000000000000000001'));
  assert.equal(d.pendingMedia(20).length, 4, '不筛就是全部');
});

test('last_seen_at：入库和再次见到都会刷新；原站删了的条目不会被删', () => {
  const r0 = one('SELECT last_seen_at FROM douyin_favorites WHERE aweme_id = ?', '7000000000000000002');
  assert.ok(r0.last_seen_at);
  db.exec(`UPDATE douyin_favorites SET last_seen_at = '2020-01-01 00:00:00' WHERE aweme_id = '7000000000000000002'`);
  d.ingestFavorites([aweme('7000000000000000002')]);
  assert.ok(one('SELECT last_seen_at FROM douyin_favorites WHERE aweme_id = ?', '7000000000000000002').last_seen_at > '2025');
  assert.equal(one('SELECT COUNT(*) AS n FROM douyin_favorites').n, 4);
});

test('syncAllAccounts：每个号 列表→收藏夹；need_login 只记那个号；汇总加总；全挂才算 need_login', async () => {
  d.upsertAccount({ id: 'dy2', nickname: '小号' });
  const calls = [];
  const syncers = {
    favorites: async ({ account, full }) => { calls.push(`fav:${account}:${full}`); return account === 'dy2' ? { need_login: true } : { added: 2, updated: 1, pages: 3, account: '主号' }; },
    folders: async ({ account }) => { calls.push(`folders:${account}`); return { added: 5, updated: 0, folders: 3 }; },
  };
  const r = await d.syncAllAccounts({ syncers });
  assert.deepEqual(calls, ['fav:main:false', 'folders:main', 'fav:dy2:false']);
  assert.equal(r.added, 7); assert.equal(r.updated, 1); assert.equal(r.pages, 3); assert.equal(r.need_login, false);
  const accts = d.listAccounts();
  assert.equal(accts.find((a) => a.id === 'dy2').need_login, true);
  assert.equal(accts.find((a) => a.id === 'main').need_login, false); assert.ok(accts.find((a) => a.id === 'main').last_sync);
  // 过期的号下一轮跳过；full 时再试
  calls.length = 0;
  await d.syncAllAccounts({ syncers });
  assert.deepEqual(calls, ['fav:main:false', 'folders:main']);
  calls.length = 0;
  const r2 = await d.syncAllAccounts({ syncers: { ...syncers, favorites: async () => ({ need_login: true }) }, full: true });
  assert.equal(r2.need_login, true, '全部都要登录');
  assert.deepEqual(calls, []);
  // 异常只影响那个号
  const r3 = await d.syncAllAccounts({ syncers: { ...syncers, favorites: async ({ account }) => { if (account === 'main') throw new Error('验证码'); return { added: 1, updated: 0, pages: 1 }; } }, full: true });
  assert.match(r3.accounts[0].error, /验证码/); assert.equal(r3.accounts[1].list.added, 1);
  assert.match(d.listAccounts()[0].error, /验证码/);
});

test('fetchPendingMediaAllAccounts：按账号分配额度，用各自的登录态；一个号被限流就停', async () => {
  d.upsertAccount({ id: 'main', need_login: false }); d.upsertAccount({ id: 'dy2', need_login: false });
  const seen = [];
  const fetcher = async ({ account, limit }) => { seen.push(`${account}:${limit}`); return { tried: 2, done: account === 'main' ? 2 : 1, failed: account === 'main' ? 0 : 1, files: 3, stopped: account === 'dy2' ? '抖音限流（HTTP 403），停下' : null }; };
  const r = await d.fetchPendingMediaAllAccounts({ limit: 40, fetcher });
  assert.deepEqual(seen, ['main:20', 'dy2:20']);
  assert.equal(r.done, 3); assert.equal(r.files, 6); assert.match(r.stopped, /403/);
});

test('收藏的音乐入库后状态里带 kind 计数和账号注册表', () => {
  d.ingestMusic([{ id_str: '660000000001', title: '晴天', author: '周杰伦', album: '叶惠美', duration: 269, play_url: { url_list: ['https://sf.douyin.com/a.mp3'] }, cover_hd: { url_list: ['https://p3.douyinpic.com/c.jpg'] } }], { account: { uid: '9', nickname: '主号' } });
  const st = d.favoritesStatus();
  assert.equal(st.kinds.music, 1);
  assert.equal(st.profiles.length, 2, '状态里带账号注册表');
});
