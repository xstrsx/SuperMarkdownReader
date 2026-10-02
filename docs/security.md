# 安全模型

文档内容是**不可信输入**。以下边界在代码中强制，而不是靠约定。

## 1. 唯一可信页面

- 只加载 `https://appassets.androidplatform.net/assets/web/index.html`。
- 禁止 `loadUrl(contentUri)`、`loadUrl(fileUri)`、`loadUrl(remoteUrl)`，
  也不把未净化文档交给 `loadData` 当顶层页面。
- 路由白名单：

  | 路由 | 含义 |
  | --- | --- |
  | `/assets/web/...` | 内置静态资源（路径规范化，拒绝 `..`、反斜杠、NUL、绝对路径） |
  | `/session/<opaque>/source` | 当前文档的 UTF-8 快照（仅当前代际） |
  | `/session/<opaque>/resource/<id>` | 已登记且位于授权目录内的本地附件 |
  | `/session/<opaque>/image/<id>` | 原生图片代理结果 |

  未登记路径返回受控 4xx，不回落系统网络；不存在 `?url=` 形式的通用代理。

- WebView 设置：JavaScript 仅为内置页面开启；`allowFileAccess=false`、
  `allowContentAccess=false`、`allowFileAccessFromFileURLs=false`、
  `allowUniversalAccessFromFileURLs=false`、多窗口/弹窗/下载关闭、定位关闭、
  Cookie 与 DOM Storage 关闭、`blockNetworkLoads=true`、混合内容为
  `NEVER_ALLOW`、Release 关闭 WebView 远程调试。
- CSP（同时写在页面 meta 与响应头）：

  ```
  default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline';
  img-src 'self' data: blob:; font-src 'self'; connect-src 'self';
  worker-src 'self'; object-src 'none'; frame-src 'none'; base-uri 'none';
  form-action 'none'
  ```

  没有 `unsafe-eval`；动态 import 只指向本地资源。

- 导航：只允许本应用 origin 内的地址；其他地址一律取消，并改为“复制链接”。
  不存在自动跳转系统浏览器。

## 2. 消息桥

- 使用 `WebViewCompat.addWebMessageListener`，允许来源精确为
  `https://appassets.androidplatform.net`，不使用 `*`。
- 每条消息校验：协议版本、`isMainFrame`、会话 id、generation、方法白名单、参数类型、
  单条消息 ≤64 KiB。
- 方法清单：`ready`、`documentRendered`、`reportRenderError`、`requestFolderGrant`、
  `copyText`、`openLocalDocument`、`registerImages`、`registerAttachments`、
  `requestExport`、`exportBegin`、`exportChunk`、`exportFinish`、`exportAbort`、
  `setPreference`、`log`。
- 没有通用 `fetch`、没有任意文件读写、没有任意 Intent、没有 shell；
  文档正文不经桥传输（走本地流式路由）。
- 若 WebView 不支持安全消息 API，则进入源码阅读模式并提示，绝不退回
  `addJavascriptInterface`。

## 3. 净化

- 渲染后的 HTML 与本地 HTML 都经过 DOMPurify：显式标签/属性白名单，
  移除 `script/style/iframe/object/embed/form/meta/base`，删除全部 `on*` 事件属性，
  `href`/`src` 在钩子中被改写为 `data-ld-href`/`data-ld-ref`（链接只能复制，
  图片交给受控资源解析），因此最终 DOM 中没有任何可导航或可外链的属性。
- 内联样式由 **css-tree** 解析成 AST 后按属性白名单保留；`url()`、`@import`、
  `expression()`、转义、`position/inset/z-index/transform` 等覆盖全屏或外部引用的能力被移除。
  DOMPurify 不作为 CSS 净化器使用。
- 独立 SVG 走 XML 预检：拒绝 `DOCTYPE`/实体/`xml-stylesheet`，移除脚本、事件、动画元素、
  未知命名空间元素与所有外部 `href`/`src`（仅保留 `#fragment` 与 `data:image/*`），
  统计节点/路径/深度并设上限；`foreignObject` 的 XHTML 子树经 DOMPurify + CSS 白名单处理，
  其 `<style>` 若含 `url()`/`@import` 则整体移除。
- 导出 SVG 复用同一预检，保证自包含且无活动内容。

## 4. 网络（唯一出口）

唯一网络客户端是 `image/RemoteImageRepository`（OkHttp），其他模块不得自建网络请求。

- 只允许 `http`/`https`；拒绝 user-info、缺失主机、非法端口。
- HTTPS 正常校验证书，不忽略证书错误，不实现“信任全部”。
- 关闭自动重定向，逐跳校验新 URL（≤5 跳），禁止 https→http 降级。
- 对**每一跳**解析出的**所有**地址做检查：默认拒绝回环、链路本地、组播、保留、私网地址；
  设置中允许局域网后仍拒绝回环与链路本地（含云元数据地址 169.254.0.0/16）。
- 不发送 cookie、Authorization、Referer；不保证需要登录或反盗链凭证的图片可用。
- 真实字节计数限制（单图 ≤12 MiB，远程 SVG ≤4 MiB），响应必须通过图片签名嗅探，
  非图片响应（例如服务端错误页）不渲染。
- 磁盘缓存 64 MiB（LRU，可清除），遵守 `no-store` 等缓存指令。
- 日志只记录 `scheme://host[:port]/…`，隐藏 query 与凭据；缓存键用 URL 的 SHA-256。

## 5. 本地文件

- 不申请 `MANAGE_EXTERNAL_STORAGE` 或任何全盘权限；只有 `INTERNET`。
- 单文件授权与目录授权分开：附件需要 `ACTION_OPEN_DOCUMENT_TREE`。
- 仅在系统真正授予 persistable 标志时调用 `takePersistableUriPermission`；
  失败时明确提示，不假定永久权限。
- 相对路径解析：解码一次百分号编码，处理 `.`/`..`，任何规范化结果都不得越过授权根；
  实际查找从授权根逐段进行，因此越界引用只会“找不到”，不会读到根外文件。
- 快照文件使用随机名保存在私有 cache，不沿用不可信路径。

## 6. 已知限制（诚实说明）

- 静态扫描“文件里没有 http 字符串”不能证明离线行为；离线结论由用户断网验证。
- 系统是否把 LiteDoc 列入某个文件的“打开方式”取决于发送方提供的 MIME；
  误报类型的文件可能不出现，可用“分享为文本”或在文件管理器中以文本类型打开。
- `web/vendor` 中第三方发行版内部仍包含少量文档性 URL（命名空间、许可证链接），
  它们不是运行时可加载资源；`scripts/verify-resource-closure.mjs` 会报告这些疑点。
