import {createHash} from 'node:crypto';
import type {RelationshipAssessmentInput,RelationshipMetric,RelationshipMetrics} from './relationship-assessment.ts';

export const RELATIONSHIP_EVIDENCE_SCHEMA='xldb-relationship-evidence-v2' as const;
export const RELATIONSHIP_EVALUATION_VERSION='relationship-evidence-rule-v2.4' as const;
export const RELATIONSHIP_EVENT_KINDS=[
  'distance_boundary','limited_contact','personal_warmth','explicit_care','mutual_closeness',
  'information_distrust','information_doubt','domain_verification','repeated_verification','sustained_reference',
  'disclosure_refusal','shallow_feeling','specific_feeling','vulnerable_disclosure','repeated_deep_disclosure',
  'delegation_refusal','supervised_task','bounded_delegation','repeated_important_delegation','broad_completed_delegation',
  'independent_coping','optional_support','habitual_support','coping_difficulty','dependency_harm',
] as const;
export type RelationshipEventKind=typeof RELATIONSHIP_EVENT_KINDS[number];
export interface RelationshipEvidenceItem {
  eventKind:RelationshipEventKind;attribution:'self'|'quoted_other'|'roleplay'|'uncertain';
  polarity:'affirmed'|'negated'|'uncertain';domain:string;timeBasis:'current'|'past'|'future'|'unknown';
  ref:{sourceId:string;revision:number;start:number;end:number;quote:string};qualifier:string;
  retracts?:{sourceId:string;revision:number;start:number;end:number;quote:string};
}
export interface RelationshipEvidenceExtraction {schema:typeof RELATIONSHIP_EVIDENCE_SCHEMA;items:RelationshipEvidenceItem[];
  receipt?:{provider:'host:relationshipEvidence';calls:1;inputCharacters:number;elapsedMs:number}}

const KIND_LEVEL:Record<RelationshipEventKind,{metric:RelationshipMetric;level:number}>=Object.fromEntries([
  ['agentToUserIntimacy',['distance_boundary','limited_contact','personal_warmth','explicit_care','mutual_closeness']],
  ['informationReliability',['information_distrust','information_doubt','domain_verification','repeated_verification','sustained_reference']],
  ['emotionalDisclosure',['disclosure_refusal','shallow_feeling','specific_feeling','vulnerable_disclosure','repeated_deep_disclosure']],
  ['taskDelegation',['delegation_refusal','supervised_task','bounded_delegation','repeated_important_delegation','broad_completed_delegation']],
  ['userDependency',['independent_coping','optional_support','habitual_support','coping_difficulty','dependency_harm']],
] .flatMap(([metric,kinds])=>(kinds as string[]).map((kind,level)=>[kind,{metric,level}]))) as Record<RelationshipEventKind,{metric:RelationshipMetric;level:number}>;
// Warmth and boundaries have the same observable levels on both sides; source role chooses direction.
const INTIMACY_KINDS=new Set<RelationshipEventKind>(['distance_boundary','limited_contact','personal_warmth','explicit_care','mutual_closeness']);
const MAX_INPUT_CHARS=48_000;
const EXTRACTION_RULES=[
  'assistant 来源只可提取亲近组，表示 Agent 对用户的态度；user 来源可提取用户亲近组及其余组。assistant 的帮助不是用户委托、依赖或信任。引用、虚构角色、假设和否定不得归属说话人。',
  '逐条扫描每个 source 的完整正文；同一维度同时有相反表态时分别引用两方，不能只保留较晚或较温暖的一方。亲近只看双方关系的明确态度；今晚勿扰、回复时段、隐私范围和普通礼貌不是冷淡。个人化友善与明确关怀若确属同一关系，可各引不同原句；当前明确疏远与关怀则冲突。',
  '信息核验须确认核验结果正确并获认可；核验失败或结果错误不得提取为 domain_verification 或 repeated_verification。一次核验不等于多次；核验发生在过去与现在继续信任是不同命题，若原文均有依据则分别提取。',
  '时间看表态或授权生效，不看执行日：现在明确授权将来写行程属于 current；现在明确表示继续信任属于 current，现已决定以后持续参考也属于 current。过去完成核验但未表达当前持续态度属于 past；仅说未来想做为 future，不补推当前态度。',
  '依赖只看用户明确表达的应对能力、寻求支持的习惯或缺少支持的影响；仅拒绝委托、划定任务权限或说自己将执行某件事，不能推出 independent_coping。明确说能独立应对或不依赖 Agent 才可提取低依赖。',
  'domain 保留真实授权/拒绝的范围，写行程不含订票、支付。不得用过细话题拆开同一亲近关系，也不得把写作授权与付款拒绝合成一项。'
].join('\n');

