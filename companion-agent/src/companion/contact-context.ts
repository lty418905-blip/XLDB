import type {SceneSource} from '../../../shared/src/scene/types.ts';
import type {ProfileEntry} from '../user-model/types.ts';
import {profileEntryUncertain} from '../user-model/store.ts';
import type {CommitmentRecord} from '../../../shared/src/commitments/types.ts';
import type {ContactAffect} from '../../../shared/src/emotion/contact-affect.ts';
import {selectWholeContactFacts} from './relationship-context.ts';
import type {CompanionPresetDocument} from './presets.ts';

export interface ContactSource {id:string;revision:number;role:'user'|'assistant';text:string;acceptedAtMs:number}
export interface ContactContext {
  clock:{nowMs:number;utcIso:string;timeZone:string;localDateTime:string;weekday:string};
  /**
   * Only the latest accepted direct user source may establish an active sleep boundary. It informs the judgment of the
   * goodnight soft window; it is not a veto.
   */
  sleepBoundary:{sourceRef:string;acceptedAtMs:number}|null;
  waiting:{phase:'waiting'|'returning';sentAtMs:number;sourceId:string;absence:string;feelings:ContactAffect['feelings'];
    needsClarification:boolean;explanations:{ref:string;quote:string}[];currentExplanation?:string}|null;
  interaction:{windowStartMs:number;windowEndMs:number;summary:string;sourceRefs:string[]};
  user:{habits:{ref:string;claim:string;uncertain:boolean}[];profile:{ref:string;claim:string;uncertain:boolean}[]};
  commitments:{ref:string;content:string;term:CommitmentRecord['term']}[];
  emotion:{persona:string;current:string};
  omitted:{habits:number;profile:number;commitments:number};
  /**
   * Information only. `invitation`: the user corrected contact to send/initiate. An invitation raises permission, it is
   * no obligation; the character still decides from her own state, and sleep or quiet windows still apply.
   */
  contactState?:{invitation:boolean};
}

const HOUR=3_600_000;
export function contactSources(sources:readonly SceneSource[],characterId:string,nowMs:number):ContactSource[]{
  if(!Number.isSafeInteger(nowMs)||nowMs<12*HOUR)throw new Error('invalid_contact_context');
  return sources.filter(source=>source.status==='accepted'&&source.processing==='ready'&&
    source.acceptedAtMs>=nowMs-12*HOUR&&source.acceptedAtMs<=nowMs&&
    source.envelope.mode==='direct'&&source.envelope.targetId===characterId&&
    source.envelope.presentIds.length===1&&source.envelope.presentIds[0]===characterId&&
    (source.role==='user'||source.role==='assistant'&&source.speakerId===characterId))
    .map(source=>({id:source.id,revision:source.revision,role:source.role as 'user'|'assistant',text:source.text,acceptedAtMs:source.acceptedAtMs}));
}

/** The summary input limit in characters; older direct sources that do not fit are left out. */
export const CONTACT_SUMMARY_INPUT_LIMIT=20_000;
/** At most this many cited sources, the newest, reach the judged context. */
export const CONTACT_SOURCE_REF_LIMIT=8;
/** The persona text in the judged context is a digest of at most this many characters. */
export const CONTACT_PERSONA_LIMIT=600;

/**
 * The summary task over the newest direct sources of the 12-hour window that fit within CONTACT_SUMMARY_INPUT_LIMIT
 * characters (older ones are left out, never an error); when even the newest alone does not fit, its text is cut to fit.
 * `sources` is the list actually shown, which the decoder must check citations against.
 */
export function contactSummaryTask(sources:readonly ContactSource[],nowMs:number){
  const serialize=(items:readonly ContactSource[])=>JSON.stringify({windowStartMs:nowMs-12*HOUR,windowEndMs:nowMs,sources:items});
  let shown:ContactSource[]=[];
  for(let index=sources.length-1;index>=0;index--){
    const candidate=[sources[index]!,...shown];
    if(serialize(candidate).length>CONTACT_SUMMARY_INPUT_LIMIT)break;
    shown=candidate;
  }
  if(!shown.length&&sources.length){
    const newest=sources.at(-1)!,room=CONTACT_SUMMARY_INPUT_LIMIT-serialize([{...newest,text:''}]).length;
    if(room<1)throw new Error('contact_context_too_large');
    shown=[{...newest,text:[...newest.text].slice(-room).join('')}];
    while(serialize(shown).length>CONTACT_SUMMARY_INPUT_LIMIT)shown=[{...newest,text:[...shown[0]!.text].slice(1).join('')}];
  }
  const input=serialize(shown);
  return {sources:shown,messages:[
    {role:'system' as const,content:'只总结所给过去12小时真实且可见的互动，区分用户与角色；不补造动机、计划或用户近况。返回 JSON：{"schema":"xldb-contact-summary-v1","summary":"不超过320字；没有互动时写无近期互动","sources":[{"id":"输入来源ID","revision":1,"quote":"来自该来源正文的逐字短句"}]}。sources列出摘要实际引用的来源及逐字证据；无互动时为空。'},
    {role:'user' as const,content:input},
  ]};
}

