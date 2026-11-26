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

### 查房前病区预计算

`deploy/systemd/medcius-ward-preround.{timer,service}` 可由院方按病区启用。示例在 **Asia/Shanghai 06:30** 启动，计算完成时间必须早于同日 **07:00**。变更时区时同时调整 `OnCalendar` 和 `MEDCIUS_WARD_TIME_ZONE`。服务使用当前已激活版本，也可在同一环境里手动运行 `node scripts/precompute-ward.mjs`。相同病区可以在截止前重跑，重跑使用新的共同截止时间与独立审计事件。

定时任务在病区审计索引提交后记录 `published_at`。只有全员采集成功且索引在同一院区日期的 07:00 前提交，任务才报告成功。研究侧栏同时显示资料截止时间与索引逾时状态，迟到批次保留供追溯。

站点需配置既有的数据源授权、只读账号和 PHI 模型，并在 `MEDCIUS_HOSPITAL_SOURCE_MODULE` 导出 `createWardPrecomputeBindings({ siteActivation })`。该函数返回服务身份 `auth`、`authorizeWard(scope, auth, { signal })` 和 `loadRoster(scope, auth, { signal })`。病区权限校验先于名册读取，每个就诊再复用 `authorizeContext`。

病区名册信封包含 `tenant_id`、`ward_id`、`as_of`、`status: "complete"`、`read_only_enforced: true`、`source_id`、`source_version`、`fetched_at`、`synchronized_through` 和 `members`。每条成员显式绑定 `tenant_id`、`ward_id`、`patient_id`、`encounter_id`。名册须覆盖该病区截止时的全部活跃住院就诊，且同步水位覆盖 `as_of`。零人病区需要同样的完整性证明。查房项逐例写入静默研究归档，病区审计索引记录成功、失败及未运行的行。源覆盖不明单独计数。

病区名册可提供 `bed_number`（如 `01床`、`A12`）。缺少床位时保留名册位置。授权复核工作站以 iframe 打开 `/research/ward`，收到 `medcius:ward-ready` 后向该 iframe 的精确 origin 发送 `his:ward-context`（payload 含院内审核人员的 `sso_token`），或发送 `his:patient-context`（另含 `tenant_id`、`patient_id`、`encounter_id`）。切换患者或退出时发送 `his:context-cleared`。可信父窗口来自 `MEDCIUS_HIS_FRAME_ANCESTORS` 配置的明确 origin。研究接口要求同租户 auditor/admin。可信宿主在患者上下文中提供 `bed_number`，或在病区上下文中提供 `tenant_id` 和 `ward_roster: [{patient_id,encounter_id,bed_number}]`。侧栏在浏览器内核对冻结时点的床位校验值，匹配后显示床号。名册缺失、患者换床或匹配失败时显示名册位置。审计仅保存绑定摘要。

`GET /api/v1/research/ward-preround/today` 从院区当天的审计索引读取工作量。指定 `audit_event_id` 和 `position` 可单独打开一床的脱敏检验值或病历原文。既有整批复核接口仍接受审计编号。页面缺少当天批次时显示空缺。浏览器不缓存病历，也不下载模型。真实 HIS 的 `/his/embed` 仅调用 `POST /api/v1/his/embed/ward-status` 核实匹配快照是否已就绪。显式静默采集接口继续供已授权后台使用。

工程环境运行 `node scripts/serve.mjs --port 8080` 后打开 `/sidebar`，可以浏览仓库合成病区，也可以在测试 EMR 中嵌入该页。合成宿主可在绑定患者的消息中声明 `template_fields`，将 `changes`、`pending`、`followup` 映射到本院字段的 `{id,label}`。点击预览后，宿主只接收与当前患者绑定的 `medcius:synthetic-draft-preview`。消息带有来源、截止时间和签名要求。医院厂商负责草稿权限、复核与最终签名。研究页只做复核。停止预计算可停用 `medcius-ward-preround.timer`，历史审计结果保留。
旧安装的完整 `current/` 目录在 `--service-stopped` 确认后移入保留目录，原位置改为兼容启动入口；
未确认则拒绝迁移，切换失败会恢复原目录。新服务单元直接使用根目录启动器。
安装锁存在时拒绝并发部署，不自动删除其他进程的锁。
恢复备份前完整保留当前数据；原始备份和恢复前数据不删除。恢复是显式灾难恢复操作，不用于消除审计事件。
离线缓存不完整、缺模型、校验错误、原生库加载错误或推理错误均阻断安装/升级。

