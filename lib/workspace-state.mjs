import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { connectionStorePath } from './connection-store.mjs';

const sections = new Set(['inbox', 'reviewChoices', 'weeklyDecisions', 'aihot', 'x']);
const queues = new Map();

export function workspaceStateFile(vaultId, base = path.dirname(connectionStorePath())) {
  if (!/^[a-f0-9]{16}$/.test(vaultId)) throw new Error('资料库标识无效');
  return path.join(base, 'workspace', `${vaultId}.json`);
}

function plain(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function text(value, limit) { return typeof value === 'string' ? value.trim().slice(0, limit) : ''; }
function webUrl(value) {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) ? url.href : ''; }
  catch { return ''; }
}

export function normalizeSection(section, value) {
  if (!sections.has(section)) throw new Error('未知的设置分区');
  if (section === 'reviewChoices') {
    if (!plain(value)) throw new Error('审阅记录格式不正确');
    return Object.fromEntries(Object.entries(value).slice(-2000).filter(([id, choice]) => /^[a-f0-9]{20}$/.test(id) && ['deferred', 'ignored'].includes(choice)));
  }
  if (section === 'weeklyDecisions') {
    if (!plain(value)) throw new Error('周回顾记录格式不正确');
    return Object.fromEntries(Object.entries(value).slice(-1000).filter(([id, entry]) => /^[a-f0-9]{20}$/.test(id) && plain(entry) && ['continue', 'reschedule', 'invalidated'].includes(entry.status))
      .map(([id, entry]) => [id, { status: entry.status, targetDate: /^\d{4}-\d{2}-\d{2}$/.test(entry.targetDate) ? entry.targetDate : '', note: text(entry.note, 400), at: text(entry.at, 40) }]));
  }
  if (section === 'aihot') return { subscribed: value?.subscribed === true };
  if (section === 'x') {
    if (!plain(value)) throw new Error('X 订阅格式不正确');
    const handle = item => /^[A-Za-z0-9_]{1,15}$/.test(item) ? item.toLowerCase() : '';
    return { handles: [...new Set((Array.isArray(value.handles) ? value.handles : []).map(handle).filter(Boolean))].slice(0, 40), custom: [...new Set((Array.isArray(value.custom) ? value.custom : []).map(handle).filter(Boolean))].slice(0, 30) };
  }
  if (!plain(value)) throw new Error('收件箱格式不正确');
  const feeds = [...new Set((Array.isArray(value.feeds) ? value.feeds : []).map(webUrl).filter(Boolean))].slice(0, 30);
  const manual = (Array.isArray(value.manual) ? value.manual : []).filter(plain).map(item => ({
    url: webUrl(item.url), title: text(item.title, 300), summary: text(item.summary, 1000), sourceName: text(item.sourceName, 200),
    kind: 'manual', sourceDate: text(item.sourceDate, 40), dateKind: text(item.dateKind, 80), capturedAt: text(item.capturedAt, 40)
  })).filter(item => item.url && item.title).slice(0, 100);
  const decisions = Object.fromEntries(Object.entries(plain(value.decisions) ? value.decisions : {}).slice(-500).flatMap(([url, decision]) => {
    if (!webUrl(url) || !plain(decision) || !['linked', 'dismissed'].includes(decision.status)) return [];
    const item = plain(decision.item) ? decision.item : {};
    return [[url, { status: decision.status, projectPath: text(decision.projectPath, 500), item: {
      url, title: text(item.title, 300), summary: text(item.summary, 1000), sourceName: text(item.sourceName, 200),
      kind: text(item.kind, 30), publishedAt: text(item.publishedAt, 40), sourceDate: text(item.sourceDate, 40), capturedAt: text(item.capturedAt, 40), dateKind: text(item.dateKind, 80)
    } }]];
  }));
  const sourceActions = (Array.isArray(value.sourceActions) ? value.sourceActions : []).filter(plain).map(item => ({
    url: webUrl(item.url), projectPath: text(item.projectPath, 500), text: text(item.text, 180), title: text(item.title, 300),
    sourceName: text(item.sourceName, 200), createdAt: text(item.createdAt, 40)
  })).filter(item => item.url && item.projectPath && item.text).slice(-500);
  return { feeds, manual, decisions, sourceActions };
}

export async function readWorkspaceState(vaultId, base) {
  try {
    const raw = JSON.parse(await readFile(workspaceStateFile(vaultId, base), 'utf8'));
    if (!plain(raw) || raw.version !== 1) throw new Error('本机工作台状态版本不兼容');
    return { version: 1, vaultId, updatedAt: raw.updatedAt || '', data: Object.fromEntries(Object.entries(raw.data || {}).filter(([key]) => sections.has(key)).map(([key, value]) => [key, normalizeSection(key, value)])) };
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export function writeWorkspaceState(vaultId, updates, { replace = false, base } = {}) {
  if (!plain(updates) || Object.keys(updates).some(key => !sections.has(key))) throw new Error('设置内容不正确');
  const previous = queues.get(vaultId) || Promise.resolve();
  const result = previous.then(async () => {
    const old = replace ? null : await readWorkspaceState(vaultId, base);
    const data = { ...(old?.data || {}) };
    for (const [section, value] of Object.entries(updates)) data[section] = normalizeSection(section, value);
    const next = { version: 1, vaultId, updatedAt: new Date().toISOString(), data };
    const file = workspaceStateFile(vaultId, base);
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, JSON.stringify(next, null, 2), { mode: 0o600 });
    await rename(temporary, file);
    return next;
  });
  queues.set(vaultId, result.catch(() => {}));
  return result;
}
