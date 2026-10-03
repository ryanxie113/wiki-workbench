import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArguments, resolveConfig } from '../lib/config.mjs';
import { normalizeDailyFormat } from '../lib/daily-format.mjs';
import { normalizeProjectFormat } from '../lib/project-format.mjs';
import { hostAllowed } from '../lib/http.mjs';
import { loadLibrary, parseFrontmatter, readAllowedFile, safeVaultPath, searchLibrary } from '../lib/wiki.mjs';
import { renderMarkdownPage } from '../lib/render.mjs';
import { createTodayFromTemplate, parseToday, updateToday, zonedNow } from '../lib/daily.mjs';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const demoVault = path.join(appDir, 'examples/demo-vault');

test('虚构资料库可独立运行：项目摘要、来源、搜索和索引', async () => {
  const library = await loadLibrary(demoVault);
  const project = library.byPath.get('projects/garden-observer.md');
  assert.equal(project.digest.progressDate, '2026-01-08');
  assert.equal(project.digest.progressSourcePath, project.path);
  assert.match(project.digest.action.join(' '), /浇水计划/);
  assert.equal(project.digest.goalEvidence.line, 12);
  assert.deepEqual(project.digest.progressEvidence.map(item => item.line), [15, 16]);
  assert.equal(project.digest.actionEvidence[0].line, 19);
  assert.equal(project.digest.actionEvidence[0].kind, 'project');
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

test('索引补充的项目目标保留索引文件和行号', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'workbench-index-source-'));
  try {
    await mkdir(path.join(directory, 'projects'));
    await writeFile(path.join(directory, 'projects/demo.md'), '# Demo\n\n## Next steps\n- Review notes\n');
    await writeFile(path.join(directory, 'index.md'), '---\nupdated: 2026-02-01\n---\n# Index\n- [[demo]] — Goal from index\n');
    const library = await loadLibrary(directory);
    const digest = library.byPath.get('projects/demo.md').digest;
    assert.equal(digest.goal, 'Goal from index');
    assert.deepEqual(digest.goalEvidence, {
      text: 'Goal from index', sourcePath: 'index.md', line: 5,
      date: '2026-02-01', kind: 'index', heading: ''
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('增量扫描复用未变页面，并更新新增、修改、删除的笔记和周报摘要', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'workbench-refresh-'));
  try {
    await mkdir(path.join(directory, 'projects'));
    await mkdir(path.join(directory, 'insights'));
    const projectFile = path.join(directory, 'projects/demo.md');
    const weeklyFile = path.join(directory, 'insights/weekly-summary.md');
    await writeFile(projectFile, '# Demo\n\n## Goal\nTrack garden samples.\n\n## Progress\n- First result\n');
    await writeFile(weeklyFile, '---\ntype: insight\nupdated: 2026-02-01\n---\n# Weekly\n\n## 下周计划\n- Prepare visit\n\n### demo\n- Weekly update\n');
    const first = await loadLibrary(directory);
    const second = await loadLibrary(directory, {}, first);
    assert.equal(second.byPath.get('insights/weekly-summary.md'), first.byPath.get('insights/weekly-summary.md'));
    assert.notEqual(second.byPath.get('projects/demo.md'), first.byPath.get('projects/demo.md'));
    assert.deepEqual(second.byPath.get('projects/demo.md').digest, first.byPath.get('projects/demo.md').digest);
    assert.equal(second.byPath.get('projects/demo.md').digest.progress[0], 'Weekly update');
    assert.equal(second.byPath.get('projects/demo.md').digest.progressEvidence[0].kind, 'weekly');
    assert.equal(second.byPath.get('projects/demo.md').digest.progressEvidence[0].sourcePath, 'insights/weekly-summary.md');
    assert.equal(second.byPath.get('projects/demo.md').digest.progressEvidence[0].line, 11);

    await writeFile(weeklyFile, '---\ntype: insight\nupdated: 2026-02-02\n---\n# Weekly\n\n## 下周计划\n- Prepare visit\n\n### demo\n- Revised weekly update\n');
    await writeFile(path.join(directory, 'projects/new.md'), '# New\n\n## Goal\nNew project\n');
    const third = await loadLibrary(directory, {}, second);
    assert.equal(third.byPath.get('projects/demo.md').digest.progress[0], 'Revised weekly update');
    assert.ok(third.byPath.has('projects/new.md'));
    assert.ok(searchLibrary(third, 'revised').some(page => page.path === 'insights/weekly-summary.md'));

    await writeFile(projectFile, '# Demo\n\n## Goal\nTrack seedlings and flowers.\n');
    await unlink(weeklyFile);
    const fourth = await loadLibrary(directory, {}, third);
    assert.equal(fourth.byPath.has('insights/weekly-summary.md'), false);
    assert.equal(fourth.byPath.get('projects/demo.md').digest.goal, 'Track seedlings and flowers.');
    assert.ok(searchLibrary(fourth, 'seedlings').some(page => page.path === 'projects/demo.md'));
    assert.equal(searchLibrary(fourth, 'revised').length, 0);
    const differentConfig = await loadLibrary(directory, { contentDir: 'projects', indexPath: 'projects/demo.md' }, fourth);
    assert.equal(differentConfig.byPath.get('projects/demo.md').type, 'index');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('项目和周报标题可配置，修改规则后重算未变项目', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'workbench-project-format-'));
  try {
    await mkdir(path.join(directory, 'projects'));
    await mkdir(path.join(directory, 'insights'));
    await writeFile(path.join(directory, 'projects/demo.md'), '---\nupdated: 2026-02-01\n---\n# Demo\n\n## Mission\nGrow healthy seedlings.\n\n## Milestones\n- Soil samples recorded\n\n## To deliver\n- Check moisture\n');
    await writeFile(path.join(directory, 'insights/sprint-review.md'), '---\ntype: insight\nupdated: 2026-02-02\n---\n# Sprint review\n\n## Next week\n- Prepare garden visit\n\n### demo\n- New growth observed\n');
    const initial = await loadLibrary(directory);
    assert.equal(initial.byPath.get('projects/demo.md').digest.goal, '');
    assert.deepEqual(initial.byPath.get('projects/demo.md').digest.action, []);
    assert.equal(initial.latestWeeklyPlan, null);

    const formatPath = path.join(directory, 'project-format.json');
    const input = {
      goalHeadings: ['Mission'], progressHeadings: ['Milestones'], actionHeadings: ['To deliver'],
      weeklySummaryNames: ['sprint-review'], weeklyPlanHeadings: ['Next week']
    };
    await writeFile(formatPath, JSON.stringify(input));
    const config = await resolveConfig(['--vault', directory, '--project-format', formatPath], {}, appDir);
    assert.deepEqual(config.projectFormat, input);
    const custom = await loadLibrary(directory, config, initial);
    const digest = custom.byPath.get('projects/demo.md').digest;
    assert.equal(digest.goal, 'Grow healthy seedlings.');
    assert.equal(digest.goalEvidence.line, 7);
    assert.deepEqual(digest.action, ['Check moisture']);
    assert.equal(digest.actionEvidence[0].line, 13);
    assert.deepEqual(custom.baseDigests.get('projects/demo.md').progress, ['Soil samples recorded']);
    assert.deepEqual(digest.progress, ['New growth observed']);
    assert.equal(digest.progressEvidence[0].sourcePath, 'insights/sprint-review.md');
    assert.equal(digest.progressEvidence[0].line, 11);
    assert.equal(custom.latestWeeklyPlan.heading, 'Next week');
    assert.notEqual(custom.cacheKey, initial.cacheKey);
    assert.notEqual(custom.byPath.get('projects/demo.md').digest, initial.byPath.get('projects/demo.md').digest);
    const repeated = await loadLibrary(directory, config, custom);
    assert.equal(repeated.byPath.get('insights/sprint-review.md'), custom.byPath.get('insights/sprint-review.md'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('项目格式配置拒绝错误字段和重复标题', async () => {
  assert.throws(() => normalizeProjectFormat({ unknown: ['Mission'] }), /未知项目格式字段/);
  assert.throws(() => normalizeProjectFormat({ goalHeadings: [] }), /goalHeadings/);
  assert.throws(() => normalizeProjectFormat({ goalHeadings: null }), /goalHeadings/);
  assert.throws(() => normalizeProjectFormat({ actionHeadings: ['TODO', 'todo'] }), /不能重复/);
  assert.throws(() => normalizeProjectFormat({ progressHeadings: ['Line\nbreak'] }), /progressHeadings/);
  await assert.rejects(resolveConfig(['--vault', demoVault, '--project-format', 'missing-project-format.json'], {}, appDir), /项目格式配置无法读取/);
  await assert.rejects(resolveConfig(['--vault', demoVault, '--project-dir', 'missing-projects'], {}, appDir), /项目目录不存在/);
});

test('非默认目录的原有 Wiki 可核对来源、采纳任务并记录进展', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'workbench-adapted-vault-'));
  try {
    await mkdir(path.join(directory, 'docs/initiatives'), { recursive: true });
    await mkdir(path.join(directory, 'daily'));
    const projectPath = 'docs/initiatives/orchard.md';
    const projectText = '# Orchard\n\n## Mission\nGrow healthy seedlings.\n\n## Milestones\n- Soil samples recorded\n\n## To deliver\n- Check moisture\n\n[Field notes](../field.md)\n';
    await writeFile(path.join(directory, projectPath), projectText);
    await writeFile(path.join(directory, 'docs/field.md'), '# Field notes\n');
    await writeFile(path.join(directory, 'docs/sprint-review.md'), '---\ntype: insight\nupdated: 2026-02-02\n---\n# Sprint review\n\n## Next week\n- Check seedlings\n\n### orchard\n- New growth observed\n');
    await writeFile(path.join(directory, 'daily/_template.md'), await readFile(path.join(appDir, 'examples/daily-template.en.md'), 'utf8'));
    const config = await resolveConfig([
      '--vault', directory, '--content-dir', 'docs', '--project-dir', 'docs/initiatives',
      '--project-format', path.join(appDir, 'examples/project-format.en.json'),
      '--daily-format', path.join(appDir, 'examples/daily-format.en.json'),
      '--write-daily', '--time-zone', 'UTC'
    ], {}, appDir);
    const library = await loadLibrary(directory, config);
    const project = library.byPath.get(projectPath);
    assert.equal(project.type, 'project');
    assert.equal(project.digest.goal, 'Grow healthy seedlings.');
    assert.equal(project.digest.progress[0], 'New growth observed');
    assert.equal(project.digest.progressEvidence[0].sourcePath, 'docs/sprint-review.md');
    assert.equal(project.digest.actionEvidence[0].sourcePath, projectPath);
    assert.match(renderMarkdownPage(project, library), /href="#\/page\/docs%2Ffield\.md"/);
    assert.ok(searchLibrary(library, 'soil samples').some(page => page.path === projectPath));

    await updateToday(directory, 'init', {}, library, config);
    await updateToday(directory, 'plan', {
      priority: 1, projectPath, text: project.digest.action[0], sourceLine: project.digest.actionEvidence[0].line
    }, library, config);
    const today = await updateToday(directory, 'record', { projectPath, text: 'Checked moisture' }, library, config);
    assert.match(today.plans[0].text, /Check moisture \[\[docs\/initiatives\/orchard\]\]/);
    assert.equal(today.records[0].text, 'Checked moisture');
    assert.equal(await readFile(path.join(directory, projectPath), 'utf8'), projectText);

    const changedRules = await loadLibrary(directory, { ...config, projectDirs: [] }, library);
    assert.equal(changedRules.byPath.get(projectPath).type, 'other');
    assert.notEqual(changedRules.cacheKey, library.cacheKey);
  } finally { await rm(directory, { recursive: true, force: true }); }
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
  assert.throws(() => parseArguments(['--project-dir', '../outside'], {}, appDir));
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
  const library = { byPath: new Map([[projectPath, { type: 'project', id: 'demo', path: projectPath, digest: { action: ['观察土壤'], actionEvidence: [{ text: '观察土壤', sourcePath: projectPath, line: 9 }] } }]]) };
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
    await assert.rejects(updateToday(directory, 'plan', { priority: 1, projectPath, text: '观察土壤', sourceLine: 10 }, library, config), /项目记录已变化/);
    await updateToday(directory, 'plan', { priority: 1, projectPath, text: '观察土壤', sourceLine: 9 }, library, config);
    const date = zonedNow('UTC').date;
    const dailyFile = path.join(directory, 'daily', `${date}.md`);
    const beforeRejectedReplace = await readFile(dailyFile, 'utf8');
    await assert.rejects(updateToday(directory, 'plan', { priority: 1, projectPath, text: '观察土壤', sourceLine: 9 }, library, config), /已有内容/);
    assert.equal(await readFile(dailyFile, 'utf8'), beforeRejectedReplace);
    await updateToday(directory, 'plan', { priority: 1, projectPath, text: '观察土壤', sourceLine: 9, replace: true }, library, config);
    const updated = await updateToday(directory, 'record', { projectPath, text: '已记录观察结果' }, library, config);
    assert.equal(updated.plans[0].text, '观察土壤 [[projects/demo]]');
    assert.equal(updated.records[0].tag, '[[projects/demo]]');
    const markdown = await readFile(dailyFile, 'utf8');
    assert.equal(parseToday(markdown, date).records.length, 1);
    if (process.platform !== 'win32') assert.equal((await stat(path.join(directory, 'daily', `${date}.md`))).mode & 0o777, 0o600);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('自定义日报标题和优先级可写入，不依赖固定的阅读段落', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'workbench-custom-daily-'));
  const projectPath = 'projects/demo.md';
  const library = { byPath: new Map([[projectPath, { type: 'project', id: 'demo', path: projectPath, digest: { action: ['Check samples'], actionEvidence: [{ text: 'Check samples', sourcePath: projectPath, line: 9 }] } }]]) };
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
    await updateToday(directory, 'plan', { priority: 1, projectPath, text: 'Check samples', sourceLine: 9 }, library, config);
    const updated = await updateToday(directory, 'record', { projectPath, text: 'Reviewed three entries' }, library, config);
    assert.equal(updated.plans[0].text, 'Check samples [[projects/demo]]');
    assert.equal(updated.records[0].text, 'Reviewed three entries');
    const markdown = await readFile(path.join(directory, 'daily', `${zonedNow('UTC').date}.md`), 'utf8');
    assert.match(markdown, /## Reflection/);
    assert.match(markdown, /\| Reviewed three entries \| \[\[projects\/demo\]\] \|\n\n## Reflection/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
