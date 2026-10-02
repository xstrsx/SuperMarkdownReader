# 兼容矩阵

版本均已在 2026-10-02 之前核对官方发布与注册表（见
[adr/0001-toolchain-and-lock.md](adr/0001-toolchain-and-lock.md) 的来源清单）。
“待用户验证”表示该目标尚未在真实设备上验证，构建通过不代表已通过。

## 工具链

| 层 | 版本 | 状态 |
| --- | --- | --- |
| AGP | 8.13.2 | 已核对官方发布说明；云端编译结果见 Actions |
| Gradle Wrapper | 8.13（bin 分发，官方 SHA-256 固定） | 已核对官方校验和文件 |
| Kotlin | 2.3.10 | 已锁定；JVM target 17 |
| JDK | 17（temurin） | 云端固定发行版 |
| compileSdk / targetSdk | 36 / 36 | 已核对依赖 AAR 元数据的 `minCompileSdk` |
| minSdk | 26 | 实际兼容性待用户验证 |
| Build Tools | 35.0.0 | 云端安装（若缺失） |
| CI runner | ubuntu-24.04 | 记录于 bootstrap 报告 |
| Node | 22.23.3（`.node-version`，22 LTS 最新补丁） | 已锁定 |

依赖版本：AndroidX core 1.18.0、AndroidX WebKit 1.17.1、OkHttp 5.2.1、
kotlinx-coroutines 1.11.0。选择 1.18.0 而不是 1.19.x 的原因：其 AAR 元数据要求
`minCompileSdk=37`，与 `compileSdk 36` 不兼容（已核对）。

## Web 运行资源

| 组件 | 版本 | 说明 |
| --- | --- | --- |
| markdown-it | 15.0.2 | 基础解析 |
| markdown-it 插件 | footnote 4.0.0 / deflist 4.0.0 / task-lists 2.1.1 / mark 4.0.0 / sub 2.0.0 / sup 2.0.0 / ins 4.0.0 / emoji 3.1.0 | 扩展语法 |
| MathJax | 4.1.3（`tex-svg.js`） | SVG 输出，字体数据完整内置 |
| @mathjax/mathjax-newcm-font | 4.1.3 | 动态字形数据（40 个分片）全部随包 |
| @mathjax/mathjax-mhchem-font-extension | 4.1.3 | mhchem 箭头等字形 |
| Mermaid | 12.0.0 | 完整 ESM 发行版 + 全部分片，非 Tiny |
| SmilesDrawer | 2.4.1 | 仅按需加载二维绘制 |
| highlight.js | 11.12.0 | 精选语言，关闭自动语言检测 |
| PapaParse | 5.7.0 | Worker 内流式解析 CSV/TSV |
| DOMPurify | 3.4.16 | HTML 净化（不承担 CSS 净化） |
| css-tree | 3.2.1 | 内联样式 AST 白名单 |

## WebView 目标

- 目标最低 Chromium/WebView 主版本：**128**（目标，不是已验证承诺）。
- 启动时探测：ES modules、动态 import、Worker（含 module worker）、AbortController、
  IntersectionObserver、ResizeObserver、TextDecoder、CSS grid/sticky、SVG filter，
  以及 AndroidX WebKit 的 `WebViewCompat.addWebMessageListener`。
- 缺失关键能力时不静默空白：降级为源码模式并明确提示（不联网更新 WebView、不下载内核）。
- **实际通过的最低 WebView 版本：待用户验证**（用户可在“第三方许可与版本”中看到当前 WebView 版本）。

## 文件类型

| 后缀 | 行为 | 状态 |
| --- | --- | --- |
| `.md` `.markdown` `.mdown` `.mkd` | 完整 Markdown 与扩展渲染 | 待用户验证 |
| `.svg` | 静态图形，缩放/平移/背景切换 | 待用户验证 |
| `.mmd` `.mermaid` | 独立图表 | 待用户验证 |
| `.csv` `.tsv` | 表格、虚拟滚动、分隔符/表头切换、数据层搜索 | 待用户验证 |
| `.smi` `.smiles` | SMILES 二维绘制，坏记录隔离 | 待用户验证 |
| `.txt` `.log` 及常见源码后缀 | 只读文本/高亮 | 待用户验证 |
| `.html` `.htm` | 受限静态展示 | 待用户验证 |
| `.tex` | 仅源码查看，不编译 | 待用户验证 |
| 未知文本 | 用户主动选择按文本或 Markdown 打开 | 待用户验证 |

## Markdown 扩展

