# 兼容性与宿主接口

核对日期：2026-09-30。Codex 版本：26.928.20755（build 12246）。宿主升级后应重新验证本页列出的行为。

## 文件打开行为

Markdown Preview 通过 MCP 文件查看器入口声明支持 `.md` 和 `.markdown`。查看器的选择由 Codex 宿主决定。

| 入口 | 当前证据 |
| --- | --- |
| 打开菜单中选择 Markdown Preview | 已确认可打开插件预览 |
| 普通单击 Markdown 文件 | 用户已确认：完成一次首选查看器选择后，普通点击会打开 Markdown Preview |
| 首次未设置首选查看器的普通单击 | 宿主静态路由仍优先识别内置 Markdown 查看器 |
| 重启后的首选查看器 | 宿主代码显示按扩展保存首选查看器；本轮未做真实重启复测 |
| 打开带行号的 Markdown 链接 | 继续使用宿主原有打开规则，插件不接管行号定位 |

首次使用请在文件查看器菜单中选择 **Open in ChatGPT → Markdown Preview**。Codex 会保存 `.md` 扩展名的首选查看器；需要恢复内置查看器时，在同一菜单中选择 **Built-in**。

插件不修改 Codex 安装包、启动设置或默认查看器规则，也不运行后台适配程序。安装器不会替换 Codex 包。

## 文件查看器接口

| 标识 | 值 |
| --- | --- |
| 插件 ID | `markdown-preview` |
| MCP 配置名称 | `markdown_preview` |
| MCP 服务名称 | `markdown-preview-mcp-server` |
| 文件查看工具 | `markdown_preview_open` |
| UI 资源 | `ui://markdown-preview/reader-v1.html` |
| 文件扩展名 | `.md`、`.markdown` |

工具输入包含 `file.name` 和 `file.resourceUri`。资源 URI 必须以 `codex-resource://` 开头，文件的绝对路径由宿主通过 `_meta["openai/resource"].path` 提供。工具不接受任意文件路径参数。

插件校验文件名、路径和 Markdown 扩展名后读取文件。图片解析限制在文档目录内，并校验解析后的真实路径。文档内本地链接通过宿主的 `openai/files/open` 打开，外部链接通过 `ui/open-link` 打开。

## 验证范围

MCP 测试覆盖工具注册、资源加载、文件校验和渲染结果。浏览器测试覆盖阅读界面、目录、主题和源码复制。两类测试独立于 Codex 运行，不能替代实际宿主中的文件点击验证。

本次已确认普通点击在完成一次首选查看器选择后可进入插件。Windows 安装流程仅完成静态检查，尚无真实 Windows 设备证据；重启后的首选查看器持久化也尚未在本轮实际复测。
