# 医生端内网工作台接入指南 (Doctor Workstation Integration)

Medcius 提供一个**独立于 EHR 厂商的医生端内网 Web 工作台**：不需要 EHR 厂商改造接口、不需要医生安装开发工具，信息科把工作台服务部署在院内前置机区即可使用。这是落地路径上最快、对 HIS 侵入最小的医生端形态；EHR 嵌入式侧边栏与 CDS Hooks 触发面仍作为参考适配保留。

## 组成

| 组件 | 落点 | 说明 |
|---|---|---|
| 工作台 UI | `servers/api/src/ui/workstation.html` | 单文件、零依赖；证据优先渲染（显式 NULL/缺口/严重度标签） |
| REST 面 | `servers/api/src/workstation-routes.mjs` | `/workstation/*`：登录、会话、四大工作流、病案质量核对、签核/验签、治理视图 |
| 目录身份适配 | `lib/clinician-directory-auth.mjs` | 医院 LDAP/AD/统一身份适配器插槽 + 确定性角色映射 + 失败锁定 + 会话吊销 |
| CA 电子签名适配 | `lib/ca-signature-adapter.mjs` | 内置 ECDSA P-256 供应商 + 医院 CA SDK 插槽；签名记录可验签、防篡改、零 PHI |

## 快速开始（工程/沙箱评估）

```bash
node scripts/serve.mjs --port 8080
# 浏览器打开 http://127.0.0.1:8080/workstation
```

无目录配置时登录返回 `WORKSTATION_DIRECTORY_NOT_CONFIGURED`（fail-closed，无演示后门）。工作流页面可用"演示病区（合成）"数据源——**生产部署强制禁用**（`DEMO_DISABLED_IN_PRODUCTION`）。

## 医院接入（三步）

### 1. 目录身份适配（工号 → 会话）

信息科实现目录适配器（LDAP bind / 统一身份 OAuth 换 token 后映射均可），并在服务启动时注入：

```javascript
import { createClinicianDirectoryAuth } from "./plugins/medcius/lib/clinician-directory-auth.mjs";
import { setWorkstationDirectoryAuth } from "./plugins/medcius/servers/api/src/workstation-routes.mjs";
import ldapAdapter from "./hospital-config/ldap-adapter.mjs"; // 医院实现：async authenticate({username, password, tenantId})

const auth = createClinicianDirectoryAuth({
  directory: ldapAdapter,
  // 角色映射由医院确认（对应《处方审核规范》第八条"规则由医疗机构确认"的身份侧纪律）
  roleAssignments: [
    { match: { department: "心血管内科" }, roles: ["physician"] },
    { match: { department: "药剂科" }, roles: ["pharmacist"] },
  ],
  maxFailedAttempts: 5,
  lockoutSec: 300,
});
setWorkstationDirectoryAuth(auth);
```

Fail-closed 纪律：目录不可用 → `AUTH_DIRECTORY_UNAVAILABLE`（不计入凭据失败、不暴露用户存在性）；凭据错误连续 5 次 → 锁定；**目录身份没有医院配置的角色映射 → 拒绝**（无隐式特权）。

### 2. 数据源绑定（只读连接器）

工作流接口接受调用方注入的数据源（与 `ReadOnlyHospitalDataBridge` 的六字段信封同构）。生产路径由前置机的 P1–P4 连接器拉取、经 PHI 出口守卫后传入；测试/评估可用 `demo_ward` 合成病区（生产禁用）。

### 3. CA 电子签名对接（法律有效的签核）

内置 `internal-ec-p256` 供应商明确**不是**医院 CA 证书（上线前检查清单项）。医院 CA SDK（CFCA/BJCA 等 P7/CMS 分离签名）按以下契约注入：

```javascript
import { createCaSignatureAdapter } from "./plugins/medcius/lib/ca-signature-adapter.mjs";
import { setWorkstationCaAdapter } from "./plugins/medcius/servers/api/src/workstation-routes.mjs"; // 如部署需全局替换

const ca = createCaSignatureAdapter({
  providerId: "hospital-ca-sdk",
  provider: {
    id: "hospital-ca-sdk",
    async sign({ payloadDigest, signerId, role }) {
      // 调医院 CA SDK 对 payloadDigest 做 P7/CMS 分离签名，返回签名 + 证书
      return { signature, key_ref, algorithm, certificate_fingerprint, certificate };
    },
    async verify({ payloadDigest, signature, certificate }) {
      return { valid, reason };
    },
  },
});
```

签名记录绑定 `{ workflow, payload_digest, signer, tenant, provider, 证书指纹, timestamp }`——不落报告原文，零 PHI 进审计链；任何载荷字节变化都会被 `CA_PAYLOAD_DIGEST_MISMATCH` 捕获（篡改证据）。

## 治理阶梯感知（D6 落地）

| 治理阶段 | 工作台行为 |
|---|---|
| Level 1 回顾性研究 / Level 2 静默试点 | 研究参考模式横幅；报告可生成但签核返回 `STAGE_FORBIDDEN` |
| Level 3 建议模式 | 签核开放：医生对**所见报告的精确摘要**完成可验证确认 |
| Level 4 认证签核写回 | 签核开放；EHR 写回仍受独立门禁（`assertWritebackAllowed`），工作台本身不写回 |

## 安全边界（重申）

- 全部工作流端点默认关闭 RBAC（无 token → 401）；`X-Tenant-ID` 与 token 租户绑定强校验；
- 工作台不写回 EHR、不下医嘱；输出均为"供专业人员复核的参考信息"；
- 审计链只记结构化事件（登录/拒绝/签核摘要），自由文本不进日志；
- 生产必须 TLS（server.mjs 强制）+ 密钥系统注入 `MEDCIUS_JWT_SECRET`。
