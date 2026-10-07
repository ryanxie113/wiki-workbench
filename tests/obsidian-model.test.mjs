import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildVaultSnapshot } from '../obsidian-plugin/src/model.mjs';

const demo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../examples/demo-vault');

test('Obsidian 只读模型使用同一来源解析，并排除日报模板', async () => {
  const paths = ['index.md', 'notes/soil-notes.md', 'projects/garden-observer.md', 'daily/_template.md'];
  const files = await Promise.all(paths.map(async relative => ({ path: relative, stat: await stat(path.join(demo, relative)) })));
  const snapshot = await buildVaultSnapshot(files, file => readFile(path.join(demo, file.path), 'utf8'));
  assert.equal(snapshot.pageCount, 3);
  assert.equal(snapshot.projects.length, 1);
  assert.equal(snapshot.projects[0].digest.progressEvidence[0].line, 15);
  assert.equal(snapshot.actions.length, 1);
  assert.equal(snapshot.actions[0].evidence.sourcePath, 'projects/garden-observer.md');
  assert.equal(snapshot.actions[0].evidence.line, 19);
  assert.equal(snapshot.actions[0].status, 'pending');
});

test('正文目录过滤仍读取目录外日报并识别已完成', async () => {
  const markdown = new Map([
    ['wiki/projects/demo.md', '# Demo\n\n## Next steps\n- Check moisture\n'],
    ['daily/2026-02-04.md', '# Daily\n\n## 今日计划\n- [x] P1: Check moisture [[wiki/projects/demo]]\n- [ ] P2:\n- [ ] P3:\n'],
    ['other/private.md', '# Unrelated\n']
  ]);
  const files = [...markdown.keys()].map(filePath => ({ path: filePath, stat: { size: markdown.get(filePath).length } }));
  const snapshot = await buildVaultSnapshot(files, file => markdown.get(file.path), { contentDir: 'wiki', dailyDir: 'daily' });
  assert.equal(snapshot.pageCount, 2);
  assert.equal(snapshot.actions[0].status, 'completed');
  assert.equal(snapshot.actions[0].adoption.path, 'daily/2026-02-04.md');
});
