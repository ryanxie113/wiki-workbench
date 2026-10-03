import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { availableAssetFile, loadLibrary, parsePage } from '../lib/wiki.mjs';
import { renderMarkdownPage, resolveWikiTarget } from '../lib/render.mjs';

test('常见 Markdown 正确呈现，危险 HTML 与远端图片不会自动执行或加载', async () => {
  const library = await loadLibrary(path.resolve('examples/demo-vault'));
  const page = parsePage('projects/preview.md', [
    '# 预览',
    '[[soil-notes|土壤]]、[[earth-notes|别名]] 和 [[projects/garden-observer|花园]]',
    '[本地笔记](../notes/soil-notes.md)',
    '',
    '- [x] 已完成',
    '  - 嵌套事项',
    '',
    '| A | B |',
    '| --- | --- |',
    '| a \\| b | c |',
    '',
    '![本地图片](../assets/plot.png)',
    '![[assets/plot.png|嵌入图片]]',
    '',
    '![远端图片](https://example.com/pixel.png)',
    '',
    '<script>alert(1)</script>'
  ].join('\n'));
  const html = renderMarkdownPage(page, library);
  assert.match(html, /href="#\/page\/notes%2Fsoil-notes\.md"/);
  assert.match(html, /href="#\/page\/notes%2Fsoil-notes\.md">别名<\/a>/);
  assert.match(html, /href="#\/page\/projects%2Fgarden-observer\.md"/);
  assert.match(html, /<ul class="contains-task-list">/);
  assert.match(html, /<ul>\s*<li data-line="6" data-line-end="\d+">嵌套事项<\/li>/);
  assert.match(html, /a \| b/);
  assert.match(html, /<div class="table-wrap"><table data-line="8" data-line-end="10">/);
  assert.match(html, /src="\/api\/asset\?path=assets%2Fplot\.png"/);
  assert.match(html, /alt="嵌入图片"/);
  assert.match(html, /class="external-image"/);
  assert.doesNotMatch(html, /<img[^>]+example\.com/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>/);
  const sourceHtml = renderMarkdownPage(library.byPath.get('projects/garden-observer.md'), library);
  assert.match(sourceHtml, /<h2 data-heading="Next steps" data-line="18" data-line-end="18">/);
  assert.match(sourceHtml, /<li data-line="19" data-line-end="\d+">/);
});

test('重名页面需路径消歧；同目录页面优先匹配', () => {
  const paths = ['a/readme.md', 'b/readme.md'];
  const library = {
    byPath: new Map(paths.map(value => [value, {}])),
    byId: new Map([['readme', paths]]),
    byAlias: new Map(),
    pages: paths.map(value => ({ path: value }))
  };
  assert.equal(resolveWikiTarget('readme', 'a/current.md', library), 'a/readme.md');
  assert.equal(resolveWikiTarget('readme', 'c/current.md', library), null);
  assert.equal(resolveWikiTarget('b/readme', 'c/current.md', library), 'b/readme.md');
  const html = renderMarkdownPage(parsePage('notes/current.md', '![bad](../../secret.png)\n\n[unsafe](javascript:alert(1))'), library);
  assert.doesNotMatch(html, /\/api\/asset/);
  assert.doesNotMatch(html, /href="javascript:/);
});

test('章节、显式相对路径和资料库根路径链接定位到正确页面', () => {
  const paths = ['readme.md', 'a/current.md', 'a/readme.md', 'b/readme.md', 'notes/soil-notes.md'];
  const library = {
    byPath: new Map(paths.map(value => [value, {}])),
    byId: new Map([['readme', paths.filter(value => value.endsWith('readme.md'))], ['soil-notes', ['notes/soil-notes.md']]]),
    byAlias: new Map(),
    pages: paths.map(value => ({ path: value }))
  };
  assert.equal(resolveWikiTarget('./readme', 'a/current.md', library), 'a/readme.md');
  assert.equal(resolveWikiTarget('../b/readme', 'a/current.md', library), 'b/readme.md');
  assert.equal(resolveWikiTarget('../../readme', 'a/current.md', library), null);
  const page = parsePage('a/current.md', [
    '# Current', '## Details',
    '[[#Details]] [[#Details|本页章节]] [[./readme|同目录]]',
    '[根目录](/readme.md) [省略后缀](../notes/soil-notes) [章节](../notes/soil-notes.md#Soil%20Samples)',
    '[目录外](../../private.md) [网络路径](//example.com/readme.md)',
    '![根目录图片](/assets/plot.png) ![[/assets/plot.png|Wiki 根目录图片]] ![[./assets/plot.png|同目录图片]]',
    '![目录外图片](../../private.png)'
  ].join('\n'));
  const html = renderMarkdownPage(page, library);
  assert.match(html, /href="#\/page\/a%2Fcurrent\.md\?heading=Details">Details<\/a>/);
  assert.match(html, /href="#\/page\/a%2Fcurrent\.md\?heading=Details">本页章节<\/a>/);
  assert.match(html, /href="#\/page\/a%2Freadme\.md">同目录<\/a>/);
  assert.match(html, /href="#\/page\/readme\.md">根目录<\/a>/);
  assert.match(html, /href="#\/page\/notes%2Fsoil-notes\.md">省略后缀<\/a>/);
  assert.match(html, /href="#\/page\/notes%2Fsoil-notes\.md\?heading=Soil%20Samples">章节<\/a>/);
  assert.match(html, /class="missing-link" aria-disabled="true">目录外<\/a>/);
  assert.doesNotMatch(html, /href="#\/page\/private\.md"/);
  assert.doesNotMatch(html, /href="#\/page\/example\.com/);
  assert.match(html, /src="\/api\/asset\?path=assets%2Fplot\.png" alt="根目录图片"/);
  assert.match(html, /src="\/api\/asset\?path=assets%2Fplot\.png" alt="Wiki 根目录图片"/);
  assert.match(html, /src="\/api\/asset\?path=a%2Fassets%2Fplot\.png" alt="同目录图片"/);
  assert.doesNotMatch(html, /\/api\/asset\?path=private\.png/);
});

test('图片接口只允许资料库内的普通栅格图片', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'workbench-assets-'));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'workbench-outside-'));
  try {
    await mkdir(path.join(root, 'assets'));
    await writeFile(path.join(root, 'assets', 'plot.png'), Buffer.from([137, 80, 78, 71]));
    await writeFile(path.join(root, 'assets', 'active.svg'), '<svg></svg>');
    await writeFile(path.join(outside, 'outside.png'), Buffer.from([137, 80, 78, 71]));
    let hasSymlink = true;
    try { await symlink(path.join(outside, 'outside.png'), path.join(root, 'assets', 'outside.png')); }
    catch (error) { if (!['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) throw error; hasSymlink = false; }
    assert.ok(await availableAssetFile(root, 'assets/plot.png'));
    assert.equal(await availableAssetFile(root, 'assets/active.svg'), null);
    if (hasSymlink) assert.equal(await availableAssetFile(root, 'assets/outside.png'), null);
    assert.equal(await availableAssetFile(root, '../outside.png'), null);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
