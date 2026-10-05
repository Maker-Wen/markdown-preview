# Markdown Preview 1.0.0

Markdown Preview 是 Codex 的 Markdown 文件查看器，支持 `.md` 和 `.markdown` 文档，在文件标签页中提供目录导航、代码高亮、KaTeX 公式、Mermaid 图表、本地图片和源码查看。

Markdown 解析与基础渲染基于 [Crossnote](https://github.com/shd101wyy/crossnote)。本项目负责 Codex 文件查看器接入、本地资源处理、安全边界和阅读界面。

## 安装

推荐通过 Codex 插件市场安装。需要 Node.js 22.12.0 或更新版本、Git 和支持 `plugin` 命令的 Codex CLI；`node` 必须可从 `PATH` 找到。市场安装和运行无需 npm，也无需 npm 登录。

携带预览运行依赖的 [`codex/marketplace`](https://github.com/Maker-Wen/markdown-preview/tree/codex/marketplace) 分支已发布。执行：

```sh
codex plugin marketplace add Maker-Wen/markdown-preview --ref codex/marketplace
codex plugin add markdown-preview@markdown-preview-marketplace
```

Codex 0.160.0 会在 app-server 启动时后台检查 Git 市场并更新已配置插件缓存；该版本没有持续定时轮询。见官方[启动流程](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/app-server/src/message_processor.rs#L540-L559)与[更新实现](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/core-plugins/src/manager.rs#L2812-L3017)。需要立即检查更新时，执行：

```sh
codex plugin marketplace upgrade markdown-preview-marketplace
codex plugin add markdown-preview@markdown-preview-marketplace
```

插件启动不安装或下载依赖；注册和更新 Git 市场时需要访问仓库。Codex 可在更新后请求 [MCP 运行环境刷新](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/app-server/src/effective_plugin_change.rs#L30-L37)，已打开的预览页面不保证立即重绘；需要时重新打开预览或开启新聊天。

### 迁移已有本地市场

先查看当前市场，记录 `markdown-preview-marketplace` 本地条目的旧 `root` 绝对路径：

```sh
codex plugin marketplace list --json
```

需要改用已发布的 Git 分支时，执行：

```sh
codex plugin marketplace remove markdown-preview-marketplace
codex plugin marketplace add Maker-Wen/markdown-preview --ref codex/marketplace
codex plugin add markdown-preview@markdown-preview-marketplace
```

迁移保留原本地市场目录和插件缓存。若迁移失败且 Git 市场已注册，先执行 `codex plugin marketplace remove markdown-preview-marketplace`。然后将占位路径替换为旧 `root`，恢复本地来源：

```sh
codex plugin marketplace add "<旧 root 的绝对路径>"
codex plugin add markdown-preview@markdown-preview-marketplace
```

`markdown-preview@personal` 属于另一个市场，不会被自动删除。若出现两个查看器，可在 Codex 插件页手动禁用旧的 personal 入口。

### Release 脚本与本地源码

Release 脚本需要 Node.js 22.12.0 或更新版本、npm 和支持 `plugin` 的 Codex CLI。以下固定入口安装最新正式 Release；重复执行可更新：

```sh
curl -fsSL https://raw.githubusercontent.com/Maker-Wen/markdown-preview/main/install-remote.sh | sh
```

Windows PowerShell：

```powershell
irm https://raw.githubusercontent.com/Maker-Wen/markdown-preview/main/install-remote.ps1 | iex
```

远程脚本默认使用 `latest`，先解析最新正式 Release 的标签，再下载该标签的归档和 `SHA256SUMS`，校验后执行安装。macOS / Linux 使用 `.tar.gz`，Windows 使用 `.zip`；`main` 仅提供安装入口，安装内容来自已发布的 Release。可用 `MARKDOWN_PREVIEW_REPOSITORY`、`MARKDOWN_PREVIEW_VERSION` 覆盖默认源和版本。

已经取得源码时，在仓库根目录执行：

```sh
./install.sh                 # macOS / Linux
.\install.ps1                # Windows PowerShell
node scripts/install.cjs     # 跨平台入口
```

安装器准备运行依赖，在注册市场前验证准备目录中的 MCP 服务，再从 `markdown-preview-marketplace` 市场安装插件。更新本地源码后重新执行本地安装入口，可更新部署。安装器生成的插件缓存不会随源码修改自动同步。

### 独立 npx 安装器

GitHub 入口使用 `main` 中的独立安装器，下载并安装最新正式 GitHub Release。需要 Node.js 22.12.0 或更新版本、npm、Git 和支持 `plugin` 的 Codex CLI：

```sh
npx --yes github:Maker-Wen/markdown-preview
```

暂用 npm 包名 `@maker-wen/markdown-preview-installer` 尚未发布，短包名入口也尚不可用。渠道说明见[源码仓库](https://github.com/Maker-Wen/markdown-preview)中的 `docs/distribution.md`。

## 更新

插件通过依赖声明和锁文件固定 Crossnote 版本。源码仓库的 [Dependabot 配置](https://github.com/Maker-Wen/markdown-preview/blob/main/.github/dependabot.yml) 每周检查 renderer 的 Crossnote 更新，更新精确依赖声明和对应锁文件并提出 PR；[验证工作流](https://github.com/Maker-Wen/markdown-preview/blob/main/.github/workflows/validate.yml) 自动运行现有 MCP、浏览器、安装器及发布包检查。维护者验证兼容性后决定是否合并和发布新的 Markdown Preview 版本。

CI 不会自动合并 PR 或发布插件。插件依赖只随维护者发布的插件版本更新，不会直接跟随 Crossnote 上游版本。

市场安装按上面的启动检查或手动命令更新。Release 脚本及 GitHub `npx` 安装器重跑同一命令即可更新到最新正式版；显式指定版本或使用历史 `v1.0.0` 脚本入口时仍安装该版本。维护者的依赖升级步骤见源码仓库的[依赖维护说明](https://github.com/Maker-Wen/markdown-preview/blob/main/docs/development.md#依赖维护)。

## 使用

安装完成后，打开新的 Codex 聊天以加载插件。首次使用时，从 Markdown 文件的查看器菜单选择 **Open in ChatGPT → Markdown Preview**。Codex 保存首选查看器后，普通点击 `.md` 文件会直接打开 Markdown Preview；选择 **Built-in** 可恢复内置查看器。

Codex 26.928.20755 的宿主路由仍决定首次普通点击的查看器。本次已确认选择一次后普通点击可以进入插件；重启后的持久化尚未在本轮实际复测。插件不会修改 Codex 安装包、启动方式或默认查看器规则。

## 支持范围

- 表格、任务列表、代码高亮、数学公式和 Mermaid 图表。
- 当前文档目录内的本地图片；外部图片以说明文字替代。
- 保留原文字符与换行的源码查看和选区复制。
- 只读展示；文档脚本、代码执行及文件导入均禁用。
- 实际可处理大小取决于内容复杂度、可用内存和宿主能力。

本地文件链接需要宿主提供 `openai/files` 扩展，网页链接由宿主处理。无法打开时，预览页面会显示错误信息。

## 开发

以下说明面向完整源码仓库；安装器生成的插件包不包含测试脚本和样例。需要 Node.js 22.12.0 或更新版本，在源码仓库的插件目录执行：

```sh
NPM_CONFIG_ENGINE_STRICT=true npm run setup
npm test
npm run test:browser
```

浏览器测试使用 Playwright 启动独立无头浏览器，不连接 Codex。固定样例位于 `tests/fixtures/markdown-sample.md`。安装器回归测试在仓库根目录执行：

```sh
node --test tests/test-node-version.cjs tests/test-installer.cjs
```

更多说明见源码仓库的[开发指南](https://github.com/Maker-Wen/markdown-preview/blob/main/docs/development.md)、[兼容性说明](https://github.com/Maker-Wen/markdown-preview/blob/main/docs/compatibility.md)和[发布指南](https://github.com/Maker-Wen/markdown-preview/blob/main/docs/releasing.md)。

## 分发说明

本目录包含插件清单、MCP 服务、预览页面及渲染依赖声明。自包含市场包携带预览运行依赖，版本为 `<base>+marketplace.<内容摘要>`；保留上游包附带的许可证材料。Release 安装器根据源码和运行环境生成 `<base>+codex.<hash>` 部署版本。自有市场清单位于源码仓库的 `.agents/plugins/marketplace.json`。安装器负责本机部署，不上传源码或创建 GitHub Release。

## 致谢

感谢 [Crossnote](https://github.com/shd101wyy/crossnote) 作者 Yiyi Wang（[shd101wyy](https://github.com/shd101wyy)）及所有贡献者提供 Markdown 引擎和渲染资源。相关开源许可见 [Crossnote LICENSE](https://github.com/shd101wyy/crossnote/blob/develop/LICENSE.md)。

同时感谢 [KaTeX](https://github.com/KaTeX/KaTeX)、[Mermaid](https://github.com/mermaid-js/mermaid) 和 [Prism](https://github.com/PrismJS/prism) 等开源项目。
