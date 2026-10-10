# Markdown Preview

Markdown Preview 是 Codex 的 Markdown 文件查看器，支持 `.md` 和 `.markdown`，渲染基于 [Crossnote](https://github.com/shd101wyy/crossnote)。

## 功能

- 标题目录、表格、任务列表和代码语法高亮。
- KaTeX 数学公式、Mermaid 图表、本地图片，以及本地文件和外部链接。
- 阅读与源码视图切换、选区复制，主题自动跟随系统。
- 只读展示，禁用文档脚本、代码执行和文件导入。

## 安装

推荐通过 Codex 插件市场安装。需要 Node.js 22.12.0 或更新版本、Git 和支持 `plugin` 命令的 Codex CLI；`node` 必须在 `PATH` 中。市场包已携带运行依赖，无需 npm。

```sh
codex plugin marketplace add Maker-Wen/markdown-preview --ref codex/marketplace
codex plugin add markdown-preview@markdown-preview-marketplace
```

也可使用远程 Release 脚本，需要 npm。脚本默认安装最新正式 Release，并校验下载摘要。

macOS / Linux：

```sh
curl -fsSL https://raw.githubusercontent.com/Maker-Wen/markdown-preview/main/install-remote.sh | sh
```

Windows PowerShell：

```powershell
irm https://raw.githubusercontent.com/Maker-Wen/markdown-preview/main/install-remote.ps1 | iex
```

## 更新

Codex 0.160.0 在启动时后台检查 Git 市场。需要立即检查更新时，执行：

```sh
codex plugin marketplace upgrade markdown-preview-marketplace
```

Release 脚本重复执行即可更新到最新正式版。更新后可重新打开预览；已有页面不保证立即刷新。

## 使用

安装后打开新的 Codex 聊天，在 Markdown 文件的查看器菜单中选择 **Open in ChatGPT → Markdown Preview**。Codex 使用保存的首选查看器；选择 **Built-in** 可返回内置查看器。

## 使用范围

- 本地图片仅从文档目录及其子目录读取；外部图片以说明文字替代。
- 保存文件后自动刷新预览；宿主不支持自动刷新时，页面会显示提示。
- 点击“在浏览器打开”可在默认浏览器阅读，并跟随当前文件保存自动刷新；使用时保持 Codex 聊天开启。
- 文档内标题链接支持页内跳转；跨文件标题链接只打开目标文件。
- 本地文件链接需要宿主提供 `openai/files` 扩展。
- 实际处理能力取决于内容复杂度、可用内存和宿主限制。

## 开发与文档

- [开发指南](docs/development.md)：环境准备、测试和本地源码安装。
- [兼容性说明](docs/compatibility.md)：Codex 查看器行为与宿主接口。
- [分发说明](docs/distribution.md)：市场构建、更新和发布。
- [发布指南](docs/releasing.md)：GitHub Release 与远程脚本。
- [更新日志](CHANGELOG.md)与 [Markdown 示例](plugins/markdown-preview/tests/fixtures/markdown-sample.md)。

## 致谢

感谢 [Crossnote](https://github.com/shd101wyy/crossnote)、[KaTeX](https://github.com/KaTeX/KaTeX)、[Mermaid](https://github.com/mermaid-js/mermaid) 和 [Prism](https://github.com/PrismJS/prism) 的作者及贡献者。Crossnote 的许可见 [LICENSE](https://github.com/shd101wyy/crossnote/blob/develop/LICENSE.md)。
