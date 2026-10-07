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

test('来源收件箱汇集 AIHOT、RSS 和手动链接，审阅后在项目页保留入口', async () => {
  const html = await readFile(path.join(appDir, 'public/index.html'), 'utf8');
  const script = await readFile(path.join(appDir, 'public/app.js'), 'utf8');
  const dom = new JSDOM(html, { url: 'http://127.0.0.1:4173/#/inbox', runScripts: 'outside-only' });
  const { window } = dom;
  window.scrollTo = () => {};
  const project = { path: 'projects/demo.md', id: 'demo', title: 'Demo project', digest: { goal: '', progress: [], progressDate: '', action: [], actionDate: '' } };
  window.fetch = async (input, options) => {
    const url = String(input);
    let data;
    if (url === '/api/bootstrap') data = {
      today: { date: '2026-10-04', exists: false, plans: [], records: [] },
      projects: [project], recent: [], pageCounts: {}, actions: [], unindexed: [],
      vault: { id: 'demo', demo: false, path: '/notes', pageCount: 1 },
      dailyWritable: false, dailyDir: 'daily', dailyFormat: { priorityLabels: [] },
      indexPath: null, overviewPath: null
    };
    else if (url === '/api/feeds/read') {
      assert.equal(options.method, 'POST');
      data = { title: 'Engineering feed', items: [{ url: 'https://example.com/story', title: '<img src=x onerror=alert(1)>', summary: 'RSS summary', sourceName: 'Engineering feed', kind: 'rss', publishedAt: '2026-10-04T08:00:00Z' }] };
    } else if (url.startsWith('/api/aihot/daily')) data = {
      report: { date: '2026-10-04', sections: [{ items: [{ title: 'AIHOT story', summary: 'AI summary', source: 'AIHOT', links: { original: 'https://example.com/story' } }] }], flashes: [], links: { aihot: 'https://aihot.news/daily/2026-10-04' } }
    };
    else throw new Error(`Unexpected request: ${url}`);
    return { ok: true, json: async () => data };
  };
  try {
    window.eval(script);
    await waitFor(() => window.document.querySelector('#inbox-feed-form'));
    const feedForm = window.document.querySelector('#inbox-feed-form');
    feedForm.querySelector('input').value = 'https://example.com/feed.xml';
    feedForm.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await waitFor(() => window.document.querySelectorAll('.inbox-card').length === 1);
    assert.equal(window.document.querySelector('.inbox-card img'), null, 'RSS 标题按文本显示');
    window.document.querySelector('[data-action="inbox-aihot"]').click();
    await waitFor(() => window.document.querySelector('[data-action="inbox-aihot"]')?.getAttribute('aria-pressed') === 'true');
    await waitFor(() => window.document.querySelectorAll('.inbox-card').length === 1);
    const card = window.document.querySelector('.inbox-card');
    card.querySelector('input[list]').value = project.path;
    card.querySelector('[data-action="inbox-link"]').click();
    await waitFor(() => window.document.querySelectorAll('.inbox-card').length === 0);
    assert.equal(window.document.querySelectorAll('.inbox-card').length, 0, '已关联条目离开待审阅列表');
    assert.match(window.localStorage.getItem('wiki-workbench-inbox:demo'), /projects\/demo\.md/);

    const manual = window.document.querySelector('#inbox-manual-form');
    manual.querySelector('[name="title"]').value = 'Manual note';
    manual.querySelector('[name="url"]').value = 'https://example.com/manual';
    manual.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    assert.equal(window.document.querySelectorAll('.inbox-card').length, 1);
    window.location.hash = '#/project/projects%2Fdemo.md';
    window.dispatchEvent(new window.HashChangeEvent('hashchange'));
    assert.match(window.document.querySelector('#main').textContent, /已关联的外部线索/);
    assert.match(window.document.querySelector('#main').textContent, /Engineering feed/);
  } finally { window.close(); }
});

