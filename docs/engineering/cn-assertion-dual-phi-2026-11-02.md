# 中文断言与双轨脱敏实现记录

本记录为工程交付说明，不是临床有效性报告。仅使用合成病历。

## 行为与边界

`cn-assertion-rules.mjs` 是版本化轻量规则词典；`cn-assertions.mjs` 建立
cue → 并列补语依赖，记录方向、原文位置与规则版本。这是浅层规则解析，
不是训练过的通用 dependency parser。规则设计参考
[ConText 原始论文](https://aclanthology.org/W07-1011.pdf) 的触发、伪触发与终止概念，
没有把英文工具的效果当成中文临床验证。

| 输入 | 预期行为 |
| --- | --- |
| 无发热、咳嗽、胸闷，偶有咳痰 | 前三项 negative；咳痰 positive；保存共享否定 cue |
| 肺炎？、高血压 | 肺炎 uncertain；后置问号不扩散到高血压 |
| R/O肺炎；考虑肺水肿可能 | uncertain，斜杠缩写不拆开 |
| 10年前行阑尾切除术，术后恢复可 | 手术作为历史发生事件保留；恢复单独标 recovered |
| 既往肺炎已愈 | historical / resolved，不自动成为当前确诊 |
| 胸痛无缓解；未行胸部CT | 分别 positive 与 not_evaluated |

`parseCnNote` 保留原字段，并增加 `assertion_clauses`。`mentions`、`cue` 的
UTF-16 偏移绑定原始文本；CRLF、重复标题与非 BMP 字符不会通过重排文本丢失位置。
手术已发生不等于其所涉疾病已治愈；“恢复可”不提升成全局无病结论。

动态实体词典在结构化身份被封装前建立，提取患者姓名/FHIR HumanName、别名、
同音变体、联系人、经管/上级/会诊医生及街道。已知姓名的同音匹配使用本地
字符读音表，不枚举患者姓名到磁盘，也不发送给外部服务。

完整双轨入口为 `createPatientSourceSnapshotAsync` 与
`HospitalAgentAdapter.executePreRoundWorkflowAsync`；已知实体词典和真实
CPU ONNX 模型在源文本进入证据快照前执行。模型错误、结果不完整、正文哈希
不匹配、非法跨度及复扫残留均阻断。旧同步入口保留兼容，并明确不宣称执行 NER。
后续文本可通过快照的私有 session 继续脱敏；跨患者/就诊/租户/显式会话复用被拒绝。

模型、安装、API、license 和运行限制见
[运行说明](../../plugins/medcius/runtimes/cn-phi-ner/README.md)。权重不进入 Git。
此处使用通用中文 NER 的量化模型，没有把它描述为已验证的医疗 RoBERTa 模型。

## 验证定位

- `tests/test-cn-assertion-dual-phi.mjs`：断言辖域、时间/主体、原文定位、同音姓名、
  词典隔离、快照/回放、异常和不完整检测器等合成回归。
- `tests/test-cn-phi-onnx.mjs`：显式启用实际模型；未在词典中的裸姓名、具体门牌、
  长文分窗、临床词阴性对照、实际异步快照和缺失模型等检查。
- 原有中文、隐私、证据与工作流测试仍作为回归边界；未改变只读 FHIR manifest
  或 append-only 审计机制。

工程执行记录见 [验收记录](cn-assertion-dual-phi-verification-2026-11-02.md)。合成回归不能给出真实病历的漏检率，
也不能建立临床证据或部署验收。此项交付不声称“彻底解决”或零漏检。

本次只使用免费公开检索和公开依赖/模型下载；未调用付费服务。
