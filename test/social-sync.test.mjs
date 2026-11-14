// 常态化同步的调度层：状态文件、need_login 跳过、单站失败不影响另一站、after 阶段；
// 以及收藏库的反向筛（exclude_tag）——「已失效」默认藏起来靠它。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = mkdtempSync(path.join(tmpdir(), 'social-sync-test-'));
process.env.FAVSYNC_DB = path.join(dir, 'test.db');
process.env.FAVSYNC_ARCHIVE = path.join(dir, 'archive');
process.env.FAVSYNC_SOCIAL_SYNC = path.join(dir, 'social-sync.json');

const { db } = await import('../src/db.js');
const { runSocialSync, socialStatus, readState, writeState, isEnabled } = await import('../src/connectors/social-sync.js');
const { saveItem, listItems } = await import('../src/store.js');

after(() => {
  try { db.close(); } catch { /* 已关 */ }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* 临时目录 */ }
});

test('runSocialSync：两站各自 try；need_login 记下来且下次跳过；force 再试；after 阶段的结果带回', async () => {
  const calls = [];
  const syncers = {
    weibo: async ({ full }) => { calls.push('weibo:' + full); return { added: 3, updated: 1, pages: 2 }; },
    douyin: async () => { calls.push('douyin'); return { need_login: true }; },
  };
  const after1 = async () => ({ weibo_images: { done: 2 } });
  const r = await runSocialSync({ syncers, after: after1, full: true });
  assert.deepEqual(calls, ['weibo:true', 'douyin']);
  assert.equal(r.sites.weibo.added, 3); assert.equal(r.sites.douyin.need_login, true);
  assert.equal(r.media.weibo_images.done, 2);
  const st = socialStatus();
  assert.equal(st.sites.weibo.need_login, false); assert.ok(st.sites.weibo.last_sync); assert.equal(st.sites.weibo.last_result.added, 3);
  assert.equal(st.sites.douyin.need_login, true);
  calls.length = 0;
  const r2 = await runSocialSync({ syncers, after: after1 });
  assert.deepEqual(calls, ['weibo:false'], '抖音 need_login 就不再撞');
  assert.equal(r2.sites.douyin.reason, 'need_login');
  const r3 = await runSocialSync({ syncers: { ...syncers, douyin: async () => { throw new Error('验证码'); } }, after: after1, force: true });
  assert.match(r3.sites.douyin.error, /验证码/);
  assert.equal(readState().douyin.error, '验证码');
  assert.equal(r3.sites.weibo.added, 3, '另一站照常');
  writeState({ weibo: { note: 'x' } });
  assert.equal(readState().weibo.last_result.added, 3, 'writeState 是合并不是覆盖');
});

test('定时开关：两站默认都开（抖音节奏和脚本一样慢，可关）；状态里带 enabled', () => {
  assert.equal(isEnabled('weibo'), true); assert.equal(isEnabled('douyin'), true);
  writeState({ douyin: { enabled: true } });
  assert.equal(isEnabled('douyin'), true); assert.equal(socialStatus().sites.douyin.enabled, true);
  writeState({ douyin: { enabled: false }, weibo: { enabled: false } });
  assert.equal(isEnabled('douyin'), false); assert.equal(socialStatus().sites.weibo.enabled, false);
  writeState({ weibo: { enabled: true } });
});

test('收藏库 exclude_tag：带该标签的条目不出现；和 tag 可以同时用', () => {
  const a = saveItem({ kind: 'note', body: '活的', tags: ['微博收藏'] });
  const b = saveItem({ kind: 'note', body: '死的', tags: ['微博收藏', '已失效'] });
  const all = listItems({ limit: 10 }).map((i) => i.item_id);
  assert.ok(all.includes(a.id) && all.includes(b.id));
  const alive = listItems({ exclude_tag: '已失效', limit: 10 }).map((i) => i.item_id);
  assert.ok(alive.includes(a.id) && !alive.includes(b.id));
  const both = listItems({ tag: '微博收藏', exclude_tag: '已失效', limit: 10 }).map((i) => i.item_id);
  assert.deepEqual(both, [a.id]);
  assert.equal(listItems({ tag: '已失效', limit: 10 }).length, 1);
});
