# 开发指南

本文面向维护 Markdown Preview 1.0.0 源码、测试本地改动和准备 GitHub Release 的开发者。

## 环境准备

- Node.js 22.12.0 或更新版本。
- npm，以及锁文件声明的服务和渲染依赖。
- Codex CLI，且支持 `plugin` 命令；仅运行单元和浏览器测试时不需要正在运行的 Codex。
- 浏览器测试需要 Playwright 支持的 Chromium；也可以指定本机 Chrome/Chromium。

从仓库根目录进入插件目录。环境准备与插件测试命令均在该目录执行：

```sh
cd plugins/markdown-preview
NPM_CONFIG_ENGINE_STRICT=true npm run setup
```

`setup` 根据两份锁文件执行 `npm ci`，安装开发依赖和可选平台依赖，并禁用依赖安装脚本。`node_modules/` 不纳入版本控制。渲染依赖位于 `runtime/renderer/`，插件运行时不依赖仓库外部的模块缓存。

`NPM_CONFIG_ENGINE_STRICT=true` 会让不满足依赖 Node.js 要求的安装直接失败。验证最低支持版本时，先确认 `node --version` 为 `v22.12.0`，再运行上述命令。PowerShell 使用 `$env:NPM_CONFIG_ENGINE_STRICT = 'true'` 后再执行 `npm run setup`。

## 代码结构

| 路径 | 职责 |
| --- | --- |
| `plugin.json`、`.codex-plugin/plugin.json` | 插件标识、版本和展示信息 |
| `mcp.json` | 本地 MCP 服务启动配置 |
| `scripts/server.cjs` | 注册文件查看器、校验宿主上下文并返回渲染结果 |
| `scripts/files.cjs` | 读取普通文件并校验读取期间的文件变化 |
| `scripts/render.cjs` | 解析 Markdown、处理本地图片并组装阅读页面 |
| `assets/viewer.html` | 目录、主题、源码视图与图表展示 |
| `assets/host-bridge.js` | MCP Apps 通信及文件、外部链接打开请求 |
| `scripts/test-mcp.cjs` | MCP 服务与渲染回归测试 |
| `scripts/test-browser.cjs` | 独立浏览器回归测试 |
| `tests/fixtures/markdown-sample.md` | 浏览器测试使用的 Markdown 样例 |
| `scripts/install.cjs` | 本地来源、Git 来源和生产依赖安装 |
| `install-remote.sh`、`install-remote.ps1` | 下载 GitHub Release 资产并调用本地安装器 |

文件访问保持只读；本地图片的真实路径必须位于文档目录内。

## 测试

运行 MCP 与渲染测试：

```sh
npm test
```

安装测试浏览器并运行界面回归：

```sh
npx playwright install chromium
npm run test:browser
```

已有兼容 Chromium 时，可指定可执行文件路径：

```sh
PLAYWRIGHT_EXECUTABLE_PATH=/path/to/chromium npm run test:browser
```

浏览器测试在独立无头进程中运行，检查图表、公式、目录、主题、源码复制、链接通信和页面异常。该测试不会连接正在运行的 Codex。

从仓库根目录运行安装器回归测试：

```sh
node --test tests/test-node-version.cjs tests/test-installer.cjs
```

独立 `npx` 安装器与可直接安装的 Codex 市场另需根目录的锁定依赖。构建、分发测试及发布说明见[安装渠道与分发](distribution.md)。三平台 CI 使用同一份市场归档检查安装后的插件缓存，并从同一份 npm 安装包检查实际入口；配置 CI 不代表已取得各平台运行结果。

还应在提交前运行脚本语法检查和差异检查：

```sh
node --check scripts/install.cjs
node --check scripts/test-installer.cjs
git diff --check
```

这些检查验证本地组件和安装器逻辑，不替代真实 Codex 文件点击、Windows 设备或发布资产下载验证。

## 安装与更新

已经取得源码时，使用仓库根目录入口：

