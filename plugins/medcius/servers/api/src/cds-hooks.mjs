// HL7 FHIR CDS Hooks 1.0/2.0 Provider for Medcius
// Translates incoming CDS Hook triggers (medication-prescribe, order-sign, patient-view)
// into evidence-gated Medcius evaluations and returns standard CDS Cards.

import { ClinicalSupervisor } from "../../../orchestrator/supervisor.mjs";

const supervisor = new ClinicalSupervisor();

export const CDS_SERVICES = [
  {
    id: "medcius-prescription-review",
    hook: "medication-prescribe",
    title: "Medcius 中国处方安全与合理用药审核",
    description: "依据《处方管理办法》与国家药品监督管理局版本化说明书执行 G1-G3 门控审核，检测配伍禁忌、重复用药、肾功能剂量及妊娠禁忌。",
    prefetch: {
      patient: "Patient/{{context.patientId}}",
      conditions: "Condition?patient={{context.patientId}}&clinical-status=active",
      draftMedications: "MedicationRequest?patient={{context.patientId}}&status=draft",
    },
  },
  {
    id: "medcius-order-sign",
    hook: "order-sign",
    title: "Medcius 医保结算清单与签署前质控",
    description: "医保版 ICD-10 诊断与手术编码合规性校验、主要诊断资格检查及医保限定支付提示。",
    prefetch: {
      patient: "Patient/{{context.patientId}}",
      conditions: "Condition?patient={{context.patientId}}",
    },
  },
  {
    id: "medcius-patient-view",
    hook: "patient-view",
    title: "Medcius 患者病历结构化概览",
    description: "提取病历结构化摘要并呈现过敏史与关键诊疗线索。",
  },
];

/** Extract simple drug names from FHIR MedicationRequest or raw strings */
function parseFhirDrugs(context, prefetch) {
  const drugs = [];
  const entries = [
    ...(context?.draftOrders?.entry ?? []),
    ...(context?.medications ?? []),
    ...(prefetch?.draftMedications?.entry ?? []),
  ];

  for (const item of entries) {
    const res = item.resource ?? item;
    // FHIR MedicationRequest codeableConcept text or display
    const text =
      res?.medicationCodeableConcept?.text ||
      res?.medicationCodeableConcept?.coding?.[0]?.display ||
      res?.medicationReference?.display ||
      res?.name ||
      (typeof res === "string" ? res : null);
    if (text) drugs.push(String(text).trim());
  }

  // Also check raw string array in context
  if (Array.isArray(context?.drugs)) {
    drugs.push(...context.drugs.map(String));
  }

  return Array.from(new Set(drugs.filter(Boolean)));
}

/** Extract diagnoses from FHIR Condition or raw strings */
function parseFhirConditions(context, prefetch) {
  const conds = [];
  const entries = [
    ...(prefetch?.conditions?.entry ?? []),
    ...(context?.conditions ?? []),
  ];

  for (const item of entries) {
    const res = item.resource ?? item;
    const text =
      res?.code?.text ||
      res?.code?.coding?.[0]?.display ||
      (typeof res === "string" ? res : null);
    if (text) conds.push(String(text).trim());
  }

  if (Array.isArray(context?.diagnoses)) {
    conds.push(...context.diagnoses.map(String));
  }

  return Array.from(new Set(conds.filter(Boolean)));
}

/** Extract patient demographics from FHIR Patient */
function parseFhirPatient(context, prefetch) {
  const pat = prefetch?.patient?.resource ?? prefetch?.patient ?? context?.patient ?? {};
  let age = null;
  if (pat.birthDate) {
    const birthYear = new Date(pat.birthDate).getFullYear();
    const curYear = new Date().getFullYear();
    age = curYear - birthYear;
  } else if (typeof pat.age === "number") {
    age = pat.age;
  }

  return {
    age,
    sex: pat.gender === "male" ? "male" : pat.gender === "female" ? "female" : null,
    sex_cn: pat.gender === "male" ? "男" : pat.gender === "female" ? "女" : pat.sex_cn,
    weightKg: pat.weightKg,
    scrUmolL: pat.scrUmolL ?? pat.scr,
  };
}

