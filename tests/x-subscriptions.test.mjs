import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { normalizeXHandle, xEmbedHtml, xEmbedSecurityHeaders } from '../lib/x-embed.mjs';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const waitFor = async predicate => {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('UI did not settle');
};

test('X 嵌入只接受账号或主页 URL，并把第三方脚本隔离在专用页面', () => {
  assert.equal(normalizeXHandle(' @SimonW '), 'simonw');
  assert.equal(normalizeXHandle('https://x.com/karpathy/'), 'karpathy');
  assert.equal(normalizeXHandle('https://twitter.com/mitchellh'), 'mitchellh');
  assert.equal(normalizeXHandle('https://x.com/a/status/123'), '');
  assert.equal(normalizeXHandle('evil.example/a'), '');
  assert.equal(normalizeXHandle('x" onload="alert(1)'), '');
  assert.match(xEmbedHtml('simonw'), /href="https:\/\/x\.com\/simonw"/);
  assert.match(xEmbedHtml('simonw'), /platform\.x\.com\/widgets\.js/);
  assert.ok(xEmbedSecurityHeaders['Content-Security-Policy'].includes("frame-ancestors 'self'"));
  assert.match(xEmbedSecurityHeaders['Content-Security-Policy'], /script-src 'sha256-[^']+'/);
  assert.throws(() => xEmbedHtml('<script>'));
});

test('工作台可管理 X 作者清单，并在用户点击后才加载官方时间线', async () => {
  const html = await readFile(path.join(appDir, 'public/index.html'), 'utf8');
  const script = await readFile(path.join(appDir, 'public/app.js'), 'utf8');
  const dom = new JSDOM(html, { url: 'http://127.0.0.1:4173/#/x', runScripts: 'outside-only' });
  const { window } = dom;
  window.scrollTo = () => {};
  window.fetch = async input => {
    assert.equal(String(input), '/api/bootstrap');
    return { ok: true, json: async () => ({
      today: { date: '2026-10-04', exists: false, plans: [], records: [] },
      projects: [], recent: [], pageCounts: {}, actions: [], unindexed: [],
      vault: { id: 'demo', demo: true, path: '/demo', pageCount: 0 },
      dailyWritable: false, dailyDir: 'daily', dailyFormat: { priorityLabels: [] },
      indexPath: null, overviewPath: null
    }) };
  };
  try {
    window.eval(script);
    await waitFor(() => window.document.querySelector('.x-profile'));
    assert.equal(window.document.querySelectorAll('.x-profile').length, 6);
    assert.equal(window.document.querySelector('.x-timeline'), null, '第三方内容必须按需加载');
    const directLink = window.document.querySelector('.x-direct-button');
    assert.equal(directLink.textContent.trim(), '在 X 阅读动态 ↗');
    assert.equal(directLink.href, 'https://x.com/simonw');
    assert.equal(directLink.target, '_blank');
    assert.match(window.document.querySelector('.x-embed-placeholder').textContent, /预览依赖 X 的嵌入服务/);
    window.document.querySelector('[data-action="x-load"]').click();
    assert.match(window.document.querySelector('.x-timeline').getAttribute('src'), /^\/x-embed\?handle=simonw$/);
    assert.ok(!window.document.querySelector('.x-timeline').getAttribute('sandbox').includes('allow-same-origin'));
    const frame = window.document.querySelector('.x-timeline');
    window.dispatchEvent(new window.MessageEvent('message', { source: frame.contentWindow, data: { type: 'wiki-workbench-x-embed', status: 'unavailable' } }));
    assert.equal(window.document.querySelector('.x-timeline'), null);
    assert.match(window.document.querySelector('.x-embed-placeholder').textContent, /嵌入时间线暂时不可用/);
    assert.equal(window.document.querySelector('.x-direct-button').href, 'https://x.com/simonw');
    window.document.querySelector('[data-action="x-toggle"][data-handle="simonw"]').click();
    assert.equal(JSON.parse(window.localStorage.getItem('wiki-workbench-x-subscriptions')).handles.includes('simonw'), false);
    const form = window.document.querySelector('#x-add-form');
    form.querySelector('input').value = 'https://x.com/Test_dev';
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    assert.ok(window.document.querySelector('[data-action="x-select"][data-handle="test_dev"]'));
    assert.equal(window.document.querySelector('.x-timeline'), null, '切换作者后不能自动连接 X');
    assert.ok(JSON.parse(window.localStorage.getItem('wiki-workbench-x-subscriptions')).custom.includes('test_dev'));
    window.document.querySelector('[data-action="x-remove"][data-handle="test_dev"]').click();
    assert.equal(window.document.querySelector('[data-action="x-select"][data-handle="test_dev"]'), null);
  } finally { window.close(); }
});
