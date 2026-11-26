// Dedicated local process. Transient text in IPC is never logged or persisted.
import {createLocalChineseNer,detectManyLocalChineseNer} from './detector.mjs';
let detector,initializing=false,busy=false,closing=false;
const send=message=>{if(process.connected) process.send(message,()=>{});};
async function close(){
  if(closing) return;closing=true;
  const timer=setTimeout(()=>process.exit(1),5000);timer.unref();
  try {await detector?.close();} finally {clearTimeout(timer);process.exit(0);}
}
process.on('disconnect',close);
process.on('message',async message=>{
  if(message?.close) {await close();return;}
  if(message?.init) {
    if(initializing||detector) {send({error:'LOCAL_NER_PROTOCOL_INVALID'});return;}
    initializing=true;
    try {
      detector=await createLocalChineseNer(message.init);
      const a=await detector.detect('王建国因胸痛入院。');
      const b=await detectManyLocalChineseNer(detector,['王建国因胸痛入院。','林志明居住于和平路28号。']);
      if([a,...b].some(r=>!r.complete||!r.spans.some(s=>s.label==='PERSON'&&s.start===0&&s.end>=3))) throw new Error('probe');
      const c=await detector.detect('郤珺无发热。');
      if(c.context_subject_screening?.probe_count!==1||!c.context_subject_screening.spans.some(s=>s.start===0&&s.end===2)) throw new Error('context_probe');
      send({ready:true,protocol:'medcius.ner-process.v5',model_id:detector.id,revision:detector.version,warmup:'SINGLE_AND_BATCH_EXECUTED',context_warmup:'SOURCE_CROP_EXECUTED',rss:process.memoryUsage().rss});
    } catch {send({error:'LOCAL_NER_ASSETS_OR_RUNTIME_UNAVAILABLE'});await close();}
    return;
  }
  if(!detector||busy||closing||!Number.isSafeInteger(message?.id)||!Array.isArray(message?.texts)) {
    send({id:message?.id,error:'LOCAL_NER_PROTOCOL_INVALID'});return;
  }
  busy=true;
  try {
    const results=await detectManyLocalChineseNer(detector,message.texts,{partitions:message.partitions});
    send({id:message.id,results,rss:process.memoryUsage().rss});
  } catch {send({id:message.id,error:'LOCAL_NER_INFERENCE_FAILED'});}
  finally {busy=false;}
});
