# 发布指南

GitHub Release 提供源码归档和远程安装所需的校验文件。自包含 `codex/marketplace` 分支独立发布，流程见[市场分发](distribution.md)。

## 准备版本

在已合并的源码提交上发布，确认工作区干净，并完成[开发指南](development.md#测试)中的测试和生产依赖审计。

同步两份插件清单、仓库根目录与服务层及 renderer 的包和锁文件根版本、MCP 服务上报版本、页面握手的 `appInfo.version`、安装器自检客户端版本、发布打包器的默认版本，以及 `CHANGELOG.md`。确认 `.agents/plugins/marketplace.json` 仍指向 `./plugins/markdown-preview`，市场名称为 `markdown-preview-marketplace`。

后续命令从仓库根目录执行，版本取自插件清单：

```sh
release_version="$(node -p "require('./plugins/markdown-preview/plugin.json').version")"
release_tag="v$release_version"
```

## 打包

在具备 `tar` 和 `zip` 的 macOS / Linux 环境运行：

```sh
node scripts/package-release.cjs --version "$release_version"
```

产物位于 `dist/`：

| 文件 | 用途 |
| --- | --- |
| `markdown-preview-v<version>.tar.gz` | macOS / Linux 源码归档 |
| `markdown-preview-v<version>.zip` | Windows 源码归档 |
| `SHA256SUMS` | 两份归档的 SHA-256 摘要 |

打包器保留安装入口、源码、清单和锁文件，排除依赖缓存、Git 数据及测试输出。`--version` 设置归档名称，不改写包内版本；上传前检查归档根目录和清单版本一致。

在 `dist/` 中校验摘要：macOS 使用 `shasum -a 256 -c SHA256SUMS`，Linux 使用 `sha256sum -c SHA256SUMS`。

## 标签与 Release

```sh
git tag -a "$release_tag" -m "Markdown Preview $release_version"
git push origin "$release_tag"
```

标签推送触发[发布工作流](../.github/workflows/release.yml)，完成测试并上传源码归档、市场归档及摘要作为 Actions 产物。手动运行工作流时，版本取自插件清单。工作流完成后，由维护者创建 GitHub Release。

使用本地已校验的产物创建正式 Release：

```sh
gh release create "$release_tag" --verify-tag --latest \
  --title "Markdown Preview $release_version" --notes-file CHANGELOG.md \
  "dist/markdown-preview-$release_tag.tar.gz" \
  "dist/markdown-preview-$release_tag.zip" \
  dist/SHA256SUMS
```

远程脚本默认解析最新正式 Release，再从该固定标签下载归档和 `SHA256SUMS`。归档名称和上传内容必须与摘要一致；用户安装命令见 [README](../README.md#安装)。

## 发布验收

1. 核对标签指向的源码提交、Release 版本及全部资产名称。
2. 下载发布后的两份归档，用同一 Release 的 `SHA256SUMS` 校验。
3. 固定本次版本，验证远程脚本下载、参数转发和安装。
4. 检查 Codex 中插件版本、安装及启用状态，验证 MCP 资源和 Markdown 渲染。
5. 在各支持平台完成查看器选择、普通 Markdown 点击及重启后的交互验收，详见[兼容性说明](compatibility.md)。

macOS / Linux 可固定版本执行：

```sh
MARKDOWN_PREVIEW_VERSION="$release_tag" sh install-remote.sh --dry-run
MARKDOWN_PREVIEW_VERSION="$release_tag" sh install-remote.sh
```

Windows PowerShell：

```powershell
$env:MARKDOWN_PREVIEW_VERSION = "v$(node -p "require('./plugins/markdown-preview/plugin.json').version")"
.\install-remote.ps1 --dry-run
.\install-remote.ps1
```

源码安装失败时按安装器提示恢复或重试，处理方式见[本地源码安装](development.md#本地源码安装)。