export function decodeContactSummary(raw:string,sources:readonly ContactSource[]):{summary:string;sources:{id:string;revision:number}[]}{
  let value:unknown;try{value=JSON.parse(raw);}catch{throw new Error('invalid_contact_summary');}
  if(!value||typeof value!=='object')throw new Error('invalid_contact_summary');
  const row=value as Record<string,unknown>;
  if(row.schema!=='xldb-contact-summary-v1'||typeof row.summary!=='string'||!row.summary.trim()||row.summary.length>320||
    !Array.isArray(row.sources)||row.sources.length>sources.length)throw new Error('invalid_contact_summary');
  const allowed=new Map(sources.map(source=>[source.id,source]));
  const refs=row.sources.map(item=>{
    if(!item||typeof item!=='object')throw new Error('invalid_contact_summary');
    const ref=item as Record<string,unknown>;
    const source=typeof ref.id==='string'?allowed.get(ref.id):undefined;
    if(!source||source.revision!==ref.revision||typeof ref.quote!=='string'||!ref.quote.trim()||
      ref.quote.length>200||!source.text.includes(ref.quote))throw new Error('invalid_contact_summary');
    return {id:ref.id as string,revision:ref.revision as number};
  });
  if(new Set(refs.map(ref=>ref.id)).size!==refs.length||(!sources.length&&refs.length))throw new Error('invalid_contact_summary');
  if(sources.length&&!refs.length)throw new Error('invalid_contact_summary');
  return {summary:row.summary.trim(),sources:refs};
}

export function contactContext(input:{sources:readonly ContactSource[];nowMs:number;summary:{summary:string;sources:{id:string;revision:number}[]};
  entries:readonly ProfileEntry[];commitments:readonly CommitmentRecord[];persona:string;emotion:string;timeZone:string;
  affect?:ContactAffect|null;contactState?:{invitation:boolean}}):ContactContext {
  const affect=input.affect;
  // A one-off window that has already ended no longer restricts anything; it stays an active commitment but is left out of
  // the judged context and its budget (a daily window always recurs and stays).
  input={...input,commitments:input.commitments.filter(record=>
    !(record.contactRestriction?.kind==='interval'&&record.contactRestriction.endAtMs<=input.nowMs))};
  const result:ContactContext={clock:contactClock(input.nowMs,input.timeZone),
    sleepBoundary:explicitSleepBoundary(input.sources),
    waiting:affect?.episode&&affect.phase!=='none'?{phase:affect.phase,sentAtMs:affect.episode.sentAtMs,
      sourceId:affect.episode.deliveryId,absence:affect.absence??'uncertain',feelings:affect.feelings,
      needsClarification:Boolean(affect.needsClarification),
      explanations:affect.sourceRefs.explanationSources.map(ref=>({ref:`${ref.sourceId}@${ref.revision}`,quote:ref.quote})),
      ...(affect.currentExplanation?{currentExplanation:affect.currentExplanation}:{})}:null,
    interaction:{windowStartMs:input.nowMs-12*HOUR,windowEndMs:input.nowMs,
    summary:input.summary.summary,sourceRefs:newestRefs(input.summary.sources,input.sources)},
    user:{habits:[],profile:[]},commitments:[],emotion:{persona:input.persona,current:input.emotion},
    omitted:{habits:0,profile:0,commitments:0},...(input.contactState?{contactState:{invitation:input.contactState.invitation}}:{})};
  const available=2400-JSON.stringify(result).length-100;
  if(available<1)throw new Error('contact_context_too_large');
  const selected=selectWholeContactFacts(input.entries,input.commitments,available);
  if(input.commitments.some(record=>record.contactRestriction&&selected.excluded.commitmentRefs.includes(`${record.id}@${record.revision}`)))
    throw new Error('contact_context_too_large');
  // The same rule as the reply strategy's uncertainFacts: hypotheses, inferred or planned bases and uncertain attribution.
  const habits=selected.profileEntries.filter(entry=>entry.theme==='daily_routine'||entry.theme==='communication')
    .map(entry=>({ref:`${entry.id}@${entry.revision}`,claim:entry.claim,uncertain:profileEntryUncertain(entry)}));
  const profile=selected.profileEntries.filter(entry=>entry.theme!=='daily_routine'&&entry.theme!=='communication')
    .map(entry=>({ref:`${entry.id}@${entry.revision}`,claim:entry.claim,uncertain:profileEntryUncertain(entry)}));
  const commitments=selected.commitments.map(record=>({ref:`${record.id}@${record.revision}`,content:record.content,term:record.term}));
  result.user={habits,profile};result.commitments=commitments;
  result.omitted={habits:input.entries.filter(entry=>(entry.theme==='daily_routine'||entry.theme==='communication')&&
      selected.excluded.profileRefs.includes(`${entry.id}@${entry.revision}`)).length,
    profile:input.entries.filter(entry=>entry.theme!=='daily_routine'&&entry.theme!=='communication'&&
      selected.excluded.profileRefs.includes(`${entry.id}@${entry.revision}`)).length,
    commitments:selected.excluded.commitmentRefs.length};
  if(JSON.stringify(result).length>2400)throw new Error('contact_context_too_large');
  return result;
}

