// 持久 profile 启动器：同一目录排队（不再因"profile 被占"报没有 Chrome）、close 放锁、多 profile 目录互不干扰。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

process.env.FAVSYNC_BROWSER_PROFILE = path.join('C:', 'tmp', 'p-default');
process.env.FAVSYNC_BROWSER_PROFILES = path.join('C:', 'tmp', 'profiles');
const { launchProfile, profileDir, DEFAULT_PROFILE, profileBusy } = await import('../src/connectors/browser-profiles.js');

const fakeLauncher = (log) => async (dir, opts) => { log.push('open:' + path.basename(dir) + ':' + opts.headless); return { close: async () => { log.push('close:' + path.basename(dir)); } }; };

test('profileDir：default 是老的共用目录，其它账号各自一个目录，名字会被清洗', () => {
  assert.equal(profileDir(), process.env.FAVSYNC_BROWSER_PROFILE);
  assert.equal(profileDir(DEFAULT_PROFILE), process.env.FAVSYNC_BROWSER_PROFILE);
  assert.equal(profileDir('dy2'), path.join(process.env.FAVSYNC_BROWSER_PROFILES, 'dy2'));
  assert.equal(profileDir('../evil name'), path.join(process.env.FAVSYNC_BROWSER_PROFILES, '.._evil_name'));
});

test('同一 profile 的第二次启动要等第一次 close；不同 profile 并行', async () => {
  const log = [];
  const a = await launchProfile('dy2', { launcher: fakeLauncher(log) });
  let bOpened = false;
  const bP = launchProfile('dy2', { launcher: fakeLauncher(log) }).then((c) => { bOpened = true; return c; });
  const c = await launchProfile('dy3', { launcher: fakeLauncher(log) });   // 另一个目录，不用等
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(bOpened, false, 'dy2 还被 a 占着');
  assert.ok(profileBusy(profileDir('dy2')));
  await a.close();
  const b = await bP;
  assert.equal(bOpened, true);
  await b.close(); await c.close();
  assert.deepEqual(log, ['open:dy2:true', 'open:dy3:true', 'close:dy2', 'open:dy2:true', 'close:dy2', 'close:dy3']);
  assert.equal(profileBusy(profileDir('dy2')), false, '都关了，队列清空');
});

test('启动失败也放锁；等待超时的那个不会把锁带走', async () => {
  const log = [];
  await assert.rejects(launchProfile('dy4', { launcher: async () => { throw new Error('boom'); } }), /boom/);
  const ok = await launchProfile('dy4', { launcher: fakeLauncher(log) });
  await assert.rejects(launchProfile('dy4', { launcher: fakeLauncher(log), timeoutMs: 20 }), /超时/);
  await ok.close();
  await new Promise((r) => setTimeout(r, 5));
  const again = await launchProfile('dy4', { launcher: fakeLauncher(log) });   // 超时者轮到时立刻放锁，这里不会卡住
  await again.close();
  assert.deepEqual(log, ['open:dy4:true', 'close:dy4', 'open:dy4:true', 'close:dy4']);
});
