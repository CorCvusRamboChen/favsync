// 数据层：同一 url 只有一张卡、标签增删、列表筛选（标签 / 反向标签 / 来源 / 关键词 / 分页）、删记录不删文件。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = mkdtempSync(path.join(tmpdir(), 'favsync-store-test-'));
process.env.FAVSYNC_DB = path.join(dir, 'test.db');
process.env.FAVSYNC_DATA = path.join(dir, 'data');
process.env.FAVSYNC_ARCHIVE = path.join(dir, 'archive');
const { db, one } = await import('../src/db.js');
const s = await import('../src/store.js');
const { archiveRoot, archivesFor, archiveStatus, writeIndex } = await import('../src/archive.js');
const { writeTextArchive, storeMediaFile, archiveDirOf } = await import('../src/connectors/favorites-archive.js');
after(() => { try { db.close(); } catch { /* 已关 */ } try { rmSync(dir, { recursive: true, force: true }); } catch { /* 临时目录 */ } });

test('saveItem：url 唯一，重复保存只补标签；没 url 的链接拒收；fillItem 只补空字段', () => {
  const a = s.saveItem({ kind: 'link', url: 'https://example.test/1', title: '一', source: '抖音', tags: ['抖音收藏', '抖音@主号'] });
  assert.equal(a.existing, false);
  const b = s.saveItem({ kind: 'link', url: 'https://example.test/1', title: '另一个标题', tags: ['抖音夹·学习'] });
  assert.equal(b.id, a.id); assert.equal(b.existing, true);
  assert.equal(s.getItem(a.id).title, '一', '标题不被覆盖');
  assert.deepEqual(s.tagsOf('link', a.id).sort(), ['抖音@主号', '抖音夹·学习', '抖音收藏'].sort());
  assert.throws(() => s.saveItem({ kind: 'link' }), /url/);
  s.fillItem(a.id, { image: 'https://img/1.jpg', excerpt: '摘要' });
  s.fillItem(a.id, { image: 'https://img/2.jpg' });
  assert.equal(s.getItem(a.id).image, 'https://img/1.jpg', 'fillItem 只补空的');
  assert.equal(s.updateItem(a.id, { note: '为什么存' }).note, '为什么存');
});

test('listItems：标签 / 反向标签 / 来源 / 关键词 / 分页；stats 与 listTags', () => {
  s.saveItem({ kind: 'link', url: 'https://example.test/2', title: '二 微博', source: '微博', tags: ['微博收藏', '已失效'] });
  s.saveItem({ kind: 'link', url: 'https://example.test/3', title: '三 推文', source: 'X', excerpt: '正文里有关键词 猫', tags: ['X收藏', 'X书签'] });
  assert.equal(s.listItems().length, 3);
  assert.deepEqual(s.listItems({ tag: '微博收藏' }).map((i) => i.title), ['二 微博']);
  assert.deepEqual(s.listItems({ exclude_tag: '已失效' }).map((i) => i.title).sort(), ['一', '三 推文']);
  assert.deepEqual(s.listItems({ source: 'X' }).map((i) => i.item_id), [s.findByUrl('https://example.test/3').id]);
  assert.equal(s.listItems({ q: '猫' }).length, 1);
  assert.equal(s.listItems({ limit: 2 }).length, 2); assert.equal(s.listItems({ limit: 2, offset: 2 }).length, 1);
  const st = s.stats();
  assert.equal(st.total, 3); assert.deepEqual(st.by_source, { 抖音: 1, 微博: 1, X: 1 }); assert.equal(st.untagged, 0);
  assert.equal(Object.keys(st.media_types).length, 7);
  assert.equal(s.listTags().find((t) => t.name === '抖音收藏').count, 1);
  const row = s.listItems({ tag: 'X书签' })[0];
  assert.equal(row.item_kind, 'link'); assert.equal(row.body, '正文里有关键词 猫', 'body 用摘要兜底');
});

test('存档：文本落盘即 done；媒体进同一目录；archivesFor 带文件列表；删记录不删文件；静态索引能生成', () => {
  const id = s.findByUrl('https://example.test/3').id;
  const rel = writeTextArchive(id, { title: '三 推文', url: 'https://example.test/3', sourceLabel: 'X 书签', body: '正文', meta: { source: 'X', tags: ['X收藏'] } });
  assert.ok(rel && existsSync(path.join(archiveRoot(), rel, 'readable.md')));
  const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(1024)]);
  const r = storeMediaFile(id, { kind: 'cover', bytes: jpg });
  assert.equal(r.ok, true); assert.equal(s.getItem(id).image.startsWith('/archive/'), true, '封面落盘后卡片改指本地');
  const [it] = archivesFor(s.listItems({ source: 'X' }));
  assert.equal(it.archive.status, 'done'); assert.deepEqual(it.archive.files.sort(), ['cover.jpg', 'metadata.json', 'readable.md']);
  assert.deepEqual([archiveStatus().done, archiveStatus().total], [1, 3]);
  assert.equal(s.mediaTypeCounts().text, 0, '有封面就不算仅文字');
  const idx = writeIndex();
  assert.equal(idx.count, 1); assert.ok(existsSync(idx.index));
  const abs = path.join(archiveRoot(), archiveDirOf(id));
  const out = s.removeItem(id);
  assert.equal(out.files_kept, true);
  assert.equal(one('SELECT COUNT(*) AS n FROM items WHERE id = ?', id).n, 0);
  assert.equal(one('SELECT COUNT(*) AS n FROM archives WHERE item_id = ?', id).n, 0);
  assert.ok(existsSync(path.join(abs, 'cover.jpg')), '硬盘上的文件一个不少');
});
