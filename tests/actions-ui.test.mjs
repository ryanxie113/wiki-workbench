import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const waitFor = async predicate => {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('UI did not settle');
};

test('周报事项可选项目采纳，结果在行动页和项目页回看', async () => {
  const html = await readFile(path.join(appDir, 'public/index.html'), 'utf8');
  const script = await readFile(path.join(appDir, 'public/app.js'), 'utf8');
  const dom = new JSDOM(html, { url: 'http://127.0.0.1:4173/#/actions', runScripts: 'outside-only' });
  const { window } = dom;
  window.scrollTo = () => {};
  window.confirm = () => true;
  window.prompt = () => '已验收';
  const project = { path: 'projects/demo.md', id: 'demo', title: 'Demo project', digest: {
    goal: '', progress: [], progressDate: '', action: [], actionDate: ''
  } };
  const candidate = { id: 'weekly-1', projectPath: null, projectTitle: '周报计划 · 未关联项目',
    actionIndex: 0, text: 'Review benchmark', evidence: { sourcePath: 'insights/weekly-summary.md', line: 9, date: '2026-10-03', kind: 'weekly', heading: '下周计划' },
    needsReview: false, ambiguous: false, adoption: null, status: 'pending' };
  const outcomes = [];
  let planPayload;
  let outcomePayload;
  window.fetch = async (input, options) => {
    const url = String(input);
    let data;
    if (url === '/api/bootstrap') data = {
      today: { date: '2026-10-04', path: 'daily/2026-10-04.md', exists: true, plans: [], records: [] },
      projects: [project], recent: [], pageCounts: {}, actions: [{ ...candidate }], actionOutcomes: [...outcomes], unindexed: [],
      vault: { id: 'demo', demo: false, path: '/notes', pageCount: 2 },
      dailyWritable: true, dailyDir: 'daily', dailyFormat: { priorityLabels: ['P1', 'P2', 'P3'] },
      indexPath: null, overviewPath: null
    };
    else if (url === '/api/daily') {
      planPayload = JSON.parse(options.body);
      candidate.adoption = { path: 'daily/2026-10-04.md', date: '2026-10-04', priority: 1, done: false, projectPath: project.path };
      candidate.status = 'planned';
      data = { today: { date: '2026-10-04', path: 'daily/2026-10-04.md', exists: true, plans: [], records: [] } };
    } else if (url === '/api/actions/outcome') {
      const payload = JSON.parse(options.body);
      outcomePayload = payload;
      const event = { id: candidate.id, status: payload.status, note: payload.note, at: '2026-10-04T08:00:00Z', adoption: candidate.adoption };
      outcomes.push(event);
      if (payload.syncDaily) {
        candidate.adoption = { ...candidate.adoption, done: true };
        candidate.status = 'completed';
      }
      data = { event, synced: Boolean(payload.syncDaily) };
    } else throw new Error(`Unexpected request: ${url}`);
    return { ok: true, json: async () => data };
  };
  try {
    window.eval(script);
    await waitFor(() => window.document.querySelector('.action-project'));
    const row = window.document.querySelector('.candidate-row');
    row.querySelector('.action-project').value = project.path;
    row.querySelector('[data-action="plan"]').click();
    await waitFor(() => candidate.status === 'planned');
    assert.equal(planPayload.sourceKind, 'weekly');
    assert.equal(planPayload.sourceLine, 9);
    assert.equal(planPayload.projectPath, project.path);
    window.location.hash = '#/actions?filter=planned';
    window.dispatchEvent(new window.HashChangeEvent('hashchange'));
    await waitFor(() => window.document.querySelector('[data-status="completed"]'));
    window.document.querySelector('[data-status="completed"]').click();
    await waitFor(() => outcomes.length === 1);
    assert.equal(outcomePayload.syncDaily, true);
    window.location.hash = '#/project/projects%2Fdemo.md';
    window.dispatchEvent(new window.HashChangeEvent('hashchange'));
    await waitFor(() => window.document.querySelector('.project-candidate-list')?.textContent.includes('已完成'));
    assert.match(window.document.querySelector('.project-candidate-list').textContent, /已完成/);
    assert.match(window.document.querySelector('.project-candidate-list').textContent, /已验收/);
    assert.equal(window.document.querySelector('.project-candidate-list .action-conflict'), null);
    assert.match(window.document.querySelector('.project-candidate-list').textContent, /insights\/weekly-summary\.md:9/);
  } finally { window.close(); }
});