test('OPML 导入去重并限制来源数量', async () => {
  const html = await readFile(path.join(appDir, 'public/index.html'), 'utf8');
  const script = await readFile(path.join(appDir, 'public/app.js'), 'utf8');
  const dom = new JSDOM(html, { url: 'http://127.0.0.1:4173/#/inbox', runScripts: 'outside-only' });
  const { window } = dom;
  window.scrollTo = () => {};
  window.fetch = async input => ({ ok: true, json: async () => String(input) === '/api/bootstrap'
    ? { today: { date: '2026-10-04', plans: [], records: [] }, projects: [], recent: [], pageCounts: {}, actions: [], unindexed: [], vault: { id: 'demo', demo: true, path: '/demo', pageCount: 0 }, dailyWritable: false, dailyDir: 'daily', dailyFormat: { priorityLabels: [] }, indexPath: null, overviewPath: null }
    : { title: 'Feed', items: [] } });
  try {
    window.eval(script);
    await waitFor(() => window.document.querySelector('#inbox-opml'));
    const input = window.document.querySelector('#inbox-opml');
    Object.defineProperty(input, 'files', { configurable: true, value: [{ size: 200, text: async () => '<opml version="2.0"><body><outline text="A" xmlUrl="https://example.com/a.xml"/><outline text="Duplicate" xmlUrl="https://example.com/a.xml"/><outline text="B" xmlUrl="https://example.com/b.xml"/></body></opml>' }] });
    input.dispatchEvent(new window.Event('change', { bubbles: true }));
    await waitFor(() => window.document.querySelectorAll('[data-action="inbox-remove-feed"]').length === 2);
    const saved = JSON.parse(window.localStorage.getItem('wiki-workbench-inbox:demo'));
    assert.deepEqual(saved.feeds, ['https://example.com/a.xml', 'https://example.com/b.xml']);
  } finally { window.close(); }
});

test('旧浏览器订阅迁入资料库状态后可在另一个浏览器读取', async () => {
  const html = await readFile(path.join(appDir, 'public/index.html'), 'utf8');
  const script = await readFile(path.join(appDir, 'public/app.js'), 'utf8');
  let persisted = null;
  const bootstrap = () => ({
    today: { date: '2026-10-05', plans: [], records: [] }, projects: [], recent: [], pageCounts: {}, actions: [], unindexed: [],
    vault: { id: 'demo', demo: true, path: '/demo', pageCount: 0 }, dailyWritable: false, dailyDir: 'daily',
    dailyFormat: { priorityLabels: [] }, indexPath: null, overviewPath: null, workspaceState: persisted
  });
  const mount = legacy => {
    const dom = new JSDOM(html, { url: 'http://127.0.0.1:4173/#/vault', runScripts: 'outside-only' });
    const { window } = dom;
    window.scrollTo = () => {};
    if (legacy) window.localStorage.setItem('wiki-workbench-inbox:demo', JSON.stringify({ feeds: ['https://example.com/feed.xml'], manual: [], decisions: {} }));
    window.fetch = async (input, options) => {
      if (String(input) === '/api/bootstrap') return { ok: true, json: async () => bootstrap() };
      if (String(input) === '/api/workspace-state') {
        const body = JSON.parse(options.body);
        assert.equal(body.import, true);
        persisted = { version: 1, vaultId: 'demo', data: body.data };
        return { ok: true, json: async () => ({ workspaceState: persisted }) };
      }
      throw new Error(`Unexpected request: ${input}`);
    };
    window.eval(script);
    return dom;
  };
  const first = mount(true);
  try { await waitFor(() => persisted?.data.inbox.feeds.includes('https://example.com/feed.xml')); }
  finally { first.window.close(); }
  const second = mount(false);
  try {
    await waitFor(() => second.window.document.querySelector('#workspace-import'));
    second.window.location.hash = '#/inbox';
    second.window.dispatchEvent(new second.window.HashChangeEvent('hashchange'));
    await waitFor(() => second.window.document.querySelector('[data-action="inbox-remove-feed"]'));
    assert.match(second.window.document.querySelector('#main').textContent, /example.com\/feed.xml/);
  } finally { second.window.close(); }
});
