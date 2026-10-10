// Local handoff preparation only. Never rewrites or activates the source pack.
import {readFileSync,writeFileSync,mkdirSync,existsSync} from "node:fs";
import {resolve,join,relative,isAbsolute} from "node:path";
import {fileURLToPath} from "node:url";
import {randomUUID} from "node:crypto";
import {validateSpecialtyRulePack,rulePackDigest,DEFAULT_RULE_PACK_DIRECTORY} from "../plugins/medcius/lib/specialty-rule-pack.mjs";
import {canonicalJson,sha256Hex} from "../plugins/medcius/servers/shared/crypto.mjs";

export function reviewPayloadDigest(pack) {
  return sha256Hex(canonicalJson({pack_id:pack.pack_id,version:pack.version,specialty:pack.specialty,care_setting:pack.care_setting,clinical_rules:pack.clinical_rules}));
}
export function inspectRulePackReview(pack,{hospitalScope=null,approvalRoot=null,review=null,now=new Date()}={}) {
  const validation=validateSpecialtyRulePack(pack,{production:true,hospitalScope,now});
  const blockers=[...validation.errors];
  if(!hospitalScope) blockers.push("TARGET_HOSPITAL_REQUIRED");
  let approvalDocumentStatus="NOT_PROVIDED";
  const ref=pack.authority?.approval_document;
  if(ref && approvalRoot) {
    const target=resolve(approvalRoot,ref),rel=relative(resolve(approvalRoot),target);
    if(rel.startsWith("..") || isAbsolute(rel)) blockers.push("APPROVAL_PATH_OUTSIDE_BUNDLE");
    else if(!existsSync(target)) blockers.push("APPROVAL_DOCUMENT_MISSING");
    else if(sha256Hex(readFileSync(target))!==pack.authority.approval_sha256) blockers.push("APPROVAL_DOCUMENT_DIGEST_MISMATCH");
    else approvalDocumentStatus="BYTES_MATCH_NOT_SIGNATURE_VERIFIED";
  } else blockers.push("LOCAL_APPROVAL_DOCUMENT_REQUIRED");
  if(!review || review.rule_payload_sha256!==reviewPayloadDigest(pack)) blockers.push("REVIEW_PAYLOAD_BINDING_MISSING_OR_CHANGED");
  if(!review?.hospital_scope || review.hospital_scope!==hospitalScope) blockers.push("REVIEW_HOSPITAL_SCOPE_MISMATCH");
  if(!review?.approved_by || review.approved_by!==pack.authority?.approved_by) blockers.push("REVIEW_APPROVER_MISMATCH");
  // This preparation tool has no trusted institutional identity/signature channel.
  // A typed name, status string or matching file hash cannot establish approval.
  return {pack_id:pack.pack_id,pack_sha256:rulePackDigest(pack),rule_payload_sha256:reviewPayloadDigest(pack),
    technical_prerequisites_met:blockers.length===0,blockers,approval_document_status:approvalDocumentStatus,
    institutional_authorization:"NOT_VERIFIED",admission_status:"BLOCKED_PENDING_INSTITUTIONAL_VERIFICATION"};
}

if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const args=process.argv.slice(2),arg=k=>{const i=args.indexOf(k);return i<0?null:args[i+1];};
  const input=arg("--pack")||join(DEFAULT_RULE_PACK_DIRECTORY,"cardiology-inpatient-sandbox.json");
  const pack=JSON.parse(readFileSync(input,"utf8"));
  const draftValidation=validateSpecialtyRulePack(pack);if(!draftValidation.ok) throw new Error(draftValidation.errors.join(","));
  const out=resolve(arg("--out")||join("out","rule-pack-review-"+randomUUID()));
  const scope=arg("--hospital-scope");
  mkdirSync(out,{recursive:true});
  const form={schema_version:"medcius.rule-pack-review-request.v1",status:"DRAFT_UNSIGNED",pack_id:pack.pack_id,
    pack_version:pack.version,rule_payload_sha256:reviewPayloadDigest(pack),hospital_scope:scope,approved_by:null,
    approver_role:null,approval_date:null,effective_from:null,review_due:null,approval_document:null,approval_sha256:null,
    rule_sources:null,local_reference_ranges_and_units_review:null,boundary_tests_review:null,rollback_owner:null};
  const status=inspectRulePackReview(pack,{hospitalScope:scope});
  for(const [name,value] of [["candidate-sandbox.json",pack],["review-request.json",form],["readiness.json",status]]) writeFileSync(join(out,name),JSON.stringify(value,null,2)+"\n",{flag:"wx"});
  const rows=Object.entries(pack.clinical_rules).map(([key,value])=>`| ${key} | ${JSON.stringify(value).replaceAll("|","\\|")} | 待院方核对来源、单位、阈值与适用人群 |`);
  writeFileSync(join(out,"REVIEW.md"),`# 院方规则包审核请求（未签署）\n\n包：${pack.pack_id} / ${pack.version}\n\n规则内容 SHA-256：${form.rule_payload_sha256}\n\n当前仍为 ${pack.status} / ${pack.data_class}，不允许以本材料启动生产。未填写医院与批准人时保持空值。\n\n| 规则组 | 当前沙箱内容 | 审核要求 |\n|---|---|---|\n${rows.join("\n")}\n\n院方需要逐条核验原始制度或指南引用、适用院区/科室/人群、单位/参考范围、等号边界、缺失数据拒绝、随访时限、责任人和回滚安排。沙箱数值不是院方推荐值。\n\n审核后需提供具名批准文档、正式医院适用范围、生效/复审日，绑定最终规则内容摘要。内容变更必须重新审核；不能仅把 status 改为 approved。正式签署真实性、授权身份及部署准入须由医院受控流程核验，本工具只准备材料并核对可验证字节，不授予权限。\n`,{flag:"wx"});
  console.log(`RULE PACK REVIEW PREPARED: ${out}; DRAFT_UNSIGNED; institutional verification pending`);
}
