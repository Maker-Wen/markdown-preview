# Markdown 增强阅读

在 Codex 中点击普通 `.md` 或 `.markdown` 文件后，自动打开增强阅读页面，支持目录、代码高亮、KaTeX 公式、Mermaid 图表和源码切换。

## 项目结构

Git 仓库根目录只保存项目说明和开发配置；可安装插件位于 `plugins/markdown-file-viewer/`，以下代码路径均相对于这个目录。

## 代码入口

| 文件 | 职责 |
| --- | --- |
| `mcp.json` | 启动本地 MCP 服务 |
| `scripts/server.cjs` | 注册文件查看器，校验宿主文件上下文 |
| `scripts/files.cjs` | 限制读取大小，拒绝非普通文件和末级符号链接 |
| `scripts/render.cjs` | 解析 Markdown，处理本地图片并组装阅读页面 |
| `assets/viewer.html` | 目录、主题、源码切换与 Mermaid 显示 |
| `assets/host-bridge.js` | 通过 MCP Apps 宿主接口打开文件和链接 |
| `tests/reader.md` | 浏览器回归使用的固定样例 |

渲染器在第一次打开文件或读取页面资源时加载，避免每个任务启动时都加载完整渲染依赖。

文档中的本地链接支持相对路径、绝对路径及中文和空格文件名，由 Codex 选择对应的 Markdown、代码或图片查看器。本页标题链接在页面内跳转；跨文件标题链接目前只打开目标文件。宿主不支持或拒绝打开时，页面显示错误原因。

源码按换行分段显示，保留原文和选区复制的字符，减少大文档切换时的布局开销。完全没有换行的长文本仍作为单段显示。

## 安装与检查

需要 Node.js 20.3 或更新版本，当前在 macOS Apple Silicon 上验证了 Node.js 24.13。首次获取项目后，从仓库根目录执行：

```sh
cd plugins/markdown-file-viewer
npm run setup
npm test
```

`setup` 使用两份锁文件执行 `npm ci`，保留所需的可选平台依赖，并禁用依赖安装脚本。`node_modules/` 不纳入 Git；不依赖 Dream Skin 或其他工具的缓存。

Playwright 已固定为开发依赖。需要浏览器检查时，先安装对应 Chromium，再执行离线页面检查：

```sh
npx playwright install chromium
npm run test:browser
```

如果已有兼容的 Chromium，可用 `PLAYWRIGHT_EXECUTABLE_PATH` 指定路径，跳过浏览器下载。Playwright 只用于开发检查，阅读插件不依赖它。

浏览器检查会打印截图和结果的临时目录，只启动独立无头浏览器，不连接正在运行的 Codex。

## 依赖与更新

安装到 Codex 的插件包包含已准备好的依赖；Git 仓库只提交代码、清单与锁文件。插件更新前先执行 `npm run setup`，确保两层依赖均已安装。

本机保留原来的个人市场入口：`~/plugins/markdown-file-viewer` 指向此项目中的 `plugins/markdown-file-viewer/`。个人市场配置和插件 ID 保持不变。

`plugin.json` 与 `.codex-plugin/plugin.json` 的版本必须保持一致。用 Codex 的插件更新流程生成新版本后，重新安装：

```sh
codex plugin add markdown-file-viewer@personal
```

仅修改源码不会替换已安装的插件缓存。当前任务需要立即加载更新时，可在插件管理中禁用后重新启用一次；否则下次正常启动 Codex 加载。

其他电脑需要先将插件注册到其 Codex 个人市场，不能直接假定上述本机入口已经存在。

## 依赖审计记录

2026-09-25 按锁文件全新安装后，`npm audit` 报告服务包 6 项依赖告警，其中 3 项为 high；渲染包 19 项，其中 10 项为 high。这些受影响版本均来自迁移前的依赖，新增的 Playwright 开发依赖不在本次告警列表中。

本次保留现有运行版本，没有自动执行 `npm audit fix`。功能检查通过不代表这些告警已消除；后续升级需结合实际调用路径和回归结果处理。可在插件目录重新检查：

```sh
npm audit
npm --prefix runtime/renderer audit
```

## 当前边界

- 单个 Markdown 文件上限为 1 MiB，本地图片合计上限为 5 MiB
- 仅嵌入当前文档目录内的本地图片，外部图片显示占位说明
- 文档只读，禁用脚本、代码执行和导入其他文件
- 修改文档后可关闭并重新打开；当前没有文件变化订阅
- 文件链接显式带行号时，当前 Codex 会走原生源码查看路径
- 文档内打开本地文件需要宿主提供 `openai/files` 扩展，外部链接仍受宿主支持的协议范围限制
- 文件查看器入口依赖当前 Codex 客户端扩展，升级后需要做兼容检查
