import { App, ItemView, Notice, Plugin, PluginSettingTab, Setting, TFile, WorkspaceLeaf } from 'obsidian';
import { buildVaultSnapshot } from './model.mjs';

const VIEW_TYPE = 'wiki-workbench-review';
const PAGE_SIZE = 50;

interface Evidence {
  sourcePath: string;
  line: number;
  date: string;
}

interface ActionCandidate {
  projectTitle: string;
  text: string;
  status: 'pending' | 'planned' | 'completed';
  evidence: Evidence;
  needsReview: boolean;
  ambiguous: boolean;
  adoption: { path: string; date: string } | null;
}

interface ProjectSummary {
  path: string;
  title: string;
  digest: {
    goal: string;
    progress: string[];
    progressDate: string;
    action: string[];
  };
}

interface WorkbenchSettings {
  contentDir: string;
  dailyDir: string;
}

const DEFAULT_SETTINGS: WorkbenchSettings = { contentDir: '', dailyDir: 'daily' };

class WorkbenchView extends ItemView {
  private plugin: WikiWorkbenchPlugin;
  private mode: 'actions' | 'projects' = 'actions';
  private visibleCount = PAGE_SIZE;
  private revision = 0;
  private snapshot: Awaited<ReturnType<typeof buildVaultSnapshot>> | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: WikiWorkbenchPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string { return VIEW_TYPE; }
  getDisplayText(): string { return 'Wiki 工作台'; }
  getIcon(): string { return 'list-todo'; }

  async onOpen(): Promise<void> { await this.refresh(); }
  async onClose(): Promise<void> { this.revision++; }

  async refresh(): Promise<void> {
    this.snapshot = null;
    await this.render();
  }

  async render(): Promise<void> {
    const revision = ++this.revision;
    const root = this.contentEl;
    root.empty();
    root.addClass('wwb-root');

    const header = root.createDiv({ cls: 'wwb-header' });
    const title = header.createDiv();
    title.createEl('small', { text: 'WIKI WORKBENCH' });
    title.createEl('h2', { text: '从记录到行动' });
    const refresh = header.createEl('button', { text: '刷新', cls: 'wwb-refresh' });
    refresh.addEventListener('click', () => void this.refresh());
    const body = root.createDiv({ cls: 'wwb-content' });
    body.createEl('p', { text: '正在读取当前资料库…', cls: 'wwb-muted' });

    try {
      const snapshot = this.snapshot || await buildVaultSnapshot(
        this.app.vault.getMarkdownFiles(),
        (file: TFile) => this.app.vault.cachedRead(file),
        this.plugin.settings
      );
      if (revision !== this.revision) return;
      this.snapshot = snapshot;
      body.empty();
      body.createEl('p', {
        text: `${this.app.vault.getName()} · 已扫描 ${snapshot.pageCount} 篇 Markdown · 只读`,
        cls: 'wwb-scope'
      });
      const tabs = body.createDiv({ cls: 'wwb-tabs' });
      for (const [mode, label, count] of [
        ['actions', '行动审阅', snapshot.actions.length],
        ['projects', '项目', snapshot.projects.length]
      ] as const) {
        const button = tabs.createEl('button', { text: `${label} ${count}` });
        button.toggleClass('is-active', this.mode === mode);
        button.addEventListener('click', () => {
          this.mode = mode;
          this.visibleCount = PAGE_SIZE;
          void this.render();
        });
      }
      if (this.mode === 'actions') this.renderActions(body, snapshot.actions);
      else this.renderProjects(body, snapshot.projects);
    } catch (error) {
      if (revision !== this.revision) return;
      body.empty();
      body.createEl('p', { text: `读取失败：${error instanceof Error ? error.message : String(error)}`, cls: 'wwb-error' });
    }
  }

  private renderActions(body: HTMLElement, actions: ActionCandidate[]): void {
    body.createEl('p', { text: '候选事项来自项目页；请打开原文核对日期和上下文。此版本不会修改笔记。', cls: 'wwb-muted' });
    if (!actions.length) {
      body.createEl('p', { text: '没有找到项目后续事项。项目页需放在 projects/ 目录，或设置 type: project。', cls: 'wwb-empty' });
      return;
    }
    for (const item of actions.slice(0, this.visibleCount)) {
      const card = body.createDiv({ cls: 'wwb-card' });
      const heading = card.createDiv({ cls: 'wwb-card-heading' });
      heading.createEl('strong', { text: item.projectTitle });
      heading.createEl('span', { text: item.status === 'completed' ? '已完成' : item.status === 'planned' ? '已采纳' : '待判断', cls: 'wwb-status' });
      card.createEl('p', { text: item.text });
      if (item.needsReview) card.createEl('small', { text: '原文后有更新的进展，请复核', cls: 'wwb-warning' });
      if (item.ambiguous) card.createEl('small', { text: '同文事项重复，无法自动匹配日报', cls: 'wwb-warning' });
      const source = card.createEl('button', {
        text: `${item.evidence.sourcePath}:${item.evidence.line} · ${item.evidence.date || '日期未记录'} ↗`,
        cls: 'wwb-source'
      });
      source.addEventListener('click', () => void this.openSource(item.evidence.sourcePath, item.evidence.line));
      if (item.adoption) {
        const adopted = item.adoption;
        const adoption = card.createEl('button', {
          text: `日报${item.status === 'completed' ? '已完成' : '已采纳'} · ${adopted.date} ↗`,
          cls: 'wwb-source'
        });
        adoption.addEventListener('click', () => void this.openSource(adopted.path));
      }
    }
    this.addMoreButton(body, actions.length);
  }