容器由锁文件安装 CPU 运行依赖（禁用安装脚本），宿主 `node_modules` 不进入构建上下文；
模型通过 `/opt/medcius/models:ro` 独立挂载。`startServer` 在监听前加载模型，每次生产请求仍执行强制边界检查。
合成回放的 CKIP 资产共 103,402,382 字节。真实院端需切换至院方批准的简体中文临床 PHI 模型目录，
按运行时契约固定模型清单的 SHA-256，并绑定部署租户。各平台需执行 CPU 探针和链路验收。
[模型清单及租户配置](../plugins/medcius/runtimes/cn-phi-ner/README.md#live-hospital-configuration)

院内查房规则由部署方选定包 ID。审批文件和规则 JSON 放入同一个只读目录，审批路径相对于
`MEDCIUS_RULE_PACK_DIR`。院方核验内容后，把 `rulePackDigest` 的值设为
`MEDCIUS_RULE_PACK_APPROVED_SHA256`。实时运行检查租户、有效期、规则摘要和审批原件的摘要。
审批元数据可使用院方可追溯的岗位或审批记录编号。
正式抗菌药规则以院方目录的完整品名匹配，仅以来源医嘱 ID 和明确开立时间为复核计时依据，
`review_after_days` 按满 24 小时计。给药日期以独立给药记录为准。

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

const config = {
  topology: "A",                          // 院内私有模型。版本和本地模型资产由院方锁定。
  model_id: "qwen2.5-14b-instruct", model_version: "2026-08",
  prompt_pack_version: "medcius-extract-v3", endpoint: "http://127.0.0.1:11434/v1",
  capacity: { max_concurrency: 8, latency_budget_ms_p95: 8000 },
};
const v = validateLlmConfig(config);

const llm = createLlmInferenceClient({ config });
await llm.extract({ text, context, entitySession }); // 使用同一患者快照的已绑定会话；缺失即阻断
```

- 提取端仅接受本机或内网 IP。内置 OpenAI 兼容传输拒绝重定向，院内可通过回环反向代理接入 Qwen 或 DeepSeek。部署方应使代理和模型进程仅能访问院内服务。
- 每次抽取返回 `{model_id, model_version, prompt_pack_version, config_digest, latency_ms}`，审计记录可回答"这条抽取出自哪个模型/提示词版本"；
- 并发预算满 → `LLM_CONCURRENCY_BUDGET_EXCEEDED`（fail-closed，不排队堆积）；超时 → `LLM_TIMEOUT`（不降级、不补造）。

### 病区数据映射与离线复核

- HIS/FHIR 接入的院方配置提供 `nhsaSystem` 与 `includeAdministrations: true`。西药规则按本院已审批、固定版本的目录校验 `nhsa_code`。计算同次就诊、同一产品在病区时区内有实际给药的日期数。复核页可展开对应的医嘱和给药记录。[国家医保局西药编码规则](https://code.nhsa.gov.cn/lib/img/file1/attachment.pdf)
- 只读任务源可映射 `assigned_to_id`、带时区的 `followup_due_at` 和原始状态。调用 `prepareWardNightHandover` 时交付上次冻结的 `previousWardHandover` 及院内 `verifyPreviousWardHandover`，即可按就诊自动承接。未获当前来源确认的责任人、期限保存在上一班记录中，当前状态标为待核实。
- EMR 可在可信患者上下文中设置 `supports_source_task_review`。医生点击“在院内任务中核对”后，宿主收到 `medcius:open-source-task`、任务标识、就诊和快照时点，打开原任务进行认领或复核。下一批次读取任务源的实际状态。
- 院内标注队列使用 `node scripts/score-cn-assertions.mjs <本地队列.json>`。输入含 `data_class: "site_deidentified"`、`tenant_id`、`protocol_id`、`adjudicated: true` 和 `notes`。每条包含就诊 `context`（含 `as_of`）、`source_id`、脱敏 `text` 和按 UTF-16 标注的 `labels[{start,end,exact,presence}]`。结果包含五类混淆矩阵、逐类样本数、精确率、召回率、F1、单类对其余类准确率，以及被暂缓的标注数和覆盖率。审核队列须独立标注，评分局限于金标准文本片段。

## 6. 升级检查单（每次升级逐项打勾）

- [ ] `node scripts/deploy.mjs status` 全 PASS
- [ ] `node scripts/run-all-checks.mjs` 全绿（步数以该文件 steps 数组为准，见 out/quality-gates-latest.json）
- [ ] 升级前 `upgrade` 已自动备份（manifest sha256 校验通过）
- [ ] `medcius.env` 密钥未变化或经密钥系统轮换（轮换需治理窗口，见运维手册 §7）
- [ ] `resident-probe --once` 无 P1/P2
- [ ] 治理阶梯未变化（变化须治理委员会决议 + 证据签名，见 governance-mode.mjs）
