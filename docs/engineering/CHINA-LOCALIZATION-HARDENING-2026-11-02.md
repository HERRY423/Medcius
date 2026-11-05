# 中国本地化缺陷修复与接入说明 · 2026-11-02

本次交付是本地工程实现与合成回归检查，`claim_type=engineering`、`evidence_level=test_passed`；适用范围是下列代码路径及测试输入。采用 L1 工程自查，**非独立审查**。没有接入真实患者、生产医院、厂商 SDK 或付费服务，也没有取得临床有效性、注册合规或宿主部署验收证据。

## 图片中的七类问题与本轮处理

| 领域 | 当前源码核对及已完成的改进 | 仍未建立的能力/证据 |
|---|---|---|
| 医院接入 | 原仓库已有 FHIR R4、CDA、视图库、HL7 v2 适配器，不能再概括为只有 JSON/CSV stub。本轮扩展 P3 的 SQLite/MySQL/PostgreSQL/SQL Server/Oracle 参数化查询方言、独立 schema 白名单、固定租户绑定、超时、未结束任务的并发限额，以及站点工厂入口；实际 SQLite 查询验证患者/就诊/租户隔离，满页保留 `complete=false`。 | 四种非 SQLite 方言仅验证 SQL 与参数契约，未连真实数据库。卫宁、东软、创业慧康、嘉和各院版本的字段映射、SOAP 认证/报文、CDC 顺序/撤销/重放及容量验收仍需院方接口材料；没有声称生产级厂商适配已完成。 |
| 中文病历 | 新增分句断言与量值抽取模块：否定、疑似、未评估、家属、既往状态分开；`R/O` 不转成肯定诊断；混合断言的整句结果保留不确定。章节重复不覆盖，CRLF/括号标题与原文 UTF-16 偏移保留；检验重复值全部保留，缺单位为 null，`<` 等比较符保留，mg/dL 不误写为 μmol/L；增加 T/P/R/BP 明示数值抽取。未确定的第一诊断不再被后面的诊断顶替。 | 仍是有边界的规则解析，不是通用医学 NLU。未建立真实中文自由病历的召回率、完整术语覆盖或临床诊断准确性。 |
| PHI | 启用有限上下文的家属/医护姓名识别，增加临床词误脱敏回归；B 类混合推理从“配置声明即可开启”改为必须实际执行院端 detector，验证文本哈希、完成标记、实体坐标，脱敏后复扫；返回文本也过守卫，失败/超时不发送，异常不回显供应商原文。医院输入先脱敏再生成锚点，冻结回放使用同一文本。 | 未捆绑、下载或验证中文 NER 模型；部署方必须提供经本地评测的 detector。`execution: local` 是适配契约声明，不能证明网络隔离或完全去标识化，receipt 明示 `complete_deidentification=NOT_ESTABLISHED`。 |
| 病案质控与编码 | 编码按明确 code_system 查询，不再跨体系回退；精确名称查询同时返回完整命中数，截断结果不冒充唯一映射；无规则状态为未评估，不当作通过。P 章成人病例转为起源复核提示；疑似诊断保留待核而非一概禁止编码。另发现原住院天数算法多计一天，按官方首页口径修正并保存旧规则/测试。 | 无官方库时 `unverifiable` 是正确的失败关闭，不应伪造词表消除该状态。CCHI 可作为独立代码体系查询，但未导入官方 CCHI 全量表，未建立 ICD↔CCHI 转换；未实现地方 DRG/DIP 分组、MCC/CC 漏报推断。 |
| 药品与目录 | 药品匹配不再选模糊查询第一条，同名多产品要求明确产品标识；产品 ID 与批准文号冲突即拒绝。目录限定支付范围只做精确名称检索，明确 `payment_eligibility=NOT_EVALUATED`。肾功能接口不把按体表面积标准化的 eGFR 当成 CrCl 分层，不生成剂量建议。官方行数量只表示语料存在，不再等同 production_ready。 | 未实现 VBP 自动替代、医保报销裁决、中成药完整配伍规则、Child-Pugh 剂量推荐或中国人群肾功能校准；这些属于独立预期用途，不能由说明书关键词命中推出。 |
| CA 与身份 | 签名 envelope 升级 v2，对 workflow、tenant、signer/role、payload digest、provider、key/cert 指纹、algorithm、time、nonce 一并签名；自由备注只存摘要。hospital profile/生产存储环境拒绝内置测试证书，要求证书链、吊销、身份、租户及新鲜度的校验响应；签署后立即验证。 | 内置 ECDSA 保持 `test_only`。未实现或验收 BJCA/CFCA/NETCA/移动签名 SDK，未验证 SM2/SM3 实现；SM4 是对称加密能力，不能用算法名称填充来冒充电子签名集成。测试里的自定义 provider 只验证接口边界。 |
| 临床证据 | 新增本地评测输入清单：真实/合成身份显式区分、数据集哈希绑定、重复记录拒绝、所有文本字段 PHI 扫描、患者级开发/评测隔离、source-first 标注声明、双标注者引用、非空且可评分 gold。合成 CLI 探针不再冠名 REAL_DATA；计数按输入描述，不给多病历伪独立区间。 | 引用字段与声明不能验证伦理批准、授权、真实去标识化或医师独立性；真实回顾性与前瞻影子研究仍 `NOT_RUN`，临床效果 `NOT_ESTABLISHED`。 |

