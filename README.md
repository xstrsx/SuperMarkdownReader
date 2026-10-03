> # ⚠️ 本项目已废弃（DEPRECATED / ARCHIVED）
>
> **LiteDoc（本仓库 `SuperMarkdownReader`）已停止开发**：不再接受新功能、修复或发布，也从未发布
> 过正式签名版本。后续工作已迁移到新仓库 👉 **[xstrsx/MarkView](https://github.com/xstrsx/MarkView)**
>
> 请前往新仓库获取源码、说明与构建产物：<https://github.com/xstrsx/MarkView>
>
> 本仓库仅作为历史归档保留：源码、工作流与文档都不再维护（Actions 配置保留为历史记录，
> 但不再用于发布），以下所有内容仅用于追溯当时的实现与决策，请勿据此进行新的开发。
>
> ---
>
# LiteDoc — 离线优先的 Android 本地文档查看器

LiteDoc 用系统 WebView 打开**本地** Markdown、SVG、Mermaid、CSV/TSV、SMILES、静态 HTML
和文本/源码文件。它没有主页、没有桌面启动图标，也不会把网页当成文档来浏览：
只能通过系统的“打开方式”“分享”“多文件分享”进入阅读界面。

> **归档状态**：本仓库的源码与工作流曾在 Actions 上验证通过（无签名 Release 构建 5.89 MiB、
> 单元测试与静态校验全绿），但**从未产出或发布正式签名 APK**，`release-signing` 环境至今未配置密钥。
> 因此当初标注为“待用户验证”的功能项都**没有**在设备上验证过，也不会在本仓库继续验证。
> 后续开发与验证请前往 [xstrsx/MarkView](https://github.com/xstrsx/MarkView)；
> 历史说明见 [docs/manual-verification.md](docs/manual-verification.md) 与
> [docs/code-check-report.md](docs/code-check-report.md)。

## 特性概览

- **完全离线**：首次安装后断网即可渲染正文、公式（MathJax + mhchem）、Mermaid 全部内置
  图表类型、化学结构（SmilesDrawer 二维）、CSV/TSV 表格与 SVG。所有运行资源内置于 APK，
  无 CDN、无远程字体、无在线公式/图表服务。
- **系统 WebView**：不内嵌 Chromium，不申请全盘存储权限。
- **单一可信页面**：WebView 只加载 `https://appassets.androidplatform.net/assets/web/index.html`，
  其余请求一律由本机路由处理，未登记的请求直接拒绝，WebView 不访问网络。
- **受限联网**：只有原生图片代理可以使用 `http/https` 加载文档引用的远程图片，可关闭，
  默认拒绝回环/链路本地/保留地址，局域网默认拒绝，可在设置中显式放开。
- **本地附件**：通过 SAF（`ACTION_OPEN_DOCUMENT_TREE`）显式授权目录，相对路径被限制在该目录内。
- **导出**：系统打印/保存 PDF；单张图形导出为自包含 SVG 或 PNG。
- **安全默认**：文档内容视为不可信输入，脚本、事件、导航、桥越权与任意文件/网络访问全部禁止。

不支持：压缩包、Office 文件、PDF 阅读、电子书、音视频播放器、远程 URL 文档下载、
化学计算/配平/结构编辑/三维分子、数学求解、AI、账号、广告与统计上报。

## 打开方式

1. **打开方式**：文件管理器里对 `.md/.svg/.mmd/.csv/.tsv/.smi/.html/.txt` 等选择 LiteDoc。
2. **分享**：任意应用“分享到 LiteDoc”（支持一次分享最多 20 个文件）。
3. **分享纯文本**：作为临时 Markdown/文本阅读；若内容只是一个 http/https 地址，
   应用会提示“不支持打开网站”并提供复制链接，绝不获取该网页。

## 使用要点

- **附件目录授权**：单文件授权不等于同目录权限。图片等本地附件缺失时，使用菜单
  “授权附件目录”选择文档所在文件夹；所有 `./`、`../` 引用都会被规范化并限制在该目录内，
  越界引用会被拒绝而不是静默替换。
- **编码**：默认按 BOM/UTF-8 严格解码；UTF-8 失败时给出候选编码并转换，也可在菜单中选择
  手动编码重新解码，保持原始换行。
- **搜索**：正文搜索匹配当前展示的文字（含源码模式）。
- **主题/字号/换行/网络图片**：设置持久保存，仅保存这几项，不建立文档历史库。
- **导出**：菜单“导出 / 打印”中提供系统打印（可保存 PDF）、单张图形导出 SVG/PNG、
  原始文件导出。导出前会先完成屏幕外内容，超时会明确提示剩余项。
- **网络图片**：默认允许 http/https 图片，可在菜单中关闭（关闭后不再发起新请求），
  并可单独清除图片缓存。

## 离线与网络边界

| 项目 | 行为 |
| --- | --- |
| 首次安装 | 不需要任何联网初始化，断网即可渲染全部内置格式 |
| WebView | `blockNetworkLoads` 开启；所有请求经本机路由白名单，未登记请求直接拒绝 |
| 远程图片 | 仅由原生 OkHttp 代理加载；不做 WebView 直连，响应必须是图片，大小/像素受限 |
| 网页链接 | 只提供复制；不打开应用内浏览器，也不自动跳转系统浏览器 |
| 明文 HTTP | 仅为原生图片代理开启（文档可能引用 http 图片）；WebView 无法使用该通道 |

## 构建

本项目**不在本地构建**。所有打包、依赖锁定、签名与校验都在 GitHub Actions 完成：

- `verify.yml`：源码检查 → 离线 Web 打包与资源闭包检查 → 无签名 Release 编译、单元测试、
  lint、包体报告与静态校验。
- `release.yml`：受保护的 `v*` 标签或手动触发 → 同一套检查 → 无签名构建 → 受限签名 job
  （仅 `zipalign`/`apksigner`）→ 签名产物静态校验 → 上传正式 APK 与校验和。
- `bootstrap.yml`：一次性生成 Gradle 依赖锁文件与校验元数据，结果推到 `bootstrap/deps`
  分支并开 PR，不直接写默认分支。

签名配置见 [docs/signing.md](docs/signing.md)，CI 细节见 [docs/ci.md](docs/ci.md)。

## 文档

- [docs/support-matrix.md](docs/support-matrix.md) — 依赖版本、格式与图表类型、边界
- [docs/architecture.md](docs/architecture.md) — 模块与数据流
- [docs/security.md](docs/security.md) — 净化、桥、导航与网络策略
- [docs/performance.md](docs/performance.md) — 包体报告与资源上限
- [docs/signing.md](docs/signing.md) — 正式签名与 GitHub 配置
- [docs/ci.md](docs/ci.md) — 工作流说明与排错
- [docs/manual-verification.md](docs/manual-verification.md) — 用户手动验证清单
- [docs/code-check-report.md](docs/code-check-report.md) — 构建前检查记录
- [docs/adr/](docs/adr/) — 关键架构决定
- [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt) — 第三方许可清单

## 许可证

应用自身采用何种许可证由仓库所有者决定；第三方组件许可见
[THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt)。