CommonMark 基础 + 以下扩展：GFM 表格、任务列表、删除线、围栏/缩进代码、常用语言高亮与 diff、
脚注、定义列表、上下标、插入/高亮、GitHub Alerts（NOTE/TIP/IMPORTANT/WARNING/CAUTION）、
Obsidian 风格 Callout（含 `[!type]-` 折叠）、YAML front matter（折叠显示，不执行）、
`[TOC]`、emoji 短代码（`markdown-it-emoji` full 集合，未知短代码保留原文）、
受限 HTML（`details`/`summary`/`kbd`/`mark`/`sup`/`sub`）、以及 `mermaid`/`smiles`/`csv`/`tsv`
围栏与 `chem`/`mhchem` 围栏。

未承诺：Dataview、插件脚本、vault 语义、wiki link、块引用、内联 SVG（会被移除并提示）。

## 数学与化学

| 项 | 支持 |
| --- | --- |
| 分隔符 | `$...$`、`$$...$$`、`\(...\)`、`\[...\]` |
| 结构 | 分式、根式、上下标、积分、求和、矩阵、cases、aligned/align/gather、编号、`\tag` |
| 引用 | `\label`/`\ref`/`\eqref`（整篇一次排版，保持文档语义与编号顺序） |
| 宏 | 表达式内 `\newcommand`/`\def`；`\gdef` 文档级 |
| TeX 扩展 | `mhchem`、`ams`、`newcommand`、`configmacros`、`boldsymbol`、`cancel`、`cases`、`color`、`enclose`、`mathtools`、`physics`、`units`、`textmacros` |
| 化学 | 化学式、反应物/生成物、离子、电荷、同位素、反应箭头（含 `<=>`、`->[条件]`）、`\pu` 单位 |
| 不实现 | 完整 LaTeX 文档编译、任意宏包、TikZ、求解/数值计算、自动配平 |

排版策略：**整篇一次排版**（见 [adr/0003-math-document-typeset.md](adr/0003-math-document-typeset.md)），
因此不做视口懒排版，编号与引用不会被打乱。

## Mermaid 图表类型

注册表来自**所锁定发行版本身**（`mermaid.getRegisteredDiagramsMetadata()`，39 项，含
`---` front-matter 守卫）。每个类型至少一个样例，样例取自该版本官方文档并用同版本
`detectType()` 验证；无法从文档取得的样例用发行版检测器合成并在
`fixtures/mermaid/diagram-support.json` 中标记 `synthetic: shipped detector`。

注册类型：`agentflow`、`architecture`、`block`、`c4`、`classDiagram`、`cynefin`、`er`、
`error`、`eventmodeling`、`flowchart-elk`、`flowchart-v2`、`gantt`、`gitGraph`、`info`、
`ishikawa`、`journey`、`kanban`、`mindmap`、`packet`、`pie`、`quadrantChart`、`radar`、
`railroad`、`railroadAbnf`、`railroadEbnf`、`railroadPeg`、`requirement`、`sankey`、
`sequence`、`stateDiagram`、`swimlane`、`timeline`、`treeView`、`treemap`、`usecase`、
`venn`、`wardley`、`xychart`、`---`（负样例：`---` 开头必须给出明确报错，不能静默空白）。

布局：默认 dagre；ELK 通过 `flowchart-elk` 图表类型使用（样例已覆盖）。
不自动注册外部图表、第三方插件或任意 Iconify 包。

Mermaid 安全与交互边界：

- `securityLevel` 固定为 `strict`，文档的 `%%{init}%%` 不允许修改它（会被剥离并提示）；
- 关闭图表点击回调与网页跳转，不把原始 SVG 直接注入主文档；
- 图内数学由 Mermaid 内置 KaTeX 模块渲染；本项目**不额外打包 KaTeX 网页字体**，
  因此图内公式使用回退字体度量（正文 MathJax 与图内数学分别管理）；
- 主题/配色/方向等白名单内调整允许；安全限制造成的差异在本节说明。

## 活动内容边界

| 内容 | 处理 |
| --- | --- |
| `<script>`、事件属性、`iframe/object/embed/form`、`meta refresh`、`base` | 移除 |
| 内联 `style` | CSS AST 白名单（禁止 `position/inset/z-index/transform/url()/@import`） |
| 链接 | 一律转为“复制链接”，不做导航；页内 `#anchor` 保留 |
| 图片 | 远程图片经原生代理；本地相对引用经 SAF 授权目录解析；两者都受大小与策略限制 |
| 独立 SVG | 预检 + 净化后以 `<img>`（blob URL）呈现，拒绝 DOCTYPE/实体/脚本/事件/外部引用 |
| `foreignObject` | 保留其受控静态内容，子节点经 DOMPurify 与 CSS 白名单处理 |
| Markdown 内联 SVG | 移除并提示（独立 SVG 请用 `.svg` 打开） |
| 远程 SVG 内的外部引用 | 移除，不递归联网 |