```sh
./install.sh                 # macOS / Linux
.\install.ps1                # Windows PowerShell
node scripts/install.cjs     # 跨平台入口
```

安装需要 Node.js 22.12.0 或更新版本、npm，以及支持 `plugin` 命令的 Codex CLI。CLI 优先从 `PATH` 查找，macOS 下也尝试应用内附带的 CLI；使用 `--repo` 时还需要 Git。

安装器在临时区域复制可分发源码、安装生产依赖，并在准备目录中执行独立 MCP 校验，然后注册 `markdown-preview-marketplace` 市场并安装其中的 `markdown-preview` 插件。安装后的 `mcp.json` 使用运行安装器的 Node.js 绝对路径。默认安装目录为用户主目录下的 `.local/share/markdown-preview/marketplace`。

安装器参数：

| 参数 | 用途 |
| --- | --- |
| `--source PATH` | 使用本地仓库作为来源，默认使用安装器所在仓库 |
| `--repo URL` | 从指定 Git 仓库获取源码 |
| `--ref REF` | 选择远程仓库的分支或标签 |
| `--install-dir PATH` | 指定安装市场的绝对路径 |
| `--codex PATH` | 指定 Codex CLI 可执行文件 |
| `--dry-run` | 只读检查并显示安装计划 |
| `--help` | 显示用法 |

远程 Release 安装不要求手动 clone。`install-remote.sh` 和 `install-remote.ps1` 默认使用正式仓库和 `latest`，先解析最新正式 Release 的标签，再按该固定标签下载归档与 `SHA256SUMS`，校验通过后调用包内安装器。macOS / Linux 使用 `.tar.gz`，Windows 使用 `.zip`。查询失败或标签不符合版本格式时直接退出，不回退到旧版本。可使用以下环境变量指定来源或固定版本：

```sh
MARKDOWN_PREVIEW_REPOSITORY=Maker-Wen/markdown-preview
MARKDOWN_PREVIEW_VERSION=v1.0.0
```

远程脚本在 GitHub Release 发布后即可使用；发布前不要把尚未上传的 Release 资产当作可用下载地址。

安装版本格式为 `<base>+codex.<hash>`。摘要由可分发源码、运行平台与架构、Node.js 路径及安装器内容生成；正式发布时基础版本固定为 `1.0.0`，部署摘要仍由安装环境生成。

## 安装结果与宿主确认

安装完成后，打开新的 Codex 聊天以加载插件。首次使用时，在文件查看器菜单中选择 **Open in ChatGPT → Markdown Preview**。选择一次后，普通 Markdown 点击会使用保存的首选查看器；Codex 仍负责保存和应用该偏好。

安装器会核对插件版本及启用状态，但不检查页面显示、普通点击路由或重启后的偏好持久化。实际交互按[兼容性说明](compatibility.md)单独核对。

若已安装其他市场中的同名插件，可在 Codex 插件页禁用旧入口以免重复显示。安装器不会覆盖其他市场条目，也不会修改 Codex 启动方式或默认查看器规则。

## 发布前流程

1. 确认两个插件清单的基础版本均为 `1.0.0`。
2. 运行 MCP、浏览器、安装器、语法和差异检查。
3. 创建 `markdown-preview-v1.0.0.tar.gz`，只包含可分发源码和必要安装入口，不包含开发依赖缓存。
4. 生成 `SHA256SUMS`，并核对压缩包校验值。
5. 创建 Git 标签 `v1.0.0`，将源码和 Release 资产发布到 GitHub 自有仓库。
6. 发布后再验证远程脚本下载、校验、安装和 Codex 插件状态。

完整清单见[发布指南](releasing.md)。

## 命名约定

