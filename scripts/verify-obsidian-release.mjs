import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
const bundled = JSON.parse(await readFile(path.join(root, 'obsidian-plugin/dist/manifest.json'), 'utf8'));
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const tag = process.argv[2];

assert.deepEqual(bundled, source, 'Release manifest must match repository root');
assert.match(source.version, /^\d+\.\d+\.\d+$/);
assert.match(source.id, /^[a-z]+(?:-[a-z]+)*$/);
assert.ok(!source.id.includes('obsidian') && !source.id.endsWith('plugin'));
assert.equal(source.version, pkg.version);
if (tag) assert.equal(tag, source.version, 'Release tag must match manifest version exactly');
assert.ok(source.description.length <= 250 && source.description.endsWith('.'));
assert.equal(source.isDesktopOnly, true);
for (const name of ['main.js', 'manifest.json', 'styles.css']) {
  assert.ok((await stat(path.join(root, 'obsidian-plugin/dist', name))).size > 0, `${name} is empty`);
}
const bundle = await readFile(path.join(root, 'obsidian-plugin/dist/main.js'), 'utf8');
assert.ok(!/\/Users\/[^/\s]+\/|[A-Z]:\\Users\\/i.test(bundle), 'Release bundle contains a private path');
console.log(`Obsidian release ${source.version}: manifest, tag, and three assets verified`);