test('本机完成记录与未勾选日报冲突时提示差异，并可按日报校准', async () => {
  const html = await readFile(path.join(appDir, 'public/index.html'), 'utf8');
  const script = await readFile(path.join(appDir, 'public/app.js'), 'utf8');
  const dom = new JSDOM(html, { url: 'http://127.0.0.1:4173/#/actions?filter=completed', runScripts: 'outside-only' });
  const { window } = dom;
  window.scrollTo = () => {};
  const project = { path: 'projects/demo.md', id: 'demo', title: 'Demo project', digest: { goal: '', progress: [], progressDate: '', action: [], actionDate: '' } };
  const adoption = { path: 'daily/2026-10-04.md', date: '2026-10-04', priority: 1, done: false };
  const candidate = { id: 'project-1', projectPath: project.path, projectTitle: project.title, actionIndex: 0,
    text: 'Review benchmark', evidence: { sourcePath: project.path, line: 9, date: '2026-10-03', kind: 'project', heading: '下一步' },
    needsReview: false, ambiguous: false, adoption, status: 'planned' };
  const outcomes = [{ id: candidate.id, status: 'completed', note: '本机记录', at: '2026-10-04T08:00:00Z', adoption }];
  let resolvePayload;
  window.fetch = async (input, options) => {
    const url = String(input);
    let data;
    if (url === '/api/bootstrap') data = {
      today: { date: '2026-10-04', path: adoption.path, exists: true, plans: [], records: [] },
      projects: [project], recent: [], pageCounts: {}, actions: [candidate], actionOutcomes: [...outcomes], unindexed: [],
      vault: { id: 'demo', demo: false, path: '/notes', pageCount: 2 }, dailyWritable: true, dailyDir: 'daily',
      dailyFormat: { priorityLabels: ['P1', 'P2', 'P3'] }, indexPath: null, overviewPath: null
    };
    else if (url === '/api/actions/outcome') {
      resolvePayload = JSON.parse(options.body);
      const event = { id: candidate.id, status: resolvePayload.status, note: resolvePayload.note, at: '2026-10-04T09:00:00Z', adoption };
      outcomes.push(event);
      data = { event, synced: false };
    } else throw new Error(`Unexpected request: ${url}`);
    return { ok: true, json: async () => data };
  };
  try {
    window.eval(script);
    await waitFor(() => window.document.querySelector('.action-conflict'));
    assert.match(window.document.querySelector('.action-conflict').textContent, /日报计划未勾选/);
    assert.ok(window.document.querySelector('[data-sync-daily="1"]'));
    adoption.date = '2026-10-03';
    window.dispatchEvent(new window.HashChangeEvent('hashchange'));
    assert.equal(window.document.querySelector('.action-conflict'), null, '旧日报未勾选、后来完成不算冲突');
    adoption.date = '2026-10-04';
    window.dispatchEvent(new window.HashChangeEvent('hashchange'));
    assert.ok(window.document.querySelector('.action-conflict'));
    window.document.querySelector('[data-action="resolve-outcome"]').click();
    await waitFor(() => outcomes.length === 2);
    assert.equal(resolvePayload.status, 'planned');
    window.location.hash = '#/actions?filter=planned';
    window.dispatchEvent(new window.HashChangeEvent('hashchange'));
    await waitFor(() => window.document.querySelector('.candidate-row'));
    assert.equal(window.document.querySelector('.action-conflict'), null);
  } finally { window.close(); }
});
