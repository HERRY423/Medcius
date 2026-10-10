import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, join, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
export const ROOT = fileURLToPath(new URL("../", import.meta.url));
export function validateControlledDocuments(root=ROOT) {
  const errors=[];
  const read=p=>JSON.parse(readFileSync(join(root,p),"utf8"));
  const registry=read("docs/compliance/qms/controlled-documents.json");
  const version=read("plugins/medcius/plugin.json").version;
  if(registry.product_version!==version) errors.push("REGISTRY_VERSION_DRIFT");
  for(const path of registry.manifests) if(read(path).version!==version) errors.push(`MANIFEST_VERSION_DRIFT:${path}`);
  const seen=new Set();
  for(const doc of registry.documents) {
    if(seen.has(doc.path)) errors.push(`DUPLICATE_DOCUMENT:${doc.path}`); seen.add(doc.path);
    const path=resolve(root,doc.path), rel=relative(root,path);
    if(rel.startsWith("..")||isAbsolute(rel)) {errors.push("DOCUMENT_PATH_ESCAPE");continue;}
    if(!existsSync(path)) {errors.push(`MISSING_DOCUMENT:${doc.path}`);continue;}
    const text=readFileSync(path,"utf8").replace(/\r\n/g,"\n");
    if(!text.includes(`Product baseline: ${version}`)) errors.push(`DOCUMENT_VERSION_DRIFT:${doc.path}`);
    if(createHash("sha256").update(text).digest("hex")!==doc.sha256_lf) errors.push(`DOCUMENT_CONTENT_CHANGED:${doc.path}`);
    if(/synthetic_validation_pass\s*[:：]\s*(?:🟢\s*)?PASS/.test(text)) errors.push(`EVIDENCE_OVERCLAIM:${doc.path}`);
  }
  for(const component of registry.components) if(read(component.path).version!==component.version) errors.push(`COMPONENT_VERSION_DRIFT:${component.path}`);
  return {ok:errors.length===0,product_version:version,documents:registry.documents.length,errors,approval_status:registry.approval_status};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const result=validateControlledDocuments(); console.log(JSON.stringify(result,null,2));
  console.log(result.ok?"CONTROLLED DOCUMENTS VALID (draft coherence, not approval)":"CONTROLLED DOCUMENTS INVALID");
  process.exitCode=result.ok?0:1;
}
