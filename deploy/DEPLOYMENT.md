# 前置机部署与运维手册（DEPLOYMENT · 缺口六落地）

> **用途**：把 Medcius 从"git 仓库 + node 进程"变成可安装、可升级、可回滚、可监控的院内交付物。与 `docs/ops/PRODUCTIZATION-OPERATIONS.md`（策略层）配套，本文是执行层。所有命令已在 CI 中做确定性子集验证（第 45 门）。

## 1. 前置机规格基线

| 项 | 沙箱评估 | 生产建议 |
|---|---|---|
| OS | 任意可跑 Node ≥20 | 麒麟/openEuler/Ubuntu LTS（院方基线） |
| CPU/内存 | 2C4G | 4C8G（含本地 LLM 推理时按模型另计 GPU） |
| 磁盘 | 10G | 系统 20G + 数据 50G+（审计链按事件量评估） |
| 网络 | 单机 | 医院内网区 → 前置机区（DMZ）；医生工作站 → 前置机 8443/TLS；前置机 → HIS 只读视图/FHIR |
| 运行身份 | 任意 | 专用 `medcius` 系统用户（非 root） |

## 2. 三种部署形态

| 形态 | 命令 | 适用 |
|---|---|---|
| 容器（推荐） | `docker compose --profile hospital up -d` | 有容器平台的院区；`deploy/medcius.env` + 卷挂载注入密钥/数据/TLS/规则包 |
| systemd 裸机 | `deploy.mjs install --target /opt/medcius` + `deploy/systemd/medcius.service` | 无容器平台 |
| 开发沙箱 | `docker compose --profile sandbox up` 或 `node scripts/serve.mjs` | 工程/演示（demo 病区可用） |

## 3. 安装 / 升级 / 回滚（`scripts/deploy.mjs`）

```bash
# 巡检（node 版本、env、数据目录、源码版本）
node scripts/deploy.mjs status

# 安装（确定性布局：releases/<时间戳> + data/ + backups/ + medcius.env；env 存在则拒绝覆盖）
node scripts/deploy.mjs install --target /opt/medcius

# 升级 = 先备份 data/（sha256 清单）→ 新版本 release → 切换 current
node scripts/deploy.mjs upgrade --target /opt/medcius

# 回滚 = 校验备份清单 sha256 → 恢复 data/（当前数据先做安全备份）
node scripts/deploy.mjs rollback --target /opt/medcius --to <backup-ts>

# 一切变更支持 --dry-run（只打印计划，不落盘）
```

升级铁律：升级前 `backup` 自动执行；审计链（append-only）只进备份、永不重建；回滚必须通过 manifest sha256 校验，损坏即中止。

## 4. 常驻探针与监控对接（落地运维手册 §6）

```bash
# 单次巡检（CI 第 45 门使用 --once；P1/P2 活跃时 exit 2）
node scripts/resident-probe.mjs --once --metrics-out /opt/medcius/metrics/probe.prom

# 常驻（systemd timer 或 compose 内另起 sidecar）
node scripts/resident-probe.mjs --interval 60 --state-file /opt/medcius/data/probe-state.json --metrics-out /opt/medcius/metrics/probe.prom
```

告警规则（确定性子集，`evaluateProbeRules` 可单测）：
- `audit_chain_broken` **P1**：审计链 verify 任何一次失败即 P1；
- `health_endpoint_down` 连续 ≥3 周期 P2，累计 ≥30 分钟升 P1；
- `production_corpus_missing` **P2**：official 语料为 0（H01 将阻断真实流程）；
- `probe_latency_breach` **P3**：/health 延迟超预算。

Prometheus 指标（`medcius_probe_*`）写入 `--metrics-out`，由院方监控平台（Prometheus file_sd / exporter 汇聚）采集；告警通知走院方既有通道。

## 5. LLM 推理路径（缺口六：从"口头约定"到"被校验的配置"）

```javascript
import { validateLlmConfig, createLlmInferenceClient } from "./plugins/medcius/lib/llm-inference-config.mjs";

const v = validateLlmConfig({
  topology: "A",                          // A 全本地 / B 混合；C 全托管在校验层直接拒绝
  model_id: "qwen2.5-14b-instruct", model_version: "2026-08",
  prompt_pack_version: "medcius-extract-v3", endpoint: "http://127.0.0.1:11434/v1",
  capacity: { max_concurrency: 8, latency_budget_ms_p95: 8000 },
});
// v.ok === false 时拒绝启动相关工作流（fail-closed）

const llm = createLlmInferenceClient({ config, transport: myOpenAICompatibleTransport });
await llm.extract({ text });  // 只有 extract() —— 对象上不存在 decide()/adjudicate()（D1 结构性限制）
```

- B 档必须声明 `desensitization_attestation: true` 与 `provider_registration_ref`（R20 备案核验引用）；
- 每次抽取返回 `{model_id, model_version, prompt_pack_version, config_digest, latency_ms}`，审计记录可回答"这条抽取出自哪个模型/提示词版本"；
- 并发预算满 → `LLM_CONCURRENCY_BUDGET_EXCEEDED`（fail-closed，不排队堆积）；超时 → `LLM_TIMEOUT`（不降级、不补造）。

## 6. 升级检查单（每次升级逐项打勾）

- [ ] `node scripts/deploy.mjs status` 全 PASS
- [ ] `node scripts/run-all-checks.mjs` 全绿（44+ 门）
- [ ] 升级前 `upgrade` 已自动备份（manifest sha256 校验通过）
- [ ] `medcius.env` 密钥未变化或经密钥系统轮换（轮换需治理窗口，见运维手册 §7）
- [ ] `resident-probe --once` 无 P1/P2
- [ ] 治理阶梯未变化（变化须治理委员会决议 + 证据签名，见 governance-mode.mjs）