export function relationshipEvidenceTask(input:RelationshipAssessmentInput){
  const sources=input.sources.map(source=>({id:source.id,revision:source.revision,role:source.role,text:source.text,acceptedAtMs:source.acceptedAtMs}));
  const payload=JSON.stringify({schema:RELATIONSHIP_EVIDENCE_SCHEMA,characterId:input.characterId,sources,
    ...(input.auxiliaryContext?{auxiliaryContext:input.auxiliaryContext}:{})});
  if(payload.length>MAX_INPUT_CHARS)throw new Error('relationship_evidence_input_incomplete');
  return {messages:[{role:'system' as const,content:`只从 sources 的逐字正文提取关系行为；auxiliaryContext 只帮助解释时间、背景和领域，绝不是评分证据，不能引用它作 ref。不要打分、诊断或推断沉默动机。输出严格 JSON：{"schema":"${RELATIONSHIP_EVIDENCE_SCHEMA}","items":[{"eventKind":枚举,"attribution":"self|quoted_other|roleplay|uncertain","polarity":"affirmed|negated|uncertain","domain":具体领域或"general","timeBasis":"current|past|future|unknown","ref":{"sourceId":ID,"revision":修订,"start":原文UTF-16起点,"end":终点,"quote":逐字片段},"qualifier":限定语或空串}]}。eventKind：${RELATIONSHIP_EVENT_KINDS.join(', ')}。五档依次对应亲近：疏远/有限/友善/关怀/双方持续接纳；信息：不信/怀疑/特定领域核验/多次核验/持续重要参考；披露：拒绝/浅谈/具体感受/脆弱/反复重要内心；委托：拒绝/监督小任务/有限授权/反复重要授权/较大任务且认可完成；依赖：独立/可选支持/惯常支持/缺少时难应对/损害独立生活。高档条件须原文直接支持。user 的“我”只属用户，assistant 的“我”只属 Agent。若同源随后明确撤回已提取命题，另输出 negated 项及被撤回项的精确 retracts ref；普通否定不填 retracts。未知直接证据时 items 为空。
${EXTRACTION_RULES}`},
    {role:'user' as const,content:payload}],responseFormat:'json' as const};
}
export const RELATIONSHIP_EVIDENCE_PROMPT_HASH=createHash('sha256').update(relationshipEvidenceTask({
  scope:{worldId:'',sessionId:'',branchId:'',characterId:''},subjectId:'',characterId:'',
  sourceVersion:0,controlsRevision:0,sources:[]}).messages.filter(message=>message.role==='system').map(message=>message.content).join('\n')).digest('hex');

export function decodeRelationshipEvidence(raw:unknown,input:RelationshipAssessmentInput):RelationshipEvidenceExtraction {
  let value:unknown=raw;
  if(typeof value==='string'){try{value=JSON.parse(value);}catch{throw new Error('invalid_relationship_evidence');}}
  if(!object(value)||value.schema!==RELATIONSHIP_EVIDENCE_SCHEMA||!Array.isArray(value.items)||value.items.length>96)
    throw new Error('invalid_relationship_evidence');
  const items:RelationshipEvidenceItem[]=value.items.map((candidate:unknown)=>{
    if(!object(candidate)||!RELATIONSHIP_EVENT_KINDS.includes(candidate.eventKind)||
      !['self','quoted_other','roleplay','uncertain'].includes(candidate.attribution)||
      !['affirmed','negated','uncertain'].includes(candidate.polarity)||
      !['current','past','future','unknown'].includes(candidate.timeBasis)||
      typeof candidate.domain!=='string'||!candidate.domain.trim()||candidate.domain.length>100||
      typeof candidate.qualifier!=='string'||candidate.qualifier.length>240||!object(candidate.ref))
      throw new Error('invalid_relationship_evidence');
    const ref=candidate.ref;
    const source=input.sources.find(item=>item.id===ref.sourceId&&item.revision===ref.revision);
    if(!source||!Number.isSafeInteger(ref.start)||!Number.isSafeInteger(ref.end)||ref.start<0||ref.end<=ref.start||
      ref.end>source.text.length||typeof ref.quote!=='string'||ref.quote.length>500||
      source.text.slice(ref.start,ref.end)!==ref.quote)throw new Error('invalid_relationship_evidence_ref');
    const kind=candidate.eventKind as RelationshipEventKind;
    if(INTIMACY_KINDS.has(kind)?source.role!=='user'&&source.role!=='assistant':source.role!=='user')
      throw new Error('invalid_relationship_evidence_role');
    return {eventKind:kind,attribution:candidate.attribution,polarity:candidate.polarity,
      domain:candidate.domain,timeBasis:candidate.timeBasis,ref:{sourceId:source.id,revision:source.revision,
        start:ref.start,end:ref.end,quote:ref.quote},qualifier:candidate.qualifier,
        ...(candidate.retracts!==undefined?{retracts:candidate.retracts}:{})};
  });
  for(const item of items){
    if(item.retracts===undefined)continue;
    const target=items.find(other=>other.polarity==='affirmed'&&other.attribution==='self'&&
      other.eventKind===item.eventKind&&relationshipDomain(other)===relationshipDomain(item)&&sameRef(other.ref,item.retracts));
    if(!target||item.attribution!=='self'||item.polarity!=='negated'||item.timeBasis!=='current'||
      !laterSameSpeaker(item,target,input))throw new Error('invalid_relationship_retraction');
    item.retracts={...target.ref};
  }
  let receipt:RelationshipEvidenceExtraction['receipt'];
  if(value.receipt!==undefined){
    if(!object(value.receipt)||value.receipt.provider!=='host:relationshipEvidence'||value.receipt.calls!==1||
      !Number.isSafeInteger(value.receipt.inputCharacters)||value.receipt.inputCharacters<0||
      !Number.isFinite(value.receipt.elapsedMs)||value.receipt.elapsedMs<0)
      throw new Error('invalid_relationship_evidence_receipt');
    receipt={provider:'host:relationshipEvidence',calls:1,inputCharacters:value.receipt.inputCharacters,
      elapsedMs:value.receipt.elapsedMs};
  }
  return {schema:RELATIONSHIP_EVIDENCE_SCHEMA,items,...(receipt?{receipt}:{})};
}