/**
 * Handle CDS Hooks Request and return standard CDS Cards
 */
export async function handleCdsHookRequest(serviceId, body) {
  const context = body?.context ?? {};
  const prefetch = body?.prefetch ?? {};
  const user = body?.user ?? "Practitioner/default";

  const patient = parseFhirPatient(context, prefetch);
  const drugs = parseFhirDrugs(context, prefetch);
  const diagnoses = parseFhirConditions(context, prefetch);
  const allergies = Array.isArray(context?.allergies) ? context.allergies : [];

  const cards = [];

  if (serviceId === "medcius-prescription-review") {
    if (!drugs.length) {
      return {
        cards: [
          {
            summary: "Medcius: 暂无待审核药品",
            detail: "处方医嘱上下文中未检测到有效拟开立药品。",
            indicator: "info",
            source: { label: "Medcius 审方引擎", url: "https://github.com/HERRY423/Medcius" },
          },
        ],
      };
    }

    const rxResult = await supervisor.reviewPrescription({
      patient,
      diagnoses,
      drugs,
      allergies,
      actor: user,
      include_samples: true,
    });

    const indicatorMap = {
      PASS: "info",
      REQUIRES_PHARMACIST_REVIEW: "warning",
      INSUFFICIENT_DATA: "warning",
      FLAG: "critical",
    };

    const card = {
      uuid: `card-rx-${Date.now()}`,
      summary: `Medcius 审方结论: 【${rxResult.verdict}】 (发现 ${rxResult.issues_count} 项考量)`,
      detail:
        rxResult.issues.length > 0
          ? rxResult.issues.map((i, idx) => `${idx + 1}. [${i.level}] ${i.message}`).join("\n")
          : "三道门控全部满足，未检出已知配伍禁忌或用药安全风险。",
      indicator: indicatorMap[rxResult.verdict] || "info",
      source: {
        label: "Medcius 处方审核辅助",
        url: "https://github.com/HERRY423/Medcius",
      },
      links: [
        {
          label: "查看药品版本化依据与门控快照",
          url: `https://medcius.local/audit/${rxResult.audit?.sequence ?? 0}`,
          type: "absolute",
        },
      ],
    };

    cards.push(card);
  } else if (serviceId === "medcius-order-sign") {
    const codeResult = await supervisor.resolveCoding({
      diagnoses,
      procedures: context?.procedures ?? [],
      patient_gender: patient.sex_cn,
      include_samples: true,
    });

    const checklist = codeResult.settlement_checklist;
    const hasIssues = checklist?.checks?.some((c) => c.passed === false);

    cards.push({
      uuid: `card-sign-${Date.now()}`,
      summary: hasIssues ? "Medcius 医保签署前预警：存在结算清单不一致项" : "Medcius 医保编码校验通过",
      detail:
        codeResult.items.map((i) => `• ${i.kind === "diagnosis" ? "诊断" : "手术"}: ${i.term} → ${i.code} (${i.code_system}, 状态:${i.validation_status})`).join("\n") +
        (hasIssues ? `\n\n清单校验提示:\n${checklist.checks.filter((c) => !c.passed).map((c) => `⚠ ${c.message}`).join("\n")}` : ""),
      indicator: hasIssues ? "warning" : "info",
      source: { label: "Medcius 医保编码校验", url: "https://github.com/HERRY423/Medcius" },
    });
  } else {
    cards.push({
      uuid: `card-default-${Date.now()}`,
      summary: "Medcius 临床辅助服务已就绪",
      detail: "服务正常响应，未发现针对当前视图的特定警示。",
      indicator: "info",
      source: { label: "Medcius", url: "https://github.com/HERRY423/Medcius" },
    });
  }

  return { cards };
}
