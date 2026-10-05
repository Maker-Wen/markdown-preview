# 开发指南

本文说明源码环境、测试、本地安装和依赖维护。用户安装与更新见 [README](../README.md#安装)。

## 环境准备

- Node.js 22.12.0 或更新版本，以及 npm。
- 本地安装需要支持 `plugin` 命令的 Codex CLI；Git 来源安装还需要 Git。
- 浏览器测试需要 Chromium 或兼容的 Chrome。

以下命令均从仓库根目录执行：

```sh
npm ci --include=dev --ignore-scripts
NPM_CONFIG_ENGINE_STRICT=true npm run setup --prefix plugins/markdown-preview
```

`setup` 按服务层和 `runtime/renderer` 的两份锁文件安装依赖，包含开发依赖及可选平台依赖，并禁用安装脚本。`node_modules/` 不纳入源码版本控制。

验证最低支持版本时，使用 Node.js 22.12.0 并启用严格 engine 校验。PowerShell 可先设置 `$env:NPM_CONFIG_ENGINE_STRICT = 'true'`，再执行 `npm run setup --prefix plugins/markdown-preview`。

## 代码结构

以下路径相对于 `plugins/markdown-preview/`：

| 路径 | 职责 |
| --- | --- |
| `plugin.json`、`.codex-plugin/plugin.json` | 插件标识、版本和展示信息 |
| `mcp.json` | MCP 服务启动配置 |
| `scripts/server.cjs` | 注册文件查看器、校验宿主上下文并返回渲染结果 |
| `scripts/files.cjs` | 读取文件并校验读取期间的文件变化 |
| `scripts/render.cjs` | 解析 Markdown、处理本地图片并组装页面 |
| `runtime/renderer/` | 锁定的 Crossnote 渲染依赖 |
| `assets/viewer.html` | 目录、主题、源码视图与图表展示 |
| `assets/host-bridge.js` | MCP Apps 通信、文件及外部链接打开请求 |
| `scripts/test-mcp.cjs`、`scripts/test-browser.cjs` | 服务和浏览器回归测试 |
| `tests/fixtures/` | 固定测试样例 |

文件访问保持只读，本地图片的真实路径必须位于文档目录内。仓库根目录的 `scripts/install.cjs` 负责源码安装，市场构建与发布工具见[市场分发](distribution.md)。

## 测试

```sh
npm test --prefix plugins/markdown-preview
npx --prefix plugins/markdown-preview playwright install chromium
npm run test:browser --prefix plugins/markdown-preview
node --test tests/test-node-version.cjs tests/test-installer.cjs
node tests/test-release-package.cjs
node tests/test-remote-installer.cjs
git diff --check
```

已有兼容 Chromium 时，可通过 `PLAYWRIGHT_EXECUTABLE_PATH` 指定可执行文件，再运行浏览器测试。

服务测试覆盖 MCP 与渲染逻辑；浏览器测试覆盖图表、公式、目录、主题、源码复制和链接通信。宿主中的查看器选择及普通 Markdown 点击按[兼容性说明](compatibility.md)验收。市场产物测试见[市场分发](distribution.md#验证)。

## 本地源码安装

macOS / Linux：

```sh
./install.sh
```

Windows PowerShell：

```powershell
.\install.ps1
```

也可使用跨平台入口 `node scripts/install.cjs`。重跑同一命令可更新本地安装。

安装器在临时目录准备源码和生产依赖，完成 MCP 自检后注册市场并安装插件。默认安装目录为 `~/.local/share/markdown-preview/marketplace`，安装后的 MCP 配置使用当前 Node.js 的绝对路径。

| 参数 | 用途 |
| --- | --- |
| `--source PATH` | 本地源码目录，默认为安装器所在仓库 |
| `--repo URL`、`--ref REF` | Git 来源及分支或标签 |
| `--install-dir PATH` | 市场安装的绝对路径 |
| `--codex PATH` | Codex CLI 可执行文件 |
| `--dry-run` | 检查环境并显示安装计划 |
| `--help` | 显示用法 |

安装器只替换带管理标记的目标目录。若同名市场指向其他路径，应使用原安装位置或先处理市场配置。失败时按输出提示重试；如提示遗留安装锁，确认没有安装任务后再移除。目录回滚后仍需重跑安装器核对 Codex 配置与缓存。

## 依赖维护

Crossnote 使用精确版本声明，由 `runtime/renderer/package-lock.json` 固定；服务层的 `package-lock.json` 独立维护。`npm ci` 按锁文件重建依赖。

升级前查询已发布版本，并审阅目标版本的变更：

```sh
npm view crossnote version
npm view crossnote versions --json
```

将 `X.Y.Z` 替换为选定版本后执行：

```sh
npm --prefix plugins/markdown-preview/runtime/renderer install --save-exact --ignore-scripts crossnote@X.Y.Z
```

审查 renderer 的包声明、锁文件和传递依赖差异；服务层锁文件仅在其依赖发生变化时更新。若最低 Node.js 要求提高，同步两层包和锁文件的 `engines.node`、安装入口、文档及 CI。

重新执行环境准备和测试，并审计两层生产依赖：

```sh
npm audit --prefix plugins/markdown-preview --omit=dev
npm audit --prefix plugins/markdown-preview/runtime/renderer --omit=dev
```

重点复核 Markdown 规则、生成的 HTML、KaTeX 字体、Mermaid 资源、本地图片及链接处理，再完成 Codex 中的渲染验收。插件版本与 Crossnote 版本独立，发版流程见[发布指南](releasing.md)。

[Dependabot](../.github/dependabot.yml) 每周检查 Crossnote 更新。升级 PR 的精确版本和传递依赖仍需审查。

## 命名约定

- 展示名称为 **Markdown Preview**，目录和包名称使用 `markdown-preview` 前缀。
- MCP 标识见[接口说明](compatibility.md#mcp-接口)，修改时同步清单、服务和测试。
- 测试脚本使用 `test-*.cjs`，固定样例位于 `tests/fixtures/`。
- 正式版本标签使用 `vMAJOR.MINOR.PATCH`。