export interface EvidenceProjection {
  metrics:RelationshipMetrics;
  /** Ambiguous readings of the same span only. Conflicting events and domains remain unresolved. */
  ambiguous:Partial<Record<RelationshipMetric,{levels:number[];items:RelationshipEvidenceItem[]}>>;
}
export function projectRelationshipEvidence(extraction:RelationshipEvidenceExtraction,input:RelationshipAssessmentInput):EvidenceProjection {
  const metrics=Object.fromEntries((['agentToUserIntimacy','userToAgentIntimacy','informationReliability','emotionalDisclosure','taskDelegation','userDependency'] as RelationshipMetric[])
    .map(key=>[key,{score:null,confidence:'low',rationale:'没有可支持的当前行为证据',evidence:[],origin:'evidence_rule',domains:[]}])) as unknown as RelationshipMetrics;
  const normalizedItems=extraction.items.map(item=>({...item,domain:relationshipDomain(item)}));
  const grouped=new Map<RelationshipMetric,RelationshipEvidenceItem[]>();
  for(const item of normalizedItems){
    if(item.attribution!=='self'||item.polarity!=='affirmed'||item.timeBasis==='future'||item.timeBasis==='unknown')continue;
    if(item.eventKind==='limited_contact'&&contactTimingOnly(item.ref.quote))continue;
    const source=input.sources.find(candidate=>candidate.id===item.ref.sourceId&&candidate.revision===item.ref.revision)!;
    const metric=INTIMACY_KINDS.has(item.eventKind)?source.role==='user'?'userToAgentIntimacy':'agentToUserIntimacy':KIND_LEVEL[item.eventKind].metric;
    grouped.set(metric,[...(grouped.get(metric)??[]),item]);
  }
  const ambiguous:EvidenceProjection['ambiguous']={};
  for(const [metric,originalItems] of grouped){
    const items=originalItems.filter(item=>{
      return !normalizedItems.some(other=>other.eventKind===item.eventKind&&other.domain===item.domain&&
        other.attribution==='self'&&other.polarity==='negated'&&other.timeBasis==='current'&&
        sameRef(item.ref,other.retracts)&&laterSameSpeaker(other,item,input));
    });
    if(!items.length)continue;
    const currentItems=items.filter(item=>item.timeBasis==='current');
    const domains=[...new Set(items.map(item=>item.domain))];
    const evidence=currentItems.slice(0,5).map(item=>({sourceId:item.ref.sourceId,revision:item.ref.revision,quote:item.ref.quote}));
    const domainItems=domains.map(domain=>{
      const positives=items.filter(item=>item.domain===domain),current=positives.filter(item=>item.timeBasis==='current');
      const negatives=normalizedItems.filter(other=>other.domain===domain&&other.attribution==='self'&&
        other.polarity==='negated'&&other.timeBasis==='current'&&!other.retracts&&
        positives.some(item=>item.eventKind===other.eventKind&&laterSameSpeaker(other,item,input)));
      const status=negatives.length?'conflicted' as const:current.length?'current' as const:'historical' as const;
      const combined=[...negatives,...(current.length?current:positives)];
      return {domain,status,levels:[...new Set((current.length?current:positives).map(item=>KIND_LEVEL[item.eventKind].level))],
        evidence:combined.slice(0,5).map(item=>({sourceId:item.ref.sourceId,revision:item.ref.revision,quote:item.ref.quote})),
        qualifiers:[...new Set(combined.map(item=>item.qualifier).filter(Boolean))].slice(0,5)};
    });
    const currentDomains=domainItems.filter(domain=>domain.status==='current');
    const conflicted=domainItems.some(domain=>domain.status==='conflicted');
    const levels=[...new Set(currentItems.map(item=>KIND_LEVEL[item.eventKind].level))];
    const sameSpan=currentItems.length>0&&currentItems.every(item=>sameRef(item.ref,currentItems[0].ref)&&item.domain===currentItems[0].domain);
    if(!conflicted&&levels.length>1&&sameSpan)ambiguous[metric]={levels,items:currentItems};
    const score=!conflicted&&currentDomains.length===1&&currentItems.length>0?
      compatibleCurrentLevel(metric,currentItems):null;
    metrics[metric]={score,confidence:'low',rationale:score===null?'仅有历史、不同领域、不同档位或当前冲突证据，暂不形成当前分值':
      `已接受对话中有${items.length}条直接行为证据`,evidence:score===null?[]:evidence,origin:'evidence_rule',domains:domainItems};
  }
  return {metrics,ambiguous};
}

