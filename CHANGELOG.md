# 更新记录

## 0.1.0 — 未发布（首个正式版本）

### 新增

- 离线优先的 Android 文档查看器：单 Activity、系统 WebView、无主页、无桌面启动图标。
- 入口：`ACTION_VIEW`、`ACTION_SEND`、`ACTION_SEND_MULTIPLE`（一次最多 20 个文件），
  纯 URL 分享识别为“不支持打开网站”并提供复制。
- 格式：Markdown（含 GFM/CommonMark 扩展、Alerts、Callout、front matter、`[TOC]`、
  emoji 短代码、受限 HTML）、数学（MathJax + mhchem，整篇一次排版）、
  Mermaid（锁定版本注册表全部 39 项类型）、SMILES 二维结构、CSV/TSV 虚拟表格、
  独立 SVG、本地静态 HTML、文本与源码。
- 安全：唯一可信页面 + 白名单路由；HTML/CSS/SVG 三层净化；精确来源的消息桥与方法白名单；
  导航一律阻断；WebView 不访问网络。
- 网络：仅原生图片代理可访问 http/https；逐跳与地址策略；真实字节/像素上限；磁盘缓存可清除。
- 本地附件：SAF 目录授权与受限相对路径解析（越界拒绝）。
- 导出：系统打印/保存 PDF；单张图形导出 SVG/PNG；原始文件导出；导出前完成屏幕外内容。
- 构建：GitHub Actions 云端构建、静态校验、受限正式签名与产物发布工作流。
- 文档：兼容矩阵、架构、安全、包体/性能、签名、CI、ADR 与用户手动验证清单。

### 已知限制

- 与构建产物对应的运行验证（首次断网、各格式渲染、导出、性能、覆盖升级）**待用户验证**。
- Markdown 内联 SVG 会被移除并提示；独立 SVG 请用 `.svg` 打开。
- Mermaid 图内数学不额外打包 KaTeX 网页字体（使用回退字形度量）。
- 文档不控制 MathJax/Mermaid 的安全相关配置；`%%{init}%%` 中安全键会被剥离。
- 未实现：压缩包/Office/PDF 阅读、化学计算与配平、结构编辑、三维分子、数学求解、
  AI、账号、广告、统计上报、云同步。
