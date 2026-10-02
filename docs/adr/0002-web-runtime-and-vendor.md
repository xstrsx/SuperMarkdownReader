# ADR 0002：Web 运行时的打包方式与第三方资源收集

状态：已采纳（2026-10-02）

## 决策

1. 应用代码与可打包的库（markdown-it 及其插件、DOMPurify、css-tree、highlight.js、
   PapaParse、smiles-drawer）由 esbuild 打包为 ESM + 代码分片，输出到 `web/dist/assets`。
2. 体积大或依赖自身分片机制的引擎（MathJax、Mermaid）**原样收集**到 `web/dist/vendor`，
   运行期通过 `import()`/`<script>` 从本地路径加载，避免二次打包产生重复代码。
3. MathJax 使用 `tex-svg.js`：该组件内联了默认 `mathjax-newcm` 字体数据；
   运行期只需再加载
   - `input/tex/extensions/*.js`（`[tex]/…` 组件，如 mhchem），
   - `@mathjax/mathjax-newcm-font/svg/dynamic/*.js`（动态字形数据，经典脚本，
     直接调用 `MathJax._.output.fonts["mathjax-newcm"].svg_ts.MathJaxNewcmFont.dynamicSetup`），
   - `@mathjax/mathjax-mhchem-font-extension/svg.js`（mhchem 箭头字形）。
4. Mermaid 收集完整的 `dist/chunks/mermaid.esm.min/*.mjs` 与入口
   `mermaid.esm.min.mjs`（约 5.4 MiB，未压缩），不使用 Tiny 版本。
5. 上游对同一份动态字形数据存在两种路径写法（带/不带包内 `js/` 段），
   因此**只发一份物理文件**，由原生路由的别名表把其它写法映射过去
   （别名由构建脚本生成进 `vendor-manifest.json`，Kotlin 侧读取）。

## 结果

- `scripts/verify-resource-closure.mjs` 静态验证：导入闭包、CSS `url()`、别名目标、
  必需资源（MathJax 组件、TeX 扩展、动态字形、Mermaid 分片）与“无 source map/无 node_modules”。
- 该检查只能证明打包图是闭合的，不能证明断网运行行为；后者由用户验证。
