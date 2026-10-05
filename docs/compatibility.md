# 兼容性与宿主接口

## 文件打开

首次使用时，在 Markdown 文件的查看器菜单选择 **Open in ChatGPT → Markdown Preview**。首选查看器由 Codex 管理，选择 **Built-in** 可切回内置查看器。

插件通过 MCP 声明支持 `.md` 和 `.markdown`，文件点击和带行号链接的打开方式由宿主决定。

## MCP 接口

| 标识 | 值 |
| --- | --- |
| 插件 ID | `markdown-preview` |
| MCP 配置名称 | `markdown_preview` |
| MCP 服务名称 | `markdown-preview-mcp-server` |
| 文件查看工具 | `markdown_preview_open` |
| UI 资源 | `ui://markdown-preview/reader-v1.html` |

工具输入为 `file.name` 和 `file.resourceUri`。URI 以 `codex-resource://` 开头，绝对路径由宿主通过 `_meta["openai/resource"].path` 提供。

插件校验文件名、扩展名和真实路径后读取文件。图片限制在文档目录及其子目录内；本地文件链接通过 `openai/files/open` 打开，外部链接通过 `ui/open-link` 打开。
