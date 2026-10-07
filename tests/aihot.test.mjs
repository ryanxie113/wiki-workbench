import test from 'node:test';
import assert from 'node:assert/strict';
import { createAihotClient, validDailyDate } from '../lib/aihot.mjs';

const daily = {
  schemaVersion: 1,
  report: {
    date: '2026-10-04', generatedAt: '2026-10-04T00:01:00Z',
    lead: { title: '今日看点', leadParagraph: '导语' },
    sections: [{ label: '模型发布', items: [{
      title: '一条新闻', summary: '摘要', source: { name: '原始媒体' },
      links: { aihot: 'https://aihot.news/items/example', original: 'https://example.com/article' },
      attribution: { name: 'AIHOT', url: 'https://aihot.news/items/example' }
    }] }],
    flashes: [], links: { aihot: 'https://aihot.news/daily/2026-10-04' },
    attribution: { name: 'AIHOT', url: 'https://aihot.news/daily/2026-10-04' }
  }
};

test('AIHOT 日报按官方结构读取，缓存并使用 ETag 重新验证', async () => {
  let clock = Date.parse('2026-10-04T01:00:00Z');
  const calls = [];
  const client = createAihotClient({ now: () => clock, fetchImpl: async (url, options) => {
    calls.push({ url, options });
    if (calls.length === 1) return new Response(JSON.stringify(daily), {
      headers: { 'content-type': 'application/json', etag: '"daily-1"', 'cache-control': 'max-age=60' }
    });
    return new Response(null, { status: 304, headers: { 'cache-control': 'max-age=60' } });
  } });
  const first = await client.getDaily();
  assert.equal(first.data.date, '2026-10-04');
  assert.equal(first.data.sections[0].items[0].links.original, 'https://example.com/article');
  assert.equal(first.data.attribution.name, 'AIHOT');
  await client.getDaily();
  assert.equal(calls.length, 1, '当天自动读取应复用日报');
  clock += 6 * 60_000;
  const checked = await client.getDaily(null, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].options.headers['If-None-Match'], '"daily-1"');
  assert.equal(checked.data, first.data);
  assert.equal(checked.stale, false);
});

test('历史日期被严格校验；上游故障时保留上次成功内容', async () => {
  assert.equal(validDailyDate('2026-02-30'), false);
  assert.equal(validDailyDate('2026-10-04'), true);
  let clock = Date.parse('2026-10-04T01:00:00Z');
  let fail = false;
  const client = createAihotClient({ now: () => clock, fetchImpl: async url => {
    assert.equal(url, 'https://aihot.news/api/v1/dailies/latest');
    if (fail) throw new Error('network error');
    return new Response(JSON.stringify(daily), { headers: { 'content-type': 'application/json' } });
  } });
  assert.throws(() => client.getDaily('2026-02-30'), /YYYY-MM-DD/);
  await client.getDaily();
  fail = true;
  clock += 25 * 60 * 60_000;
  const fallback = await client.getDaily();
  assert.equal(fallback.stale, true);
  assert.equal(fallback.data.date, '2026-10-04');
  assert.equal((await client.getDaily()).stale, true, '故障期间缓存仍应标记为过期');
});

test('AIHOT 限流时遵守 Retry-After，不立即重试', async () => {
  let clock = Date.parse('2026-10-04T01:00:00Z');
  let calls = 0;
  const client = createAihotClient({ now: () => clock, fetchImpl: async () => {
    calls++;
    return new Response(null, { status: 429, headers: { 'retry-after': '1200' } });
  } });
  await assert.rejects(client.getDaily(), /过于频繁/);
  clock += 10 * 60_000;
  await assert.rejects(client.getDaily(), /过于频繁/);
  assert.equal(calls, 1);
});

test('日报索引保留来源且只允许 HTTP 链接', async () => {
  const client = createAihotClient({ fetchImpl: async () => new Response(JSON.stringify({
    schemaVersion: 1,
    items: [{ date: '2026-10-04', leadTitle: '<img onerror=alert(1)>', links: { aihot: 'javascript:alert(1)' }, attribution: { name: 'AIHOT', url: 'https://aihot.news/daily/2026-10-04' } }]
  }), { headers: { 'content-type': 'application/json' } }) });
  const result = await client.getIndex();
  assert.equal(result.data.items[0].title, '<img onerror=alert(1)>');
  assert.equal(result.data.items[0].links.aihot, null);
  assert.equal(result.data.items[0].attribution.url, 'https://aihot.news/daily/2026-10-04');
});
