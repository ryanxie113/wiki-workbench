import test from 'node:test';
import assert from 'node:assert/strict';
import { createFeedClient, isPublicAddress, parseFeedXml, publicFeedUrl } from '../lib/feeds.mjs';

test('RSS 与 Atom 提取可核对的标题、原文链接和发布时间', () => {
  const rss = parseFeedXml(`<?xml version="1.0"?><rss version="2.0"><channel><title>Engineering &amp; Research</title><item><title>First &amp; best</title><link>https://example.com/posts/one</link><description><![CDATA[<p>Read <strong>this</strong></p>]]></description><pubDate>Sun, 04 Oct 2026 10:00:00 GMT</pubDate></item></channel></rss>`, 'https://example.com/feed.xml');
  assert.equal(rss.title, 'Engineering & Research');
  assert.equal(rss.items[0].title, 'First & best');
  assert.equal(rss.items[0].url, 'https://example.com/posts/one');
  assert.equal(rss.items[0].publishedAt, '2026-10-04T10:00:00.000Z');
  assert.equal(rss.items[0].summary, 'Read this');

  const atom = parseFeedXml(`<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Notes</title><entry><title>Second</title><link rel="self" href="https://example.com/atom/2"/><link rel="alternate" href="https://example.com/posts/two"/><updated>2026-10-03T09:30:00Z</updated><summary>Useful note</summary></entry></feed>`, 'https://example.com/atom.xml');
  assert.equal(atom.items[0].url, 'https://example.com/posts/two');
  assert.equal(atom.items[0].publishedAt, '2026-10-03T09:30:00.000Z');
  assert.equal(atom.items[0].summary, 'Useful note');
});

test('订阅源地址和 DNS 结果拒绝本机、内网及非网页协议', () => {
  assert.throws(() => publicFeedUrl('http://127.0.0.1/feed'), /公开网站/);
  assert.throws(() => publicFeedUrl('https://localhost/feed'), /公开网站/);
  assert.throws(() => publicFeedUrl('file:///etc/passwd'), /公开网站/);
  assert.equal(isPublicAddress('10.0.0.1'), false);
  assert.equal(isPublicAddress('172.16.0.1'), false);
  assert.equal(isPublicAddress('192.168.1.1'), false);
  assert.equal(isPublicAddress('100.64.0.1'), false);
  assert.equal(isPublicAddress('::1'), false);
  assert.equal(isPublicAddress('8.8.8.8'), true);
  assert.throws(() => parseFeedXml('<!DOCTYPE rss [<!ENTITY x SYSTEM "file:///etc/passwd">]><rss/>', 'https://example.com/feed'), /XML 格式/);
});

test('获取失败时保留本次服务中已成功读取的来源', async () => {
  let fail = false;
  let time = Date.parse('2026-10-04T00:00:00Z');
  const client = createFeedClient({
    retrieve: async () => {
      if (fail) throw new Error('网络暂时不可用');
      return '<rss><channel><title>Notes</title><item><title>One</title><link>https://example.com/one</link></item></channel></rss>';
    }, now: () => time
  });
  const first = await client.get('https://example.com/feed');
  assert.equal(first.items.length, 1);
  fail = true;
  time += 16 * 60_000;
  const stale = await client.get('https://example.com/feed');
  assert.equal(stale.stale, true);
  assert.equal(stale.error, '网络暂时不可用');
  assert.equal(stale.items[0].url, first.items[0].url);
  const stillStale = await client.get('https://example.com/feed');
  assert.equal(stillStale.stale, true);
});
