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

test('AIHOT 日报在工作台中可获取、订阅、切换往期，并安全显示外部内容', async () => {
  const html = await readFile(path.join(appDir, 'public/index.html'), 'utf8');
  const script = await readFile(path.join(appDir, 'public/app.js'), 'utf8');
  const dom = new JSDOM(html, { url: 'http://127.0.0.1:4173/#/aihot', runScripts: 'outside-only' });
  const { window } = dom;
  window.scrollTo = () => {};
  const calls = [];
  const report = (date, title) => ({
    date, lead: { title, paragraph: '今日导语' },
    sections: [{ label: '模型发布', items: [{
      title: '<img src=x onerror=alert(1)>', summary: '测试摘要', source: '原始媒体',
      links: { aihot: 'https://aihot.news/items/example', original: 'https://example.com/article' }
    }] }],
    flashes: [], links: { aihot: `https://aihot.news/daily/${date}` },
    attribution: { name: 'AIHOT', url: `https://aihot.news/daily/${date}` }
  });
  window.fetch = async input => {
    const url = String(input);
    calls.push(url);
    let data;
    if (url === '/api/bootstrap') data = {
      today: { date: '2026-10-04', exists: false, plans: [], records: [] },
      projects: [], recent: [], pageCounts: {}, actions: [], unindexed: [],
      vault: { id: 'demo', demo: true, path: '/demo', pageCount: 0 },
      dailyWritable: false, dailyDir: 'daily', dailyFormat: { priorityLabels: [] },
      indexPath: null, overviewPath: null
    };
    else if (url.startsWith('/api/aihot/dailies')) data = { items: [
      { date: '2026-10-04', title: '今日看点' }, { date: '2026-10-03', title: '往期看点' }
    ] };
    else if (url.startsWith('/api/aihot/daily')) {
      const date = new URL(url, window.location.href).searchParams.get('date') || '2026-10-04';
      data = { report: report(date, date === '2026-10-04' ? '今日看点' : '往期看点'), stale: false };
    } else throw new Error(`Unexpected request: ${url}`);
    return { ok: true, json: async () => data };
  };
  try {
    window.eval(script);
    await waitFor(() => window.document.querySelector('.aihot-lead h2')?.textContent === '今日看点');
    assert.match(window.document.querySelector('#main').textContent, /测试摘要/);
    assert.equal(window.document.querySelector('#main img'), null, '上游标题应按文本显示');
    assert.equal(window.document.querySelectorAll('.aihot-item-meta a').length, 2);
    window.document.querySelector('[data-action="aihot-subscribe"]').click();
    assert.equal(window.localStorage.getItem('wiki-workbench-aihot-subscription'), '1');
    assert.equal(window.document.querySelector('[data-action="aihot-subscribe"]').getAttribute('aria-pressed'), 'true');
    await waitFor(() => calls.some(url => url.includes('/api/aihot/daily?refresh=1')));
    const select = window.document.querySelector('#aihot-date');
    select.value = '2026-10-03';
    select.dispatchEvent(new window.Event('change', { bubbles: true }));
    await waitFor(() => window.document.querySelector('.aihot-lead h2')?.textContent === '往期看点');
    assert.ok(calls.some(url => url.includes('date=2026-10-03')));
  } finally { window.close(); }
});
