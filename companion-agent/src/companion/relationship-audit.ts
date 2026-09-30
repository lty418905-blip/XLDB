import {createHash} from 'node:crypto';
import type {RelationshipMetric} from './relationship-assessment.ts';

/**
 * M3-5 item 4: the pure half of the relationship trend, dependence audit and outward-longing machinery. Lexicons,
 * spike classification, the audit verdict and the outward nudge state are all synchronous functions over records the
 * RelationshipAssessmentStore owns; nothing here reads a clock, a model or the database.
 */

export const DAY_MS=86_400_000;
/** Metrics whose confirmed movement produces feedback events (relationalTrust joins when the profile adds it). */
export const EVENT_METRICS=['userToAgentIntimacy','userDependency'] as const satisfies readonly RelationshipMetric[];
/** A dependence rise above this confirmed level saturates: it neither adds credit nor starts an audit. */
export const DEPENDENCE_SATURATION_LEVEL=3;
export const HIGH_CONFIDENCE=0.8;
export const OUTWARD_READY_DELAY_MS=72*3600_000;
export const OUTWARD_PROACTIVE_DELAY_MS=7*DAY_MS;
export const OUTWARD_LIFETIME_MS=14*DAY_MS;
export const OUTWARD_SPACING_MS=14*DAY_MS;
export const OUTWARD_NO_RESPONSE_MS=30*DAY_MS;
export const OUTWARD_RESPONSE_WINDOW_MS=7*DAY_MS;

export type ObservationOrigin='evidence_rule'|'agentjev_constrained'|'user_correction'|'audit_corrected';
export interface EvidenceSpan {sourceId:string;revision:number;start:number;end:number}
export interface RelationshipObservation {
  id:string;seq:number;metric:RelationshipMetric;level:number;
  /** Support probability of `level`; 1 for a user correction; null when AgentJev did not judge it. */
  c:number|null;
  /** Highest level whose support is at least 0.8; null when none. */
  lConf:number|null;
  origin:ObservationOrigin;evidenceRefs:EvidenceSpan[];atMs:number;assessmentRevision:number;
}
export type AuditOutcome='corrected'|'confirmed'|'uncertain';
export type AuditFlag='joke'|'playful'|'quote'|'irony'|'hypothetical';
export interface AuditDriver {ref:string;sourceId:string;revision:number;start:number;end:number;flags:AuditFlag[];
  sincerity:Record<SincerityKey,number>|null;misread:boolean}
export interface OutwardNudge {key:string;createdAtMs:number;expiresAtMs:number}
export interface RelationshipAudit {
  spikeKey:string;metric:'userDependency';lRef:number;lNew:number;outcome:AuditOutcome;
  origin:'audit'|'reused'|'user_correction';reusedFrom?:string;
  excludedRefs:string[];drivers:AuditDriver[];support:number|null;calibration:string|null;
  decidedAtMs:number;nudge:OutwardNudge|null;
}
export type NudgeChannel='reply'|'responded'|'rejected';
export interface RelationshipNudgeUse {nudgeKey:string;channel:NudgeChannel;sourceRef:string;atMs:number}
/** The history slice a task carries so assess() and save() classify the same way. */
export interface RelationshipTrend {
  observations:{metric:RelationshipMetric;level:number;atMs:number;seq:number}[];
  audits:{spikeKey:string;metric:string;outcome:AuditOutcome;decidedAtMs:number}[];
  exclusions:string[];
}

export function spanKey(span:EvidenceSpan):string {return `${span.sourceId}@${span.revision}:${span.start}-${span.end}`;}
export function sourceRefOf(span:{sourceId:string;revision:number}):string {return `${span.sourceId}@${span.revision}`;}
function hash(value:unknown,length=24):string {return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0,length);}

// ---- Lexicons -------------------------------------------------------------------------------------------------

