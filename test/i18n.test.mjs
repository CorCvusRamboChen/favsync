// 界面文案字典：zh / en 的键完全一致、没有空值、占位符 {x} 两边对得上；配对链接的 token 解析。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
await import(path.join(root, 'public', 'js', 'i18n.js').replace(/\\/g, '/').replace(/^([A-Za-z]):/, 'file:///$1:'));
const dict = globalThis.FS_I18N;

test('zh / en 键一致，没有空字符串', () => {
  const zh = Object.keys(dict.zh).sort(), en = Object.keys(dict.en).sort();
  assert.deepEqual(en.filter((k) => !dict.zh[k]), [], 'en 多出来的键');
  assert.deepEqual(zh.filter((k) => !dict.en[k]), [], 'zh 多出来的键');
  assert.deepEqual(zh, en);
  for (const l of ['zh', 'en']) for (const [k, v] of Object.entries(dict[l])) assert.ok(typeof v === 'string' && v.trim(), `${l}.${k} 为空`);
  assert.ok(zh.length > 150);
});

test('占位符 {x} 两种语言一致', () => {
  const ph = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
  for (const k of Object.keys(dict.zh)) assert.deepEqual(ph(dict.zh[k]), ph(dict.en[k]), `占位符不一致：${k}`);
});

test('页面里用到的 t(key) 都在字典里', () => {
  const used = new Set();
  for (const f of ['public/js/shell.js', 'public/js/library.js', 'public/js/settings.js', 'public/library.html', 'public/settings.html']) {
    const src = readFileSync(path.join(root, f), 'utf-8');
    for (const m of src.matchAll(/\bt\(\s*'([a-z0-9_.]+)'/g)) used.add(m[1]);
    for (const m of src.matchAll(/data-i18n(?:-title|-ph|-doc)?="([a-z0-9_.]+)"/g)) used.add(m[1]);
  }
  // 以 . 结尾的是动态前缀（t('lib.media.' + k)）：要求字典里至少有一个该前缀的键
  const missing = [...used].filter((k) => (k.endsWith('.') ? !Object.keys(dict.zh).some((d) => d.startsWith(k)) : !dict.zh[k]));
  assert.deepEqual(missing, [], '字典里没有的键');
  assert.ok(used.size > 80);
});
