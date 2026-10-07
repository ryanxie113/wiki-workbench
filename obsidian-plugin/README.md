# Wiki Workbench Companion（只读原型）

这个 Obsidian 桌面插件直接读取当前资料库中的 Markdown，展示项目进展和带原文行号的行动候选项。点击来源可以在 Obsidian 中打开笔记。它不会修改任何笔记，也不需要独立工作台的本地服务器。

## 构建与安装

在本仓库根目录运行：

```bash
npm ci
npm run build:obsidian
```

构建产物位于 `obsidian-plugin/dist/`，包含 `main.js`、`manifest.json`、`styles.css`；仓库根目录的 `manifest.json` 是版本信息的唯一来源。将三个构建文件复制到**独立测试资料库**的 `.obsidian/plugins/wiki-workbench-companion/`，然后在 Obsidian 的社区插件设置中启用。请先在测试资料库中验证，不要直接用主资料库做插件开发。

通过侧边栏图标或命令面板的“打开 Wiki 工作台”进入。默认扫描当前资料库全部 Markdown；如果正文放在 `wiki/`、日报放在 `daily/`，可在插件设置中把正文目录设为 `wiki`。

## 验证

在仓库根目录运行 `npm test` 和 `npm run check:obsidian`。测试使用虚构资料库及隔离的 Obsidian 接口模拟器，覆盖插件加载、视图内容、原文行号跳转、标签切换复用扫描结果，以及笔记修改后的自动刷新。构建用 `npm run build:obsidian` 验证，随后运行 `npm run verify:obsidian-release` 检查发布附件。接口模拟不能代替真实 Obsidian 桌面版的界面和兼容性试装。

## 当前范围

- 从项目页中提取目标、进展、后续事项和来源；从日报识别同文事项的采纳与勾选完成。
- 项目识别依赖 `projects/` 目录或 `type: project`；当前按工作台默认章节标题识别。
- 项目进展暂未叠加周报，审阅选择、日报写入和移动端支持暂未实现。
- 插件依赖 Node.js 内置模块，因此标记为仅桌面版。公开发布前仍需完成真实 Obsidian 中的交互测试和社区目录检查。

插件复用独立工作台的解析逻辑。Obsidian 官方的 [Vault API](https://docs.obsidian.md/Plugins/Vault) 负责读取文件，源码不需要访问资料库的绝对路径。
