import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

const require = createRequire(import.meta.url);
const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const demo = path.join(appDir, 'examples/demo-vault');

function addObsidianDomHelpers(window) {
  const prototype = window.HTMLElement.prototype;
  prototype.createEl = function (tag, options = {}) {
    const element = window.document.createElement(tag);
    if (options.text !== undefined) element.textContent = options.text;
    if (options.cls) element.className = options.cls;
    this.appendChild(element);
    return element;
  };
  prototype.createDiv = function (options = {}) { return this.createEl('div', options); };
  prototype.empty = function () { this.replaceChildren(); };
  prototype.addClass = function (name) { this.classList.add(name); };
  prototype.toggleClass = function (name, enabled) { this.classList.toggle(name, enabled); };
}

test('Obsidian 插件在隔离宿主中加载、显示、跳转并随笔记修改刷新', async () => {
  const result = await build({
    entryPoints: [path.join(appDir, 'obsidian-plugin/src/main.ts')],
    bundle: true, platform: 'node', format: 'cjs', target: 'es2022', external: ['obsidian'], minify: true, write: false
  });
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
  addObsidianDomHelpers(dom.window);
  const files = new Map();
  for (const relative of ['index.md', 'notes/soil-notes.md', 'projects/garden-observer.md']) {
    files.set(relative, await readFile(path.join(demo, relative), 'utf8'));
  }
  const reads = [];
  const opened = [];
  const handlers = new Map();
  const commands = [];
  let viewFactory;
  let view;
  class TFile {
    constructor(filePath) { this.path = filePath; this.stat = { size: files.get(filePath).length }; }
  }
  class ItemView {
    constructor(leaf) {
      this.app = leaf.app;
      this.leaf = leaf;
      this.contentEl = dom.window.document.createElement('div');
      dom.window.document.body.appendChild(this.contentEl);
    }
  }
  class Plugin {
    constructor(app) { this.app = app; }
    async loadData() { return null; }
    registerView(_type, factory) { viewFactory = factory; }
    addRibbonIcon() {}
    addCommand(command) { commands.push(command); }
    addSettingTab() {}
    registerEvent() {}
  }
  class PluginSettingTab {
    constructor(app) { this.app = app; this.containerEl = dom.window.document.createElement('div'); }
  }
  const vault = {
    getName: () => '虚构测试库',
    getMarkdownFiles: () => [...files.keys()].map(filePath => new TFile(filePath)),
    cachedRead: async file => { reads.push(file.path); return files.get(file.path); },
    getAbstractFileByPath: filePath => files.has(filePath) ? new TFile(filePath) : null,
    on: (event, callback) => { handlers.set(event, callback); return { event, callback }; }
  };
  const app = {
    vault,
    workspace: {
      onLayoutReady: callback => callback(),
      getLeavesOfType: () => view ? [{ view }] : [],
      getLeaf: () => ({ openFile: async (file, options) => { opened.push({ path: file.path, options }); } }),
      revealLeaf: async () => {}
    }
  };
  const module = { exports: {} };
  const context = {
    module, exports: module.exports,
    require: name => name === 'obsidian'
      ? { ItemView, Plugin, PluginSettingTab, TFile, Notice: class {}, Setting: class {} }
      : require(name),
    window: dom.window, document: dom.window.document, console, Buffer, process,
    TextEncoder, TextDecoder, setTimeout, clearTimeout
  };
  vm.runInNewContext(result.outputFiles[0].text, context, { filename: 'wiki-workbench-plugin.js' });
  const PluginClass = module.exports.default;
  const plugin = new PluginClass(app);
  await plugin.onload();
  assert.equal(commands[0].id, 'open-workbench');
  assert.ok(handlers.has('modify'));
  view = viewFactory({ app });
  await view.onOpen();
  assert.match(view.contentEl.textContent, /虚构测试库 · 已扫描 3 篇 Markdown · 只读/);
  assert.match(view.contentEl.textContent, /整理下周的浇水计划/);
  assert.equal(reads.length, 3);

  view.contentEl.querySelector('.wwb-source').click();
  await Promise.resolve();
  assert.equal(opened[0].path, 'projects/garden-observer.md');
  assert.equal(opened[0].options.eState.line, 18);

  [...view.contentEl.querySelectorAll('.wwb-tabs button')].find(button => button.textContent.startsWith('项目')).click();
  await Promise.resolve();
  assert.match(view.contentEl.textContent, /用一份公开可分享的样例记录植物状态/);
  assert.equal(reads.length, 3, '切换视图应复用扫描结果');

  files.set('projects/garden-observer.md', files.get('projects/garden-observer.md').replace('- 整理下周的浇水计划。', '- 检查新的苗床。'));
  handlers.get('modify')();
  await new Promise(resolve => setTimeout(resolve, 460));
  [...view.contentEl.querySelectorAll('.wwb-tabs button')].find(button => button.textContent.startsWith('行动审阅')).click();
  await Promise.resolve();
  assert.match(view.contentEl.textContent, /检查新的苗床/);
  assert.equal(reads.length, 6);
  await view.onClose();
  plugin.onunload();
  dom.window.close();
});
