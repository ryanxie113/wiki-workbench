import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { XMLParser, XMLValidator } from 'fast-xml-parser';

const MAX_FEED_BYTES = 1_000_000;
const CACHE_MS = 15 * 60_000;
const parser = new XMLParser({ ignoreAttributes: false, parseTagValue: false, trimValues: true, processEntities: true });
const asArray = value => value == null ? [] : Array.isArray(value) ? value : [value];
const valueText = value => typeof value === 'string' ? value : typeof value === 'number' ? String(value) : typeof value?.['#text'] === 'string' ? value['#text'] : '';
const cleanText = value => valueText(value).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

export function publicFeedUrl(input) {
  if (typeof input !== 'string' || input.length > 2048) throw new Error('请输入有效的 RSS/Atom 地址');
  let url;
  try { url = new URL(input.trim()); }
  catch { throw new Error('请输入有效的 RSS/Atom 地址'); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || isIP(url.hostname) ||
    url.hostname.toLowerCase() === 'localhost' || url.hostname.toLowerCase().endsWith('.localhost') || url.hostname.toLowerCase().endsWith('.local')) {
    throw new Error('RSS/Atom 地址必须指向公开网站');
  }
  url.hash = '';
  return url.href;
}

export function isPublicAddress(address) {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && (b === 168 || b === 0 || b === 88 && c === 99 || b === 0 && c === 2)) return false;
    if (a === 198 && (b === 18 || b === 19 || b === 51 && c === 100)) return false;
    if (a === 203 && b === 0 && c === 113) return false;
    return true;
  }
  if (isIP(address) === 6) return /^[23]/i.test(address) && !address.toLowerCase().startsWith('2001:db8:');
  return false;
}

async function retrievePublicFeed(input, redirects = 0) {
  const url = new URL(publicFeedUrl(input));
  if (redirects > 3) throw new Error('RSS/Atom 重定向过多');
  const addresses = await lookup(url.hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(item => !isPublicAddress(item.address))) throw new Error('RSS/Atom 地址解析到非公开网络');
  const selected = addresses[0];
  return new Promise((resolve, reject) => {
    const agent = url.protocol === 'https:' ? https : http;
    const request = agent.get(url, {
      headers: { Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.5', 'User-Agent': 'WikiWorkbench/0.1 (+local RSS reader)' },
      lookup: (_hostname, options, callback) => options.all
        ? callback(null, [selected]) : callback(null, selected.address, selected.family),
      timeout: 10_000
    }, response => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
        response.resume();
        resolve(retrievePublicFeed(new URL(response.headers.location, url).href, redirects + 1));
        return;
      }
      if (response.statusCode < 200 || response.statusCode >= 300) {
        response.resume();
        reject(new Error(`RSS/Atom 获取失败（HTTP ${response.statusCode}）`));
        return;
      }
      const chunks = [];
      let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > MAX_FEED_BYTES) {
          request.destroy(new Error('RSS/Atom 内容超过 1 MB'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        try {
          const charset = /charset=([^;\s]+)/i.exec(response.headers['content-type'] || '')?.[1] || 'utf-8';
          resolve(new TextDecoder(charset).decode(Buffer.concat(chunks)));
        } catch { reject(new Error('RSS/Atom 编码无法读取')); }
      });
      response.on('error', reject);
    });
    request.on('timeout', () => request.destroy(new Error('RSS/Atom 连接超时')));
    request.on('error', reject);
  });
}

function articleUrl(value, base) {
  try {
    const url = new URL(valueText(value), base);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
  } catch { return ''; }
}

function atomLink(value, base) {
  const links = asArray(value);
  const chosen = links.find(link => typeof link === 'object' && (!link['@_rel'] || link['@_rel'] === 'alternate')) || links[0];
  return articleUrl(typeof chosen === 'object' ? chosen?.['@_href'] : chosen, base);
}

function dateValue(value) {
  const time = Date.parse(valueText(value));
  return Number.isFinite(time) ? new Date(time).toISOString() : '';
}

export function parseFeedXml(xml, feedUrl) {
  if (typeof xml !== 'string' || xml.length > MAX_FEED_BYTES || /<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml) || XMLValidator.validate(xml) !== true) {
    throw new Error('RSS/Atom XML 格式不正确');
  }
  const parsed = parser.parse(xml);
  const rss = parsed.rss?.channel;
  const atom = parsed.feed;
  const rdf = parsed['rdf:RDF'];
  const root = rss || atom || rdf?.channel;
  if (!root) throw new Error('此地址不是 RSS/Atom 订阅源');
  const feedTitle = cleanText(root.title) || new URL(feedUrl).hostname;
  const rawItems = asArray(rss ? root.item : atom ? root.entry : rdf.item).slice(0, 80);
  const items = rawItems.map(entry => {
    const url = atom ? atomLink(entry.link, feedUrl) : articleUrl(entry.link || entry.guid?.['#text'] || entry.guid, feedUrl);
    if (!url) return null;
    const title = cleanText(entry.title).slice(0, 300) || url;
    const summary = cleanText(atom ? entry.summary || entry.content : entry.description || entry['content:encoded']).slice(0, 550);
    const publishedAt = dateValue(atom ? entry.published || entry.updated : entry.pubDate || entry['dc:date']);
    return {
      id: createHash('sha256').update(url).digest('hex').slice(0, 20),
      title, summary, url, publishedAt, feedUrl, sourceName: feedTitle, kind: 'rss'
    };
  }).filter(Boolean);
  return { title: feedTitle, feedUrl, items };
}

export function createFeedClient({ retrieve = retrievePublicFeed, now = Date.now } = {}) {
  const cache = new Map();
  return {
    async get(url, force = false) {
      const feedUrl = publicFeedUrl(url);
      let entry = cache.get(feedUrl);
      if (entry?.pending) return entry.pending;
      if (!force && entry && now() < entry.expiresAt) {
        if (entry.data) return { ...entry.data, stale: Boolean(entry.lastError), error: entry.lastError || '', fetchedAt: entry.fetchedAt };
        throw new Error(entry.lastError || 'RSS/Atom 暂时无法连接');
      }
      entry ||= { data: null, fetchedAt: '', expiresAt: 0, pending: null, lastError: '' };
      cache.set(feedUrl, entry);
      entry.pending = (async () => {
        try {
          const data = parseFeedXml(await retrieve(feedUrl), feedUrl);
          entry.data = data;
          entry.fetchedAt = new Date(now()).toISOString();
          entry.expiresAt = now() + CACHE_MS;
          entry.lastError = '';
          return { ...data, stale: false, fetchedAt: entry.fetchedAt };
        } catch (error) {
          entry.expiresAt = now() + 60_000;
          entry.lastError = error.message;
          if (entry.data) return { ...entry.data, stale: true, error: error.message, fetchedAt: entry.fetchedAt };
          throw error;
        } finally { entry.pending = null; }
      })();
      return entry.pending;
    }
  };
}
