# 安装渠道与分发

推荐使用预构建 Codex 插件市场。市场分发包携带预览运行依赖，Codex 安装后直接启动 MCP。远程 Release 脚本与本地源码安装入口见 [README](../README.md#安装)。

## 市场安装与更新

用户需要 Node.js 22.12.0 或更新版本、Git，以及支持 `plugin` 命令的 Codex CLI；`node` 必须可从 `PATH` 找到。市场安装和运行无需 npm，也无需 npm 登录。

[`codex/marketplace`](https://github.com/Maker-Wen/markdown-preview/tree/codex/marketplace) 分支已发布，用户执行：

```sh
codex plugin marketplace add Maker-Wen/markdown-preview --ref codex/marketplace
codex plugin add markdown-preview@markdown-preview-marketplace
```

Codex 0.160.0 在 [app-server 启动时](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/app-server/src/message_processor.rs#L540-L559)后台检查已配置 Git 市场，有新提交后更新市场快照并[刷新已配置插件缓存](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/core-plugins/src/manager.rs#L2812-L3017)。该版本没有持续定时轮询；需要立即检查更新时，执行：

```sh
codex plugin marketplace upgrade markdown-preview-marketplace
codex plugin add markdown-preview@markdown-preview-marketplace
```

注册和更新 Git 市场需要访问仓库。插件启动不安装依赖，也不联网下载依赖。Codex 可在更新后请求 [MCP 运行环境刷新](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/app-server/src/effective_plugin_change.rs#L30-L37)，已打开的预览页面不保证立即重绘；需要时重新打开预览或开启新聊天。这里说明的是源码行为，不代表图形界面的自动更新交互已实测。

### 从同名本地市场迁移

安装脚本可能已注册同名本地市场。先查询当前注册，记录 `markdown-preview-marketplace` 本地条目的旧 `root` 绝对路径：

```sh
codex plugin marketplace list --json
```

确认需要改用已发布的 Git 分支后，移除旧注册并添加新来源：

```sh
codex plugin marketplace remove markdown-preview-marketplace
codex plugin marketplace add Maker-Wen/markdown-preview --ref codex/marketplace
codex plugin add markdown-preview@markdown-preview-marketplace
```

迁移保留原本地市场目录和插件缓存。若迁移失败且 Git 市场已注册，先执行 `codex plugin marketplace remove markdown-preview-marketplace`。然后将下面的占位路径替换为记录的旧 `root`，恢复本地来源：

```sh
codex plugin marketplace add "<旧 root 的绝对路径>"
codex plugin add markdown-preview@markdown-preview-marketplace
```

`markdown-preview@personal` 属于另一个市场，不会被上述迁移自动删除。若出现两个查看器，可在 Codex 插件页手动禁用旧的 personal 插件。

## 构建自包含市场

以下是维护者操作，需要 npm。从源码仓库根目录准备插件的两层锁定依赖，再构建市场：

正式市场应从已提交、已核对的源码构建，避免混入工作区的其他改动。可通过 `--source-commit <完整 Git SHA>` 在两类构建入口中记录来源提交；该参数只记录来源，不会替维护者恢复或核对源码。分发根目录及插件目录都会生成市场专用 README。

```sh
npm --prefix plugins/markdown-preview run setup
node scripts/build-marketplace.cjs
```

构建输出 `dist/marketplace`，可供 Codex 作为本地市场安装，也可用于发布分支。根目录的 `package.json` 是私有构建工具配置，只为市场归档声明开发依赖，不提供用户安装入口。需要归档时，准备根目录的锁定开发依赖并执行：

```sh
npm ci --include=dev --ignore-scripts
node scripts/package-marketplace.cjs
```

打包器会重新构建市场，并输出 `dist/markdown-preview-marketplace.tgz` 与 `dist/marketplace.SHA256SUMS`。分发包保留预览运行资源、第三方包 metadata 和上游包附带的许可证材料；开发测试、Playwright、平台限定依赖和原生模块不进入分发包。

Crossnote 的完整包及预览入口静态依赖闭包保留在源码的实际嵌套位置。其他生产包递归复制声明的依赖和必需 peer，并核对锁文件版本。Crossnote 的按需导出工具不属于只读预览的分发范围；浏览器 Mermaid、KaTeX 字体和样式来自 Crossnote 自带资源。上游入口格式变化、缺少依赖或出现平台组件时构建会失败，需要重新审查。

构建器只替换带匹配标记的产物目录，先在临时目录完成构建，再交换目录。默认版本为 `<base>+marketplace.<内容摘要>`，两份插件清单与包元数据保持一致；相同内容在不同输出目录得到相同版本。`--version` 可显式指定版本，维护者应保证该版本不会重复用于不同内容。

## 发布市场分支

发布器默认仅显示计划：

```sh
node scripts/publish-marketplace.cjs
```

确认产物、版本和目标仓库后执行：

```sh
node scripts/publish-marketplace.cjs --publish
```

发布器在独立临时 Git 仓库中生成 `codex/marketplace` 分发分支，不切换或修改开发工作区。更新时必须识别远程分支的构建标记，保留历史并使用正常快进推送；不会强制覆盖其他分支。Git 提交身份及远程推送权限由维护者提供。`node_modules` 是分发内容，发布器会显式加入它们，即使维护者全局忽略了该目录。

发布后，用户按本文开头的安装和更新命令使用。`main` 用于开发源码，发布后的 `codex/marketplace` 提供可直接启动的完整市场。发布市场不等于上架官方公共插件目录，也不创建新的正式 GitHub Release。维护者应从准备发布的源码版本构建产物，分别核对 Release 与市场渠道。

2026-10-05 的首个市场分发为 `1.0.0+marketplace.426e39632880453a`，来自已提交源码 `00bc7471761a62672b901d0b5e96c7738826dbba`。已在 macOS 的临时 Codex 配置中验证 GitHub 安装、市场更新，以及从最终缓存按 `mcp.json` 启动 MCP、读取 UI 资源并渲染 Markdown。该记录不代表 Windows/Linux 或 Codex 图形界面的宿主交互已验证。

同名本地来源迁移到 Git、再回退到原本地来源也已在临时配置中实测：插件保持安装及启用状态，原本地市场目录保留。

## 验证

```sh
node --test tests/test-marketplace-package.cjs tests/test-marketplace-publisher.cjs
node --test tests/test-marketplace-install.cjs
```

分发测试归档后移动包到独立目录，在禁网且关闭全局依赖搜索的进程中执行完整样例渲染与 UI 资源装配。市场安装测试使用临时 Codex 配置，实际安装市场，再按插件清单从最终缓存完成 MCP 初始化、资源读取与 Markdown 渲染。缺少 Codex CLI 或未生成分发目录时该项会跳过；需要把缺失前提视为失败时，设置 `MARKDOWN_PREVIEW_REQUIRE_CODEX=1`。发布后可通过 `MARKDOWN_PREVIEW_MARKETPLACE_GIT=Maker-Wen/markdown-preview` 和 `MARKDOWN_PREVIEW_MARKETPLACE_REF=codex/marketplace` 验证真实 Git 安装及市场更新，仍使用临时配置。

三平台 CI 下载 Linux 构建的同一份市场归档和摘要，校验后从最终插件缓存完成 MCP 启动检查。远程 Release 脚本的下载与参数处理由对应测试覆盖；真实安装及宿主交互仍需单独验证。

本地验证与 CI、真实用户设备及公开发行是不同证据。macOS 本地结果不代表 Windows/Linux 已运行，也不能代替实际用户在 Codex 界面选择查看器的验证。
