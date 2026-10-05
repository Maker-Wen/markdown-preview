# Markdown Preview

**Markdown Preview 1.0.0** 是面向 Codex 的 Markdown 文件查看器。它在文件标签页中提供目录导航、代码高亮、KaTeX 公式、Mermaid 图表、本地图片和源码视图，支持 `.md` 与 `.markdown` 文件。

Markdown 解析与基础渲染基于 [Crossnote](https://github.com/shd101wyy/crossnote)。本项目提供 Codex 文件查看器接入、本地资源处理、安全边界和阅读界面。

## 功能

- 标题目录、表格、任务列表和代码语法高亮。
- KaTeX 数学公式与 Mermaid 图表。
- 文档目录内的本地图片，以及本地文件和外部链接。
- 阅读视图与源码视图切换，保留源码字符和复制内容。
- 浅色、深色和跟随系统的阅读主题。
- 只读展示，禁用文档脚本、代码执行和文件导入。

## 安装

### Codex 插件市场

推荐通过 Codex 插件市场安装。需要 Node.js 22.12.0 或更新版本、Git，以及支持 `plugin` 命令的 Codex CLI；`node` 必须可从 `PATH` 找到。市场安装和运行无需 npm，也无需 npm 登录。

预构建分发分支 [`codex/marketplace`](https://github.com/Maker-Wen/markdown-preview/tree/codex/marketplace) 已发布，携带插件及预览运行依赖。执行：

```sh
codex plugin marketplace add Maker-Wen/markdown-preview --ref codex/marketplace
codex plugin add markdown-preview@markdown-preview-marketplace
```

已核实的 Codex 0.160.0 会在 app-server 启动时后台检查 Git 市场并更新已配置插件缓存；这是启动时检查，不是持续定时轮询。见官方[启动流程](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/app-server/src/message_processor.rs#L540-L559)与[市场及缓存更新实现](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/core-plugins/src/manager.rs#L2812-L3017)。需要立即检查更新时，执行：

```sh
codex plugin marketplace upgrade markdown-preview-marketplace
codex plugin add markdown-preview@markdown-preview-marketplace
```

分发版本包含内容摘要，源码或锁定依赖变化时会生成新的缓存版本。插件启动不安装依赖，也不联网下载依赖；注册和更新 Git 市场时需要访问仓库。Codex 可在更新后请求 [MCP 运行环境刷新](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/app-server/src/effective_plugin_change.rs#L30-L37)，已打开的预览页面不保证立即重绘；需要时重新打开预览或开启新聊天。

### 从本地市场迁移

如果之前使用安装脚本注册了同名本地市场，先执行下列只读命令，记录 `markdown-preview-marketplace` 条目的旧 `root` 绝对路径：

```sh
codex plugin marketplace list --json
```

确认该条目是需要迁移的本地市场后，移除市场注册并改用已发布的 Git 分支：

```sh
codex plugin marketplace remove markdown-preview-marketplace
codex plugin marketplace add Maker-Wen/markdown-preview --ref codex/marketplace
codex plugin add markdown-preview@markdown-preview-marketplace
```

这些步骤不删除原本地市场目录或已安装的插件缓存。若迁移失败且 Git 市场已经注册，先执行 `codex plugin marketplace remove markdown-preview-marketplace`。然后把下面的占位路径替换为刚记录的旧 `root`，恢复本地来源：

```sh
codex plugin marketplace add "<旧 root 的绝对路径>"
codex plugin add markdown-preview@markdown-preview-marketplace
```

`markdown-preview@personal` 属于另一个市场。上述迁移不会自动删除该入口；如同时显示两个查看器，可在 Codex 插件页手动禁用旧的 personal 插件。

### 远程脚本

远程脚本保留为 GitHub Release 安装渠道，需要 Node.js 22.12.0 或更新版本、npm 和支持 `plugin` 的 Codex CLI。以下固定入口安装最新正式 Release；重复执行可更新：

macOS / Linux：

```sh
curl -fsSL https://raw.githubusercontent.com/Maker-Wen/markdown-preview/main/install-remote.sh | sh
```

Windows PowerShell：

```powershell
irm https://raw.githubusercontent.com/Maker-Wen/markdown-preview/main/install-remote.ps1 | iex
```

远程脚本默认使用 `latest`，先解析最新正式 Release 的标签，再下载该标签的归档和 `SHA256SUMS` 并校验。macOS / Linux 使用 `.tar.gz`，Windows 使用 `.zip`。下载来源是已发布的 Release；`main` 仅提供安装入口。仓库地址和版本可以通过 `MARKDOWN_PREVIEW_REPOSITORY`、`MARKDOWN_PREVIEW_VERSION` 覆盖。

需要安装指定版本时，例如：

```sh
curl -fsSL https://raw.githubusercontent.com/Maker-Wen/markdown-preview/main/install-remote.sh | MARKDOWN_PREVIEW_VERSION=v1.0.0 sh
```

检查下载、校验及安装计划而不安装插件：

```sh
curl -fsSL https://raw.githubusercontent.com/Maker-Wen/markdown-preview/main/install-remote.sh | sh -s -- --dry-run
```

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

安装器会准备生产依赖、运行 MCP 自检、注册自有市场 `markdown-preview-marketplace`，并安装 `markdown-preview`。重复执行本地安装入口可更新当前源码的部署；默认安装目录为用户主目录下的 `.local/share/markdown-preview/marketplace`。

## 更新

Crossnote 与 Markdown Preview 分别发布版本。插件通过依赖声明和锁文件固定 Crossnote 版本；上游发布新版本后，需要验证兼容性，再随新的插件版本分发。已安装的插件不会自动跟随上游更新。

仓库的 [Dependabot 配置](.github/dependabot.yml) 每周检查 renderer 的 Crossnote 更新，更新精确依赖声明和对应锁文件并提出 PR。[验证工作流](.github/workflows/validate.yml) 自动运行现有 MCP、浏览器、安装器及发布包检查。维护者仍负责审查、合并和发版；CI 不会自动合并 PR 或发布插件。

市场安装按上面的启动检查或手动命令更新。本地源码安装先更新源码，再重新执行本地入口。Release 脚本重跑同一命令即可更新到最新正式版；显式指定版本时仍安装该版本。历史 `v1.0.0` 脚本地址仍会安装 `v1.0.0`。

维护者升级 Crossnote 的具体步骤见[开发指南中的依赖维护](docs/development.md#依赖维护)。

## 使用

安装完成后，打开新的 Codex 聊天以加载插件。首次使用时，在 Markdown 文件的查看器菜单中选择 **Open in ChatGPT → Markdown Preview**。本次会话已确认，选择一次后，后续直接点击 `.md` 文件会进入 Markdown Preview。

Codex 仍由宿主决定文件查看器。首次没有首选查看器时，普通 `.md` 点击可能进入内置查看器；插件不会修改 Codex 安装包、启动设置或默认路由。详见[兼容性说明](docs/compatibility.md)。

## 本地开发

从仓库根目录执行：

```sh
cd plugins/markdown-preview
NPM_CONFIG_ENGINE_STRICT=true npm run setup
npm test
npm run test:browser
```

安装器回归测试：

```sh
node --test tests/test-node-version.cjs tests/test-installer.cjs
```

开发、测试和发布流程见[开发指南](docs/development.md)与[发布指南](docs/releasing.md)。

## 项目结构

```text
docs/                        开发、兼容性与发布说明
.agents/plugins/             自有市场清单
install.sh / install.ps1     本地安装入口
install-remote.sh / .ps1    GitHub Release 远程安装入口
scripts/install.cjs          安装与更新流程
scripts/build-marketplace.cjs 自包含市场构建器
scripts/publish-marketplace.cjs 分发分支发布入口（默认只显示计划）
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
| [安装渠道与分发](docs/distribution.md) | 市场安装、迁移、构建、验证及发布 |
| [更新日志](CHANGELOG.md) | 版本变更记录 |
| [Markdown 示例](plugins/markdown-preview/tests/fixtures/markdown-sample.md) | 渲染功能与浏览器测试样例 |

## 致谢

感谢 [Crossnote](https://github.com/shd101wyy/crossnote) 作者 Yiyi Wang（[shd101wyy](https://github.com/shd101wyy)）及所有贡献者。本插件复用 Crossnote 的 Markdown 引擎和部分渲染资源，相关开源许可见 [Crossnote LICENSE](https://github.com/shd101wyy/crossnote/blob/develop/LICENSE.md)。

同时感谢 [KaTeX](https://github.com/KaTeX/KaTeX)、[Mermaid](https://github.com/mermaid-js/mermaid) 和 [Prism](https://github.com/PrismJS/prism) 等项目提供公式、图表和代码高亮能力。
