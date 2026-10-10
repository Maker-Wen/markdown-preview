# 兼容性与宿主接口

## 文件打开

首次使用时，在 Markdown 文件的查看器菜单选择 **Open in ChatGPT → Markdown Preview** 。首选查看器由 Codex 管理，选择 **Built-in** 可切回内置查看器。

插件通过 MCP 声明支持 `.md` 和 `.markdown`，文件点击和带行号链接的打开方式由宿主决定。

## MCP 接口

| 标识 | 值 |
| --- | --- |
| 插件 ID | `markdown-preview` |
| MCP 配置名称 | `markdown_preview` |
| MCP 服务名称 | `markdown-preview-mcp-server` |
| 文件查看工具 | `markdown_preview_open` |
| 自动刷新工具 | `markdown_preview_refresh` |
| 浏览器打开工具 | `markdown_preview_open_browser` |
| UI 资源 | `ui://markdown-preview/reader-v1.html` |

工具输入为 `file.name` 和 `file.resourceUri`。URI 以 `codex-resource://` 开头，绝对路径由宿主通过 `_meta["openai/resource"].path` 提供。

插件校验文件名、扩展名和真实路径后读取文件。图片限制在文档目录及其子目录内；本地文件链接通过 `openai/files/open` 打开。HTTPS 链接优先使用宿主提供的 `openExternal`；该能力不可用时，以及 HTTP、mailto 链接，通过 `ui/open-link` 打开。打开失败时在预览中显示错误。

## 自动刷新

保存当前 Markdown 文件后，预览自动更新正文、源码和目录，并保留阅读位置、源码视图及目录设置。监听的是已打开文件的保存内容，不包含尚未保存的编辑内容或本地图片文件的单独修改。

此功能需要宿主声明 `serverTools` 并支持界面通过 `tools/call` 调用当前 MCP 服务。刷新工具仅对界面开放，使用随机监听标识与版本号；宿主必须继续提供同一文件的 `openai/resource.path`。页面不能通过刷新工具指定任意文件路径。

文件暂时删除或读取失败时，页面保留最后一次成功的内容并显示“自动刷新失败”，文件恢复后继续尝试。宿主不支持该能力时显示“自动刷新不可用”，可关闭后重新打开预览读取最新内容。

## 在浏览器打开

预览工具栏的“在浏览器打开”会调用系统默认浏览器，显示当前 Markdown 的只读阅读页。页面包含相同的公式、图表、代码高亮和目录，并跟随已打开文件的保存自动刷新；不会跟随 Codex 中其他文件的标签切换。

此入口同样需要宿主支持 `serverTools` 和 `tools/call`，每次打开都会重新校验宿主文件上下文。浏览器页面由仅监听 `127.0.0.1` 的本地服务提供，通过随机会话地址访问；本地服务拒绝不匹配的 Host、跨网站请求和任意文件路径参数。

使用浏览器阅读时需保持当前 Codex 聊天的 MCP 服务运行。会话闲置 5 分钟后失效，可从插件重新打开。网页链接在新的浏览器标签中打开，本地文件链接会提示返回 Codex 操作。
