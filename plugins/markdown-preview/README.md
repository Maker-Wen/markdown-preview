# Markdown Preview 插件市场

Codex Markdown 查看器，支持保存后自动更新、浏览器预览、目录、代码高亮、KaTeX、Mermaid、本地图片和源码查看。

由 [yomori](https://github.com/Maker-Wen) 维护。查看 [功能截图与使用说明](https://github.com/Maker-Wen/markdown-preview#readme)。

## 安装

需要 Node.js 22.12.0+、Git 和支持 `plugin` 命令的 Codex CLI，`node` 须在 PATH 中。运行依赖随包提供。

```sh
codex plugin marketplace add Maker-Wen/markdown-preview --ref codex/marketplace
codex plugin add markdown-preview@markdown-preview-marketplace
```

打开新聊天，在 Markdown 文件的查看器菜单选择 **Open in ChatGPT → Markdown Preview** 。

保存已打开的文件后，正文、源码和目录自动更新，并保留阅读位置和目录设置。点击“在浏览器打开”可在默认浏览器中阅读；使用时保持当前 Codex 聊天开启。主题跟随系统，预览保持只读。

## 更新

手动检查市场并安装更新：

```sh
codex plugin marketplace upgrade markdown-preview-marketplace
codex plugin add markdown-preview@markdown-preview-marketplace
```

更新后重新打开预览或新聊天。

## 分发信息

版本：`0.1.0+marketplace.ea8f31b768676964` · [源码与文档](https://github.com/Maker-Wen/markdown-preview/tree/51db647e0d915d2be807b802005ce6ee3292c41e)

包含预览运行依赖及上游许可证材料。
