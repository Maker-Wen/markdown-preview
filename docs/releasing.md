# 发布指南

本文定义 Markdown Preview 的 GitHub 自有市场发布流程。以下以 `v1.0.0` 为版本示例，发布时应替换为实际版本。发布目标是 GitHub 源码仓库、Git 标签和 GitHub Release 资产；不包含公共插件目录或工作区发布。

本文描述源码 Release 渠道。独立 npm 安装器与自包含 `codex/marketplace` 分支分别发布，流程见[安装渠道与分发](distribution.md)。发布工作流会额外生成这两类可下载的打包产物；它不会自动发布 npm 包、推送市场分支或上架官方插件目录。

## 发布信息

| 项目 | 值 |
| --- | --- |
| 仓库 | `Maker-Wen/markdown-preview` |
| 源码版本 | `1.0.0` |
| Git 标签 | `v1.0.0` |
| 默认归档 | `markdown-preview-v1.0.0.tar.gz` |
| 校验文件 | `SHA256SUMS` |
| 自有市场 | `markdown-preview-marketplace` |

仓库已创建；Release 资产和 raw 脚本 URL 要在完成推送与 Release 上传后再做远程安装验证。

## 发布前检查

在仓库根目录执行：

```sh
cd plugins/markdown-preview
NPM_CONFIG_ENGINE_STRICT=true npm run setup
npm test
npm run test:browser
cd ../..
node --test tests/test-node-version.cjs tests/test-installer.cjs
node --check scripts/install.cjs
node --check tests/test-installer.cjs
git diff --check
```

还要确认：

- `plugins/markdown-preview/plugin.json` 与 `.codex-plugin/plugin.json` 的基础版本均为 `1.0.0`。
- `.agents/plugins/marketplace.json` 指向 `./plugins/markdown-preview`，市场名称为 `markdown-preview-marketplace`。
- 归档不包含 `node_modules/`、`.git/`、开发测试输出或用户缓存。
- `SHA256SUMS` 与归档使用同一文件名和字节内容。
- 依赖审计结果已经记录，并区分已修复项和发布已知风险。

## 创建 Release 资产

归档应保留安装器所需的源码、清单、运行时依赖声明和远程安装脚本。不要把开发依赖目录直接打进源码归档；本地安装器和远程安装器会在目标机器准备生产依赖。

示意命令：

```sh
tar --exclude='node_modules' --exclude='.git' -czf markdown-preview-v1.0.0.tar.gz .
shasum -a 256 markdown-preview-v1.0.0.tar.gz > SHA256SUMS
```

最终归档内容应由发布者检查；上面的命令不是跨平台打包器的替代实现。Windows 端的安装脚本使用同一 Release 资产，当前尚无真实 Windows 设备发布证据。

## 创建标签和 GitHub Release

```sh
git add README.md CHANGELOG.md docs install.sh install.ps1 install-remote.sh install-remote.ps1 scripts plugins .agents tests .github .gitignore
git commit -m "release: markdown preview v1.0.0"
git tag -a v1.0.0 -m "Markdown Preview 1.0.0"
git push origin <branch>
git push origin v1.0.0
```

在 GitHub Release 中上传：

- `markdown-preview-v1.0.0.tar.gz`
- `SHA256SUMS`

推送前应先确认远程仓库和分支名，不能用占位值执行命令。GitHub Release 创建后，再把真实 raw 地址写入分发说明或项目主页。

## 远程安装

远程安装脚本不要求用户手动 clone：

```sh
curl -fsSL https://raw.githubusercontent.com/Maker-Wen/markdown-preview/main/install-remote.sh | sh
```

Windows PowerShell：

```powershell
irm https://raw.githubusercontent.com/Maker-Wen/markdown-preview/main/install-remote.ps1 | iex
```

脚本默认使用 `Maker-Wen/markdown-preview` 与 `latest`，先解析最新正式 Release 的标签，再下载该标签的归档和 `SHA256SUMS`，校验成功后调用包内安装器。归档和校验文件均使用解析出的固定标签，避免下载过程中发布新版本造成混用。维护者应将正式 Release 标记为最新版本，并上传匹配文件名的归档及摘要；无需随版本修改安装脚本的默认值或用户安装命令。需要临时切换源或版本时，使用：

```sh
MARKDOWN_PREVIEW_REPOSITORY=Maker-Wen/markdown-preview \
MARKDOWN_PREVIEW_VERSION=v1.0.0 \
  sh install-remote.sh
```

远程脚本至少应验证 Node.js 22.12.0、归档摘要、目标目录和安装失败后的清理；它不应修改 Codex 安装包或启动方式。

## 发布后验证

发布者应分别记录：

1. Git 标签和 Release 资产可下载。
2. `SHA256SUMS` 能校验归档。
3. macOS / Linux 远程安装完成后，Codex 报告插件为已安装并启用。
4. MCP 自检、插件页面和一次实际文件查看器选择成功。
5. 普通 `.md` 点击在完成一次首选查看器选择后进入 Markdown Preview。
6. Windows 安装与重启后偏好持久化的证据（目前均未完成，不得写成已验证）。

本地测试、宿主运行、Release 资产和用户设备验证应分开记录，不能用其中一类证据替代其他类别。
