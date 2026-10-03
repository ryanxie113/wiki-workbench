import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { loadLibrary, searchLibrary } from '../lib/wiki.mjs';

const root = await mkdtemp(path.join(os.tmpdir(), 'wiki-workbench-bench-'));
const elapsed = async work => {
  const start = performance.now();
  const value = await work();
  return { value, ms: performance.now() - start };
};

try {
  await mkdir(path.join(root, 'projects'));
  const body = `## Goal\nKeep notes searchable.\n\n## Progress\n${'soil observation garden sample data. '.repeat(80)}\n`;
  await Promise.all(Array.from({ length: 600 }, (_, index) => writeFile(
    path.join(root, 'projects', `sample-${index}.md`),
    `---\ntype: project\nupdated: 2026-01-01\n---\n# Sample ${index}\n${body}`
  )));
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
  warm.sort((a, b) => a - b);
  console.log(JSON.stringify({
    pages: library.pages.length,
    coldMs: Math.round(cold.ms),
    warmMedianMs: Math.round(warm[2]),
    search100Ms: Math.round(search.ms)
  }));
} finally {
  await rm(root, { recursive: true, force: true });
}
