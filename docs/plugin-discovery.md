# 插件发现与公开上架评估

查证日期：2026-10-10。本文面向维护者，区分现有 GitHub 分发与 OpenAI 公共插件目录，并记录当前文件查看器需要保留的宿主依赖。

## 现有分发与公共目录

公开 GitHub 仓库可供他人访问，添加本项目的 Git marketplace 后可安装插件；这不会自动将插件加入所有用户的默认搜索。OpenAI 将本地、仓库市场与 ChatGPT / Codex 共用的公共插件目录分开，前者用于开发、测试和团队分发。[官方分发说明](https://developers.openai.com/plugins/build/plugins)、[本项目安装入口](../README.md#安装)

| 渠道 | 用户如何发现和使用 | 依据 |
| --- | --- | --- |
| GitHub 仓库 | 通过仓库链接了解功能，按安装说明使用已发布的 marketplace | [README](../README.md)、[市场分发](distribution.md) |
| 自建 Git marketplace | 先添加 `Maker-Wen/markdown-preview` 的 `codex/marketplace` 分支，再安装 `markdown-preview@markdown-preview-marketplace` | [安装命令](../README.md#安装)、[市场分发](distribution.md) |
| OpenAI 公共插件目录 | 完成正式提交、审核和发布后，可按发布名称搜索或使用目录直链 | [目录发现机制](https://developers.openai.com/plugins/deploy/app-review#discovery) |

公开目录收录需要独立操作：发布者身份验证、上传插件 ZIP、处理自动检查、提交审核，获批后选择 Publish。审核通过本身不等于已发布；目录首页展示与主动推荐还取决于 OpenAI 的分发筛选。[提交与发布流程](https://developers.openai.com/plugins/deploy/submission)、[发布与分发说明](https://developers.openai.com/plugins/deploy/app-review#publication-and-distribution)

## 当前实现的适配边界

当前 MCP 通过 `stdio` 启动本地 Node.js 进程，执行 `scripts/server.cjs`。文件查看工具声明 `.md` / `.markdown` 的宿主文件入口；输入使用 `codex-resource://`，实际绝对路径来自宿主的 `openai/resource.path`，经文件名、扩展名和真实路径校验后读取。自动刷新也要求同一文件的宿主上下文。[MCP 配置](../plugins/markdown-preview/mcp.json)、[服务实现](../plugins/markdown-preview/scripts/server.cjs)、[兼容性说明](compatibility.md)

浏览器阅读页的 HTTP 服务只监听 `127.0.0.1`，每个随机会话仅访问已授权的文件，协议不接受浏览器提供的路径。它用于本机阅读和刷新，没有提供公网 MCP 传输，不能作为公共目录提交所要求的公网端点。[浏览器会话实现](../plugins/markdown-preview/scripts/browser-preview.cjs)、[浏览器兼容性说明](compatibility.md#在浏览器打开)

官方公开提交的 MCP 流程要求服务位于可公开访问的域名，不能使用本地或测试端点；提交包中需要声明 MCP URL，并完成连接与域名验证。据此，当前本地文件查看器需要另行评估适配，不能承诺将现有 ZIP 原样上传即可公开上架。[MCP 提交要求](https://developers.openai.com/plugins/deploy/app-review#remote-mcp-server-requirements)、[MCP 提交设置](https://developers.openai.com/plugins/deploy/submission#connect-and-scan-your-mcp-server)

这不表示所有本地 `stdio` 插件永远无法上架。官方打包文档同时提供了联系 OpenAI 寻求 local MCP support 的途径；如果要保留本地文件访问架构，应先确认这一支持途径的可用性和要求，再决定上架方案。[本地 MCP 支持说明](https://developers.openai.com/plugins/build/plugins#bundled-mcp-servers-and-lifecycle-hooks)

评估时须保留当前授权边界：读取用户明确打开的本地文件，不接受模型或浏览器指定任意路径。公网 MCP 端点不能仅凭本机绝对路径获得用户文件；若提出上传文档或引入远程存储，应作为需要用户明确选择的新产品流程单独评估，不能作为上架过程中的隐式替换。宿主文件入口、刷新调用和本地链接扩展在公共目录安装后的实际支持情况也需独立验证。[授权入口源码](../plugins/markdown-preview/scripts/server.cjs)、[宿主接口说明](compatibility.md)

## 正式上架前的准备

1. 确认发布身份、所属组织和提交权限，准备可公开访问的支持与隐私政策页面。[提交权限与身份验证](https://developers.openai.com/plugins/deploy/submission#confirm-access-and-publishing-identity)、[清单字段要求](https://developers.openai.com/plugins/deploy/submission#manifest-fields)
2. 优先确认 local MCP support 是否适用于本项目，明确服务运行位置与文件授权流程，验证公共目录渠道能支持现有宿主文件入口，再决定是否制作适配包。[本地 MCP 支持说明](https://developers.openai.com/plugins/build/plugins#bundled-mcp-servers-and-lifecycle-hooks)、[当前宿主依赖](compatibility.md)
3. 完成名称、描述、关键词、作者、图标和截图等展示资料，确保元数据与实际功能一致。准备适用的正向、负向和边界验收场景。[提交字段要求](https://developers.openai.com/plugins/deploy/submission#manifest-fields)、[完整插件测试](https://developers.openai.com/plugins/deploy/connect-chatgpt#test-the-complete-plugin)
4. 复核打包内容与当前提交限制，再上传 ZIP、完成自动检查和审核。本文仅记录评估，不代表已创建草稿、上传、提交或发布到平台。[正式提交流程](https://developers.openai.com/plugins/deploy/submission)

## 当前推荐渠道

先按现有发布流程提供最新自包含 marketplace，补齐仓库截图、关键词和清晰的安装入口，让拿到链接的用户可直接安装。需要使用远程 Release 脚本时，应先创建正式 Release 及校验资产。公共目录上架继续作为独立适配评估；以实际通过目录安装后的宿主行为验证作为是否推进的依据。[源码发布流程](releasing.md)、[市场发布流程](distribution.md)、[安装与宿主兼容性](compatibility.md)
