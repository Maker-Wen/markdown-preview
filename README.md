# Markdown Preview

**Markdown Preview 1.0.0** 是面向 Codex 的 Markdown 文件查看器。它在文件标签页中提供目录导航、代码高亮、KaTeX 公式、Mermaid 图表、本地图片和源码视图，支持 `.md` 与 `.markdown` 文件。

## 功能

- 标题目录、表格、任务列表和代码语法高亮。
- KaTeX 数学公式与 Mermaid 图表。
- 文档目录内的本地图片，以及本地文件和外部链接。
- 阅读视图与源码视图切换，保留源码字符和复制内容。
- 浅色、深色和跟随系统的阅读主题。
- 只读展示，禁用文档脚本、代码执行和文件导入。

## 安装

需要 Node.js 20.3 或更新版本、npm，以及支持 `plugin` 命令的 Codex CLI。

正式版本提供不需要手动 clone 的远程安装入口。仓库发布后，使用对应版本的安装脚本：

macOS / Linux：

```sh
curl -fsSL https://raw.githubusercontent.com/Maker-Wen/markdown-preview/v1.0.0/install-remote.sh | sh
```

Windows PowerShell：

```powershell
irm https://raw.githubusercontent.com/Maker-Wen/markdown-preview/v1.0.0/install-remote.ps1 | iex
```

远程脚本默认下载 GitHub Release 的 `markdown-preview-v1.0.0.tar.gz`，并使用同一 Release 中的 `SHA256SUMS` 校验。仓库地址和版本可以通过 `MARKDOWN_PREVIEW_REPOSITORY`、`MARKDOWN_PREVIEW_VERSION` 覆盖。

已经取得源码时，可在仓库根目录执行本地安装：

```sh
./install.sh                 # macOS / Linux
.\install.ps1                # Windows PowerShell
node scripts/install.cjs     # 跨平台入口
```

也可以直接从 Git 来源安装指定标签，无需手动 clone：

```sh
node scripts/install.cjs --repo <Git URL> --ref v1.0.0
```

安装器会准备生产依赖、运行 MCP 自检、注册自有市场 `markdown-preview-marketplace`，并安装 `markdown-preview`。重复执行可更新安装；默认安装目录为用户主目录下的 `.local/share/markdown-preview/marketplace`。

## 使用

安装完成后，打开新的 Codex 聊天以加载插件。首次使用时，在 Markdown 文件的查看器菜单中选择 **Open in ChatGPT → Markdown Preview**。本次会话已确认，选择一次后，后续直接点击 `.md` 文件会进入 Markdown Preview。

Codex 仍由宿主决定文件查看器。首次没有首选查看器时，普通 `.md` 点击可能进入内置查看器；插件不会修改 Codex 安装包、启动设置或默认路由。详见[兼容性说明](docs/compatibility.md)。

## 本地开发

从仓库根目录执行：

```sh
cd plugins/markdown-preview
npm run setup
npm test
npm run test:browser
```

安装器回归测试：

```sh
node --test tests/test-installer.cjs
```

开发、测试和发布流程见[开发指南](docs/development.md)与[发布指南](docs/releasing.md)。

## 项目结构

```text
docs/                        开发、兼容性与发布说明
.agents/plugins/             自有市场清单
install.sh / install.ps1     本地安装入口
install-remote.sh / .ps1    GitHub Release 远程安装入口
scripts/install.cjs          安装与更新流程
plugins/markdown-preview/    可安装的插件包
```

## 使用范围

- 文档和图片的实际处理能力取决于内容复杂度、可用内存及宿主限制。
- 本地图片仅从文档所在目录及其子目录读取。
- 文件修改后需关闭并重新打开预览；当前不订阅文件变化。
- 文档内的标题链接支持页内跳转；跨文件标题链接只打开目标文件。
- 本地文件链接需要宿主提供 `openai/files` 扩展。

## 文档

| 文档 | 内容 |
| --- | --- |
| [开发指南](docs/development.md) | 环境准备、代码结构、测试与安装更新 |
| [兼容性说明](docs/compatibility.md) | Codex 文件打开行为与 MCP 接口 |
| [发布指南](docs/releasing.md) | v1.0.0 标签、Release 资产和远程安装入口 |
| [更新日志](CHANGELOG.md) | 版本变更记录 |
| [Markdown 示例](plugins/markdown-preview/tests/fixtures/markdown-sample.md) | 渲染功能与浏览器测试样例 |
