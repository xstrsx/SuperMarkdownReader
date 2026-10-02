# 正式签名与发布配置

对外只交付**长期固定正式证书**签名的 Release APK。缺少签名材料时工作流**明确失败**，
不会退回 Debug 密钥、临时生成的密钥或无签名产物。

本文件只写配置步骤与公开指纹，不保存任何密码或 keystore 内容。

## 1. 由用户创建并保管密钥（Agent 不代建）

在没有现成正式密钥时，由用户在受控位置交互式创建（密码不要出现在命令行、聊天或仓库）：

```bash
keytool -genkeypair -v \
  -keystore litedoc-release.p12 \
  -storetype PKCS12 \
  -alias litedoc-release \
  -keyalg RSA \
  -keysize 3072 \
  -sigalg SHA256withRSA \
  -validity 10000
```

要求：

- 至少两份独立加密备份（离线介质 + 受控云盘），密码单独存入密码管理器；
- base64 不是加密；
- 该证书决定今后覆盖升级，**不要更换**。

导出公开指纹（用于配置 `EXPECTED_SIGNER_SHA256`）：

```bash
keytool -list -v -keystore litedoc-release.p12 -alias litedoc-release | grep -i 'SHA256:'
```

把 keystore 转成 base64（仅用于填入 GitHub secret，不要提交到仓库）：

```bash
base64 -w0 litedoc-release.p12 > litedoc-release.p12.base64
```

## 2. GitHub 配置

创建一个受保护的环境，名称必须是 **`release-signing`**（`release.yml` 的签名 job 使用它）。

环境 secrets：

| Secret | 内容 |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | keystore 文件的 base64 内容 |
| `ANDROID_KEYSTORE_PASSWORD` | keystore 密码 |
| `ANDROID_KEY_ALIAS` | 例如 `litedoc-release` |
| `ANDROID_KEY_PASSWORD` | 私钥密码 |

环境 variables：

| Variable | 内容 |
| --- | --- |
| `EXPECTED_SIGNER_SHA256` | 正式证书的 SHA-256 指纹（去重冒号也接受） |

保护规则建议：只允许受保护分支 `main` 与 `v*` 标签部署；`main` 需要评审。

## 3. 发布流程

1. 确认 `main` 通过 `verify.yml`。
2. 打标签并推送：`git tag v0.1.0 && git push origin v0.1.0`（或运行 `release.yml` 的
   `workflow_dispatch`）。
3. `guard` 校验：仅 `v*` 标签或默认分支；发布 commit 必须属于 `main` 历史。
4. `build` 生成无签名 APK 并完成静态校验与包体报告。
5. `sign` 在受保护环境中工作：先把 keystore 解码到 `RUNNER_TEMP`，用 `keytool -list`
   **预检** alias 是否存在、证书 SHA-256 是否等于 `EXPECTED_SIGNER_SHA256`
   （不一致就在签名前失败，避免产生签名身份错误的 APK），然后 zipalign + apksigner；
   签名后再核对一次并由 `apksigner verify --print-certs` 输出证书；keystore 在步骤结束时删除。
6. `verify-signed` 对签名产物再校验并产出 `SHA256SUMS`、`build-info.json`。
7. 需要时（手动勾选 `publish_draft`）创建 **draft** GitHub Release；公开发布由用户决定。

下载入口：该 run 的 artifact **`LiteDoc-release-bundle`**（含 APK、`SHA256SUMS`、
包体报告、校验报告）。安装与运行验证由用户完成。

## 4. 缺失材料时的行为

- 缺少任一 secret 或 `EXPECTED_SIGNER_SHA256`：`sign` job 打印缺失项并以非零状态退出；
  `verify-signed` 与 `publish-draft` 不会执行，因此不会产出被误认为正式版的产物。
- 证书指纹不匹配：签名 job 失败并打印实际与期望指纹。
- 未配置签名时仍可通过 `verify.yml` 获得 `unsigned-internal-build`（仅供内部检查，不作为交付）。