## 已实际复现的错误与测试证据

- 最初加入的 7 个回归测试在修改前全部失败，修复后通过；随后扩展为 **24 个针对性测试，24/24 通过**。这是开发回归证据，不是独立外部验证。
- 完整项目检查最终为 **78/78 步完成，0 步失败**：**65 项带断言的工程检查通过，13 项报告/评测脚本执行完成**。报告生成步骤只证明执行完成，不能统称为终点达标；receipt 保留每步 `kind`、`assertion_status`、退出码与输出哈希。
- 首次完整运行有 3 步失败，均涉及 `FROZEN_RECORD_REPLAY_MISMATCH`：上下文姓名规则误脱敏临床词，以及锚点形成后再脱敏造成文本不一致。修复后原失败检查通过；失败日志仍保留。
- 住院天数另外先加入官方示例回归，实际观察到旧代码错误报冲突，再修复算法；后续完整回归又检出一个沿用旧天数的“clean”对账夹具，也按同一来源纠正。旧预期 `出院−入院+1` 与旧病例均已归档；本轮修改 gold 是有来源的规范纠错，不是为提高指标调阈值。
- 固定噪声基准的 combined 从旧版本 **20/30** 全字段命中变为 **21/30**，字段命中从 **59/72** 变为 **61/72**；clean 仍 **30/30**。仍有 **9/30** combined 样例非全字段命中，缩写方言仍 **22/30**。同一组开发夹具与噪声种子相互依赖，不宣称显著改善、独立重复或真实世界泛化；未调整下限绊线。
- `node scripts/validate-json.mjs` 与 `node scripts/validate-skills.mjs` 纳入完整运行。AGENTS 指定的 `<user-home>\.codex\skills\.system\plugin-creator\scripts\validate_plugin.py` 在本机不存在，调用失败，记为 **NOT_RUN_TOOL_MISSING**，没有用无关脚本替代或把这项写成通过。

执行记录：[最终完整日志](../../out/china-localization-2026-11-02/full-checks-final.log)、[最终机器回执](../../out/china-localization-2026-11-02/quality-gates-final.json)、[针对性测试](../../out/china-localization-2026-11-02/targeted-final.log)、[首次完整运行失败](../../out/china-localization-2026-11-02/full-checks.log)、[住院天数修复前失败](../../out/china-localization-2026-11-02/stay-day-before-fix.log)。旧产物：[此前证据备份](../../out/china-localization-2026-11-02/prior-evidence.zip)、[旧住院天数规则及夹具](../../out/china-localization-2026-11-02/prior-stay-day-rule.zip)。`out/` 是本地交付产物，默认不提交 Git。