- 展示名称统一为 **Markdown Preview**；目录和包名称使用 `markdown-preview` 前缀。
- MCP 配置、工具和资源标识属于集成接口，具体值见[兼容性说明](compatibility.md#文件查看器接口)。修改时需同步清单、服务、宿主集成及测试。
- 测试脚本使用 `test-*.cjs`，固定样例放在 `tests/fixtures/`。
- 版本标签使用 `vMAJOR.MINOR.PATCH`，正式首版为 `v1.0.0`。

## 依赖维护

Crossnote 在 `plugins/markdown-preview/runtime/renderer/package.json` 中使用精确版本声明，实际依赖由该目录的 `package-lock.json` 固定。服务层的 `plugins/markdown-preview/package-lock.json` 独立维护。上游发布新版不会自动替换已安装依赖，`npm ci` 也只会按现有锁文件重建依赖。

升级时，从仓库根目录查询 npm 已发布的版本，再阅读上游的发布说明和目标版本之间的变更，选择要验证的确切版本：

```sh
npm view crossnote version
npm view crossnote versions --json
```

下面仅以 `0.9.41` 展示受控升级命令；执行前应核对当时的发布内容和目标版本：

```sh
npm --prefix plugins/markdown-preview/runtime/renderer install --save-exact --ignore-scripts crossnote@0.9.41
```

此命令更新 renderer 的 `package.json` 和 `package-lock.json`。检查两者差异及传递依赖变化；Crossnote 升级本身不要求改动服务层的锁文件，也不应混入无关依赖升级。

如果传递依赖提高最低 Node.js 版本，应同步两层包与锁文件的根 `engines.node`、安装入口、文档和 CI。

依赖变更后，从仓库根目录准备测试环境并运行现有检查：

```sh
NPM_CONFIG_ENGINE_STRICT=true npm run setup --prefix plugins/markdown-preview
npm test --prefix plugins/markdown-preview
npm run test:browser --prefix plugins/markdown-preview
node --test tests/test-node-version.cjs tests/test-installer.cjs
node tests/test-release-package.cjs
node tests/test-remote-installer.cjs
git diff --check
```

浏览器检查需要按前文准备 Chromium。还应分别审计服务层和 renderer 的生产依赖，并将审计结果记录在发布审查中：

```sh
npm audit --prefix plugins/markdown-preview --omit=dev
npm audit --prefix plugins/markdown-preview/runtime/renderer --omit=dev
```

复核本插件自有 parser 规则、上游生成的 HTML、KaTeX 字体、Mermaid 脚本和样式文件路径，以及本地图片与链接处理。上述组件测试通过后，还需在真实 Codex 中检查文件查看器选择、普通 Markdown 点击和渲染交互；它们不能替代宿主验证，也不代表 Windows 已验证。

插件版本与 Crossnote 版本独立。升级经验证后，按[发布指南](releasing.md)发布新的插件版本：同步两份插件清单、相关包版本元数据、MCP 服务与界面上报版本、打包器默认版本和更新日志，再创建对应 Git 标签和 Release 资产。远程脚本继续默认使用 `latest`，README 中的 `main` 固定入口无需随版本修改。用户重跑该命令后取得最新正式版及其新依赖；历史 `v1.0.0` 脚本入口或显式指定的版本仍只安装该版本。

仓库已配置[Dependabot](../.github/dependabot.yml)，每周检查 `plugins/markdown-preview/runtime/renderer` 中 Crossnote 的更新。直接依赖跟踪范围仅为 Crossnote；升级 PR 更新其精确版本声明和 renderer 锁文件，传递依赖的变化也需一起审查。上面的手动流程可用于维护者主动选择目标版本或处理升级失败。

[验证工作流](../.github/workflows/validate.yml) 自动对 PR 和 `main` 分支推送，在 Node.js 22.12.0 和 24.x 上启用严格 engine 校验，运行现有 MCP、浏览器、安装器版本边界、安装器、发布包与远程安装器检查。检查失败时先定位依赖变化带来的影响；检查通过后，仍需维护者阅读差异并完成上述真实 Codex 复核，再决定合并和发版。组件检查不代表 Windows 或用户设备已经验证。

当前流程不会自动合并 PR、发布插件或更新用户端安装。用户取得已发布的新版本仍需运行对应安装命令；依赖升级和漏洞处置不应隐含在版本号修改中。