  private renderProjects(body: HTMLElement, projects: ProjectSummary[]): void {
    if (!projects.length) {
      body.createEl('p', { text: '没有找到项目页。项目页需放在 projects/ 目录，或设置 type: project。', cls: 'wwb-empty' });
      return;
    }
    for (const project of projects.slice(0, this.visibleCount)) {
      const card = body.createDiv({ cls: 'wwb-card' });
      card.createEl('strong', { text: project.title });
      if (project.digest.goal) card.createEl('p', { text: project.digest.goal });
      if (project.digest.progress.length) {
        card.createEl('small', { text: `最近进展 · ${project.digest.progressDate || '日期未记录'}`, cls: 'wwb-muted' });
        card.createEl('p', { text: project.digest.progress.join('；') });
      }
      card.createEl('small', { text: `${project.digest.action.length} 条后续事项`, cls: 'wwb-muted' });
      const source = card.createEl('button', { text: `${project.path} ↗`, cls: 'wwb-source' });
      source.addEventListener('click', () => void this.openSource(project.path));
    }
    this.addMoreButton(body, projects.length);
  }

  private addMoreButton(body: HTMLElement, total: number): void {
    if (this.visibleCount >= total) return;
    const more = body.createEl('button', { text: `显示更多（剩余 ${total - this.visibleCount} 项）`, cls: 'wwb-more' });
    more.addEventListener('click', () => {
      this.visibleCount += PAGE_SIZE;
      void this.render();
    });
  }

  private async openSource(path: string, line?: number): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      new Notice('原文文件已移动或删除，请刷新工作台');
      return;
    }
    const leaf = this.app.workspace.getLeaf('tab');
    await leaf.openFile(file, line ? { eState: { line: line - 1 } } : undefined);
  }
}

class WorkbenchSettingTab extends PluginSettingTab {
  private plugin: WikiWorkbenchPlugin;

  constructor(app: App, plugin: WikiWorkbenchPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    new Setting(containerEl).setName('正文目录').setDesc('留空扫描整个资料库；例如 wiki。日报目录和根索引始终另外读取。')
      .addText(text => text.setPlaceholder('整个资料库').setValue(this.plugin.settings.contentDir)
        .onChange(async value => {
          this.plugin.settings.contentDir = value.trim().replace(/^\/+|\/+$/g, '');
          await this.plugin.saveSettings();
        }));
    new Setting(containerEl).setName('日报目录').setDesc('用于识别已采纳和勾选完成的事项；默认 daily。')
      .addText(text => text.setValue(this.plugin.settings.dailyDir)
        .onChange(async value => {
          this.plugin.settings.dailyDir = value.trim().replace(/^\/+|\/+$/g, '') || 'daily';
          await this.plugin.saveSettings();
        }));
  }
}

export default class WikiWorkbenchPlugin extends Plugin {
  settings: WorkbenchSettings = { ...DEFAULT_SETTINGS };
  private refreshTimer: number | null = null;

  async onload(): Promise<void> {
    this.settings = { ...DEFAULT_SETTINGS, ...(await this.loadData() as Partial<WorkbenchSettings> | null) };
    this.registerView(VIEW_TYPE, leaf => new WorkbenchView(leaf, this));
    this.addRibbonIcon('list-todo', '打开 Wiki 工作台', () => void this.activateView());
    this.addCommand({ id: 'open-workbench', name: '打开 Wiki 工作台', callback: () => void this.activateView() });
    this.addSettingTab(new WorkbenchSettingTab(this.app, this));
    this.app.workspace.onLayoutReady(() => {
      this.registerEvent(this.app.vault.on('create', () => this.scheduleRefresh()));
      this.registerEvent(this.app.vault.on('modify', () => this.scheduleRefresh()));
      this.registerEvent(this.app.vault.on('delete', () => this.scheduleRefresh()));
      this.registerEvent(this.app.vault.on('rename', () => this.scheduleRefresh()));
    });
  }

  onunload(): void {
    if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    this.scheduleRefresh();
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => {
      this.refreshTimer = null;
      for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
        if (leaf.view instanceof WorkbenchView) void leaf.view.refresh();
      }
    }, 400);
  }

  private async activateView(): Promise<void> {
    const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0] || this.app.workspace.getLeaf('tab');
    await leaf.setViewState({ type: VIEW_TYPE, active: true });
    await this.app.workspace.revealLeaf(leaf);
  }
}
