# 构建前代码检查记录

检查对象：本仓库 `main` 分支的源码与配置。云端编译结果见 Actions run（链接在最终交付说明中）。
本地（WSL Ubuntu）**不执行** Android/Gradle 构建、Web 生产打包或模拟器。

## 已执行并通过的检查

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 依赖安装与锁文件一致性 | `npm ci --prefix web` | 通过（`package-lock.json` 含 integrity，`npm ci` 无差异） |
| TypeScript 类型检查（strict、noUnusedLocals/Parameters） | `npm run typecheck --prefix web` | 通过，0 错误 |
| Markdown 管线检查 | `npm run test:markdown --prefix web` | 40/40 通过（见下表明细） |
| 净化层检查（真实 DOM：jsdom） | `npm run test:sanitizers --prefix web` | 54/54 通过 |
| Mermaid 支持矩阵检查 | `npm run verify:mermaid --prefix web` | 注册 39 类型 / 样例 39 / 检出 38 + 1 负样例，布局 dagre+elk 均覆盖 |
| 工具链版本核实 | 见 [adr/0001-toolchain-and-lock.md](adr/0001-toolchain-and-lock.md) | 全部可解析；发现 `core-ktx` 1.19.x 要求 compileSdk 37 并已改用 1.18.0 |
| Gradle Wrapper 完整性 | 官方 sha256 校验后从发行版提取 wrapper jar | 通过（`20f1b117…aed78`） |
| Kotlin 单元测试 | `./gradlew :app:testDebugUnitTest`（Actions） | 见 Actions；本地不执行 |

### Markdown 管线检查覆盖

- 代码围栏/行内代码中的 `$` 不参与数学解析；价格 `$5`、转义 `\$99` 保持原样；
- `$...$`、`\(...\)`、`$$...$$`、`\[...\]` 正确产出占位并被 MathJax 识别；
- GitHub Alerts 与 Obsidian Callout（含折叠、未知类型降级）标记正确；
- front matter 被折叠渲染且不参与正文解析；
- 标题锚点：中文、重复标题加后缀、行内标记被剥离；
- 顶层块分组：列表/表格/围栏各自成块，分批插入不破坏结构；
- 末尾引用定义可用、脚注区块生成；
- `mermaid`/`csv`/`smiles` 围栏生成带索引的块容器；
- 未知语言被记录且不高亮（无自动语言检测）；
- `[TOC]` 与 emoji 短代码（未知短代码保留原文）；
- 超限 Mermaid 块回退为源码并给出提示。

### 净化层检查覆盖

- CSS：白名单保留、`position/inset/z-index`、`url()`、`@import`、`expression()`、转义全部移除；
- HTML：`script`/事件属性/`iframe`/`object`/`embed`/`form`/`meta`/`base`/`style`/内联 SVG 全部移除；
  链接变为 `data-ld-href`（不可导航）、图片变为 `data-ld-ref`（受控解析）；
- 本地 HTML 文档：远程样式表/脚本/表单/iframe 移除，页内锚点与安全内联样式保留；
- SVG：含 DOCTYPE/实体的文件整体拒绝；`script`/事件/动画/外部引用移除；
  渐变/蒙版/裁剪/滤镜/局部 `use`/受控 `foreignObject` 保留；
  `foreignObject` 内脚本与定位样式被移除；深度与路径数量上限生效。

## 静态审阅要点（人工）

- 权限：仅 `INTERNET`；未申请 `MANAGE_EXTERNAL_STORAGE` 或全盘权限。
- Manifest：无 MAIN/LAUNCHER、无 BROWSABLE、无 http/https 入口、无 `*/*` 过滤器。
- WebView：文件访问/内容访问/通用文件来源访问关闭、多窗口与弹窗关闭、
  Cookie 与 DOM Storage 关闭、`blockNetworkLoads=true`、混合内容 `NEVER_ALLOW`、
  Release 关闭远程调试。
- 路由：仅 `/assets/web/…`、`/session/<id>/source|resource|image`；无通用代理；
  路径规范化与别名表在 Kotlin 侧再次校验。
- 桥：来源精确 match、方法白名单、会话/代际校验、单条 ≤64 KiB、正文不过桥。
- 网络：唯一 OkHttp 客户端；逐跳策略；每跳全部解析地址检查；真实字节计数；
  非图片响应拒绝；日志仅 `scheme://host:port/…`。
- 生命周期：代际递增取消旧任务；切换文档重载壳页面以清理 DOM/Observer/Worker；
  打印期间冻结会话并排队新 Intent；`onRenderProcessGone` 降级为源码模式。
- 签名：Release 不使用 debug 签名；签名 job 不执行仓库构建脚本、仅临时解码 keystore、
  指纹不匹配即失败。
- 包体：无 source map、无 node_modules、无 fixture 入包（由 `verify-apk.py` 静态强制）。
- 编码：BOM 优先 → 严格 UTF-8 → 候选评分/手动选择；不乱码静默；原始字节保留以便重解码。

## Actions 构建结果（云端）

| Workflow | 触发 | 结果 |
| --- | --- | --- |
| `verify.yml` | `push` main（commit `956e7aa`） | **全部成功**：source checks / offline web build / unsigned release build |
| `release.yml` | tag `v0.1.0`（commit `fcaf694`） | guard 成功、build 成功、**sign 失败（未配置签名材料，符合设计）**、verify-signed 跳过 |

未签名 Release 构建的实测数据（同一 commit 的 `web-dist` 产物）：

- APK：**5.89 MiB**（6,173,174 字节），目标 15 MiB，预算 20 MiB → 在目标内。
- 压缩内容合计 5.84 MiB；解压后 18.38 MiB；条目 270。
- 分项：`mathjax-font-glyphs` 2.975 MiB、`mermaid` 1.532 MiB、`mathjax-engine` 0.670 MiB、
  `dex` 0.291 MiB、`web-application` 0.281 MiB、其余 ≈0.09 MiB。
- 静态校验：`applicationId=dev.litedoc.viewer`、`minSdk=26`、`targetSdk=36`、
  `versionCode=1`、`versionName=0.1.0`、无 launcher activity、无 BROWSABLE、
  仅 `INTERNET`（另有应用自身命名空间的签名级权限供自身非导出接收器使用）、
  vendor manifest 236/236 文件存在且字节数一致、无 source map / node_modules / fixture 入包。
- Kotlin 单元测试：26 项全部通过（`testDebugUnitTest`）。
- lint：0 error（45 warning）。

工作流日志摘要（用于失败排查，无秘密）：
- `ci-report` 分支：verify run 的作业结论与日志摘录。
- `ci-report-release` 分支：release run 的作业结论、包体报告与校验事实。

## 尚未验证（必须由云端或用户完成）

| 项目 | 原因 |
| --- | --- |
| Kotlin/Android 编译、lint、单元测试、R8、资源打包 | 需要 Android SDK，仅在 Actions 执行 |
| 真实 APK 的包体数值、包结构静态校验 | 需要构建产物 |
| 正式签名与证书指纹核验 | 需要用户配置正式密钥（`release-signing` 环境）；当前 sign job 按设计明确失败，未产出签名产物 |
| 首次断网渲染、系统入口、各格式实际渲染、图片策略、授权、导出、性能、覆盖升级 | **由用户手动下载安装后验证**，Agent 不负责运行验收 |
