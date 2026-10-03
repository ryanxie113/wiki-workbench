import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArguments, resolveConfig } from '../lib/config.mjs';
import { normalizeDailyFormat } from '../lib/daily-format.mjs';
import { hostAllowed } from '../lib/http.mjs';
import { loadLibrary, parseFrontmatter, readAllowedFile, safeVaultPath, searchLibrary } from '../lib/wiki.mjs';
import { createTodayFromTemplate, parseToday, updateToday, zonedNow } from '../lib/daily.mjs';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const demoVault = path.join(appDir, 'examples/demo-vault');

test('虚构资料库可独立运行：项目摘要、来源、搜索和索引', async () => {
  const library = await loadLibrary(demoVault);
  const project = library.byPath.get('projects/garden-observer.md');
  assert.equal(project.digest.progressDate, '2026-01-08');
  assert.equal(project.digest.progressSourcePath, project.path);
  assert.match(project.digest.action.join(' '), /浇水计划/);
  assert.deepEqual(project.attributes.sources, ['notes/soil-notes.md']);
  assert.deepEqual(library.unindexed, []);
  assert.ok(searchLibrary(library, '土壤').some(page => page.path === 'notes/soil-notes.md'));
  assert.ok(!library.byPath.has('daily/_template.md'));
});

test('任意 Markdown 目录无需 frontmatter 或根索引', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'workbench-vault-'));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'workbench-outside-'));
  try {
    await mkdir(path.join(directory, 'projects'));
    await mkdir(path.join(directory, 'projects', 'nested'));
    await mkdir(path.join(directory, 'private'));
    await writeFile(path.join(directory, 'projects', 'alpha.md'), '# Alpha\n\n## Progress\n- First milestone\n');
    await writeFile(path.join(directory, 'projects', 'empty.md'), '# Empty project\n');
    await writeFile(path.join(directory, 'projects', 'nested', 'beta.md'), '# Beta\n');
    await writeFile(path.join(directory, 'private', 'skip.md'), '# Excluded\n');
    await writeFile(path.join(outside, 'outside.md'), '# Outside\n');
    let hasSymlink = true;
    try { await symlink(path.join(outside, 'outside.md'), path.join(directory, 'outside.md')); }
    catch (error) { if (!['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) throw error; hasSymlink = false; }
    const library = await loadLibrary(directory, { excludes: ['private'] });
    assert.equal(library.byPath.get('projects/alpha.md').type, 'project');
    assert.equal(library.byPath.get('projects/empty.md').digest.progressDate, '');
    assert.equal(library.byPath.get('projects/nested/beta.md').type, 'project');
    assert.equal(library.byPath.has('private/skip.md'), false);
    if (hasSymlink) assert.equal(library.byPath.has('outside.md'), false);
    assert.deepEqual(library.unindexed, []);
    if (hasSymlink) assert.equal(await readAllowedFile(directory, 'outside.md'), null);
    assert.equal(await readAllowedFile(directory, 'projects/alpha.md'), '# Alpha\n\n## Progress\n- First milestone\n');
    assert.ok(searchLibrary(library, 'project').some(page => page.path === 'projects/empty.md'));
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('YAML 列表、路径限制和命令参数', () => {
  const parsed = parseFrontmatter('---\ntags:\n  - alpha\n  - beta\nsources: ["notes/a.md"]\n---\n# Title\n');
  assert.deepEqual(parsed.attributes.tags, ['alpha', 'beta']);
  assert.deepEqual(parsed.attributes.sources, ['notes/a.md']);
  assert.equal(safeVaultPath('../etc/hosts'), null);
  assert.equal(safeVaultPath('notes/../../etc/hosts'), null);
  assert.equal(safeVaultPath('.git/config'), null);
  assert.equal(safeVaultPath('notes/a.md'), 'notes/a.md');
  const config = parseArguments(['--vault', demoVault, '--content-dir', 'projects', '--time-zone', 'UTC', '--exclude', 'private', '--write-daily'], {}, appDir);
  assert.equal(config.contentDir, 'projects');
  assert.equal(config.writeDaily, true);
  assert.deepEqual(config.excludes, ['private']);
  assert.throws(() => parseArguments(['--content-dir', '../outside'], {}, appDir));
  assert.throws(() => normalizeDailyFormat({ priorityLabels: ['High', 'High', 'Low'] }), /不能重复/);
  assert.equal(hostAllowed('127.0.0.1:4173', 4173), true);
  assert.equal(hostAllowed('localhost:4173', 4173), true);
  assert.equal(hostAllowed('example.com:4173', 4173), false);
  assert.equal(hostAllowed('127.0.0.1:9999', 4173), false);
});

test('日报默认拒绝写入；显式启用后按指定时区与模板创建', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'workbench-daily-'));
  const projectPath = 'projects/demo.md';
  const library = { byPath: new Map([[projectPath, { type: 'project', id: 'demo', digest: { action: ['观察土壤'] } }]]) };
  const config = { dailyDir: 'daily', timeZone: 'UTC', writeDaily: true };
  try {
    await mkdir(path.join(directory, 'daily'));
    const template = await readFile(path.join(demoVault, 'daily/_template.md'), 'utf8');
    await writeFile(path.join(directory, 'daily/_template.md'), template);
    await assert.rejects(updateToday(directory, 'init', {}, library), /日报写入未启用/);
    const today = await updateToday(directory, 'init', {}, library, config);
    assert.equal(today.exists, true);
    assert.equal(today.plans.length, 3);
    assert.match(createTodayFromTemplate(template, '2026-10-03'), /week: W40/);
    await updateToday(directory, 'plan', { priority: 1, projectPath, text: '观察土壤' }, library, config);
    const updated = await updateToday(directory, 'record', { projectPath, text: '已记录观察结果' }, library, config);
    assert.equal(updated.plans[0].text, '观察土壤 [[demo]]');
    assert.equal(updated.records[0].tag, '[[demo]]');
    const date = zonedNow('UTC').date;
    const markdown = await readFile(path.join(directory, 'daily', `${date}.md`), 'utf8');
    assert.equal(parseToday(markdown, date).records.length, 1);
    if (process.platform !== 'win32') assert.equal((await stat(path.join(directory, 'daily', `${date}.md`))).mode & 0o777, 0o600);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('自定义日报标题和优先级可写入，不依赖固定的阅读段落', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'workbench-custom-daily-'));
  const projectPath = 'projects/demo.md';
  const library = { byPath: new Map([[projectPath, { type: 'project', id: 'demo', digest: { action: ['Check samples'] } }]]) };
  try {
    await mkdir(path.join(directory, 'daily'));
    await writeFile(path.join(directory, 'daily/_template.md'), '# Invalid template\n');
    await assert.rejects(resolveConfig(['--vault', directory, '--write-daily'], {}, appDir), /日报模板缺少/);
    await writeFile(path.join(directory, 'daily/_template.md'), '## 今日计划\n- [ ] P1:\n- [ ] P2:\n- [ ] P3:\n\n## 时间线\n| 时间 | 内容 |\n| --- | --- |\n');
    await assert.rejects(resolveConfig(['--vault', directory, '--write-daily'], {}, appDir), /日报模板缺少/);
    const template = await readFile(path.join(appDir, 'examples/daily-template.en.md'), 'utf8');
    await writeFile(path.join(directory, 'daily/_template.md'), template);
    const config = await resolveConfig(['--vault', directory, '--write-daily', '--time-zone', 'UTC', '--daily-format', path.join(appDir, 'examples/daily-format.en.json')], {}, appDir);
    assert.deepEqual(config.dailyFormat.priorityLabels, ['High', 'Medium', 'Low']);
    const initialized = await updateToday(directory, 'init', {}, library, config);
    assert.deepEqual(initialized.plans.map(plan => plan.label), ['High', 'Medium', 'Low']);
    await updateToday(directory, 'plan', { priority: 1, projectPath, text: 'Check samples' }, library, config);
    const updated = await updateToday(directory, 'record', { projectPath, text: 'Reviewed three entries' }, library, config);
    assert.equal(updated.plans[0].text, 'Check samples [[demo]]');
    assert.equal(updated.records[0].text, 'Reviewed three entries');
    const markdown = await readFile(path.join(directory, 'daily', `${zonedNow('UTC').date}.md`), 'utf8');
    assert.match(markdown, /## Reflection/);
    assert.match(markdown, /\| Reviewed three entries \| \[\[demo\]\] \|\n\n## Reflection/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
