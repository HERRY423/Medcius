// One entry per measurement, linked to exact report bytes; never merge cohorts.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
const root=fileURLToPath(new URL("../",import.meta.url));
const hash=bytes=>createHash("sha256").update(bytes).digest("hex");
const sources=[
  ...['A','B'].map(k=>[`phi-development-v6-${k}`,`docs/engineering/verification/phi-v6/after-${k}.json`,"已转为开发回归的 v5 挑战",s=>`姓名完整遮盖 ${s.summary.masked}/${s.summary.entities}，临床段保留 ${s.summary.retained}/${s.summary.segments}`]),
  ["phi-fresh-challenge-v6","docs/engineering/verification/phi-v6/fresh/challenge-results.json","实现冻结后构造的 36 个姓名、12 种语境及临床负对照",s=>Object.entries(s.arms).map(([arm,r])=>`${arm} 完整遮盖 ${r.summary.completely_masked}/${r.summary.entities}，临床保留 ${r.summary.clinical_segments_retained}/${r.summary.clinical_segments}`).join(' / ')],
  ["phi-balanced-burst-v6","docs/engineering/verification/phi-v6/crop-burst.json","64 并发补查负载，每版 12 轮",s=>['v4','v5','v6'].map(arm=>{const r=s.runs.filter(x=>x.arm===arm);return `${arm} 拒绝 ${r.reduce((sum,x)=>sum+x.rejected,0)}，p95 均值 ${(r.reduce((sum,x)=>sum+x.completed_latency.p95_ms,0)/r.length).toFixed(1)} ms`;}).join(' / ')],
  ["phi-development-repair-v5","docs/engineering/verification/phi-v5/development-120.json","原 120 条挑战已转为开发回归，含 12 条已知反例",s=>`实体完整遮盖 ${s.summary.masked}/${s.summary.entities}，临床段保留 ${s.summary.retained}/${s.summary.segments}`],
  ["phi-fresh-challenge-v5","docs/engineering/verification/phi-v5/final-holdout/challenge-results.json","最终实现冻结后首次评估的 72 条同作者合成样例",s=>Object.entries(s.arms).map(([arm,r])=>`${arm} 遮盖 ${r.summary.completely_masked}/${r.summary.entities}，保留 ${r.summary.clinical_segments_retained}/${r.summary.clinical_segments}，阻断 ${r.summary.blocked}`).join(' / ')],
  ["phi-balanced-burst-v5","docs/engineering/verification/phi-v5/three-way-final.json","本机 64 请求补查密集负载，三版本轮换顺序",s=>['v3','v4','v5'].map(a=>{const rows=s.runs.filter(r=>r.arm===a);return `${a} p95 均值 ${(rows.reduce((n,r)=>n+r.completed_latency.p95_ms,0)/rows.length).toFixed(1)} ms，拒绝 ${rows.reduce((n,r)=>n+r.rejected,0)}`;}).join(' / ')],
  ["phi-unseen-challenge-v4","docs/engineering/verification/2026-11-19-phi-v4/challenge-results.json","120 条实现冻结后一次性评估的新合成样例；同作者、非独立盲审；保留漏检和误删",s=>Object.entries(s.arms).map(([k,v])=>`${k}: 实体完整遮盖 ${v.summary.completely_masked}/${v.summary.entities}；临床段保留 ${v.summary.clinical_segments_retained}/${v.summary.clinical_segments}；阻断 ${v.summary.blocked}`).join('；')],
  ...['legacy','crop-heavy'].map(name=>[`phi-burst-${name}-v4`,`docs/engineering/verification/2026-11-19-phi-v4/paired-${name}.json`,"同机六轮交替前后对照；64 请求完成量与拒绝分列；非完整查房 80 ms 门槛",s=>['before','after'].map(arm=>{const rows=s.runs.filter(r=>r.arm===arm&&r.burst===64);return `${arm}: 完成 ${rows.reduce((n,x)=>n+x.completed,0)}/${64*rows.length}；拒绝 ${rows.reduce((n,x)=>n+x.rejected,0)}；p95 均值 ${(rows.reduce((n,x)=>n+x.completed_latency.p95_ms,0)/rows.length).toFixed(1)} ms`;}).join('；')]),
  ["phi-crop-component-v4","docs/engineering/verification/2026-11-19-phi-v4/paired-component.json","旧开发文本的片段推理；12 轮交替对照；不等于端到端性能",s=>['before','after'].map(arm=>{const r=s.runs.filter(x=>x.arm===arm&&x.count===8);return `${arm}: 8 片段均值 ${(r.reduce((n,x)=>n+x.ms,0)/r.length).toFixed(2)} ms`;}).join('；')],
  ["cross-evaluation-negative-controls-v1","out/evaluation-negative-controls.json","六个现有评分器的错误输出与无效输入检测；不建立金标准独立性",s=>`${s.summary.evaluations} 类评测 / ${s.summary.controls} 项负对照；未检出 ${s.summary.undetected}`],
  ["label-statistics-fixture-v1","out/shadow-mode-multicenter-summary.json","生成标签行；不运行摘要引擎",s=>`${s.total_cases} 行；独立性 ${s.independence_status}; 终点通过 ${s.pass_classification.endpoint_pass}`],
  ["engine-anchor-replay-v2","plugins/medcius/evals/shadow-mode/reports/real-world-shadow-study-summary.json","固定时间的合成患者回放",s=>`${s.total_cases} 例 / ${s.total_candidate_items} 候选；锚点分类 ${JSON.stringify(s.anchor_metrics)}`],
  ["engine-policy-challenge-v1","plugins/medcius/evals/shadow-mode/reports/engine-challenge-summary.json","软件契约预期；非独立医师金标准",s=>`${s.summary.n} 例；不匹配 ${s.summary.mismatches}；负对照 ${Object.keys(s.negative_controls).length}`],
  ["time-motion-assumptions-v1","plugins/medcius/evals/time-motion/reports/time-motion-assumptions-summary.json","预设工作流时间模型",s=>`假设节省 ${s.assumed_saved_percentage}%`],
  ["time-motion-four-row-simulation-v1","plugins/medcius/evals/time-motion/reports/time-motion-statistical-summary.json","另一个四行合成输入；不与预设模型合并",s=>`${s.sample_size} 行；描述性节省 ${s.time_metrics.time_saved_percentage}%`],
  ["noise-fixture-v1","plugins/medcius/evals/real-world-noise/reports/noise-robustness-baseline.json","历史原文匹配基线；10 份病历的 seed 变体不独立，原报告区间不代表患者总体不确定性",s=>Object.entries(s.results).map(([k,v])=>`${k}: ${v.note_exact_rate.str}`).join("；")],
  ["noise-diagnostics-v2","plugins/medcius/evals/real-world-noise/reports/noise-diagnostics-v2.json","当前开发诊断；原文匹配与词法别名匹配分列，非临床召回率",s=>Object.entries(s.models).map(([k,v])=>`${k}: 原文 ${v.literal_exact}/${v.runs}；别名 ${v.alias_exact}/${v.runs}`).join("；")],
  ["phi-clinical-development-v1","docs/engineering/verification/2026-11-15-phi-cpu/coverage-final.json","人工编写的开发样例，非独立临床召回率；保留罕见裸姓名漏检",s=>`${s.summary.cases} 条；实体完整遮盖 ${s.summary.completely_masked}/${s.summary.entities}；临床文字保留 ${s.summary.clinical_literals_retained}/${s.summary.clinical_literals}；阻断 ${s.summary.blocked}`],
  ["phi-peak-process-pool-v1","docs/engineering/verification/2026-11-15-phi-cpu/peak-final.json","本机合成 PHI 入口突发负载；非完整查房流程，不替代 80 ms 门槛；完成与拒绝分列",s=>s.profiles.map(p=>{const r=p.rows.find(r=>r.simultaneous_requests===32);return `${p.profile}: 32 并发三轮 p95 均值 ${(r.runs.reduce((n,x)=>n+x.completed_latency.p95_ms,0)/r.runs.length).toFixed(1)} ms`;}).join('；')],
  ["phi-subject-development-v2","docs/engineering/verification/2026-11-15-phi-v2/subjects-final.json","原样例与新增开发挑战分列；非独立临床召回率，保留新发现的裸姓名漏检",s=>Object.entries(s.cohorts).map(([k,v])=>`${k}: 实体完整遮盖 ${v.summary.completely_masked}/${v.summary.entities}；临床文字保留 ${v.summary.clinical_literals_retained}/${v.summary.clinical_literals}；阻断 ${v.summary.blocked}`).join('；')],
  ["phi-subject-development-v3","docs/engineering/verification/2026-11-15-phi-v3/coverage-final.json","原 24 条、80 条挑战与新增 125 条开发样例分列；临床文字按原文位置计分，非独立临床验证",s=>Object.entries(s.cohorts).map(([k,v])=>`${k}: 实体完整遮盖 ${v.summary.completely_masked}/${v.summary.entities}；临床文字保留 ${v.summary.clinical_literals_retained}/${v.summary.clinical_literals}；阻断 ${v.summary.blocked}`).join('；')],
  ["phi-context-burst-v3","docs/engineering/verification/2026-11-15-phi-v3/paired-final.json","修改前冻结源码与 v3 在同机相同负载下六轮交替对照；非正式等效检验或医院总体性能",s=>['before','after'].map(arm=>{const rows=s.runs.filter(r=>r.arm===arm&&r.burst===64);return `${arm}: 完成 ${rows.reduce((n,x)=>n+x.completed,0)}/${64*rows.length}；拒绝 ${rows.reduce((n,x)=>n+x.rejected,0)}；p95 均值 ${(rows.reduce((n,x)=>n+x.completed_latency.p95_ms,0)/rows.length).toFixed(1)} ms`;}).join('；')],
  ["phi-burst-microbatch-v2","docs/engineering/verification/2026-11-15-phi-v2/burst-final.json","相同本机输入和 CPU 预算；普通队列与扩大队列对照；仅合成 PHI 入口负载，非医院总体效果",s=>s.profiles.map(p=>{const r=p.rows.find(r=>r.simultaneous_requests===64);return `${p.profile}: 64 请求三轮完成 ${r.runs.reduce((n,x)=>n+x.completed,0)}/192；拒绝 ${r.runs.reduce((n,x)=>n+x.rejected,0)}；p95 均值 ${(r.runs.reduce((n,x)=>n+x.completed_latency.p95_ms,0)/r.runs.length).toFixed(1)} ms`;}).join('；')],
  ["benefit-negative-control-v1","plugins/medcius/evals/clinical-benefit/reports/synthetic-measurement-summary.json","反向计时与缺失测量负对照",s=>`描述性节省 ${s.descriptive_mean_saved_seconds} 秒；缺失 ${s.missing_episodes}；获益 ${s.efficiency_benefit}`],
];
const entries=sources.map(([id,path,scope,describe])=>{
  const absolute=join(root,path);
  if(!existsSync(absolute)) return {id,path,scope,status:"NOT_RUN",sha256:null,metrics:null};
  const bytes=readFileSync(absolute), data=JSON.parse(bytes);
  if(data.evaluation_id && data.evaluation_id!==id) throw new Error(`EVIDENCE_ID_MISMATCH:${id}`);
  if(data.execution_status && data.execution_status!=="COMPLETED") throw new Error(`EVIDENCE_RUN_INCOMPLETE:${id}`);
  // Only the two explicitly enumerated synthetic reports above are exported.
  // Publish identical bytes so checkout readers can resolve every index link.
  let publishedPath=path;
  if(path.startsWith('out/')) {
    publishedPath=`docs/evidence/reports/${id}.json`;
    mkdirSync(join(root,'docs/evidence/reports'),{recursive:true});
    writeFileSync(join(root,publishedPath),bytes);
  }
  return {id,path:publishedPath,source_path:path,scope,status:"SYNTHETIC_ONLY",sha256:hash(bytes),input_sha256:data.input_sha256??null,metrics:describe(data),clinical_evidence_pass:false};
});
entries.push({id:"public-benchmark",path:"plugins/medcius/evals/public-benchmarks/README.md",scope:"未运行公开数据集评测；转换器不计为评测结果",status:"NOT_RUN",sha256:null,metrics:null});
const dir=join(root,"docs/evidence"); mkdirSync(dir,{recursive:true});
writeFileSync(join(dir,"current-evidence.json"),JSON.stringify({schema_version:"medcius.evidence-index.v1",clinical_evidence_pass:false,entries},null,2)+"\n");
writeFileSync(join(dir,"CURRENT-EVIDENCE.md"),`# 当前评测证据索引\n\n由 scripts/build-evidence-index.mjs 从原始报告读取。各条目有独立身份、输入范围与文件哈希；不同分母不可相互替代。本地 out/ 中的两份具名合成摘要按原字节复制到 docs/evidence/reports/，使仓库内链接可直接读取；source_path 保留生成位置。所有结果均不支持临床获益或部署准入。\n\n| 评测身份 | 状态 / 范围 | 原始报告与指标 |\n|---|---|---|\n${entries.map(e=>`| ${e.id} | ${e.status}；${e.scope} | [报告](../../${e.path})：${e.metrics??"未测量"} |`).join("\n")}\n\n机器索引 current-evidence.json 保存报告 SHA-256。公开基准尚缺批准的数据与独立预测；生产规则包仍为 0 个院方审批产物。\n`);
console.log("Evidence index written: distinct cohorts, exact report hashes, NOT_RUN retained.");