另有[验证摘要与文件哈希](../../out/china-localization-2026-11-02/verification.json)、[本轮改动快照](../../out/china-localization-2026-11-02/verified-change-snapshot.zip)、[旧夹具触发的完整检查失败](../../out/china-localization-2026-11-02/full-checks-stay-fixture-failure.log)及[缺失校验器调用记录](../../out/china-localization-2026-11-02/required-plugin-validator.log)。

## 接口迁移与部署者需要提供的实现

**P3 只读执行器。** `createViewDbConnector` 新增 `dialect`、`schema`、`fixedTenantId`、`timeoutMs`、`maxConcurrency`。`query(sql, params, { signal, readOnly, dialect })` 由部署者绑定真实驱动、只读账号与批准视图；标识符来自静态白名单，患者/就诊/租户值必须传给驱动绑定，不能字符串拼接。SQL Server 用 `@p1…`，PostgreSQL 用 `$1…`，Oracle 用 `:1…`，MySQL/SQLite 用 `?`；驱动应按此顺序绑定。`readOnly: true` 不能代替数据库授权。没有 tenant 列时必须提供 `fixedTenantId` 并在账号/视图层隔离租户。超时后未停止的执行器继续占用并发名额；满页表示可能截断，不能报告为完整阴性。本次没有新增 CDC 引擎或后台数据库连接。

`createSiteConnectors(activation, { channel: 'viewdb', query, tables, columns, mappers, dialect, ... })` 将固定租户绑定到已激活站点，并继续经过原 PHI 守卫。默认四张视图只覆盖 patient/encounter/lis/his；查房工作流所需的其余来源仍须明确提供，缺失不能按完整输入放行。

**本地 PHI detector。** `createLlmInferenceClient({ config, transport, localPhiDetector })` 的 B 模式仍需原四项声明，并新增实际检测器与无嵌入凭据的 HTTPS endpoint 要求。检测器接口：

```javascript
{
  id: 'deployment-detector-id',
  version: 'reviewed-model-and-policy-version',
  execution: 'local',
  async detect(text, { signal }) {
    // 在批准的本地运行时调用真实实体识别器；这里没有提供假检测实现。
    // 返回如下对象，spans 必须对应传入的这个原文：
    // { complete: true, text_sha256: SHA256(text),
    //   spans: [{ start, end, label: 'PERSON' }] }
  }
}
```

坐标为 JS UTF-16、左闭右开；可用标签为 PERSON、ADDRESS、IDENTIFIER、CONTACT、ORGANIZATION。超时、缺失完成标记、哈希不匹配、非法坐标、复扫残留均拒绝。模型返回文本也检测；transport 异常改为固定错误，不传播供应商可能包含输入的错误详情。检测器的版本和执行 receipt 不代表它有足够的召回率，部署仍需含裸人名与误脱敏病例的本地标注集。全本地 A 模式的网络位置仍由医院部署验证。

**签名 v2。** 自定义 provider 现在必须实现 `getSigningIdentity`、`sign`、`verify`。`getSigningIdentity({ signerId, role, tenantId })` 返回 `key_ref`、`algorithm`、`certificate_fingerprint`；`sign` 收到的是整个 unsigned envelope 的摘要，不能只签原业务 payload。签署过程中身份返回值变化即拒绝。

hospital 模式还要求 `assurance='hospital_ca'`，以及 verify 返回 `valid=true`、`certificate_chain_valid=true`、`revocation_status='good'`、一致的 `signer_id`/`tenant_id` 和 5 分钟内的 `checked_at`。这些检查必须由真实 SDK/KMS/证书服务执行，不能静态填 true。`requiredAlgorithm` 可钉住院方批准的算法标识，标识本身不证明实现正确。旧 v1 记录保留原样；v2 验证器拒绝旧格式，不自动重签、不改写历史审计链。新签名与旧版本不兼容，升级前需院端联调和明确的历史记录展示策略。

