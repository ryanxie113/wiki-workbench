import { mkdtemp, mkdir, writeFile, unlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import assert from 'node:assert/strict';
import { loadLibrary, parsePage, readAllowedFile, searchLibrary } from '../lib/wiki.mjs';
import { renderMarkdownPage } from '../lib/render.mjs';

const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--pages')) throw new Error('用法：npm run bench -- --pages 5000');
const pageCount = Number(args[1] ?? 600);
if (!Number.isInteger(pageCount) || pageCount < 2 || pageCount > 20_000) throw new Error('--pages 必须是 2–20000 的整数');

const root = await mkdtemp(path.join(os.tmpdir(), 'wiki-workbench-bench-'));
const elapsed = async work => {
  const start = performance.now();
  const value = await work();
  return { value, ms: performance.now() - start };
};

try {
  await mkdir(path.join(root, 'projects'));
  const body = `## Goal\nKeep notes searchable.\n\n## Progress\n${'soil observation garden sample data. '.repeat(80)}\n`;
  for (let start = 0; start < pageCount; start += 64) {
    await Promise.all(Array.from({ length: Math.min(64, pageCount - start) }, (_, offset) => {
      const index = start + offset;
      return writeFile(path.join(root, 'projects', `sample-${index}.md`),
        `---\ntype: project\nupdated: 2026-01-01\n---\n# Sample ${index}\n${body}`);
    }));
  }
  const cold = await elapsed(() => loadLibrary(root));
  let library = cold.value;
  const warm = [];
  for (let index = 0; index < 5; index++) {
    const run = await elapsed(() => loadLibrary(root, {}, library));
    library = run.value;
    warm.push(run.ms);
  }
  const search = await elapsed(() => {
    for (let index = 0; index < 100; index++) searchLibrary(library, 'soil garden');
  });
  const open = await elapsed(async () => {
    const relative = `projects/sample-${Math.floor(pageCount / 2)}.md`;
    const page = parsePage(relative, await readAllowedFile(root, relative));
    return renderMarkdownPage(page, library);
  });
  assert.match(open.value, /soil observation garden/);
  await writeFile(path.join(root, 'projects/sample-0.md'), '# Sample 0\n\n## Progress\n- Changed marker\n');
  await writeFile(path.join(root, 'projects/new.md'), '# New\n\n## Goal\nNew marker\n');
  await unlink(path.join(root, 'projects/sample-1.md'));
  const changed = await elapsed(() => loadLibrary(root, {}, library));
  assert.equal(changed.value.pages.length, pageCount);
  assert.equal(changed.value.byPath.has('projects/sample-1.md'), false);
  assert.equal(changed.value.byPath.get('projects/sample-0.md').digest.progress[0], 'Changed marker');
  assert.ok(searchLibrary(changed.value, 'New marker').some(page => page.path === 'projects/new.md'));
  assert.equal(searchLibrary(changed.value, 'soil garden').some(page => page.path === 'projects/sample-0.md'), false);
  warm.sort((a, b) => a - b);
  console.log(JSON.stringify({
    pages: pageCount,
    coldMs: Math.round(cold.ms),
    warmMedianMs: Math.round(warm[2]),
    search100Ms: Math.round(search.ms),
    openMs: Math.round(open.ms),
    changedRefreshMs: Math.round(changed.ms),
    heapMb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024)
  }));
} finally {
  await rm(root, { recursive: true, force: true });
}
