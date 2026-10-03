# Wiki Workbench

一个在本机运行的 Markdown 工作台。它扫描你指定的资料库，提供项目摘要、全文搜索、原文阅读、`[[wikilink]]` 跳转和可选的每日记录。默认只读，资料不会上传。

目前界面为中文，适合个人资料库；它不是多用户在线服务。阅读器支持常见 Markdown 的嵌套列表、任务清单、表格、代码块与图片。复杂 Obsidian 插件语法仍可能无法完整显示。

## 五分钟试用

需要 Node.js 20 或更新版本。

```bash
npm ci
npm start
```

打开 <http://127.0.0.1:4173>。默认展示 `examples/demo-vault/` 中的虚构内容。此时工作台只读。

读取自己的 Markdown 文件夹：

```bash
npm start -- --vault /absolute/path/to/notes
```

任何 `.md` 文件都能搜索和阅读，不要求 YAML frontmatter 或根索引。`projects/` 内的页面自动进入项目视图；也可以用 `type: project` 标记。项目摘要从 `Goal`、`Progress`、`Next steps` 等标题提取，并始终提供原文入口。

## 适配结构化 Wiki

如果资料库用 `wiki/` 保存正文、`daily/` 保存日报、根目录 `index.md` 保存索引，可以这样启动：

```bash
npm start -- --vault /absolute/path/to/vault --content-dir wiki --daily-dir daily --index index.md --time-zone Asia/Shanghai
```

`--content-dir` 限定主要扫描目录，同时仍读取日报目录与根索引。可重复使用 `--exclude relative/path` 排除目录。缺少索引时不显示“未入索引”提示。

只有在确认日报模板适合自己时才启用写入：

```bash
npm start -- --vault /absolute/path/to/vault --content-dir wiki --write-daily
```

写入功能需要资料库内已有 `daily/_template.md`。默认识别“今日计划”下的 P1/P2/P3 清单和“时间线”表格。启动时会检查模板，格式不匹配就拒绝创建日报。

其他格式可通过 `--daily-format` 指定 JSON 配置，例如 [英文配置](examples/daily-format.en.json) 对应 [英文模板](examples/daily-template.en.md)：

```bash
npm start -- --vault /absolute/path/to/vault --write-daily --daily-format examples/daily-format.en.json
```

将示例模板复制到所选资料库的 `daily/_template.md` 后再启用该配置。可设置 `planHeading`、`timelineHeading` 和三个 `priorityLabels`；模板可使用 `{{date}}`、`{{week}}`、`{{weekday}}` 占位符。时间线必须是“时间、内容、项目”三列表格。`--daily-dir` 可更改目录，`--time-zone` 使用 IANA 时区名称。运行 `npm start -- --help` 查看所有参数。

## 文件与隐私边界

- 服务只监听 `127.0.0.1`，不会把资料传到远端。不要直接暴露到公网。
- 默认不写文件。`--write-daily` 只允许修改指定日报目录中的当日文件；其他 Markdown、原始资料和索引保持只读。
- 扫描跳过隐藏目录、`node_modules`、符号链接、超过 3 MB 的 Markdown 文件，以及 `--exclude` 指定的路径。API 读取会检查文件真实路径是否仍在资料库内。
- 本地 PNG、JPEG、GIF、WebP、AVIF 图片可在原文中显示，单文件上限 10 MB。远端图片只提供手动打开的链接；SVG 不以内嵌图片提供。
- 页面上的日期来自文档记录，不代表项目今天仍在推进。打开原文核对后再采纳任务。

## 开发

`npm run bench` 会在临时目录生成 600 篇虚构笔记，测量首次扫描、连续刷新和 100 次搜索；结束后自动清理。结果仅用于比较同一机器上的版本，不代表真实资料库的绝对耗时。

```bash
npm test
npm run bench
npm run dev
```

测试仅使用 `examples/demo-vault/` 和临时生成的虚构文件，不依赖任何私人 Wiki。贡献方式见 [CONTRIBUTING.md](CONTRIBUTING.md)，安全报告方式见 [SECURITY.md](SECURITY.md)。

本仓库的源码与样例库应与任何私人资料库分开管理。公开远程仓库时，只推送本目录的独立 Git 历史，不要导入私人资料库或其提交历史。

## 许可证

代码采用 [MIT 许可证](LICENSE)。`package.json` 保留 `private: true`，只表示暂不向 npm 发布包，不影响源码仓库的开源许可。