本次仅修改工作区，未部署到医院。迁移出现回归时先停用受影响的 B 类出域、签名或视图通道，保留本轮与历史记录，回退至已经验收的部署版本；不能通过恢复测试密钥、跳过 PHI 检查或重签历史记录来“修复”验收失败。

**编码与药品消费方。** `search_codes` 增加 `code_system`、`match_mode='exact_name'` 和 `total_matches`/`truncated`；自动填充仅接受精确唯一结果，其他结果保留候选或 null。`check_settlement_list.checks[].ok` 现在可能为 null，表示缺少适用规则或必要上下文；消费者不能把 null 当通过，也不能把它计作已观察到的冲突。`production_ready` 不再由 official 行数决定，改读 `corpus_available` 获取存在性信息。需另外完成来源版本、权限、具体预期用途和部署验收。

## 真实评测入口的使用边界

合成回归显式使用：

```powershell
node plugins/medcius/evals/real-world-noise/ingest-real-data.mjs synthetic-notes.jsonl --synthetic --report synthetic-replay.md
```

真实数据只能在另行批准的数据处理边界内运行：

```powershell
node plugins/medcius/evals/real-world-noise/ingest-real-data.mjs deidentified-notes.jsonl --manifest reviewed-intake.json --report retrospective-replay.md
```

这只是命令模板，本轮没有执行真实数据回放。不得同时指定 `--synthetic` 和 `--manifest`。

manifest 必须有 `schema_version='medcius.clinical-evaluation-intake.v1'`、`data_kind=retrospective|prospective_shadow`、`study_ref`、`protocol_ref`、`authorization_ref`、`ethics_ref`、`processing_ref`、`parser_version`、`site_ref`、`annotation_protocol_ref`、`split_policy_ref`、`development_subject_refs`，以及 `dataset_sha256`。最后一项的计算定义为 `sha256Hex(canonicalJson(cases))`，cases 是依 JSONL 顺序解析的记录数组；这只绑定数据版本，不证明授权真实性。

每条记录须有不含身份的 note_id、note_text、非空 gold、source_meta.desensitized=true；真实输入还须声明 subject_ref、source_record_ref、source_version、split=evaluation、annotation_source=source_first、model_output_visible=false、至少两个不同 annotator_refs。以患者标识检查开发/评测交叉，不把多份病历计作多个独立患者。标识与清单应使用本地批准的假名引用；不要把审批原文、患者信息或本地私有路径填进可外发日志。

输出只记录 `DECLARED_RETROSPECTIVE` / `DECLARED_PROSPECTIVE_SHADOW`，授权核验仍为 EXTERNAL_REVIEW_REQUIRED，标注独立性与临床效果仍为 NOT_ESTABLISHED。结构门禁通过不能自动进入生产或解除临床研究审批。

## 影响实现选择的公开依据

本轮只用公开通用查询；检索日期 2026-11-02，来源为 NHC、NHSA、药监相关官方页面及 CDC 的 ICD-10 定义，属于针对具体规则的有限核对，不是系统综述或法规适用性鉴定。