function relationshipDomain(item:RelationshipEvidenceItem):string {
  if(!INTIMACY_KINDS.has(item.eventKind))return item.domain;
  const domain=item.domain.trim();
  return domain==='general'||/^(?:relationship|the relationship|我们(?:的)?关系|双方(?:的)?关系|双方相处|亲近关系)$/i.test(domain)
    ?'relationship':domain;
}

/** A contact schedule alone is a control, not a statement about relational closeness. */
function contactTimingOnly(quote:string):boolean {
  return /(?:今晚|今天|明天|晚上|白天|睡觉|睡眠|点后|点前|时段|tonight|tomorrow|after \d|before \d|while (?:I |I'm )?sleep)/i.test(quote)&&
    /(?:主动联系|联系时段|别联系|不要联系|发消息|回复时段|contact window|do not (?:call|text|message))/i.test(quote)&&
    !/(?:亲近|亲密|在乎|喜欢你|关心你|保持距离|疏远|冷淡|珍惜|不想再|受够|永远|以后都|再也|(?:our|this) relationship|keep (?:some )?distance|never|anymore|ever again)/i.test(quote);
}

/** Directly supported, cumulative positive closeness within one domain only. */
function compatibleCurrentLevel(metric:RelationshipMetric,items:RelationshipEvidenceItem[]):number|null {
  const levels=[...new Set(items.map(item=>KIND_LEVEL[item.eventKind].level))];
  if(levels.length===1)return levels[0];
  if(metric!=='agentToUserIntimacy'&&metric!=='userToAgentIntimacy')return null;
  const compatible=new Map<string,number>([['2,3',3],['2,4',4],['3,4',4],['2,3,4',4]]);
  const selected=compatible.get([...levels].sort().join(','));
  if(selected===undefined)return null;
  // Different readings of one quote remain for local ranking, not cumulative evidence.
  for(const item of items){
    if(items.some(other=>other!==item&&KIND_LEVEL[other.eventKind].level!==KIND_LEVEL[item.eventKind].level&&
      other.ref.sourceId===item.ref.sourceId&&other.ref.revision===item.ref.revision&&
      other.ref.start<item.ref.end&&item.ref.start<other.ref.end))return null;
  }
  return selected;
}

function sameRef(left:RelationshipEvidenceItem['ref'],right:unknown):boolean {
  return object(right)&&left.sourceId===right.sourceId&&left.revision===right.revision&&
    left.start===right.start&&left.end===right.end&&left.quote===right.quote;
}
function laterSameSpeaker(later:RelationshipEvidenceItem,earlier:RelationshipEvidenceItem,input:RelationshipAssessmentInput):boolean {
  const a=input.sources.find(source=>source.id===later.ref.sourceId&&source.revision===later.ref.revision);
  const b=input.sources.find(source=>source.id===earlier.ref.sourceId&&source.revision===earlier.ref.revision);
  return !!a&&!!b&&a.role===b.role&&(a.acceptedAtMs>b.acceptedAtMs||a.id===b.id&&later.ref.start>earlier.ref.start);
}

function object(value:unknown):value is Record<string,any>{return typeof value==='object'&&value!==null&&!Array.isArray(value);}
