import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { connectionStorePath } from './connection-store.mjs';

export function outcomeFile(vaultId, base = path.dirname(connectionStorePath())) {
  if (!/^[a-f0-9]{16}$/.test(vaultId)) throw new Error('资料库标识无效');
  return path.join(base, 'outcomes', `${vaultId}.json`);
}

export async function readOutcomes(vaultId, base) {
  try {
    const events = JSON.parse(await readFile(outcomeFile(vaultId, base), 'utf8'));
    return Array.isArray(events) ? events.filter(item => item && typeof item.id === 'string' && typeof item.status === 'string').slice(-2000) : [];
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

const queues = new Map();
export function replaceOutcomes(vaultId, events, base) {
  if (!Array.isArray(events) || events.length > 2000 || events.some(event => !event || !/^[a-f0-9]{20}$/.test(event.id)
    || !['completed', 'deferred', 'invalidated', 'planned'].includes(event.status) || typeof event.text !== 'string')) throw new Error('结果记录格式不正确');
  const previous = queues.get(vaultId) || Promise.resolve();
  const result = previous.then(async () => {
    const file = outcomeFile(vaultId, base);
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, JSON.stringify(events, null, 2), { mode: 0o600 });
    await rename(temporary, file);
  });
  queues.set(vaultId, result.catch(() => {}));
  return result;
}
export function appendOutcome(vaultId, candidate, status, note, base) {
  if (!['completed', 'deferred', 'invalidated', 'planned'].includes(status)) throw new Error('结果状态无效');
  const cleanNote = typeof note === 'string' ? note.trim().replace(/[\r\n]+/g, ' ') : '';
  if (cleanNote.length > 400 || (['deferred', 'invalidated'].includes(status) && !cleanNote)) throw new Error('请填写 1–400 字的结果依据');
  const previous = queues.get(vaultId) || Promise.resolve();
  const result = previous.then(async () => {
    const file = outcomeFile(vaultId, base);
    const events = await readOutcomes(vaultId, base);
    const event = { id: candidate.id, status, note: cleanNote, at: new Date().toISOString(),
      text: candidate.text, evidence: candidate.evidence, adoption: candidate.adoption };
    events.push(event);
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, JSON.stringify(events.slice(-2000), null, 2), { mode: 0o600 });
    await rename(temporary, file);
    return event;
  });
  queues.set(vaultId, result.catch(() => {}));
  return result;
}
