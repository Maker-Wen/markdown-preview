# 市场分发

本文面向维护者，说明自包含 Codex 插件市场的构建、归档和发布。用户安装与更新见 [README](../README.md#安装)，源码 Release 见[发布指南](releasing.md)。

## 构建与归档

使用 Node.js 22.12.0 或更新版本，从干净、已提交的源码工作区构建：

```sh
npm ci --include=dev --ignore-scripts
npm run setup --prefix plugins/markdown-preview
node scripts/build-marketplace.cjs --source-commit "$(git rev-parse HEAD)"
```

输出目录为 `dist/marketplace`。`--source-commit` 记录来源提交，不切换源码；构建前应确认工作区与该提交一致。

需要归档时执行：

```sh
node scripts/package-marketplace.cjs --source-commit "$(git rev-parse HEAD)"
```

打包器重新构建市场并生成：

| 产物 | 用途 |
| --- | --- |
| `dist/marketplace/` | 可直接安装或发布的市场目录 |
| `dist/markdown-preview-marketplace.tgz` | 市场归档 |
| `dist/marketplace.SHA256SUMS` | 归档的 SHA-256 摘要 |

分发包包含预览运行资源、生产依赖、包 metadata 和上游附带的许可证材料。Crossnote 保留完整包；其他依赖按预览入口的依赖闭包复制，并核对锁文件版本。开发测试、Playwright、平台限定依赖和原生模块不进入分发包。上游入口或依赖结构变化导致构建失败时，应重新审查分发范围。

默认版本为 `<base>+marketplace.<内容摘要>`，两份插件清单与包元数据保持一致。使用 `--version` 指定版本时，同一版本应对应同一内容。构建器只替换带匹配管理标记的输出目录，构建完成后才交换目录。

归档与校验和先在输出父目录的临时目录中准备完整，再备份旧文件并替换最终文件。准备或替换失败时，恢复这两份文件原有的内容与存在状态；已有目录或符号链接不会被覆盖。若恢复失败，错误会给出保留的备份目录；成功后仅清理失败则发出警告，已生成的归档与校验和仍有效。

这项恢复保证覆盖可捕获的打包错误。市场目录仍由构建器独立更新；同一输出位置应串行打包，进程被强制终止或断电时不保证两份文件同时切换。

## 验证

```sh
node --test tests/test-marketplace-package.cjs tests/test-marketplace-publisher.cjs
MARKDOWN_PREVIEW_REQUIRE_CODEX=1 node --test tests/test-marketplace-install.cjs
```

安装测试需要支持 `plugin` 命令的 Codex CLI 和已构建的 `dist/marketplace`。可通过 `MARKDOWN_PREVIEW_TEST_CODEX` 指定 CLI 路径。PowerShell 先设置 `$env:MARKDOWN_PREVIEW_REQUIRE_CODEX = '1'`，再执行测试命令。

归档测试在独立目录中禁网渲染样例；安装测试使用临时 Codex 配置，检查插件版本及启用状态，再从最终缓存读取 `mcp.json` 并启动 MCP，验证资源和 Markdown 渲染。三平台 CI 校验同一份归档及摘要，并执行缓存启动检查。

## 发布市场分支

确认产物和验证结果后，先查看发布计划：

```sh
node scripts/publish-marketplace.cjs
```

核对版本、目标仓库和分支，再发布：

```sh
node scripts/publish-marketplace.cjs --publish
```

发布器需要 Git 提交身份和远程推送权限。默认目标为 `Maker-Wen/markdown-preview` 的 `codex/marketplace` 分支，可通过 `--source`、`--repo`、`--ref` 指定来源和目标。

发布器使用独立临时仓库，保留远程分支历史并正常快进推送。已有分支必须含有效构建标记；并发更新冲突时重新核对远程状态后重试。运行依赖会随市场提交，开发工作区保持原样。

发布后验证 Git 安装及更新：

```sh
MARKDOWN_PREVIEW_MARKETPLACE_GIT=Maker-Wen/markdown-preview \
MARKDOWN_PREVIEW_MARKETPLACE_REF=codex/marketplace \
  node --test tests/test-marketplace-install.cjs
```

测试使用临时配置，并以本地 `dist/marketplace` 的版本为预期值。保留本次构建目录，发布后在 Codex 中选择查看器并检查渲染。
