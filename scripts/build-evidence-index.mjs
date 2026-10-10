// One entry per measurement, linked to exact report bytes; never merge cohorts.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
const root=fileURLToPath(new URL("../",import.meta.url));
const hash=bytes=>createHash("sha256").update(bytes).digest("hex");
const sources=[
  ["cross-evaluation-negative-controls-v1","out/evaluation-negative-controls.json","六个现有评分器的错误输出与无效输入检测；不建立金标准独立性",s=>`${s.summary.evaluations} 类评测 / ${s.summary.controls} 项负对照；未检出 ${s.summary.undetected}`],
  ["label-statistics-fixture-v1","out/shadow-mode-multicenter-summary.json","生成标签行；不运行摘要引擎",s=>`${s.total_cases} 行；独立性 ${s.independence_status}; 终点通过 ${s.pass_classification.endpoint_pass}`],
  ["engine-anchor-replay-v2","plugins/medcius/evals/shadow-mode/reports/real-world-shadow-study-summary.json","固定时间的合成患者回放",s=>`${s.total_cases} 例 / ${s.total_candidate_items} 候选；锚点分类 ${JSON.stringify(s.anchor_metrics)}`],
  ["engine-policy-challenge-v1","plugins/medcius/evals/shadow-mode/reports/engine-challenge-summary.json","软件契约预期；非独立医师金标准",s=>`${s.summary.n} 例；不匹配 ${s.summary.mismatches}；负对照 ${Object.keys(s.negative_controls).length}`],
  ["time-motion-assumptions-v1","plugins/medcius/evals/time-motion/reports/time-motion-assumptions-summary.json","预设工作流时间模型",s=>`假设节省 ${s.assumed_saved_percentage}%`],
  ["time-motion-four-row-simulation-v1","plugins/medcius/evals/time-motion/reports/time-motion-statistical-summary.json","另一个四行合成输入；不与预设模型合并",s=>`${s.sample_size} 行；描述性节省 ${s.time_metrics.time_saved_percentage}%`],
  ["noise-fixture-v1","plugins/medcius/evals/real-world-noise/reports/noise-robustness-baseline.json","固定噪声夹具；非真实临床泛化",s=>Object.entries(s.results).map(([k,v])=>`${k}: ${v.note_exact_rate.str}`).join("；")],
  ["benefit-negative-control-v1","plugins/medcius/evals/clinical-benefit/reports/synthetic-measurement-summary.json","反向计时与缺失测量负对照",s=>`描述性节省 ${s.descriptive_mean_saved_seconds} 秒；缺失 ${s.missing_episodes}；获益 ${s.efficiency_benefit}`],
];
const entries=sources.map(([id,path,scope,describe])=>{
  const absolute=join(root,path);
  if(!existsSync(absolute)) return {id,path,scope,status:"NOT_RUN",sha256:null,metrics:null};
  const bytes=readFileSync(absolute), data=JSON.parse(bytes);
  if(data.evaluation_id && data.evaluation_id!==id) throw new Error(`EVIDENCE_ID_MISMATCH:${id}`);
  if(data.execution_status && data.execution_status!=="COMPLETED") throw new Error(`EVIDENCE_RUN_INCOMPLETE:${id}`);
  return {id,path,scope,status:"SYNTHETIC_ONLY",sha256:hash(bytes),input_sha256:data.input_sha256??null,metrics:describe(data),clinical_evidence_pass:false};
});
entries.push({id:"public-benchmark",path:"plugins/medcius/evals/public-benchmarks/README.md",scope:"未运行公开数据集评测；转换器不计为评测结果",status:"NOT_RUN",sha256:null,metrics:null});
const dir=join(root,"docs/evidence"); mkdirSync(dir,{recursive:true});
writeFileSync(join(dir,"current-evidence.json"),JSON.stringify({schema_version:"medcius.evidence-index.v1",clinical_evidence_pass:false,entries},null,2)+"\n");
writeFileSync(join(dir,"CURRENT-EVIDENCE.md"),`# 当前评测证据索引\n\n由 scripts/build-evidence-index.mjs 从原始报告读取。各条目有独立身份、输入范围与文件哈希；不同分母不可相互替代。旧 out/ 报告仅在此索引引用时才是当前产物。所有结果均不支持临床获益或部署准入。\n\n| 评测身份 | 状态 / 范围 | 原始报告与指标 |\n|---|---|---|\n${entries.map(e=>`| ${e.id} | ${e.status}；${e.scope} | [报告](../../${e.path})：${e.metrics??"未测量"} |`).join("\n")}\n\n机器索引 current-evidence.json 保存报告 SHA-256。公开基准尚缺批准的数据与独立预测；生产规则包仍为 0 个院方审批产物。\n`);
console.log("Evidence index written: distinct cohorts, exact report hashes, NOT_RUN retained.");