- NHC《住院病案首页数据填写质量规范（暂行）》第六条、第十一条（三）明确了编码体系及住院期间疑似诊断仍未确诊时的主要诊断选择规则，因此不能加入“所有疑似诊断均不得编码”的通用禁令。本轮只做待核提示，未自动选码。[官方 PDF，第 1–2 页文本](https://www.nhc.gov.cn/yzygj/c100068/201606/2e3b6393fcff4f0095a45a507a975f2f/files/1732862097149_84256.pdf)
- NHC 2011 年首页填写说明第十九项给出 6 月 12 日入院、15 日出院计 3 天的例子；湖南省医保局 2023 年规则第 63 项另明确同日入出院计 1 天。修正的是病案首页日历日口径，不是按小时结算或床位收费算法。[NHC 原文](https://www.nhc.gov.cn/wjw/gfxwj/201112/a927f36f48cf4887bcbb6bc821a79d8b.shtml)、[湖南省医保局规则](https://ybj.hunan.gov.cn/ybj/first113541/firstF/f3113607/202306/t20230614_29374849.html)
- ICD-10 第 XVI 章限定围产期起源，并不等价于“仅允许当前新生儿使用”；这不排除某些具体码与地方规则有单独年龄限制，故未知起源转人工复核，未建立全国通用放行规则。[CDC 收录 ICD-10，Chapter XVI 开篇，PDF 文本约第 1006 页](https://www.cdc.gov/nchs/data/dvs/2e_volume1_2017.pdf)
- 官方材料仍明确使用 ICD-10/ICD-9-CM-3；本次没有找到足以授权把所有院内手术编码统一替换为 CCHI 的依据。因此实现代码体系隔离，避免在没有院端版本/映射时擅自替换。[NHC 首页规范](https://www.nhc.gov.cn/yzygj/c100068/201606/2e3b6393fcff4f0095a45a507a975f2f/files/1732862097149_84256.pdf)、[NHSA 2026 年编码应用通知索引](https://www.nhsa.gov.cn/art/2026/1/19/art_109_19413.html)（后者仅核对通知索引，附件正文未能读取，不作为 CCHI 替代结论的依据）。
- 图片混淆了分类界定与注册审查文件：项目现有 SAMD-PATHWAY 已分别列出 2021 年第 47 号分类界定文件和 2022 年第 8 号 AI 注册审查指导原则，无需把正确文档再“修复”为图片中的文号。[官方转载公告](https://www.cncsdr.org/ggtz/ggzz/202203/t20220311_304188.html)；本轮只核对公告题名，未进行完整法律适用性审查。

## 下一步的验收条件与成本边界

1. **一个医院、一个版本的实际接入验收**：提供批准的只读接口契约、脱敏样例及撤销/重复/乱序案例后，测患者隔离、完整性与断点恢复；失败收窄该通道，成功只支持该院版本。未运行，预计工程数日，接口材料未到位前不能给可靠总工期。
2. **院端 PHI 与 CA 分别验收**：在批准的本地运行时用人工标注的裸姓名/误脱敏案例验证 detector；用真实测试证书验证签署、换证、吊销、超时与身份错配。通过才增加对应组件的宿主验收证据，不升级为临床有效性。未运行，需院方检测器/SDK/证书测试环境，外部费用未知，本轮未购买。
3. **经批准的独立回顾性/影子评测**：冻结解析器、抽样、患者划分、人工标注与终点后再收集独立资料；结果决定维持、收窄或扩大具体工作流范围。未运行，需要真实资料与医生工时，当前不编造样本量、效果量或完成日期。

可选增强：在获得上述失败样例后扩展缩写词典、站点 mapper 或地区规则包；不为展示功能而加入未经验证的处方推荐、自动替代或编码裁决。

七项底线逐项状态：**通过（仅工程夹具范围）**：输入质控（无效字段/PHI/重复记录）、方法前提（坐标/单位/代码体系契约）、阴性对照与基线（篡改/串患者/未知词表/修复前失败）；**不适用**：样本与批次、分析单位与生物学重复、多重比较、训练测试泄漏——本轮不估计临床人群参数、不训练模型、不进行显著性检验，患者划分门禁测试不等于真实研究无泄漏；**未知**：真实临床的上述七项均尚无获批数据可评，不将它们记作通过。缺少的外部 plugin-creator 校验独立记为 NOT_RUN_TOOL_MISSING。

费用：AgentMuxer 仅免费能力搜索，未 resolve/invoke，未发生该平台付费调用；未下载模型、官方全量数据库或真实病例。
