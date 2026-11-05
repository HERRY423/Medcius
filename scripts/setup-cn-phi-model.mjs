// Explicit operator action only; production inference never calls this script.
import { readFile, writeFile, mkdir, rename, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
const manifest = JSON.parse(await readFile(new URL('../plugins/medcius/runtimes/cn-phi-ner/model-manifest.json', import.meta.url),'utf8'));
const target = process.argv[2];
if (!target) throw new Error('Usage: node scripts/setup-cn-phi-model.mjs <local-model-directory>');
const total = Object.values(manifest.files).reduce((n,f) => n + f.bytes, 0);
if (!Number.isSafeInteger(total) || total > 1000000000) throw new Error('MODEL_MANUAL_DOWNLOAD_REQUIRED');
await mkdir(resolve(target),{recursive:true});
const sha = b => createHash('sha256').update(b).digest('hex');
for (const [name,entry] of Object.entries(manifest.files)) {
  const dest=resolve(target,name);
  try { const b=await readFile(dest); if(b.length===entry.bytes && sha(b)===entry.sha256) { console.log(`Verified ${name}`); continue; } }
  catch (e) { if (e.code !== 'ENOENT') throw new Error('MODEL_LOCAL_READ_FAILED'); }
  // Manifest records the publisher's pinned byte counts; never download an
  // unknown-size model or allow a response to exceed its declared allowance.
  const remote=name.endsWith('.onnx')?'onnx/'+name:name;
  const url=`https://huggingface.co/${manifest.model_id}/resolve/${manifest.revision}/${remote}`;
  const response=await fetch(url,{signal:AbortSignal.timeout(120000)});
  if(!response.ok) throw new Error('MODEL_DOWNLOAD_FAILED');
  const length=response.headers.get('content-length');
  if(length && Number(length)!==entry.bytes) { await response.body.cancel(); throw new Error('MODEL_LENGTH_MISMATCH'); }
  let size=0; const chunks=[];
  for await (const chunk of response.body) {
    size+=chunk.length;
    if(size>entry.bytes) throw new Error('MODEL_DOWNLOAD_SIZE_EXCEEDED');
    chunks.push(chunk);
  }
  const bytes=Buffer.concat(chunks);
  if(size!==entry.bytes || sha(bytes)!==entry.sha256) throw new Error('MODEL_INTEGRITY_FAILED');
  const part=dest+'.'+randomUUID()+'.partial';
  try { await writeFile(part,bytes,{flag:'wx'}); await rename(part,dest); }
  catch { await unlink(part).catch(()=>{}); throw new Error('MODEL_LOCAL_WRITE_FAILED'); }
  console.log(`Verified ${name}: ${size} bytes`);
}
console.log(`Local assets verified; ${total} bytes. No clinical validation implied.`);
