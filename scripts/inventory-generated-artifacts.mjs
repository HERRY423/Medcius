// Read-only inventory. No deletion, deduplication, or archive mutation.
import {readdirSync,readFileSync,statSync,existsSync,mkdirSync,writeFileSync} from "node:fs";
import {join,relative} from "node:path";
import {createHash} from "node:crypto";
import {fileURLToPath} from "node:url";
const root=fileURLToPath(new URL("../",import.meta.url));
const files=[],unknown=[];
function walk(dir) {
  for(const entry of readdirSync(dir,{withFileTypes:true})) {
    const path=join(dir,entry.name), rel=relative(root,path).replaceAll("\\","/");
    if(entry.isSymbolicLink()) {unknown.push({path:rel,reason:"SYMLINK_NOT_FOLLOWED"});continue;}
    if(entry.isDirectory()) walk(path);
    else if(entry.isFile()&&!entry.name.startsWith("artifact-inventory")) {
      try {const stat=statSync(path); files.push({path:rel,bytes:stat.size,sha256:createHash("sha256").update(readFileSync(path)).digest("hex")});}
      catch {unknown.push({path:rel,reason:"UNREADABLE"});}
    }
  }
}
for(const dir of ["out","output","codex-audit-data"]) if(existsSync(join(root,dir))) walk(join(root,dir));
const groups=new Map();
for(const file of files) {const key=file.path.split("/").slice(0,2).join("/");const group=groups.get(key)||{path:key,files:0,bytes:0};group.files++;group.bytes+=file.bytes;groups.set(key,group);}
const byHash=new Map();for(const file of files){const group=byHash.get(file.sha256)||[];group.push(file.path);byHash.set(file.sha256,group);}
const report={schema_version:"medcius.artifact-inventory.v1",created_at:new Date().toISOString(),action:"INVENTORY_ONLY_NO_DELETION",files:files.length,bytes:files.reduce((sum,f)=>sum+f.bytes,0),groups:[...groups.values()],exact_duplicate_groups:[...byHash].filter(([,paths])=>paths.length>1).map(([sha256,paths])=>({sha256,paths})),unknown,manifest:files};
mkdirSync(join(root,"out"),{recursive:true});writeFileSync(join(root,"out/artifact-inventory.json"),JSON.stringify(report,null,2));
console.log(JSON.stringify({files:report.files,bytes:report.bytes,duplicate_groups:report.exact_duplicate_groups.length,unknown:unknown.length,action:report.action}));
