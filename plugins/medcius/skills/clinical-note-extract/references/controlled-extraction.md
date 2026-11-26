# 受控中文病历抽取

适用者是院内宿主 Agent 的接入开发者；触发是对同一患者、同一就诊的一个版本化病历做只读抽取。该接口补充模型候选供医师复核，不授予诊断、处方、编码、写回或外发权限。

## 接入

```js
import { createCnNoteExtractor } from '../../../lib/cn-note-extraction.mjs';
import { createLlmInferenceClient } from '../../../lib/llm-inference-config.mjs';

// config / transport / localPhiDetector / entitySession 由批准的院内接入提供。
// config.prompt_pack_version 必须为 cn-note-candidates-1。
const client = createLlmInferenceClient({ config, transport, localPhiDetector });
const extractor = createCnNoteExtractor({ client, localPhiDetector });
const result = await extractor.extract({ note, context, entitySession, mode: 'hybrid' });
```

`note` 必须包含 `id/source_system/version_id/tenant_id/patient_id/encounter_id/timestamp/text`；`context` 包含相同的三个身份字段及带时区的 `as_of`。也接受 `source_version` 或 `meta.versionId` 作为来源版本。缺失、归属不一致、未来记录或无效时间一律拒绝；生产模式仍要求经过验证的本地 NER 与匹配的 PHI entity session。请使用批准边界内的身份标识，不把真实患者病历粘贴到通用对话。

不提供 `client` 时仍可运行 `rules_only`。这也执行本地隐私防护，不会自动选择、下载或调用任何模型。`hybrid` 只能使用现有受控客户端；固定 prompt pack、模型版本、配置摘要都进入返回记录。transport 是部署依赖，本库没有隐式网络客户端，也没有重试购买或充值逻辑。A/B 拓扑的部署许可仍由原有配置与运行时防护执行。

## 返回值与处理

- `source` 是脱敏后的精确本地快照；所有新 `text_anchor` 都绑定该快照的来源、版本、全文哈希与记录摘要，不能直接用于原始 EHR 坐标。
- `rules` 保留兼容的确定性解析结果；其中旧式聚合字段不自动获得新锚点认证。`rule_mentions` 给出逐条原文及已绑定的锚点。词法别名在 `term_mentions` 单列，原文值不被改写；`PE/RA/MS` 无默认展开。
- `review_candidates` 仅为模型建议的原文摘录，类型与语义均待复核。`rule_agreement` 只表示三轴标签与规则一致；`rule_conflict/context_incomplete/model_conflict/semantic_review_required` 明确指出审阅原因。每项都有完整句段的 `context_anchor`。不将候选直接投影到诊断字段或自动判定链。
- `rejected_candidates` 仅含序号和固定原因码，不回显模型的无效原文。超额输出、无效 schema、过期 hash/request、伪造 quote、错误 UTF-16 坐标与私有数据均受拦截。
- `coverage` 区分 `NOT_RUN/FAILED/REJECTED/PARTIAL/MODEL_REPORTED_COMPLETE`。模型自报完整不构成召回率或完整性验证；无候选不等于没有症状。

若 transport 超时或响应格式错误，返回已有规则结果并标记模型失败；PHI 防护失败则拒绝整个操作。默认总时限 30 秒、最多 2 个并发，守卫未停止时不提前释放并发位。单份输入最多 24,000 UTF-16 单元，回复最多 131,072 单元、128 个候选、每段 2,000 单元，transport 接收 8,192 output-token 上限。部署端必须执行该上限；本地长度检查不能强制供应商收费上限。超长输入直接拒绝，不静默截断；跨段合并尚未实现。

## 验证与回退

运行 `node --test tests/test-cn-note-extraction.mjs` 与全套工程检查。新合成语法夹具用于开发回归；mock transport 只验证管线和隔离，不测真实模型召回率。旧噪声评分与别名诊断分开保留，不能把换评分方法后的数字当作模型提升。

立即回退方式是 `mode: 'rules_only'`，模型候选不进入宿主最终记录。真实模型启用前，应在批准的本地语料上按患者划分开发/评估集，以源文本先行且看不到模型输出的独立标注比较规则与混合流程，分别报告候选召回、误报、三轴错误、弃答和复核时间；不同医院或科室需分别检查。此处没有临床有效性或部署准入判定。
