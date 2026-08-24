export const meta = {
  name: "settlement-check",
  description:
    "结算清单端到端模拟：5 阶段 NHSA 编码校验（诊断/手术）→ 结算可及性校验 → DRG/DIP 分组探针（示例权重）→ 结构化报告。把 nhsa-coding 从“协议”变为可跑通的演示。",
  phases: [
    { title: "LoadCase" },
    { title: "CodeResolve" },
    { title: "Validate" },
    { title: "GroupingProbe" },
    { title: "Report" },
  ],
};

// Args (from the skill or direct invocation):
//   caseNote?: string  — 病历片段/出院小结摘要（可选，辅助判断主要诊断）
//   diagnoses: string[] — 本次结算清单拟纳入的诊断（术语原文，如 ["2型糖尿病", "高血压"]）
//   procedures?: string[] — 手术/操作术语
//   province?: string  — 参保地（省），用于 L3 待遇探针与权重提示
//   pluginRoot: string — 插件根绝对路径（Workflow tool 传入，定位 weights-sample.json）
//   dataRoot?: string  — 数据根（可选，默认 $CLAUDE_MEDCIUS_DATA）
//   outDir?: string    — 输出目录（可选，默认 dataRoot/settlement-check/out）
//
// Returns: structured JSON report (also written to outDir/report.json if outDir given)
let A = args;
if (typeof A === "string") {
  try { A = JSON.parse(A); } catch { A = {}; }
}
const caseNote = typeof A?.caseNote === "string" ? A.caseNote : "";
const diagnoses = Array.isArray(A?.diagnoses) ? A.diagnoses.map(String) : [];
const procedures = Array.isArray(A?.procedures) ? A.procedures.map(String) : [];
const province = typeof A?.province === "string" ? A.province : "";
const pluginRoot = typeof A?.pluginRoot === "string" ? A.pluginRoot : "";
const dataRoot = typeof A?.dataRoot === "string" ? A.dataRoot : "";
const outDir = typeof A?.outDir === "string" ? A.outDir : "";

if (!diagnoses.length && !procedures.length) {
  throw new Error("settlement-check needs at least { diagnoses: string[] } or { procedures: string[] }");
}
if (!pluginRoot || !/^\/[\w./-]+$/.test(pluginRoot)) {
  // Windows absolute path like C:/... also accepted
  if (!/^[A-Za-z]:[\\/][\w./\\-]+$/.test(pluginRoot)) {
    throw new Error("settlement-check needs args { pluginRoot: absolute path to installed plugin }");
  }
}

// Schemas for agent structured outputs — keep tight so agents can't free-form.
const CODE_RESULT_SCHEMA = {
  type: "object",
  required: ["items"],
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        required: ["term", "code", "code_system", "code_version", "effective_date", "retrieved_at", "source", "validation_status"],
        properties: {
          term: { type: "string" },
          kind: { type: "string", enum: ["diagnosis", "procedure"] },
          code: { type: "string" },
          code_system: { type: "string" },
          code_version: { type: "string" },
          effective_date: { type: "string" },
          retrieved_at: { type: "string" },
          source: { type: "string" },
          validation_status: { type: "string", enum: ["valid", "pending", "unverifiable"] },
          notes: { type: "string" },
        },
      },
    },
    stopped: { type: "boolean" },
    stop_reason: { type: "string" },
  },
};

const VALIDATION_SCHEMA = {
  type: "object",
  required: ["checks"],
  properties: {
    checks: {
      type: "array",
      items: {
        type: "object",
        required: ["term", "code", "eligible"],
        properties: {
          term: { type: "string" },
          code: { type: "string" },
          eligible: { type: "boolean" },
          reasons: { type: "array", items: { type: "string" } },
          is_main_diagnosis_candidate: { type: "boolean" },
        },
      },
    },
    main_diagnosis: {
      type: "object",
      properties: {
        term: { type: "string" },
        code: { type: "string" },
        rationale: { type: "string" },
      },
    },
  },
};

const GROUPING_SCHEMA = {
  type: "object",
  required: ["adrg", "drg", "weight", "disclaimer"],
  properties: {
    adrg: { type: "string" },
    drg: { type: "string" },
    weight: { type: "number" },
    fee: { type: "number" },
    inputs: { type: "object" },
    disclaimer: { type: "string" },
  },
};

phase("LoadCase");
const weightsPath = `${pluginRoot}/workflows/data/weights-sample.json`;
log(`Case: ${diagnoses.length} diagnoses, ${procedures.length} procedures${province ? `, province=${province}` : ""}. Reading ${weightsPath} for grouping probe.`);

// ---- CodeResolve: 5-phase NHSA resolution via one agent fan-out ----
phase("CodeResolve");
const codeResult = await agent(
  `You are running phase CodeResolve of the nhsa-coding 5-phase protocol.\n` +
  `Inputs:\n` +
  `  diagnoses=${JSON.stringify(diagnoses)}\n` +
  `  procedures=${JSON.stringify(procedures)}\n` +
  `  caseNote=${JSON.stringify(caseNote.slice(0, 1200))}\n\n` +
  `For EACH term:\n` +
  `  1) Map to the CN clinical term without inference (no severity/stage/laterality invention).\n` +
  `  2) Call 本地编码与目录库 (Local China Codes) search_codes (code_type diagnosis/procedure) to retrieve candidates — even if you think you know the code. Copy code/code_system/code_version/effective_date verbatim when returned; if the local tool returns no version fields, record them as "unknown". Do not call any hosted MCP (no hcls.mcp.claude.com).\n` +
  `  3) Record retrieved_at (now, ISO) and source (local china-codes).\n` +
  `  4) Set validation_status: valid only if code_version and effective_date are present and the code is full settlement length; otherwise pending or unverifiable.\n` +
  `  5) If Local China Codes is unavailable or corpus_status is empty, set stopped=true and stop_reason explaining you must ingest the local pack and must not emit codes from memory; return whatever items were resolved before the stop.\n\n` +
  `Return StructuredOutput with schema { items: [{ term, kind, code, code_system, code_version, effective_date, retrieved_at, source, validation_status, notes }], stopped?, stop_reason? }. ` +
  `Every item must carry the six provenance fields; unknown values must be literal "unknown", never fabricated.\n`,
  { label: "settlement:code-resolve", phase: "CodeResolve", schema: CODE_RESULT_SCHEMA },
);

