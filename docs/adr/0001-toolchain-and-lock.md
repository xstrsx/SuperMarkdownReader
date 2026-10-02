# ADR 0001：工具链锁定与依赖锁定方式

状态：已采纳（2026-10-02）

## 背景

项目必须能从一个 commit + 一份锁文件重建，并且本地不做 Android 构建。
方案给出的候选版本（AGP 8.13.2、Gradle 8.13、Kotlin 2.3.10、compileSdk 36、
Node 22 LTS、MathJax 4.1.3、Mermaid 12.0.0、markdown-it 15.0.2、smiles-drawer 2.4.1）
需要在锁定前逐个核实是否存在、受维护且互相兼容。

## 核实结果

| 候选 | 结果 |
| --- | --- |
| AGP 8.13.2 | Google Maven 可解析（`gradle-8.13.2.pom` 200）；8.13.3 不存在，故不采用 |
| Kotlin 2.3.10 | Maven Central 可解析 |
| Gradle 8.13 | `services.gradle.org` 官方 sha256 = `20f1b117…aed78`，已下载并本地校验通过 |
| Node 22.23.3 | 官方 dist index 中 22.x 最新 LTS 补丁，与本地一致 |
| markdown-it 15.0.2 / MathJax 4.1.3 / Mermaid 12.0.0 / smiles-drawer 2.4.1 / PapaParse 5.7.0 / DOMPurify 3.4.16 / highlight.js 11.12.0 / esbuild 0.28.2 | npm registry 均可解析 |
| androidx.core:core-ktx | 最新 1.19.1 的 AAR 元数据要求 `minCompileSdk=37`，与 compileSdk 36 不兼容；改用 **1.18.0**（minCompileSdk 36，minAgp 8.9.1） |
| AndroidX WebKit 1.17.1 | AAR 元数据 minCompileSdk 33，兼容 |
| OkHttp | 采用稳定版 5.2.1（minSdk/JDK 兼容），未取最新补丁 |
| appcompat / material | **不采用**：单 Activity + 原生 Toolbar 已足够，去掉可显著减小 APK 与依赖面（不需要 fragment/emoji2/drawerlayout） |
| jsdom 26.1.0 | 仅开发期依赖，用于在无设备环境下真实执行净化器检查 |

Kotlin 2.3.10 与 AGP 8.13.2 的组合由云端构建最终验证；本地不运行 Gradle。

## 决策

1. 提交完整 Gradle Wrapper 四件套：`gradlew`/`gradlew.bat` 取自 `gradle/gradle` 仓库
   `v8.13.0` 标签，`gradle-wrapper.jar` 从**官方校验和验证过的** Gradle 8.13 发行版中
   提取（sha256 `81a82aae…7ae45f`），`gradle-wrapper.properties` 固定 bin 分发与官方
   `distributionSha256Sum` 并启用 `validateDistributionUrl`。
2. 提交 `web/package-lock.json`（`npm ci` 使用）与 `.node-version`。锁文件由公开 registry
   解析生成，包含 integrity 哈希。
3. Gradle 依赖锁与校验元数据只能在 Gradle 运行时产生，因此由 `bootstrap.yml` 在云端生成，
   推到 `bootstrap/deps` 分支并开 PR；根构建脚本仅在检测到锁文件时启用锁定。
4. 工具链整体升级必须单独提交并重跑检查；不采用 `latest`，不伪造版本。

## 影响

- 仓库不包含 `web/dist` 与任何构建产物，一个 commit + 锁文件即可重建。
- 首次进入仓库时未合并 bootstrap PR，则 CI 不启用 Gradle 锁定（并在日志中说明）。
