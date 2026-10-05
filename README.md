# Markdown Preview 插件市场

Codex Markdown 查看器，支持目录、代码高亮、KaTeX、Mermaid、本地图片和源码查看。

## 安装

需要 Node.js 22.12.0+、Git 和支持 `plugin` 命令的 Codex CLI，`node` 须在 PATH 中。运行依赖随包提供。

```sh
codex plugin marketplace add Maker-Wen/markdown-preview --ref codex/marketplace
codex plugin add markdown-preview@markdown-preview-marketplace
```

打开新聊天，在 Markdown 文件的查看器菜单选择 **Open in ChatGPT → Markdown Preview**。

## 更新

Codex 启动时检查市场更新。手动更新：

```sh
codex plugin marketplace upgrade markdown-preview-marketplace
```

更新后重新打开预览或新聊天。

## 分发信息

版本：`1.0.0+marketplace.e0817958abec29b8` · [源码与文档](https://github.com/Maker-Wen/markdown-preview/tree/92966b8ba6863f287f3481261616bb1e79760461)

包含预览运行依赖及上游许可证材料。
