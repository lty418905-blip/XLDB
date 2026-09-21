import type {Access,Memory,MemorySnapshot} from './access.ts';

/** Missing on legacy records means retain, never permission to forget. */
export interface Retention {
  kind:'retain'|'peripheral';
  basisQuote:string;
  cues:string[];
}

export function retentionOf(value:unknown,detail:string):Retention|undefined {
  if(value===undefined)return undefined;
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('invalid_memory_retention');
  const input=value as Record<string,unknown>;
  if(Object.keys(input).some(key=>!['kind','basisQuote','cues'].includes(key))||
    !['retain','peripheral'].includes(String(input.kind))||typeof input.basisQuote!=='string'||
    !input.basisQuote.trim()||input.basisQuote.length>1000||!detail.includes(input.basisQuote)||
    !Array.isArray(input.cues)||input.cues.length>3)throw new Error('invalid_memory_retention');
  const cues=input.cues.map(cue=>{
    if(typeof cue!=='string'||cue.trim().length<4||cue.length>80||!detail.includes(cue))throw new Error('invalid_memory_retention');
    return cue;
  });
  return {kind:input.kind as Retention['kind'],basisQuote:input.basisQuote,cues:[...new Set(cues)]};
}

const DAY=86_400_000;

/** A view-only time decision; it neither changes history nor writes on recall. */
export function retainedAccess(memory:Memory,nowMs:number,cueText=''): {access:Access;reactivated?:true} {
  if(memory.accessOverride||memory.access!=='clear'||memory.source.reference||memory.retention?.kind!=='peripheral')return {access:memory.access};
  if(memory.reactivated)return {access:memory.access,reactivated:true};
  const since=memory.retentionAtMs??memory.source.knownAtMs;
  const age=Math.max(0,nowMs-since);
  // Only explicitly peripheral memories participate. Anchors and protected
  // facts survive every stage, and absence of a safe classification retains.
  const first=memory.kind==='episode'?30*DAY:60*DAY;
  if(age<first)return {access:'clear'};
  if(cueText&&memory.retention.cues.some(cue=>cueText.includes(cue)))return {access:'clear',reactivated:true};
  return {access:age<180*DAY?'gist':'feeling'};
}

/** Use the same effective granularity for retrieval and foreground context. */
export function retentionSnapshot(snapshot:MemorySnapshot,nowMs:number,cueText=''):MemorySnapshot {
  const clock=snapshot.memoryTimeMs??nowMs;
  return {...snapshot,memories:new Map([...snapshot.memories].map(([id,memory])=>{
    const result=retainedAccess(memory,clock,cueText);
    return [id,{...memory,access:result.access,...(result.reactivated?{reactivated:true}:{})}];
  }))};
}
