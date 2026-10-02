# 交付说明（Actions 产物入口与验证边界）

## 产物入口

| 内容 | 位置 |
| --- | --- |
| 无签名内部构建（**不可作为用户安装包**） | `verify.yml` 或 `release.yml` run 的 artifact `unsigned-internal-build` / `release-build-reports` |
| 源码检查报告 | artifact `code-check-report`（含 `reports/*.json` 与工具链记录） |
| 离线 Web 资源与闭包检查 | artifact `web-dist`、`web-build-reports` |
| **正式签名 APK**、`SHA256SUMS`、`build-info.json`、包体报告 | `release.yml` run 的 artifact **`LiteDoc-release-bundle`** |
| 失败排查用的日志摘要 | 分支 `ci-report`（verify）、`ci-report-release`（release） |

`LiteDoc-release-bundle` 只有在配置了正式签名后才存在（见 `docs/signing.md`）。

## 复核方式

```bash
sha256sum -c SHA256SUMS            # 与下载的 APK 对照
cat build-info.json                # commit / workflow run / 锁文件哈希 / 证书指纹 / 版本
cat reports/size-report.md         # 包体分项
cat reports/apk-verification-signed.json   # 静态校验事实（含签名证书 SHA-256）
```

## 边界

- Agent 不下载、不安装、不运行 APK，不搭建模拟器/真机/浏览器自动化验收。
- 首次断网、安装与升级、各格式渲染、图片策略、授权、导出与性能，**由用户手动下载后验证**
  （清单见 `docs/manual-verification.md`）。
- 构建成功与静态校验通过**不等于**功能已在设备上验证；本文与仓库中未收到用户结果的条目
  一律标注“待用户验证”。
