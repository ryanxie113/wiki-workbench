import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadLibrary } from '../lib/wiki.mjs';
import { buildActionInbox } from '../lib/actions.mjs';
import { buildWeeklyReview } from '../lib/weekly-review.mjs';
import { updateToday, zonedNow } from '../lib/daily.mjs';
import { readWorkspaceState, writeWorkspaceState, workspaceStateFile } from '../lib/workspace-state.mjs';

test('订阅、审阅和来源行动按资料库持久化，导入可覆盖并拒绝不安全链接', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'workbench-state-'));
  const vaultId = '0123456789abcdef';
  try {
    const inbox = { feeds: ['https://example.com/feed.xml', 'file:///bad'], manual: [], decisions: {}, sourceActions: [
      { url: 'https://example.com/story', projectPath: 'projects/demo.md', text: '试做原型', title: 'Story', createdAt: '2026-10-03T09:00:00Z' },
      { url: 'javascript:alert(1)', projectPath: 'projects/demo.md', text: 'Bad' }
    ] };
    await writeWorkspaceState(vaultId, { inbox, reviewChoices: { ['a'.repeat(20)]: 'deferred' } }, { base: directory });
    const saved = await readWorkspaceState(vaultId, directory);
    assert.deepEqual(saved.data.inbox.feeds, ['https://example.com/feed.xml']);
    assert.equal(saved.data.inbox.sourceActions.length, 1);
    assert.equal(saved.data.reviewChoices['a'.repeat(20)], 'deferred');
    assert.equal(JSON.parse(await readFile(workspaceStateFile(vaultId, directory), 'utf8')).version, 1);
    await writeWorkspaceState(vaultId, { weeklyDecisions: { ['b'.repeat(20)]: { status: 'reschedule', targetDate: '2026-10-10', note: '等待验证' } } }, { base: directory });
    assert.equal((await readWorkspaceState(vaultId, directory)).data.inbox.sourceActions.length, 1, '分区更新不擦除订阅');
    await writeWorkspaceState(vaultId, { x: { handles: ['simonw'], custom: [] } }, { base: directory, replace: true });
    const replaced = await readWorkspaceState(vaultId, directory);
    assert.deepEqual(Object.keys(replaced.data), ['x']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('外部来源需关联有效项目才进入行动队列，未完成计划进入每周回顾', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'workbench-weekly-flow-'));
  try {
    await mkdir(path.join(directory, 'projects'));
    await mkdir(path.join(directory, 'daily'));
    await writeFile(path.join(directory, 'projects/demo.md'), '# Demo\n');
    await writeFile(path.join(directory, 'daily/2026-10-03.md'), '# Daily\n\n## 今日计划\n- [ ] P1: 试做原型 [[projects/demo]]\n- [x] P2: 已完成 [[projects/demo]]\n- [ ] P3:\n');
    const library = await loadLibrary(directory);
    const proposals = [
      { url: 'https://example.com/story', projectPath: 'projects/demo.md', text: '试做原型', title: 'Story', createdAt: '2026-10-03T09:00:00Z' },
      { url: 'https://example.com/unknown', projectPath: 'projects/missing.md', text: '无效项目' }
    ];
    const actions = buildActionInbox(library, {}, proposals);
    assert.equal(actions.length, 1);
    assert.equal(actions[0].status, 'planned');
    assert.equal(actions[0].evidence.url, 'https://example.com/story');
    const weekly = buildWeeklyReview(library, {}, '2026-10-05', actions, []);
    assert.equal(weekly.unfinished.length, 1);
    assert.equal(weekly.unfinished[0].actionId, actions[0].id);
    assert.equal(weekly.unfinished[0].path, 'daily/2026-10-03.md');
    const today = zonedNow('UTC').date;
    await writeFile(path.join(directory, `daily/${today}.md`), '# Daily\n\n## 今日计划\n- [ ] P1:\n- [ ] P2:\n- [ ] P3:\n');
    const currentLibrary = await loadLibrary(directory);
    const payload = { priority: 1, projectPath: 'projects/demo.md', text: '试做原型', sourceKind: 'external', sourcePath: 'https://example.com/story' };
    await assert.rejects(updateToday(directory, 'plan', payload, currentLibrary, { writeDaily: true, timeZone: 'UTC' }), /来源行动已变化/);
    const updated = await updateToday(directory, 'plan', payload, currentLibrary, { writeDaily: true, timeZone: 'UTC', sourceActions: proposals });
    assert.match(updated.plans[0].text, /试做原型 \[\[projects\/demo\]\]/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