const items = Array.isArray(codeResult?.items) ? codeResult.items : [];
log(`CodeResolve: ${items.length} codes${codeResult?.stopped ? ` — stopped: ${codeResult.stop_reason}` : ""}.`);

// ---- Validate: settlement eligibility (phase 5) ----
phase("Validate");
const validation = await agent(
  `You are running phase Validate (settlement eligibility) for nhsa-coding stage five.\n` +
  `Code items:\n${JSON.stringify(items, null, 2)}\n\n` +
  `Case note (for main-diagnosis judgment):\n${JSON.stringify(caseNote.slice(0, 1500))}\n\n` +
  `For each code, check:\n` +
  `  1) Was the condition actually evaluated/managed/treated in this encounter (not just history)?\n` +
  `  2) Does specificity match the note (no .8 when .9 is warranted)?\n` +
  `  3) Is the code unique, full-length, from this retrieval (not memory)?\n` +
  `  4) Is it allowed as main diagnosis (e.g. Z-codes not main)?\n` +
  `  5) If the connector exposed any settlement-eligibility flags, honor them; else apply the spec and mark uncertain as pending.\n` +
  `Also pick the single main diagnosis candidate with rationale.\n` +
  `Return StructuredOutput { checks: [{ term, code, eligible: bool, reasons: string[], is_main_diagnosis_candidate }], main_diagnosis: { term, code, rationale } | null }.\n`,
  { label: "settlement:validate", phase: "Validate", schema: VALIDATION_SCHEMA },
);
const checks = Array.isArray(validation?.checks) ? validation.checks : [];
log(`Validate: ${checks.filter((c) => c.eligible).length}/${checks.length} eligible.`);

// ---- GroupingProbe: DRG/DIP probe using sample weights (or file read) ----
phase("GroupingProbe");
const grouping = await agent(
  `You are running phase GroupingProbe (DRG/DIP).\n` +
  `Read the file at ${weightsPath} (weights-sample.json) — it contains sample ADRG/DRG weights and rate, clearly marked as synthetic examples, not any province's actual rates.\n` +
  `Given:\n` +
  `  main_diagnosis=${JSON.stringify(validation?.main_diagnosis ?? null)}\n` +
  `  procedures=${JSON.stringify(procedures)}\n` +
  `  province=${JSON.stringify(province)}\n` +
  `Pick the closest ADRG/DRG entry by major diagnostic category (best-effort keyword match; if uncertain pick the first example and note why), report its weight and compute fee = weight * rate if rate is present.\n` +
  `Return StructuredOutput { adrg, drg, weight, fee?, inputs, disclaimer } where disclaimer must state weights are synthetic examples and real grouping requires the hospital's actual grouping software and current provincial catalogue/rates.\n`,
  { label: "settlement:grouping", phase: "GroupingProbe", schema: GROUPING_SCHEMA },
);
log(`GroupingProbe: ${grouping?.drg ?? "?"} weight=${grouping?.weight ?? "?"}`);

// ---- Report ----
phase("Report");
const report = {
  meta: {
    workflow: meta.name,
    at: new Date().toISOString(),
    disclaimer:
      "本工作流为教学/演示用途：编码与分组结果依赖所用连接器与示例权重，不代表任何省的实际结算结果；样例权重不得用于真实结算。所有编码已附出处与 validation_status，L3/L4 数字纪律见 nhsa-policy。",
  },
  inputs: { caseNote: caseNote.slice(0, 800), diagnoses, procedures, province, pluginRoot },
  code_resolution: codeResult,
  validation,
  groupingProbe: grouping,
  next_steps: [
    "复核每个编码的 code_system/code_version/effective_date/retrieved_at/source/validation_status 六字段完整性；unknown 时 validation_status 不得为 valid。",
    "将 Validate 的 eligible=false 项剔除结算清单；main_diagnosis 须符合《结算清单填写规范》。",
    "GroupingProbe 仅为探针：替换 weights-sample.json 为就医地当期分组器与费率表后重跑，或直接以医院分组器结果为准。",
    "如需扩展：补省 L3 待遇文件并接入 nhsa-policy 的 L3/L4 分层输出。",
  ],
};

// Persist if outDir was given — via an agent because the workflow sandbox has no filesystem.
if (outDir) {
  if (!/^\/[\w./-]+$/.test(outDir) && !/^[A-Za-z]:[\\/][\w./\\-]+$/.test(outDir)) {
    log(`outDir path contains unsafe characters — not writing: ${outDir}`);
  } else {
    const payload = JSON.stringify(report, null, 2).replaceAll("`", "\\`");
    await agent(
      `Write the following JSON verbatim to ${outDir}/report.json (create parent dirs if needed). Do not reformat, summarize, or truncate.\n\n` +
      "```json\n" + payload + "\n```\n\n" +
      `After writing, return { written: true, path: "${outDir}/report.json" } via StructuredOutput.`,
      { label: "settlement:write-report", phase: "Report", schema: { type: "object", properties: { written: { type: "boolean" }, path: { type: "string" } } } },
    );
  }
}

return report;
