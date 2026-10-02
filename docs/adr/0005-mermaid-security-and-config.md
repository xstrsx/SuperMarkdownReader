# ADR 0005：Mermaid 的安全等级、配置白名单与交互

状态：已采纳（2026-10-02）

## 决策

1. 初始化固定 `securityLevel: 'strict'`，并禁用 HTML 标签（`htmlLabels: false`、
   `flowchart.htmlLabels: false`），使输出为纯 SVG 文本，便于导出与打印。
2. 不调用 `bindFunctions`：默认关闭图表点击回调与网页跳转。
3. 文档中的 `%%{init: …}%%` 指令经白名单解析后重建：只允许主题、配色变量、方向、
   曲线/间距/换行等排版项；`securityLevel`、`htmlLabels`、`*LabelHtmlLabels` 等
   安全相关键一律剥离并提示用户。
4. 布局：默认 dagre；ELK 通过 `flowchart-elk` 图表类型提供（样例行已覆盖）。
   不接受 `flowchart.defaultRenderer` 之类的运行时布局切换，因为无法在离线环境验证
   是否真正切换，避免“悄悄改变语义”。
5. 并发为 1，唯一图形 id 稳定；缓存键包含源码、主题、字号与引擎版本；主题变化使缓存失效。
6. 图内数学使用 Mermaid 自带的 KaTeX 模块；不额外打包 KaTeX 字体，因此数学字形使用
   回退度量（已在兼容矩阵说明）。

## 判定依据

`getRegisteredDiagramsMetadata()` 来自所锁定发行版，样例来自该版本官方文档并用同版本
`detectType()` 验证；`scripts/collect-mermaid-types.mjs --check` 在 CI 中强制
“注册集合 − 样例覆盖集合 = ∅”。