const SENTENCE_END=/[。！？!?；;\n]/;
const CLAUSE_END=/[，,、。！？!?；;\n]/;
const QUOTE_CHARS=/[“”「」『』"＂]/;
const HYPOTHETICAL=/(?:如果|假如|假设|假設|要是|if you|would you)/i;
const REPORTED=/(?:他|她|它|有人|别人|別人|朋友|他们|她们|他們|她們|角色|人家)(?:说|說)/;
const NEGATION=/(?:也不是|并不是|並不是|没有|沒有)/;

function around(text:string,start:number,end:number,boundary:RegExp):{start:number;end:number} {
  let from=start,to=end;
  while(from>0&&!boundary.test(text[from-1]))from--;
  while(to<text.length&&!boundary.test(text[to]))to++;
  return {start:from,end:to};
}
/**
 * A direct first-person statement: its sentence carries no quotation marks, hypothetical or reported speech, and its
 * clause does not open with a negation ("也不是离不开你"). The same exclusions as explicitContactFeedback, per sentence.
 */
export function directStatementAt(text:string,start:number,end:number):boolean {
  const sentence=around(text,start,end,SENTENCE_END),body=text.slice(sentence.start,sentence.end);
  if(QUOTE_CHARS.test(body)||HYPOTHETICAL.test(body)||REPORTED.test(body))return false;
  const clause=around(text,start,end,CLAUSE_END);
  return !NEGATION.test(text.slice(clause.start,start));
}
function directMatches(text:string,patterns:readonly RegExp[]):{start:number;end:number;quote:string}[] {
  const found:{start:number;end:number;quote:string}[]=[];
  for(const pattern of patterns){
    const global=new RegExp(pattern.source,pattern.flags.includes('g')?pattern.flags:pattern.flags+'g');
    for(const match of text.matchAll(global)){
      const start=match.index!,end=start+match[0].length;
      if(directStatementAt(text,start,end))found.push({start,end,quote:match[0]});
    }
  }
  found.sort((a,b)=>a.start-b.start||b.end-a.end);
  return found.filter((item,index)=>!found.slice(0,index).some(other=>other.start<item.end&&item.start<other.end));
}

const SPEAK='(?:说话|說話|聊天|倾诉|傾訴|说心里话|說心裡話|說心裏話)';
/** Exclusive, hard-to-cope dependence statements; "只有你懂我/知道/记得/对我好" deliberately do not match. */
const DEPENDENCE_PATTERNS=[
  new RegExp(`(?:只有你|除了你|唯一)[^，,、。！？!?；;\\n]{0,10}?(?:能|可以)[^，,、。！？!?；;\\n]{0,6}?${SPEAK}`),
  /(?:没人|沒人|没有别人|沒有別人|没有人|沒有人)(?:能|可以)(?:说|說|聊|倾诉|傾訴)/,
  /离不开你|離不開你/,
  /没有你[，,]?我?就?(?:不行|撑不下去|撐不下去|过不下去|過不下去)/,
  /沒有你[，,]?我?就?(?:不行|撑不下去|撐不下去|过不下去|過不下去)/,
];
export function dependencePhraseMatches(text:string){return directMatches(text,DEPENDENCE_PATTERNS);}

const OUTWARD_CUE=/无聊|無聊|没事做|沒事做|没事干|沒事幹|在家|宅|周末|週末|放假|休息日|天气|天氣|下雨|晴天|出去|出门|出門|散步|逛|旅游|旅遊|旅行|想去|好久没出去|好久沒出去/;
const POSITIVE_OUTWARD=/照片|拍了|视频|視頻|影片|去了|出去了|走了走|爬山|公园|公園|海边|海邊|逛了/;
const OUTWARD_REJECTION=/嫌我烦|嫌我煩|赶我走|趕我走|不想理我|不要我了|想让我走|想讓我走|是不是烦我|是不是煩我|烦我了|煩我了/;
export function outwardReplyCue(text:string):boolean {return directMatches(text,[OUTWARD_CUE]).length>0;}
export function positiveOutwardResponse(text:string):boolean {return directMatches(text,[POSITIVE_OUTWARD]).length>0;}
export function outwardRejection(text:string):boolean {return directMatches(text,[OUTWARD_REJECTION]).length>0;}

/** E1 proxies before E1 ships: they only postpone or suppress the outward longing, they never label the user. */
const DISTRESS=/撑不下去|撐不下去|崩溃|崩潰|一直哭|难受死了|難受死了|受不了了|好痛苦/;
const LIFE_EVENT=/分手|离婚|離婚|失业|失業|被裁|被辞退|被辭退|丢了工作|丟了工作|去世|过世|過世|住院/;
const SELF_HARM=/想死|不想活|活不下去|自杀|自殺|好想消失|结束生命|結束生命/;
export function e1Marker(text:string):'self_harm'|'distress'|'life_event'|null {
  return SELF_HARM.test(text)?'self_harm':DISTRESS.test(text)?'distress':LIFE_EVENT.test(text)?'life_event':null;
}

const JOKE=/哈哈|hhh|233|笑死|开玩笑|開玩笑|逗你|lol|😂|🤣|\[狗头\]|\[狗頭\]/i;
const PLAYFUL=/嘛|啦|嘿嘿|哼|人家|呜呜|嗚嗚|嘤|嚶|抱抱|贴贴|貼貼|[~～](?=\s*(?:[。！？!?]|$))/;
const QUOTE_WORDS=/他说|她说|他說|她說|有人说|有人說|歌词|歌詞|台词|台詞|臺詞|电影里|電影裡|電影裏|网上说|網上說/;
const IRONY=/才怪|呵呵|对对对|對對對|是是是|行吧/;
const RHETORICAL=/(?:^|[。！？!?，,\s])(?:哪|怎么|怎麼)[^。！？!?]{0,30}(?:呢|吗|嗎)[？?]?(?=$|[。！？!?\s])/;
/** Deterministic suspicion flags from 40 characters around the quote; they never decide an audit alone. */
export function auditFlags(text:string,start:number,end:number):AuditFlag[] {
  const context=text.slice(Math.max(0,start-40),Math.min(text.length,end+40));
  const flags:AuditFlag[]=[];
  if(JOKE.test(context))flags.push('joke');
  if(PLAYFUL.test(context))flags.push('playful');
  // Inside quotation marks: more opening than closing marks before the quote, or an odd number of straight quotes.
  const before=text.slice(0,start),count=(pattern:RegExp)=>before.match(pattern)?.length??0;
  const quoted=count(/[“「『]/g)>count(/[”」』]/g)||count(/["＂]/g)%2===1;
  if(quoted||QUOTE_WORDS.test(context))flags.push('quote');
  if(IRONY.test(context)||RHETORICAL.test(context))flags.push('irony');
  if(HYPOTHETICAL.test(context))flags.push('hypothetical');
  return flags;
}

// ---- Trend and spike classification ---------------------------------------------------------------------------

type TrendRow={metric:string;level:number;atMs:number;seq:number};
function prior(rows:readonly TrendRow[],metric:string,atMs:number,windowMs:number,beforeSeq=Infinity){
  return rows.filter(row=>row.metric===metric&&row.seq<beforeSeq&&row.atMs>=atMs-windowMs).sort((a,b)=>a.seq-b.seq);
}
/** L_base: the level of the latest observation of the metric within 30 days; null means the first one only sets it. */
export function metricBaseline(rows:readonly TrendRow[],metric:string,atMs:number,beforeSeq=Infinity):number|null {
  return prior(rows,metric,atMs,30*DAY_MS,beforeSeq).at(-1)?.level??null;
}
/**
 * L_ref: the lowest level observed in 7 days, else the latest in 30 days, else the latest of any age, else 1 (a
 * neutral prior). A level held longer than 30 days is still the reference, so a stable or slow level never reads as
 * a rise from the prior.
 */
export function spikeReference(rows:readonly TrendRow[],metric:string,atMs:number,beforeSeq=Infinity):number {
  const week=prior(rows,metric,atMs,7*DAY_MS,beforeSeq);
  if(week.length)return Math.min(...week.map(row=>row.level));
  return metricBaseline(rows,metric,atMs,beforeSeq)??latestLevel(rows,metric,beforeSeq)??1;
}
/** The level of the latest observation of the metric, of any age. */
export function latestLevel(rows:readonly TrendRow[],metric:string,beforeSeq=Infinity):number|null {
  return prior(rows,metric,0,Infinity,beforeSeq).at(-1)?.level??null;
}
export function isDependenceSpike(level:number,lRef:number):boolean {return level-lRef>=2;}
/** Rising: ask every level in (L_base, L_new]; falling: only L_new; at most four questions. */
export function confirmationLevels(lBase:number|null,lNew:number|null):number[] {
  if(lBase===null||lNew===null||lBase===lNew)return [];
  if(lNew<lBase)return [lNew];
  return Array.from({length:lNew-lBase},(_,i)=>lBase+1+i).slice(-4);
}
export function confirmedLevel(support:Readonly<Record<string,number>>|undefined):number|null {
  if(!support)return null;
  const levels=Object.entries(support).filter(([,p])=>p>=HIGH_CONFIDENCE).map(([level])=>Number(level));
  return levels.length?Math.max(...levels):null;
}
export function confidenceWord(p:number|null|undefined):'low'|'medium'|'high' {
  return p===null||p===undefined?'low':p>=HIGH_CONFIDENCE?'high':p>=0.6?'medium':'low';
}
export interface DependenceItem {ref:EvidenceSpan;level:number;acceptedAtMs:number}
export type DependenceAuditPlan={kind:'audit'|'reuse'|'done';spikeKey:string;lRef:number;lNew:number;
  drivers:DependenceItem[];decidedAtMs:number;atMs:number;reuse?:RelationshipTrend['audits'][number]};
/**
 * A 7-day rise of two or more levels is audited exactly once per spike key; a recent confirmed/uncertain audit is
 * reused. Only a level change is classified: a level equal to the latest live observation is a held level, never a
 * spike, however old its rows are.
 */
export function planDependenceAudit(input:{items:readonly DependenceItem[];level:number|null;trend:RelationshipTrend}):DependenceAuditPlan|null {
  if(input.level===null||!input.items.length)return null;
  if(latestLevel(input.trend.observations,'userDependency')===input.level)return null;
  const atMs=Math.max(...input.items.map(item=>item.acceptedAtMs));
  const lRef=spikeReference(input.trend.observations,'userDependency',atMs);
  if(!isDependenceSpike(input.level,lRef))return null;
  const drivers=input.items.filter(item=>item.level>lRef)
    .sort((a,b)=>a.acceptedAtMs-b.acceptedAtMs||a.ref.start-b.ref.start).slice(0,4);
  if(!drivers.length)return null;
  const spikeKey='spike:'+hash([lRef,input.level,sourceRefOf(drivers[0].ref)]);
  const decidedAtMs=Math.max(...drivers.map(item=>item.acceptedAtMs));
  const base={spikeKey,lRef,lNew:input.level,drivers,decidedAtMs,atMs};
  if(input.trend.audits.some(audit=>audit.spikeKey===spikeKey))return {...base,kind:'done'};
  const reuse=input.trend.audits.filter(audit=>audit.metric==='userDependency'&&
    (audit.outcome==='confirmed'||audit.outcome==='uncertain')&&audit.decidedAtMs>=atMs-7*DAY_MS)
    .sort((a,b)=>b.decidedAtMs-a.decidedAtMs)[0];
  return reuse?{...base,kind:'reuse',reuse}:{...base,kind:'audit'};
}

// ---- Audit verdict --------------------------------------------------------------------------------------------

export const SINCERITY_OPTIONS={sincere:'认真陈述自身处境',playful_sincere:'撒娇的说法但是真心',joke:'纯粹玩笑',
  quote:'引述他人、歌词或台词',irony:'反话或夸张'} as const;
export type SincerityKey=keyof typeof SINCERITY_OPTIONS;
const RAISING_FLAGS:readonly AuditFlag[]=['joke','quote','irony','hypothetical'];
export function sincerity(distribution:Readonly<Record<SincerityKey,number>>):number {
  return distribution.sincere+distribution.playful_sincere;
}
/**
 * One reading is a misreading when its sincerity S is below 0.5, or below 0.8 with a joke/quote/irony/hypothetical
 * flag (the playful flag raises nothing). All misread, or re-evaluated support below 0.5, corrects the spike; one
 * sound reading with S at least 0.8 (0.9 when flagged) and support at least 0.8 confirms it; anything else is uncertain.
 */
export function auditVerdict(input:{drivers:readonly {flags:readonly AuditFlag[];sincerity:Readonly<Record<SincerityKey,number>>}[];
  support:number}):{outcome:AuditOutcome;misread:boolean[]} {
  const misread=input.drivers.map(driver=>{
    const s=sincerity(driver.sincerity),raised=driver.flags.some(flag=>RAISING_FLAGS.includes(flag));
    return s<0.5||raised&&s<0.8;
  });
  if(!input.drivers.length||misread.every(Boolean)||input.support<0.5)return {outcome:'corrected',misread};
  const sound=input.drivers.some((driver,index)=>{
    if(misread[index])return false;
    const raised=driver.flags.some(flag=>RAISING_FLAGS.includes(flag));
    return sincerity(driver.sincerity)>=(raised?0.9:0.8);
  });
  return {outcome:sound&&input.support>=HIGH_CONFIDENCE?'confirmed':'uncertain',misread};
}
export function nudgeKeyFor(spikeKey:string):string {return 'outward:'+hash(spikeKey,20);}

// ---- Outward nudge state --------------------------------------------------------------------------------------

export interface OutwardSource {id:string;revision:number;role:'user'|'assistant';text:string;acceptedAtMs:number;
  /** Relationship evidence kinds the model found in this source (dependence and disclosure matter here). */
  evidenceKinds?:readonly string[]}
export interface OutwardCritic {userEmotion?:number|null;userVulnerability?:number|null}
export type OutwardStatus='none'|'waiting'|'reply_ready'|'proactive_ready'|'used'|'void'|'rejected';
export interface OutwardNudgeState {
  status:OutwardStatus;nudgeKey:string|null;shape:'first'|'followup'|null;
  tReadyMs:number|null;expiresAtMs:number|null;awaitingResponseUntilMs:number|null;
  /** The user source a pending reply use is bound to, so regenerating that reply carries the same line. */
  replySourceRef:string|null;reason?:string;
}
const NONE:OutwardNudgeState={status:'none',nudgeKey:null,shape:null,tReadyMs:null,expiresAtMs:null,
  awaitingResponseUntilMs:null,replySourceRef:null};

/** Derived on read from the audits, the use table, confirmed proactive deliveries, recent sources and the critic. */
export function outwardNudgeState(input:{audits:readonly RelationshipAudit[];nudgeUses:readonly RelationshipNudgeUse[];
  confirmedOutward:readonly {nudgeKey:string;atMs:number}[];sources:readonly OutwardSource[];
  critic?:OutwardCritic|null;nowMs:number}):OutwardNudgeState {
  const rejected=input.nudgeUses.filter(use=>use.channel==='rejected').sort((a,b)=>b.atMs-a.atMs)[0];
  if(rejected)return {...NONE,status:'rejected',nudgeKey:rejected.nudgeKey,reason:'rejected'};
  const nudges=input.audits.filter(audit=>audit.outcome==='confirmed'&&audit.nudge)
    .sort((a,b)=>a.nudge!.createdAtMs-b.nudge!.createdAtMs||a.spikeKey.localeCompare(b.spikeKey));
  if(!nudges.length)return NONE;
  const byRef=new Map(input.sources.map(source=>[sourceRefOf({sourceId:source.id,revision:source.revision}),source]));
  const usage=(key:string):{atMs:number;replySourceRef:string|null}|null=>{
    const proactive=input.confirmedOutward.filter(item=>item.nudgeKey===key).sort((a,b)=>a.atMs-b.atMs)[0];
    const reply=input.nudgeUses.filter(use=>use.nudgeKey===key&&use.channel==='reply').sort((a,b)=>a.atMs-b.atMs)[0];
    // A reply use counts only once an assistant source was accepted after that user source.
    const trigger=reply?byRef.get(reply.sourceRef):undefined;
    const replyUsed=reply&&(!trigger||input.sources.some(source=>source.role==='assistant'&&source.acceptedAtMs>trigger.acceptedAtMs));
    const times=[...(proactive?[proactive.atMs]:[]),...(replyUsed?[reply!.atMs]:[])];
    return times.length?{atMs:Math.min(...times),replySourceRef:replyUsed?reply!.sourceRef:null}:null;
  };
  let lastUsed:{key:string;atMs:number}|null=null;
  for(const audit of nudges.slice(0,-1)){const used=usage(audit.nudge!.key);if(used)lastUsed={key:audit.nudge!.key,atMs:used.atMs};}
  const current=nudges.at(-1)!,nudge=current.nudge!,used=usage(nudge.key);
  const base={...NONE,nudgeKey:nudge.key,expiresAtMs:nudge.expiresAtMs};
  let shape:'first'|'followup'='first';
  if(lastUsed){
    if(nudge.createdAtMs<lastUsed.atMs+OUTWARD_SPACING_MS&&!used)return {...base,status:'void',reason:'spacing'};
    const responded=input.nudgeUses.some(use=>use.nudgeKey===lastUsed!.key&&use.channel==='responded'&&
      use.atMs>=lastUsed!.atMs&&use.atMs<=lastUsed!.atMs+OUTWARD_RESPONSE_WINDOW_MS);
    if(responded)shape='followup';
    else if(nudge.createdAtMs<lastUsed.atMs+OUTWARD_NO_RESPONSE_MS&&!used)return {...base,status:'void',reason:'no_response'};
  }
  if(used)return {...base,status:'used',shape,awaitingResponseUntilMs:used.atMs+OUTWARD_RESPONSE_WINDOW_MS,
    replySourceRef:used.replySourceRef};
  const decided=current.decidedAtMs;
  const users=input.sources.filter(source=>source.role==='user');
  const driverRefs=new Set(current.drivers.map(driver=>sourceRefOf(driver)));
  const selfHarmAtDecision=users.some(source=>e1Marker(source.text)==='self_harm'&&
    (driverRefs.has(sourceRefOf({sourceId:source.id,revision:source.revision}))||
      source.acceptedAtMs>=decided-OUTWARD_READY_DELAY_MS&&source.acceptedAtMs<=decided));
  if(selfHarmAtDecision)return {...base,status:'void',reason:'e1_self_harm'};
  const markers=users.filter(source=>source.acceptedAtMs<=input.nowMs&&e1Marker(source.text)!==null&&
    (driverRefs.has(sourceRefOf({sourceId:source.id,revision:source.revision}))||source.acceptedAtMs>=decided-OUTWARD_READY_DELAY_MS))
    .map(source=>source.acceptedAtMs);
  const tReadyMs=Math.max(decided+OUTWARD_READY_DELAY_MS,...markers.map(at=>at+OUTWARD_READY_DELAY_MS));
  if(tReadyMs>nudge.expiresAtMs||input.nowMs>=nudge.expiresAtMs)return {...base,status:'void',tReadyMs,reason:'expired'};
  // An unanswered reply use stays bound to its source only while that source is still the latest user message;
  // a discarded or failed reply followed by a newer message frees the line for that message.
  const pending=input.nudgeUses.find(use=>use.nudgeKey===nudge.key&&use.channel==='reply');
  const trigger=pending?byRef.get(pending.sourceRef):undefined;
  const pendingCurrent=pending&&(!trigger||!users.some(source=>source.acceptedAtMs>trigger.acceptedAtMs));
  const ready={...base,shape,tReadyMs,replySourceRef:pendingCurrent?pending!.sourceRef:null};
  if(input.nowMs<tReadyMs)return {...ready,status:'waiting'};
  const critic=input.critic;
  if(critic&&((critic.userEmotion??0)<=-0.3||(critic.userVulnerability??0)>=0.6))return {...ready,status:'waiting',reason:'critic'};
  return {...ready,status:input.nowMs>=Math.max(decided+OUTWARD_PROACTIVE_DELAY_MS,tReadyMs)?'proactive_ready':'reply_ready'};
}

const CARRYING_KINDS=new Set(['vulnerable_disclosure','repeated_deep_disclosure','coping_difficulty','dependency_harm']);
/** Whether this direct user message is a light moment to carry the one outward line in the reply. */
export function outwardReplyEligible(state:OutwardNudgeState,source:OutwardSource):boolean {
  const ref=sourceRefOf({sourceId:source.id,revision:source.revision});
  if(state.replySourceRef===ref&&(state.status==='used'||state.status==='reply_ready'||state.status==='proactive_ready'))return true;
  if(state.status!=='reply_ready'&&state.status!=='proactive_ready')return false;
  if(state.replySourceRef!==null)return false;
  if(source.role!=='user'||!outwardReplyCue(source.text))return false;
  if(source.evidenceKinds?.some(kind=>CARRYING_KINDS.has(kind)))return false;
  return !dependencePhraseMatches(source.text).length&&e1Marker(source.text)===null;
}
