const API_ROOT = 'https://aihot.news/api/v1';
const MAX_RESPONSE_BYTES = 1_000_000;
const RETRY_DELAY = 5 * 60_000;
const MAX_CACHE_AGE = 24 * 60 * 60_000;

export function validDailyDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}

function cacheAge(headers, fallback) {
  const match = /(?:^|,)\s*max-age=(\d+)/i.exec(headers.get('cache-control') || '');
  return match ? Math.min(Number(match[1]) * 1000, MAX_CACHE_AGE) : fallback;
}

function retryAfterMs(value, timestamp) {
  if (!value) return 0;
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  const until = Date.parse(value);
  return Number.isFinite(until) ? Math.max(0, until - timestamp) : 0;
}

function checkedLink(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
  } catch { return null; }
}

function requiredText(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('AIHOT 返回的数据格式不正确');
  return value;
}

function optionalText(value) { return typeof value === 'string' ? value : ''; }

function normalizeItem(item) {
  if (!item || typeof item !== 'object') throw new Error('AIHOT 返回的数据格式不正确');
  return {
    title: requiredText(item.title),
    summary: optionalText(item.summary),
    source: optionalText(item.source?.name),
    links: { aihot: checkedLink(item.links?.aihot), original: checkedLink(item.links?.original) },
    attribution: { name: optionalText(item.attribution?.name), url: checkedLink(item.attribution?.url) }
  };
}

function normalizeDaily(input) {
  const report = input?.report;
  if (input?.schemaVersion !== 1 || !validDailyDate(report?.date) || !Array.isArray(report.sections)) {
    throw new Error('AIHOT 返回的数据格式不正确');
  }
  return {
    date: report.date,
    generatedAt: optionalText(report.generatedAt),
    lead: { title: optionalText(report.lead?.title), paragraph: optionalText(report.lead?.leadParagraph) },
    sections: report.sections.map(section => ({
      label: requiredText(section?.label),
      items: Array.isArray(section.items) ? section.items.map(normalizeItem) : []
    })),
    flashes: Array.isArray(report.flashes) ? report.flashes.map(normalizeItem) : [],
    links: { aihot: checkedLink(report.links?.aihot) },
    attribution: { name: optionalText(report.attribution?.name), url: checkedLink(report.attribution?.url) }
  };
}

function normalizeIndex(input) {
  if (input?.schemaVersion !== 1 || !Array.isArray(input.items)) throw new Error('AIHOT 返回的数据格式不正确');
  return {
    items: input.items.filter(item => validDailyDate(item?.date)).map(item => ({
      date: item.date,
      title: optionalText(item.leadTitle),
      paragraph: optionalText(item.leadParagraph),
      links: { aihot: checkedLink(item.links?.aihot) },
      attribution: { name: optionalText(item.attribution?.name), url: checkedLink(item.attribution?.url) }
    }))
  };
}

async function readLimitedJson(response) {
  if (!(response.headers.get('content-type') || '').includes('application/json')) throw new Error('AIHOT 返回了非 JSON 内容');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('AIHOT 响应为空');
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new Error('AIHOT 响应过大');
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(new TextDecoder().decode(Buffer.concat(chunks))); }
  catch { throw new Error('AIHOT 返回的 JSON 无法解析'); }
}

export function createAihotClient({ fetchImpl = fetch, now = Date.now } = {}) {
  const cache = new Map();

  async function get(path, kind, force = false) {
    let entry = cache.get(path);
    const timestamp = now();
    if (entry?.pending) return entry.pending;
    if (entry && !entry.data && timestamp < entry.expiresAt) throw new Error(entry.lastError || 'AIHOT 暂时无法连接，请稍后重试');
    if (entry?.data && ((!force && timestamp < entry.expiresAt) || (force && timestamp - entry.attemptedAt < RETRY_DELAY))) {
      return { data: entry.data, stale: Boolean(entry.stale), fetchedAt: entry.fetchedAt };
    }
    entry ||= { data: null, etag: '', expiresAt: 0, attemptedAt: 0, fetchedAt: '', failures: 0, stale: false };
    cache.set(path, entry);
    entry.attemptedAt = timestamp;
    entry.pending = (async () => {
      let retryAfter = 0;
      try {
        const headers = { Accept: 'application/json' };
        if (entry.etag) headers['If-None-Match'] = entry.etag;
        const response = await fetchImpl(`${API_ROOT}${path}`, {
          headers, signal: AbortSignal.timeout(10_000), redirect: 'error'
        });
        if (response.status === 304 && entry.data) {
          entry.failures = 0;
          entry.stale = false;
          entry.lastError = '';
          entry.expiresAt = now() + cacheAge(response.headers, 60 * 60_000);
          return { data: entry.data, stale: false, fetchedAt: entry.fetchedAt };
        }
        if (!response.ok) {
          if (response.status === 429) retryAfter = retryAfterMs(response.headers.get('retry-after'), now());
          throw new Error(response.status === 429 ? 'AIHOT 请求过于频繁，请稍后重试' : `AIHOT 暂时无法获取日报（${response.status}）`);
        }
        const raw = await readLimitedJson(response);
        const data = kind === 'index' ? normalizeIndex(raw) : normalizeDaily(raw);
        entry.data = data;
        entry.etag = response.headers.get('etag') || '';
        entry.fetchedAt = new Date(now()).toISOString();
        entry.failures = 0;
        entry.stale = false;
        entry.lastError = '';
        entry.expiresAt = now() + cacheAge(response.headers, 60 * 60_000);
        return { data, stale: false, fetchedAt: entry.fetchedAt };
      } catch (error) {
        entry.failures++;
        entry.stale = true;
        entry.expiresAt = now() + Math.max(retryAfter, Math.min(RETRY_DELAY * (2 ** (entry.failures - 1)), 60 * 60_000));
        entry.lastError = error.message?.startsWith('AIHOT') ? error.message : 'AIHOT 暂时无法连接，请稍后重试';
        if (entry.data) return { data: entry.data, stale: true, fetchedAt: entry.fetchedAt };
        if (error.name === 'TimeoutError' || error.name === 'AbortError') throw new Error('AIHOT 连接超时，请稍后重试');
        throw new Error(entry.lastError);
      } finally { entry.pending = null; }
    })();
    return entry.pending;
  }

  return {
    getDaily(date = null, force = false) {
      if (date !== null && !validDailyDate(date)) throw new RangeError('日报日期必须是 YYYY-MM-DD');
      return get(date ? `/dailies/${date}` : '/dailies/latest', date ? 'dated' : 'latest', force);
    },
    getIndex(force = false) { return get('/dailies', 'index', force); }
  };
}
