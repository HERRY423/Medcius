# 中文断言与双轨 PHI 工程验收记录

日期：2026-11-02（America/Los_Angeles）。本地合成数据工程测试，未使用真实患者数据。

## 本次结果

| 项目 | 实际状态 |
| --- | --- |
| 新增规则、会话、异步入口及异常回归 | 16 项 PASS |
| 固定版本 ONNX CPU 集成 | 1 项 PASS，实际加载权重执行，不是模拟 detector |
| 上述两文件 + 会诊、交班、医院适配器回归 | 同次 Node test 输出 20 tests / 20 pass / 0 fail / 0 skipped |
| JSON contracts | PASS |
| Skills / plugin manifests | PASS |
| 项目全套 80 项检查或合成脚本 | 79 项整套完成；另 1 项部署回归补齐验证环境后单独 PASS |
| 指定 Python plugin validator | NOT_RUN：指定脚本不存在；在宿主技能及插件缓存目录中未找到替代副本 |
| 真实病历脱敏召回率 / 临床验证 / 医院部署验收 | NOT_ESTABLISHED / NOT_RUN |

`engineering × test_passed` 的范围仅限实际列出的测试；不代表 `host_accepted`
或临床用户效果。合成脚本执行成功不替代其科学或临床终点判断。

## 命令与证据

新增实际模型集成显式设置
`MEDCIUS_CN_NER_MODEL_DIR=C:\Medcius\output\models\bert-base-chinese-ner-int8` 后执行：

```powershell
node --test tests/test-cn-assertion-dual-phi.mjs tests/test-cn-phi-onnx.mjs tests/test-hospital-agent-adapter.mjs tests/test-shift-handover.mjs tests/test-consult-preparation.mjs
node scripts/validate-json.mjs
node scripts/validate-skills.mjs
```

指定但未成功执行的命令：

```powershell
python <user-home>\.codex\skills\.system\plugin-creator\scripts\validate_plugin.py plugins\medcius
```

Python 返回文件不存在，exit 1。不能把该项写成通过。

为保留工作区已有报告，全套 runner 在按文件 SHA-256 留档的独立源码副本中执行。
未改写原工作区的既有评估报告。

- 第一轮：`output/cn-dual-phi-verification-20261102/full-checks.log`：70/80 完成，
  10 项失败；包括本机网络连接受限、错误消息兼容和就诊 ID 不一致。
- 第二轮：`output/cn-dual-phi-verification-20261102-r2/full-checks.log`：79/80 完成，
  唯一失败为复制目录没有 `.git`，部署预检 `source_revision` 未通过。
- 第二轮机器记录：
  `output/cn-dual-phi-verification-20261102-r2/workspace/out/quality-gates-latest.json`。
  原始记录保留 79 完成 / 1 失败，不覆盖成 80/80。
- 为隔离副本建立真实的本地临时 Git 仓库后，仅重跑
  `node tests/test-deployment-runtime.mjs`，exit 0，并出现
  `ALL RUNTIME FORM (缺口六) TESTS PASSED`；日志为
  `output/cn-dual-phi-verification-20261102-r2/deployment-rerun.log`。
- 第二轮文件清单：`output/cn-dual-phi-verification-20261102-r2/source-manifest.json`；
  完成后核对了 26 个相关源文件，未发现相对第二轮副本的内容漂移。
  后续仅补充本文及使用说明。

因此记录为“79 项整套完成 + 1 项单独复验通过”，不宣称存在一次 80/80 的统一运行。
原工作区没有创建提交，也没有发布插件。

## 模型与依赖

- 模型：`Xenova/bert-base-chinese-ner`，revision
  `be592940bc954f32492c831bdd1d086a04036597`。
- 权重：102,959,365 bytes，SHA-256
  `7f8e1a4dac9c65d880b41c8ebedda02f074536f5ab249bdae66cfe41ae709dee`。
- 配置及 tokenizer 也逐文件校验，见
  `plugins/medcius/runtimes/cn-phi-ner/model-manifest.json`。
- CPU runtime：onnxruntime-node 1.23.2；Node 24.13.0；Windows x64。
- 本地音节表：pinyin-pro 3.29.5 的字符读音，20,935 个条目；来源许可证随表保存。
- 公开模型/依赖的已核对大小低于 1 GB。本次无付费 API 调用，无患者资料外发。

模型集成覆盖了未加入词典的合成裸姓名、具体门牌、超过单窗口的文本、非 BMP
前缀、症状文本阴性对照、异步快照、缺失模型、取消与关闭后的拒绝。它是通用中文
NER 的工程回放；不提供真实病历误删率或漏检率，也不承诺零漏检。

完整双轨仅由异步入口执行。同步兼容入口明确保留 `NER: NOT_RUN`；所需生产
入口迁移与模型接受须在宿主部署配置中落实，不能用同步返回的 `phi_safe` 冒充完整脱敏。
