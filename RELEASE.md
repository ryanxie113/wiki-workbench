# 公开发布前检查

此目录是与私人 Wiki 分离的本地 Git 仓库。发布时应创建一个全新的远程仓库，只推送此目录的历史；不要从原工作仓库导入提交历史。

- [x] 使用者已确认源码、界面素材与示例内容可以公开发布。
- [x] 已选 MIT 许可证，在根目录加入正式 `LICENSE`，并在 `package.json` 标明许可；保留 `private: true` 以避免误发 npm。
- [x] 已审阅跟踪文件与提交历史，未发现私钥、令牌、内部地址、个人路径或真实业务内容。
- [x] 已在独立干净检出运行 `npm ci`、`npm test`、5,000 篇虚构笔记基准测试，并验证示例资料库与无 frontmatter 的外部 Markdown 目录均可启动。
- [x] 建立远程仓库后，配置私密漏洞报告入口，并将地址写入 `SECURITY.md`。
- [x] 确认 CI 成功，并公开远程仓库。
- [ ] 完成插件实机验证后创建首个版本标签。

公开仓库：[ryanxie113/wiki-workbench](https://github.com/ryanxie113/wiki-workbench)。2026-10-07 的 [CI 检查](https://github.com/ryanxie113/wiki-workbench/actions/runs/37565390030) 已覆盖 Linux（Node.js 20/22）、macOS 和 Windows 的测试、类型检查、插件构建与附件校验。

## Obsidian 社区目录提交

官方要求公开 GitHub 仓库的根目录包含 `README.md`、`LICENSE`、`manifest.json`。本仓库已按此准备；`manifest.json` 的插件 ID 为 `wiki-workbench-companion`，版本为 `0.1.0`。构建产物必须作为同版本号 GitHub Release 的**三个独立附件**上传：`main.js`、`manifest.json` 和 `styles.css`，不能只上传 ZIP。推送 `0.1.0` 标签后，发布工作流会在测试通过时创建 Release。

- [x] 根目录插件清单、许可证、用途与限制说明；源码和构建脚本可公开审阅。
- [x] 虚构资料库的无界面集成测试、类型检查、构建与附件一致性检查。
- [ ] 在真实 Obsidian 桌面版中用独立测试资料库验证安装、启动、视图、设置和原文跳转。
- [x] 建立公开 GitHub 仓库并推送本目录的独立历史，确认 CI 通过。
- [ ] 推送与清单一致的 `0.1.0` 标签，核对 GitHub Release 的三个独立附件。
- [ ] 在 [Obsidian 社区目录](https://community.obsidian.md) 登录 Obsidian 账号、连接 GitHub 账号，并提交公开仓库地址；处理自动审阅结果。

官方流程见 [Submit your plugin](https://docs.obsidian.md/Plugins/Releasing/Submit%20your%20plugin) 和 [Submission requirements](https://docs.obsidian.md/community-directory/submission-requirements-for-plugins)。
