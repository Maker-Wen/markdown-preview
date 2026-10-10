# Markdown Preview

Codex 的 Markdown 文件查看器，支持 `.md` 和 `.markdown`。

## 安装

需要 Node.js 22.12.0 或更新版本、Git 和支持 `plugin` 命令的 Codex CLI；`node` 必须在 `PATH` 中。市场包已携带运行依赖，无需 npm。

```sh
codex plugin marketplace add Maker-Wen/markdown-preview --ref codex/marketplace
codex plugin add markdown-preview@markdown-preview-marketplace
```

远程脚本和更新方法见[完整安装说明](https://github.com/Maker-Wen/markdown-preview#安装)。

## 使用

安装后打开新的 Codex 聊天，从 Markdown 文件的查看器菜单选择 **Open in ChatGPT → Markdown Preview**。Codex 使用保存的首选查看器；选择 **Built-in** 可返回内置查看器。保存文件后自动刷新；插件更新后需重新打开预览。

## 支持范围

- 表格、任务列表、代码高亮、数学公式和 Mermaid 图表。
- 文档目录及子目录内的本地图片；外部图片以说明文字替代。
- 保留源码字符与换行的源码视图和选区复制。
- 保存后自动更新正文、源码和目录，保留滚动位置、源码视图及目录设置。宿主不支持自动刷新时，页面会显示提示。
- 点击“在浏览器打开”可在系统默认浏览器阅读，保留目录、公式、图表和代码高亮，并跟随当前文件保存自动刷新。浏览器页依赖当前 Codex 聊天的预览服务；本地文件链接请返回 Codex 打开。
- 只读展示，禁用文档脚本、代码执行和文件导入。
- 文档内标题链接支持页内跳转；跨文件标题链接只打开目标文件。
- 本地文件和网页链接由宿主处理；本地文件链接需要 `openai/files` 扩展。
- 实际处理能力取决于内容复杂度、可用内存和宿主限制。

## 文档

[开发指南](https://github.com/Maker-Wen/markdown-preview/blob/main/docs/development.md)、[兼容性说明](https://github.com/Maker-Wen/markdown-preview/blob/main/docs/compatibility.md)和[分发说明](https://github.com/Maker-Wen/markdown-preview/blob/main/docs/distribution.md)。

## 致谢

感谢 [Crossnote](https://github.com/shd101wyy/crossnote)、[KaTeX](https://github.com/KaTeX/KaTeX)、[Mermaid](https://github.com/mermaid-js/mermaid) 和 [Prism](https://github.com/PrismJS/prism) 的作者及贡献者。Crossnote 的许可见 [LICENSE](https://github.com/shd101wyy/crossnote/blob/develop/LICENSE.md)。
