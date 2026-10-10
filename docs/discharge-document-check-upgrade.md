# 出院资料核对升级

## 目标与语义

节省主管医师查找结果、整理用药衔接和确认后续安排资料的时间。三个维度独立列出已有资料、缺口和原始依据，始终将资料整理与临床出院决定分开。

旧实现的 `is_ready` 布尔值、按药名推断连续性、未知结果变为正式回报，以及自动补写通用警示与复诊时限均已移除。来源医嘱不证明已执行，来源复核不证明临床任务结束，来源预约记载不证明实际完成预约。

## 来源合同

基础资料使用 `createPatientSourceSnapshot`，与会诊和交接班共用相同患者、就诊、租户、截止时间、来源版本及缺失状态。必须为活跃住院就诊。补充输入为：

- `dischargeMedications`：出院药品原始记录，包含名称、剂量、途径、频次、疗程或停止规则。
- `medicationTransitions`：明确的 `continue/change/stop/new`、`author_id`、适用的前后来源链接；调整、停止、新增需 `rationale_text`。继续但字段不同产生待核对项，不判定医学错误。
- `followUpPlans`：`purpose`、`scheduled_at` 或 `timing_text`、`destination`、`responsible_party`、`contact_route`、`author_id`、`arrangement_status`。`booked` 还需预约引用；`target_ref` 可指向当前结果。
- `patientInstructions`：来源医师实际提供的 `text` 和 `author_id`。
- `financialAccessRecords`：原费用与可获得性合同，另按本次截止时间筛选和检查估算有效期。

每条补充记录需 `id`、含时区的 `recorded_at`、`source_reference: {resource_id, source_system}`；显式患者/就诊/租户字段必须匹配。链接格式为 `{source_id, content_sha256}`，哈希取对应已选来源的 evidence，不按名字自动配对。补充资料全部冻结到同一截止时间，另以 `document_snapshot_digest` 绑定内容；`packet_digest` 绑定完整输出。

来源归属字段仅表示适配器提供了可追查记录，**不构成认证签字、医嘱批准或预约核验**。宿主仍需建立真实来源访问与身份边界。本次不开放临床落地。

冲突、旧版本、晚到、无来源、无时间或撤回记录不会默认为当前有效资料。原始 PHI 在来源进入输出前拒绝。报告更正会使旧版本复核和跟进链接失效。空清单不等于无需药物或无需后续安排，全部药物明确停止也不会据此断言用药范围完整。

## 返回合同与迁移

`medcius.discharge-document-check.v2` 提供 `domains.results/medications/follow_up`。各域状态为 `unknown/gaps_present/fields_present_in_supplied_records`；最后一个仅说明输入记录的核对字段已具备。

`documentation_summary.coverage=not_established`，不宣称全院资料完整。缺少有来源的过敏记录仍提示回源核对。`clinical_suitability.assessed=false`、`is_suitable_for_discharge=null`。保留兼容字段 `readiness_verdict.is_ready=null, deprecated=true`，消费者必须迁移到三组资料状态，不得将 null 转换成“不能出院”或“可以出院”。旧的自动警示、签字措辞和默认复诊时间不再返回。

核心为宿主中立只读引擎，SDK 和本地 HTTP 参考适配器复用同一合同。参考页面默认展示三组资料和缺口，原始记录按需展开。HIS/SSO/临床落地仍为 P0-FROZEN。

## 验证与下一阶段

`node tests/test-discharge-readiness.mjs` 覆盖三域字段齐备但无医学结论、结果更正与旧复核、缺失与冲突、明确继续/调整/停止、新旧药品不同、预约与患者说明来源、费用过期、PHI、身份、SDK 及页面转义。HTTP 回归验证来源缺失不会被静默替换、就诊不匹配与 PHI 拒绝。

`node scripts/demo-discharge-document-check.mjs` 生成本地合成预览：资料不足、输入字段齐备、报告更正后需重新核对。合成数据不证明临床效率或安全。

下一阶段需另行批准本工作流研究：由独立人员标注结果版本与复核状态、用药衔接文档和后续责任字段，对照原流程测量寻找/整理时间、遗漏、错误引用和重复核对，单独评估认知负担。不得以医学出院率或自动批准率作为本模块效果指标。失败回退至人工查阅原始来源，保持冻结，不恢复旧的出院判断逻辑。
