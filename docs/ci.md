# CI 与构建

所有构建都在 GitHub Actions 完成。本地（WSL）只做源码编辑与非 Android 构建的检查。

## 工作流

### `verify.yml`

触发：`push` 到 `main`、`pull_request`、`workflow_dispatch`。默认权限 `contents: read`。

| Job | 内容 |
| --- | --- |
| `source-check` | `npm ci`、TypeScript 类型检查、Markdown 管线检查（jsdom 无关）、净化器检查（jsdom）、Mermaid 矩阵检查、wrapper 校验和固定检查、工具链记录 |
| `web-build` | `npm ci`、生产打包、资源闭包静态检查、许可清单收集、上传 `web-dist` |
| `android-build` | 下载同一 commit 的 `web-dist`、Kotlin 单元测试、`lintRelease`、无签名 `assembleRelease`、包体报告、APK 静态校验、上传 `unsigned-internal-build` |
| `diagnostics` | 仅 `main` 的 push：把本次运行的日志摘要推到 `ci-report` 分支（公开仓库的日志本就是公开的），便于快速定位失败 |

产物命名：无签名产物明确标注 `unsigned-internal-build`，**不可作为用户安装包**。

### `release.yml`

触发：受保护的 `v*` 标签或 `workflow_dispatch`（可选 `publish_draft`）。

1. `guard`：拒绝 PR/fork/任意分支；要求发布 commit 属于 `main` 历史；推导版本号。
2. `build`：与 `verify` 相同的检查 → 无签名 Release 构建 → 包体报告与静态校验 →
   上传待签名 APK。
3. `sign`：`environment: release-signing`。**不执行仓库中的任何构建脚本**，仅使用
   `zipalign`/`apksigner`；keystore 只解码到 `RUNNER_TEMP` 并在结束时删除；
   缺少任何 secret 或缺失 `EXPECTED_SIGNER_SHA256` 时明确失败（无 Debug/临时/无签名回退）。
4. `verify-signed`：对签名产物再次静态校验（applicationId、版本、minSdk/targetSdk、
   证书指纹、vendor manifest 一致性），生成 `SHA256SUMS` 与 `build-info.json`。
5. `publish-draft`：仅在手动触发并勾选时创建 **draft** Release。

### `bootstrap.yml`

一次性生成 Gradle 依赖锁文件（`gradle.lockfile`、`app/gradle.lockfile`）与
`gradle/verification-metadata.xml`，推到 `bootstrap/deps` 分支并开 PR；
不直接写默认分支，不使用任何密钥。合并后应禁用该工作流。

## 依赖锁定策略

- `web/package-lock.json`、`.node-version`、`gradle/wrapper/*` 已提交并校验（wrapper jar
  取自官方校验和验证过的 Gradle 8.13 发行版）。
- Gradle 锁与校验元数据由 `bootstrap.yml` 生成后提交；根 `build.gradle.kts` 只在检测到
  锁文件时才启用锁定，因此全新 checkout 在 bootstrap 之前也能构建。
- 常规 CI 一律 `npm ci`，不允许在构建过程中更新锁文件。
- 升级依赖必须单独提交并重跑检查；运行验证仍由用户完成。

## 云端命令顺序

```bash
npm ci --prefix web
npm run typecheck --prefix web
npm run test:markdown --prefix web
npm run test:sanitizers --prefix web
npm run verify:mermaid --prefix web
npm run build --prefix web
npm run verify:closure --prefix web
node scripts/collect-licences.mjs
./gradlew --no-daemon :app:testDebugUnitTest lintRelease assembleRelease
python3 scripts/size-report.py --apk app/build/outputs/apk/release/app-release-unsigned.apk
python3 scripts/verify-apk.py --apk app/build/outputs/apk/release/app-release-unsigned.apk --mode unsigned
```

## 排错

| 现象 | 处理 |
| --- | --- |
| `web/dist/index.html not found` | 先运行 web 构建；Android 构建依赖 `web-dist` 产物 |
| `minCompileSdk` 报错 | 依赖升级引入了更高 `minCompileSdk`；核对 AAR 元数据后调整版本或 `compileSdk` |
| 资源闭包检查失败 | `vendor-manifest.json` 与 `dist` 不一致；删除 `web/dist` 重新构建 |
| Mermaid 矩阵检查失败 | 新增/更名图表类型未覆盖：把新类型加入 `docs/support-matrix.md` 与样例 |
| 签名 job 失败并提示缺少材料 | 按 [signing.md](signing.md) 配置受保护环境与 secret/variable |
| 需要读日志但没有 artifact 权限 | `main` 的 push 会发布 `ci-report` 分支上的日志摘要 |

## 本地可做的检查（不构建 Android）

```bash
npm ci --prefix web
npm run typecheck --prefix web
npm run test:markdown --prefix web
npm run test:sanitizers --prefix web
npm run verify:mermaid --prefix web
```

本地**不做**：Gradle/Android 构建、Web 生产打包、模拟器、真机或浏览器自动化验收。
