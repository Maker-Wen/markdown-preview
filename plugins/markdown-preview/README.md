# Markdown Preview 插件市场

这是 Markdown Preview 的预构建 Codex 分发分支，提供目录导航、代码高亮、KaTeX 公式、Mermaid 图表、本地图片和源码视图。

## 安装

需要 Node.js 22.12.0 或更新版本（`node` 在 PATH 中）、Git，以及支持 `plugin` 命令的 Codex CLI。运行依赖已随市场分发，安装时无需 npm。

```sh
codex plugin marketplace add Maker-Wen/markdown-preview --ref codex/marketplace
codex plugin add markdown-preview@markdown-preview-marketplace
```

打开新的 Codex 聊天，在 Markdown 文件的查看器菜单中选择 **Open in ChatGPT → Markdown Preview**。查看器选择及偏好保存由 Codex 宿主管理。

## 更新

```sh
codex plugin marketplace upgrade markdown-preview-marketplace
codex plugin add markdown-preview@markdown-preview-marketplace
```

更新后打开新的聊天。市场版本包含插件内容摘要，避免不同内容共用同一个插件缓存。

## 已有安装

如果曾通过远程脚本或源码安装同名市场，先用 `codex plugin marketplace list --json` 记录旧市场的绝对路径，再移除该市场配置并按上面的命令添加 Git 市场：

```sh
codex plugin marketplace remove markdown-preview-marketplace
```

移除配置保留原本的本地市场目录。若迁移失败，可移除 Git 市场配置，再用 `codex plugin marketplace add <旧市场绝对路径>` 和 `plugin add` 恢复原渠道。`markdown-preview@personal` 属于另一市场；如同时安装，可在插件页禁用旧入口。

## 分发信息

版本：`1.0.0+marketplace.426e39632880453a`。源码提交：`00bc7471761a62672b901d0b5e96c7738826dbba`。

[源码与开发文档](https://github.com/Maker-Wen/markdown-preview/tree/00bc7471761a62672b901d0b5e96c7738826dbba)。本分支携带预览所需的生产依赖及上游包附带的许可证材料；维护源码位于源码分支。
