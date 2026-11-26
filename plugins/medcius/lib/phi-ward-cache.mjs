// Optional, local, memory-only dictionary prewarming. Never caches notes,
// snapshots, sanitized outputs, neural clearance or model replies.
import {createHash} from 'node:crypto';
import {createPhiEntitySession,phiNoteEntityMetadata} from './phi-entity-session.mjs';
const keys=['tenant_id','ward_id','patient_id','encounter_id','phi_session_id'];
const keyOf=context=>{
  if(!context || keys.some(k=>typeof context[k]!=='string'||!context[k].trim()||context[k].length>256)) throw new Error('PHI_WARD_CONTEXT_REQUIRED');
  return JSON.stringify(keys.map(k=>context[k]));
};
const canonical=(value,depth=0)=>{
  if(depth>16) throw new Error('PHI_WARD_METADATA_INVALID');
  if(Array.isArray(value)) return value.map(item=>canonical(item,depth+1));
  if(value&&typeof value==='object') return Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k],depth+1)]));
  return value;
};
function prepare(source,sourceVersion) {
  const key=keyOf(source?.context);
  if(typeof sourceVersion!=='string'||!/^[A-Za-z0-9_.:-]{1,128}$/.test(sourceVersion)) throw new Error('PHI_WARD_SOURCE_VERSION_REQUIRED');
  // Keep only entity metadata. Narrative bodies never enter a persistent key
  // or cache. The temporary clone is dropped after dictionary construction.
  let metadata,serialized;
  try {
    if(!Array.isArray(source.notes??[])||(source.notes??[]).some(n=>!n||typeof n!=='object')) throw new Error('shape');
    metadata=structuredClone({context:source.context,patient:source.patient,encounter:source.encounter,
    practitioners:source.practitioners??[],careTeam:source.careTeam??[],organizations:source.organizations??[],locations:source.locations??[],
    notes:(source.notes??[]).map(phiNoteEntityMetadata)});
    serialized=JSON.stringify(canonical(metadata));
  } catch {throw new Error('PHI_WARD_METADATA_INVALID');}
  if(serialized.length>1_000_000) throw new Error('PHI_WARD_METADATA_LIMIT');
  return {key,sourceVersion,metadata,digest:createHash('sha256').update(serialized).digest('hex')};
}

export function createWardPhiSessionCache({maxSessions=64,ttlMs=300000,now=Date.now}={}) {
  if(!Number.isInteger(maxSessions)||maxSessions<1||maxSessions>256||!Number.isInteger(ttlMs)||ttlMs<1||ttlMs>900000
    ||typeof now!=='function') throw new Error('PHI_WARD_CACHE_LIMIT_INVALID');
  const entries=new Set(), current=new Map();let closed=false,prepared=0,reused=0,evicted=0;
  const remove=entry=>{entry.retired=true;if(current.get(entry.key)===entry) current.delete(entry.key);
    if(!entry.active) {entries.delete(entry);entry.session.dispose();}};
  const clock=()=>{const t=now();if(!Number.isFinite(t)) throw new Error('PHI_WARD_CLOCK_INVALID');return t;};
  const prune=t=>{for(const e of entries) if(t<e.created||t>=e.expires) remove(e);};
  const close=()=>{closed=true;clearInterval(timer);for(const entry of entries) remove(entry);};
  // Expired idle dictionaries are disposed even when no new request arrives.
  // In-flight leases drain; they are never given to a subsequent request.
  const timer=setInterval(()=>{try {prune(clock());} catch {close();}},Math.min(ttlMs,1000));timer.unref();
  const acquire=(source,sourceVersion,active)=>{
    if(closed) throw new Error('PHI_WARD_CACHE_CLOSED');
    const data=prepare(source,sourceVersion), t=clock();prune(t);
    let entry=current.get(data.key);
    if(entry && entry.sourceVersion===data.sourceVersion) {
      if(entry.digest!==data.digest) throw new Error('PHI_WARD_SOURCE_VERSION_REUSED');
      reused++;
    } else {
      if(entry) remove(entry);
      if(entries.size>=maxSessions) {
        const idle=[...entries].filter(e=>!e.active).sort((a,b)=>a.used-b.used)[0];
        if(!idle) throw new Error('PHI_WARD_CACHE_FULL');
        remove(idle);evicted++;
      }
      const session=createPhiEntitySession({...data.metadata,cacheScans:false});
      entry={key:data.key,sourceVersion:data.sourceVersion,digest:data.digest,session,active:0,retired:false,created:t,expires:t+ttlMs};
      entries.add(entry);current.set(data.key,entry);prepared++;
    }
    entry.used=t;if(active) entry.active++;
    return entry;
  };
  return Object.freeze({
    prewarm(batch) {
      if(!Array.isArray(batch)||batch.length>maxSessions) throw new Error('PHI_WARD_CACHE_LIMIT_INVALID');
      for(const item of batch) {
        if(!item||typeof item!=='object') throw new Error('PHI_WARD_METADATA_INVALID');
        acquire(item.source,item.sourceVersion,false);
      }
      return {status:'DICTIONARIES_PREPARED',count:batch.length,neural_clearance:'NOT_RUN'};
    },
    async withSession(source,{sourceVersion}={},work) {
      if(typeof work!=='function') throw new Error('PHI_WARD_WORK_REQUIRED');
      const entry=acquire(source,sourceVersion,true);
      try {return await work(entry.session);}
      finally {entry.active--;if(entry.retired||closed||clock()>=entry.expires) remove(entry);}
    },
    invalidate(context) {const key=keyOf(context);for(const e of entries) if(e.key===key) remove(e);},
    diagnostics(){prune(clock());return {state:closed?'CLOSED':'READY',sessions:entries.size,leased:[...entries].filter(e=>e.active).length,
      max_sessions:maxSessions,ttl_ms:ttlMs,prepared,reused,evicted,cache_kind:'ENTITY_DICTIONARIES_ONLY'};},
    close,
  });
}