/** The cited refs in source order, keeping only the newest CONTACT_SOURCE_REF_LIMIT. */
function newestRefs(refs:readonly {id:string;revision:number}[],sources:readonly ContactSource[]):string[] {
  const order=new Map(sources.map((source,index)=>[`${source.id}@${source.revision}`,index]));
  return refs.map(ref=>`${ref.id}@${ref.revision}`).sort((a,b)=>(order.get(a)??-1)-(order.get(b)??-1)).slice(-CONTACT_SOURCE_REF_LIMIT);
}

/**
 * A deterministic digest of at most CONTACT_PERSONA_LIMIT characters for the judged context; the stored persona is not
 * changed. With the companion's imported preset, it is built from its structured fields (name, relationship to the user,
 * core personality and a few voice and interaction lines), trimmed field by field; otherwise the persona text is cut at
 * the last sentence boundary within the limit.
 */
export function contactPersonaDigest(persona:string,preset?:CompanionPresetDocument|null):string {
  if(preset){
    const text=(value:unknown)=>typeof value==='string'&&value.trim()?value.trim():null;
    const personality=(preset.personality??{}) as Record<string,unknown>,interaction=(preset.interaction??{}) as Record<string,unknown>;
    const relation=(preset.initialUserRelation??{}) as Record<string,unknown>;
    const relationLine=[relationWord(relation.status),relationWord(relation.kinship),relationWord(relation.romance)].filter(Boolean).join('，');
    const lines=[`${preset.identity.name}（${preset.displayName}）`,relationLine?`与用户：${relationLine}`:null,
      text(personality.core),text(interaction.voice),text(interaction.supportStyle),text(interaction.whenUserBusy),text(interaction.boundaries)]
      .filter((line):line is string=>line!==null);
    let digest='';
    for(const line of lines){
      const next=digest?`${digest}\n${line}`:line;
      if(next.length>CONTACT_PERSONA_LIMIT)break;
      digest=next;
    }
    if(digest)return digest;
  }
  const value=persona.trim();
  if(value.length<=CONTACT_PERSONA_LIMIT)return value;
  const head=value.slice(0,CONTACT_PERSONA_LIMIT);
  const boundary=Math.max(...['。','！','？','!','?','.','\n'].map(mark=>head.lastIndexOf(mark)));
  // A sentence boundary in the first half would throw away too much: cut at the limit instead.
  return boundary>=CONTACT_PERSONA_LIMIT/2?head.slice(0,boundary+1).trim():head;
}

/** Preset relation codes in words; unknown ASCII codes are left out rather than shown raw, free text is kept. */
const RELATION_WORDS:Record<string,string>={not_met:'尚未相识',met:'已相识',acquainted:'已相识',friends:'朋友',friend:'朋友',
  none:'无亲属关系',family:'家人',relative:'亲属',not_established:'未建立恋爱关系',ambiguous:'暧昧',dating:'恋爱中',
  established:'恋爱中',partner:'伴侣',married:'已婚'};
