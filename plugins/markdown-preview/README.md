# Markdown Preview

Codex 的 Markdown 预览插件（Markdown preview），支持 `.md` 和 `.markdown`，提供 KaTeX 公式、Mermaid 图表、代码高亮和目录导航。保存 Markdown 后自动更新，也可在独立浏览器阅读。

## 预览截图

实际浏览器阅读页的浅色与深色主题：

![Markdown Preview 浏览器预览，浅色主题](https://raw.githubusercontent.com/Maker-Wen/markdown-preview/main/docs/images/browser-preview-light.jpg)

![Markdown Preview 浏览器预览，深色主题](https://raw.githubusercontent.com/Maker-Wen/markdown-preview/main/docs/images/browser-preview-dark.jpg)

## 安装

需要 Node.js 22.12.0 或更新版本、Git 和支持 `plugin` 命令的 Codex CLI；`node` 必须在 `PATH` 中。市场包已携带运行依赖，无需 npm。

```sh
codex plugin marketplace add Maker-Wen/markdown-preview --ref codex/marketplace
codex plugin add markdown-preview@markdown-preview-marketplace
```

更新方法见[更新说明](https://github.com/Maker-Wen/markdown-preview#更新)。本地源码安装见[开发指南](https://github.com/Maker-Wen/markdown-preview/blob/main/docs/development.md#本地源码安装)。

## 使用

安装后打开新的 Codex 聊天，从 Markdown 文件的查看器菜单选择 **Open in ChatGPT → Markdown Preview** 。Codex 使用保存的首选查看器；选择 **Built-in** 可返回内置查看器。保存文件后自动刷新；插件更新后需重新打开预览。

## 支持范围

- 表格、任务列表、代码高亮、KaTeX 数学公式和 Mermaid 图表。
- 文档目录及子目录内的本地图片；外部图片以说明文字替代。
- 保留源码字符与换行的源码视图和选区复制。
- 保存后自动更新正文、源码和目录，保留滚动位置、源码视图及目录设置。宿主不支持自动刷新时，页面会显示提示。
- 点击“在浏览器打开”可在系统默认浏览器阅读，保留目录、公式、图表和代码高亮，并跟随当前文件保存自动刷新。浏览器页依赖当前 Codex 聊天的预览服务；本地文件链接请返回 Codex 打开。
- 只读预览。

## 文档

- [兼容性说明](https://github.com/Maker-Wen/markdown-preview/blob/main/docs/compatibility.md)：渲染范围、链接行为与宿主要求。
- [开发指南](https://github.com/Maker-Wen/markdown-preview/blob/main/docs/development.md)：环境准备、测试和本地源码安装。

## 作者

[yomori](https://github.com/Maker-Wen) 维护本插件。问题和功能建议可提交到 [GitHub Issues](https://github.com/Maker-Wen/markdown-preview/issues)。

## 致谢

感谢 [Crossnote](https://github.com/shd101wyy/crossnote)、[KaTeX](https://github.com/KaTeX/KaTeX)、[Mermaid](https://github.com/mermaid-js/mermaid) 和 [Prism](https://github.com/PrismJS/prism) 的作者及贡献者。Crossnote 的许可见 [LICENSE](https://github.com/shd101wyy/crossnote/blob/develop/LICENSE.md)。
