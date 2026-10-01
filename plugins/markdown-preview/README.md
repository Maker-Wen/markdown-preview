# Markdown Preview 1.0.0

Markdown Preview 是 Codex 的 Markdown 文件查看器，支持 `.md` 和 `.markdown` 文档，在文件标签页中提供目录导航、代码高亮、KaTeX 公式、Mermaid 图表、本地图片和源码查看。

Markdown 解析与基础渲染基于 [Crossnote](https://github.com/shd101wyy/crossnote)。本项目负责 Codex 文件查看器接入、本地资源处理、安全边界和阅读界面。

## 安装

需要 Node.js 20.3 或更新版本、npm，以及支持 `plugin` 命令的 Codex CLI。

正式版本提供无需手动 clone 的远程入口。仓库发布后，使用对应版本的脚本：

```sh
curl -fsSL https://raw.githubusercontent.com/Maker-Wen/markdown-preview/v1.0.0/install-remote.sh | sh
```

Windows PowerShell：

```powershell
irm https://raw.githubusercontent.com/Maker-Wen/markdown-preview/v1.0.0/install-remote.ps1 | iex
```

远程脚本默认下载 GitHub Release 的 `markdown-preview-v1.0.0.tar.gz` 和 `SHA256SUMS`，校验后执行安装。可用 `MARKDOWN_PREVIEW_REPOSITORY`、`MARKDOWN_PREVIEW_VERSION` 覆盖默认源和版本。

已经取得源码时，在仓库根目录执行：

```sh
./install.sh                 # macOS / Linux
.\install.ps1                # Windows PowerShell
node scripts/install.cjs     # 跨平台入口
```

安装器准备运行依赖，在注册市场前验证准备目录中的 MCP 服务，再从 `markdown-preview-marketplace` 市场安装插件。更新本地源码后重新执行本地安装入口，可更新部署。安装器生成的插件缓存不会随源码修改自动同步。

## 更新

插件通过依赖声明和锁文件固定 Crossnote 版本。源码仓库的 [Dependabot 配置](../../.github/dependabot.yml) 每周检查 renderer 的 Crossnote 更新，更新精确依赖声明和对应锁文件并提出 PR；[验证工作流](../../.github/workflows/validate.yml) 自动运行现有 MCP、浏览器、安装器及发布包检查。维护者验证兼容性后决定是否合并和发布新的 Markdown Preview 版本。

当前流程不会自动合并 PR、发布插件或更新用户端安装；现有安装不会自动替换 Crossnote。

远程更新应使用目标插件版本对应的安装入口；固定的 `v1.0.0` 命令仍会安装旧版本。更新后打开新的 Codex 聊天以加载插件。维护者的依赖升级步骤见完整源码仓库的[依赖维护说明](../../docs/development.md#依赖维护)。

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

以下说明面向完整源码仓库；安装器生成的插件包不包含测试脚本和样例。需要 Node.js 20.3 或更新版本，在源码仓库的插件目录执行：

```sh
npm run setup
npm test
npm run test:browser
```

浏览器测试使用 Playwright 启动独立无头浏览器，不连接 Codex。固定样例位于 `tests/fixtures/markdown-sample.md`。安装器回归测试在仓库根目录执行：

```sh
node --test tests/test-installer.cjs
```

更多说明见仓库根目录的[开发指南](../../docs/development.md)、[兼容性说明](../../docs/compatibility.md)和[发布指南](../../docs/releasing.md)。

## 分发说明

本目录包含插件清单、MCP 服务、预览页面及渲染依赖声明。正式版本基础版本为 `1.0.0`；安装器根据源码和运行环境生成 `<base>+codex.<hash>` 部署版本。自有市场清单位于源码仓库的 `.agents/plugins/marketplace.json`。安装器负责本机部署，不上传源码或创建 GitHub Release。

## 致谢

感谢 [Crossnote](https://github.com/shd101wyy/crossnote) 作者 Yiyi Wang（[shd101wyy](https://github.com/shd101wyy)）及所有贡献者提供 Markdown 引擎和渲染资源。相关开源许可见 [Crossnote LICENSE](https://github.com/shd101wyy/crossnote/blob/develop/LICENSE.md)。

同时感谢 [KaTeX](https://github.com/KaTeX/KaTeX)、[Mermaid](https://github.com/mermaid-js/mermaid) 和 [Prism](https://github.com/PrismJS/prism) 等开源项目。