function relationWord(value:unknown):string|null {
  if(typeof value!=='string'||!value.trim())return null;
  const code=value.trim();
  return RELATION_WORDS[code]??(/^[a-z0-9_]+$/i.test(code)?null:code);
}

/**
 * An estimate, not a bound: whether the parts of the judged context that can never be left out (the persona digest, the
 * clock, the waiting state and every commitment with a current contact window) fit, assuming a 320-character summary and
 * the newest CONTACT_SOURCE_REF_LIMIT refs. Deterministic and model-free, so a context that clearly cannot fit is known
 * before any summary job runs. The finished context can still overflow (for example with longer refs than estimated);
 * that real overflow is still caught by the caller and the opportunity deferred for an hour.
 */
export function contactContextFits(input:Omit<Parameters<typeof contactContext>[0],'summary'|'entries'>):boolean {
  const refs=input.sources.slice(-CONTACT_SOURCE_REF_LIMIT).map(source=>({id:source.id,revision:source.revision}));
  try{contactContext({...input,entries:[],summary:{summary:'无'.repeat(320),sources:refs}});return true;}
  catch(error){if(error instanceof Error&&error.message==='contact_context_too_large')return false;throw error;}
}

export function explicitSleepBoundary(sources:readonly ContactSource[]):ContactContext['sleepBoundary'] {
  const latest=explicitSleepSource(sources);
  return latest?{sourceRef:`${latest.id}@${latest.revision}`,acceptedAtMs:latest.acceptedAtMs}:null;
}

/**
 * The latest direct user source when it is a current, explicit goodnight. Callers pass the 12-hour contact sources, so
 * the soft sleep window lasts until the next user message or until that source leaves the window.
 */
export function explicitSleepSource(sources:readonly ContactSource[]):ContactSource|null {
  let latest:ContactSource|undefined;
  for(const source of sources)if(source.role==='user'&&(!latest||source.acceptedAtMs>=latest.acceptedAtMs))latest=source;
  if(!latest)return null;
  // Require a direct, current statement. A habit, quoted speech, denial, or an older
  // bedtime followed by a new user message cannot establish this boundary.
  const text=latest.text.replace(/“[^”]*”|‘[^’]*’|「[^」]*」|『[^』]*』|"[^"]*"|'[^']*'/gu,'').trim();
  const direct=/(?:^|[。！？\n])\s*(?:(?:我|我现在|我先|我要|我得|现在|先)\s*(?:去|要|准备)?\s*睡(?:觉)?(?:了)?|晚安)(?:[，。！？\s]|$)/u;
  const match=direct.exec(text);
  if(!match)return null;
  const following=text.slice(match.index+match[0].length);
  // A future plan (e.g. “明早继续工作”) is not a retraction of going to sleep now.
  const currentRetraction=/^(?:(?:但是|不过|其实|但)\s*)?(?:我)?(?:现在|目前|这会儿|此刻)?(?:没睡|不睡|还醒着|醒了|(?:还要|还得|还在|正在|继续)(?:继续)?(?:工作|加班|忙|学习))/u;
  const deniedSleep=/^(?:(?:但是|不过|其实|但)\s*)?(?:我)?(?:不是说|并非|不表示|没说).{0,12}(?:睡|休息)/u;
  if(following.split(/[，,。；;！？!?\n]/u).some(clause=>currentRetraction.test(clause.trim())||deniedSleep.test(clause.trim())))return null;
  return latest;
}

export function contactClock(nowMs:number,timeZone:string):ContactContext['clock'] {
  if(!Number.isSafeInteger(nowMs)||nowMs<0||typeof timeZone!=='string'||!timeZone)throw new Error('invalid_contact_clock');
  let parts:Intl.DateTimeFormatPart[];
  try{parts=new Intl.DateTimeFormat('en-US-u-ca-gregory-nu-latn',{timeZone,year:'numeric',month:'2-digit',day:'2-digit',
    hour:'2-digit',minute:'2-digit',second:'2-digit',weekday:'short',hourCycle:'h23'}).formatToParts(nowMs);}
  catch{throw new Error('invalid_contact_clock');}
  const part=(kind:Intl.DateTimeFormatPartTypes)=>parts.find(item=>item.type===kind)?.value??'';
  return {nowMs,utcIso:new Date(nowMs).toISOString(),timeZone,
    localDateTime:`${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}:${part('second')}`,
    weekday:part('weekday')};
}
