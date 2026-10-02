# ADR 0004：网络图片的唯一出口与策略

状态：已采纳（2026-10-02）

## 决策

1. WebView **不直连网络**：`blockNetworkLoads=true`，且 `shouldInterceptRequest`
   只放行本机路由白名单，未登记请求返回受控 4xx。
2. 文档中的远程图片由页面登记 URL（`registerImages`），原生返回不透明 id，页面再把
   `<img src>` 指向 `/session/<id>/image/<opaque>`。渲染器永远拿不到可自行请求的地址。
3. 唯一网络客户端是 OkHttp（`image/RemoteImageRepository`）：
   - 仅 http/https；拒绝 user-info、缺失主机、非法端口；
   - 关闭自动重定向，逐跳校验（≤5 跳），禁止 https→http 降级；
   - 对每一跳解析出的**全部**地址做私网/回环/链路本地/保留地址检查，
     默认拒绝私网，设置中允许局域网后仍拒绝回环与链路本地；
   - 不发送 cookie/Authorization/Referer；真实字节计数（≤12 MiB）、图片签名嗅探、
     非图片响应不渲染；磁盘缓存 64 MiB 且可清除。
4. 明文 HTTP 通过 `network_security_config.xml` 明确允许，仅为该客户端；
   WebView 无任何路径可使用明文。
5. 关闭网络图片开关时：禁止新增下载（路由直接返回 403），并取消可取消的请求；
   已显示的本地内容不受影响（本地附件与已缓存图片仍可显示）。

## 已知限制

- 需要登录或反盗链凭证的图片不保证显示（不发送任何凭证）。
- 允许局域网会扩大可访问范围，但仍不进行任何网络扫描，只访问文档中明确引用的地址。
- `blockNetworkLoads` 与自定义路由的交互需要在真实设备上确认；页面在源请求失败时会
  自动回退一次（关闭该开关但仍保持路由白名单），并在报告中记录。
