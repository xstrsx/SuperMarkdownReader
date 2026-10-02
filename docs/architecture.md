# 架构

## 分层

```
系统 VIEW / SEND / SEND_MULTIPLE
   → IntentParser            解析并去重（≤20 个文件），识别纯 URL
   → DocumentRepository      授权检查、受限读取、BOM/编码探测、UTF-8 快照、真实字节计数
   → DocumentSession(Store)  会话 id / generation / 类型 / 编码 / 快照（LRU ≤20，总量 ≤128 MiB）
   → ViewerViewModel         generation 递增、取消旧任务、装配描述符、附件与图片登记
   → ViewerActivity          单 Activity + 原生 Toolbar + 系统 WebView + 系统面板
   → LocalAssetRouter        唯一可信页面与 /session 路由（白名单）
   → 内置页面（assets/web）  Worker 整篇解析 → 主线程分批插入完整语法块 → 调度器懒渲染
   → 原生能力                 资源解析、附件授权、图片代理、导出/打印、设置
```

## Android 端模块

| 文件 | 职责 |
| --- | --- |
| `ViewerActivity` | 单 Activity，工具栏/搜索条/多文档切换条/WebView/系统对话框；打印期间冻结会话 |
| `ViewerViewModel` | 会话编排（generation、取消、附件与图片登记、描述符），不持有 View |
| `LiteDocApp` | 进程级状态（设置 + 会话编排器），使 Activity 重建不丢会话 |
| `intent/IntentParser` | VIEW/SEND/SEND_MULTIPLE 解析、去重、纯 URL 识别 |
| `document/DocumentRepository` | 受限读取与快照；编码转写；失败分类 |
| `document/TextDecoder` | BOM 优先、严格 UTF-8、候选编码评分、二进制提示 |
| `document/DocumentKindDetector` | 名称 + MIME + 头部嗅探联合判定 |
| `document/DocumentSessionStore` | 会话 LRU 与快照清理 |
| `storage/FolderAccessRepository` | SAF 树授权、按路径段子节点查找、越界防护 |
| `storage/AttachmentRegistry` | 相对引用 → 不透明 id → 授权 URI |
| `web/LocalAssetRouter` | `WebViewAssetLoader` + `/assets/` 与 `/session/` 处理器 + 别名表 |
| `web/ViewerWebViewClient` | 请求拦截（全部本地）、导航阻断、渲染进程崩溃降级 |
| `web/ViewerMessageBridge` | `addWebMessageListener`、方法白名单、会话/代际校验、大小上限 |
| `image/ImageRequestPolicy` | URL/重定向/地址策略（纯逻辑，可单测） |
| `image/RemoteImageRepository` | 唯一网络出口：OkHttp + 磁盘缓存 + 逐跳策略 + 真实字节上限 |
| `export/ExportCoordinator` | PDF 打印、导出目标、分块写入与 SHA-256 校验 |
| `settings/ViewerSettings` | 主题/字号/换行/图片开关等少量偏好 |

## Web 端模块

| 文件 | 职责 |
| --- | --- |
| `main.ts` | 能力探测、文档装载、渲染分派、原生推送处理、导出编排 |
| `bridge/protocol.ts` | 消息封装、请求/应答、推送、大小与协议版本校验 |
| `session/capabilities.ts` | 启动能力探测与降级依据 |
| `security/sanitize.ts` | HTML 净化白名单与资源占位（`data-ld-ref`） |
| `security/css.ts` | 内联样式 AST 白名单 |
| `security/svg.ts` | SVG 预检/净化/复杂度限制/栅格化 |
| `markdown/engine.ts` | markdown-it + 插件 + 数学/告警/Callout/front matter/TOC/块分组 |
| `markdown/highlight.ts` | 精选语言的高亮（懒加载） |
| `renderers/*` | markdown/math/mermaid/smiles/csv/svg/text 各格式渲染 |
| `scheduler/queue.ts` | 有界队列（并发 1）、视口预取、导出时 drain |
| `workers/document.worker.ts` | 整篇 Markdown 解析与 CSV 数据层 |
| `export/export.ts` | 导出状态机、屏幕外内容完成、分块协议 |

## 关键设计决定

1. **单页 + 白名单路由**：WebView 只加载内置页面；`/session/<id>/source`、`/resource/<id>`、
   `/image/<id>` 三种路由按不透明 id 与当前代际访问，其余一律 4xx。
2. **整篇解析、分批插入**：Worker 一次性解析整篇文档（引用定义在末尾、脚注、跨块结构才能正确），
   主线程按完整顶层块分批插入，兼顾语法正确与响应性；不按字节/行数切割源文件。
3. **整篇数学排版**：见 ADR 0003。
4. **图表按需渲染**：Mermaid/SMILES/CSV 通过 IntersectionObserver 进入视口附近才渲染，
   并发 1，缓存键包含源码/主题/字号/引擎版本。
5. **代际取消**：切换文档即递增 generation，Workers/队列/Promise/导出回调在提交 UI 前校验代际。
6. **快照而非库**：文档以随机名临时快照保存于私有 cache，关闭或 LRU 淘汰即删除，
   不建立永久文档库；进程被清理后需重新打开（不声称分享 URI 永久可用）。

## 数据流（图片）

```
文档中的 <img> → 渲染器登记 URL（桥 registerImages/registerAttachments）
   → 原生登记不透明 id 并回传 /session/<id>/image/<opaque>
   → <img src> 指向该本地地址 → 路由 → RemoteImageRepository 拉取
   → 字节上限/类型嗅探/像素预算 → 本地响应 → 渲染
```
失败（策略拒绝、超时、非图片、超限）返回明确 4xx，页面显示占位与原因，不回退成网页。
