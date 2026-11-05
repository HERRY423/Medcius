# 前置机部署与运维手册（DEPLOYMENT · 缺口六落地）

> **用途**：院内交付的安装、升级、恢复与监控说明。工程回归不代替目标操作系统、容器镜像和医院接入验收。

## 1. 前置机规格基线

| 项 | 沙箱评估 | 生产建议 |
|---|---|---|
| OS | Node ≥22，匹配该平台的 ONNX CPU 原生依赖 | 经医院验收的操作系统；容器使用 glibc 基镜像 |
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

# 先在受控构建机准备 package-lock.json 指定的 npm 缓存和独立模型资产。
# 安装器只运行 npm ci --offline --ignore-scripts --omit=dev，不自动联网下载。
# MEDCIUS_CN_NER_MODEL_DIR 必须为已按清单核验的本地模型目录。
# 安装布局：不可变 releases/<唯一版本> + active-release.json + launch.mjs。
node scripts/deploy.mjs install --target /opt/medcius

# 停止服务后执行备份/升级，避免复制正在写入的 SQLite/WAL。
# 升级 = 备份 data/ → 准备依赖 → 真实 CPU NER 探针 → 原子切换启动指针。
node scripts/deploy.mjs upgrade --target /opt/medcius
# 旧版 current/ 为完整目录时，在停止旧服务后显式确认迁移：
# node scripts/deploy.mjs upgrade --target /opt/medcius --service-stopped

# 回滚 = 校验备份清单 sha256 → 恢复 data/（当前数据先做安全备份）
node scripts/deploy.mjs rollback --target /opt/medcius --to <backup-ts>

# 一切变更支持 --dry-run（只打印计划，不落盘）
```

升级铁律：升级前 `backup` 自动执行；审计链（append-only）只进备份、永不重建；回滚必须通过 manifest sha256 校验，损坏即中止。

`launch.mjs` 在启动时解析并固定一个 release 的真实路径；依赖或模型失败不激活新版本，旧 release、数据与现有环境文件均保留。
systemd 必须使用本目录更新后的 `ExecStart=/usr/bin/node /opt/medcius/launch.mjs`。
旧安装的完整 `current/` 目录在 `--service-stopped` 确认后移入保留目录，原位置改为兼容启动入口；
未确认则拒绝迁移，切换失败会恢复原目录。新服务单元直接使用根目录启动器。
安装锁存在时拒绝并发部署，不自动删除其他进程的锁。
恢复备份前完整保留当前数据；原始备份和恢复前数据不删除。恢复是显式灾难恢复操作，不用于消除审计事件。
离线缓存不完整、缺模型、校验错误、原生库加载错误或推理错误均阻断安装/升级。

容器由锁文件安装 CPU 运行依赖（禁用安装脚本），宿主 `node_modules` 不进入构建上下文；
模型通过 `/opt/medcius/models:ro` 独立挂载。`startServer` 在监听前加载模型，每次生产请求仍执行强制边界检查。
模型清单固定为 103,402,382 字节，运行时绝不从网络下载。各平台仍须实际启动和合成链路验收。

容器健康检查使用 `node scripts/healthcheck.mjs`，跟随服务的 TLS 配置，生产缺 TLS 或证书不可信均失败。
探针连接 `127.0.0.1`，证书须含此回环地址的 SAN；院内 CA 可经只读挂载及 `NODE_EXTRA_CA_CERTS` 注入，不关闭证书验证。
实际离线容器回归使用 `scripts/validate-container.mjs`：先构建镜像，然后设置
`MEDCIUS_CONTAINER_IMAGE`、`MEDCIUS_CN_NER_MODEL_DIR`、`MEDCIUS_CONTAINER_TEST_TLS`。
最后一个目录只放合成回环测试证书 `synthetic.key` / `synthetic.crt`，不使用生产密钥。
此验收会启动临时非 root、无外网、只读根文件系统容器，并覆盖模型/依赖缺失、TLS 和合成 PHI 回归；不替代医院验收。

插件检查可在仓库内运行 `node scripts/validate-plugin.mjs`，使用固定上游版本与 Python / PyYAML 依赖，
来源和哈希见 `scripts/vendor/openai-plugin-validator/provenance.json`。性能检查固定 `MEDCIUS_PERF_BUDGET_FACTOR=1`，不接受放宽门槛的覆盖值。

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
await llm.extract({ text, context, entitySession }); // 使用同一患者快照的已绑定会话；缺失即阻断
```

- B 档必须声明 `desensitization_attestation: true` 与 `provider_registration_ref`（R20 备案核验引用）；
- 每次抽取返回 `{model_id, model_version, prompt_pack_version, config_digest, latency_ms}`，审计记录可回答"这条抽取出自哪个模型/提示词版本"；
- 并发预算满 → `LLM_CONCURRENCY_BUDGET_EXCEEDED`（fail-closed，不排队堆积）；超时 → `LLM_TIMEOUT`（不降级、不补造）。

## 6. 升级检查单（每次升级逐项打勾）

- [ ] `node scripts/deploy.mjs status` 全 PASS
- [ ] `node scripts/run-all-checks.mjs` 全绿（步数以该文件 steps 数组为准，见 out/quality-gates-latest.json）
- [ ] 升级前 `upgrade` 已自动备份（manifest sha256 校验通过）
- [ ] `medcius.env` 密钥未变化或经密钥系统轮换（轮换需治理窗口，见运维手册 §7）
- [ ] `resident-probe --once` 无 P1/P2
- [ ] 治理阶梯未变化（变化须治理委员会决议 + 证据签名，见 governance-mode.mjs）
