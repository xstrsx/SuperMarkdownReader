# 包体与性能

## 现状

- 目标：正式 APK 争取约 15 MiB，预算 20 MiB（MiB = 1,048,576 字节）。
- 实际数值：**以 Actions 包体报告为准**（`reports/size-report.md` / `size-report.json`，
  作为 artifact 与 workflow summary 提供）。本文件不预填未经测量的数字。
- 运行性能（冷/热启动、首次可读时间、大文件滚动、内存）：**待用户手动下载后验证**。

## 包体构成（分类由 `scripts/size-report.py` 实测统计）

`dex`、`android-resources`、`manifest`、`signature-and-metadata`、`native-libs`、
`mathjax-engine`、`mathjax-font-glyphs`、`mathjax-font-extensions`、`mermaid`、
`smiles`、`web-application`、`web-shell`、`other-assets`、`other`。

已知的大项是 MathJax 动态字形数据与 Mermaid 完整分片；二者都是“已承诺的离线能力”，
不通过删除分片或减少图表类型来压缩包体。若超预算，按以下顺序优化：

1. 检查重复库、source map、未使用字体、示例与测试数据是否入包；
2. 复核 Mermaid 是否只收集了 `mermaid.esm.min` 一套分片（而不是 core/esm/esm.min 三套）；
3. 复核 MathJax 只收集 SVG 输出所需资源（不含 CHTML 字体与 woff2）；
4. 调整 R8/资源压缩与 `noCompress` 配置；
5. 仍然超预算时在报告中给出分项与可选方案，不擅自削减功能范围。

## 性能设计

启动流水线：Activity 启动后同时做两件事——加载轻量壳、后台读取并快照文档。
壳只加载基础 CSS、桥与解析入口；MathJax、Mermaid、SMILES 都不在启动路径上。

- 整篇 Markdown 在 Worker 中一次解析；主线程按完整顶层块分批插入（每批 24 块）。
- 数学：整篇一次排版（见 ADR 0003），不懒排版。
- Mermaid/SMILES/CSV：视口附近提前约 800 px 触发，队列并发 1。
- CSV：数据层在 Worker，DOM 只挂载可视行 + 少量预取行；搜索在数据层进行并可跳转。
- 图片：`loading="lazy"`，远程图片由原生代理按需拉取，磁盘缓存 64 MiB。
- Markdown 正文不裁剪屏幕外 DOM，以保证复制、查找、锚点、无障碍与打印行为可控。

## 资源上限（代码中强制执行）

| 内容 | 上限 |
| --- | --- |
| Markdown/HTML 富渲染 | ≤8 MiB 正常；8–32 MiB 提示大文件并默认源码/受限模式；>32 MiB 不整篇载入富渲染 |
| 普通文本/源码 | 单次快照 ≤32 MiB，超出明确提示 |
| 独立 SVG | 8 MiB，另有节点 ≤60k、路径 ≤20k、深度 ≤64 |
| 单个 Mermaid 块 | 128 KiB |
| 单个数学表达式 | 64 KiB（含宏展开/缓冲限制） |
| 单条 SMILES | 16 KiB；单文件 ≤5,000 条 |
| CSV/TSV | 32 MiB、100,000 行、200 列、2,000,000 单元格（先到为准） |
| 代码高亮 | 单块 ≤200 KiB，超出显示普通代码但复制完整 |
| YAML front matter | ≤64 KiB |
| PNG 导出 | 最长边 ≤8,192 px、总像素 ≤16 MP |
| 会话 | 前台 ≤20 个，快照总量 ≤128 MiB |
| 桥消息 | 单条 ≤64 KiB；复制文本 ≤256 k 字符 |
| 图片 | 单图 ≤12 MiB，远程 SVG ≤4 MiB，解码 ≤16 MP，磁盘缓存 64 MiB，并发 3，超时 10/15/30 s |

这些是保护条件，不是“达到上限仍然流畅”的承诺。拒绝或降级都会明确告知。

## 用户手动性能观察建议

固定样例在 `fixtures/performance/`：100 KiB 普通 MD、1 MiB 复杂 MD、200 个公式、
全部 Mermaid 类型文档、50 个混合图表、5 MiB SVG、100,000 行受限 CSV。
建议观察：冷/热启动、正文首次可读时间、复杂块完成时间、大文件滚动、连续切换 10 次后的表现。
真机参考目标（**优化目标，不是未测试的保证**）：中端 4 GiB 设备上 100 KiB MD 首屏争取 1 秒量级、
1 MiB 文档争取 2 秒量级。
