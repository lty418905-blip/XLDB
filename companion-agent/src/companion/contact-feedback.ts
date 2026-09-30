import {createHash} from 'node:crypto';
import type {RelationshipContactChoice,RelationshipCorrectionRecord,RelationshipMetric} from './relationship-assessment.ts';
import {DAY_MS,DEPENDENCE_SATURATION_LEVEL,EVENT_METRICS,HIGH_CONFIDENCE,isDependenceSpike,latestLevel,metricBaseline,
  spikeReference,type AuditOutcome,type RelationshipAudit,type RelationshipNudgeUse,type RelationshipObservation} from './relationship-audit.ts';

/**
 * M3-5 item 4: the single derivation of contact feedback. Relationship corrections, observations, audits and nudge
 * uses are projections the RelationshipAssessmentStore reads back with their source references; AgentJev's silent
 * learning and the tension model read this one output. A revised, rolled-back or deleted source drops the rows that
 * cite it, so the events they produced disappear with them. Silence never produces an event.
 */

export type ContactFeedbackKind='positive'|'negative'|'invitation'|'boundary'|'score_rise'|'score_drop'|
  'outward_rejected'|'dependence_audit';
export interface ContactFeedbackEvent {
  id:string;kind:ContactFeedbackKind;atMs:number;
  /** positive/negative/outward_rejected: the delivery the reaction refers to, when it was a proactive message. */
  deliveryId?:string;
  /** The user source carrying the reaction (T1 feedback, a rejected outward line). */
  source?:{id:string;revision:number};
  metric?:RelationshipMetric;level?:number;
  /** The support probability behind a score event; 1 for a user correction. */
  confidence?:number;
  origin:'reply'|'correction'|'control'|'observation'|'audit'|'nudge';
  /** invitation: the one-off seed key, invite:<assessment revision of the correction>. */
  seedKey?:string;
  outcome?:AuditOutcome;nudgeKey?:string;
}
export interface FeedbackSource {id:string;revision:number;role:'user'|'assistant';text:string;acceptedAtMs:number}
export interface ContactFeedbackInput {
  /** Accepted direct sources of this companion and real user, in acceptance order. */
  sources:readonly FeedbackSource[];
  correction?:RelationshipCorrectionRecord|null;
  /** Contact pauses and hardened boundaries from their own authorities. */
  boundaries?:readonly {id:string;atMs:number;kind:'pause'|'harden'}[];
  observations?:readonly RelationshipObservation[];
  audits?:readonly RelationshipAudit[];
  nudgeUses?:readonly RelationshipNudgeUse[];
  /** Confirmed proactive deliveries that carried an outward frame, so a rejection can label that contact. */
  outwardDeliveries?:readonly {nudgeKey:string;deliveryId:string}[];
}

const SCORE_HIGH_WATER_MS=14*DAY_MS;
function eventId(value:unknown):string {return 'feedback:'+createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0,24);}

/** Only explicit reactions referring to this contact become contact labels (T1). */
export function explicitContactFeedback(text:string):'positive'|'negative'|null {
  if(/[“”「」『』"<>]|(?:如果|假如|他说|她说|假设|if you|would you)/i.test(text))return null;
  if(!/(?:这条消息|这次联系|你.{0,6}(?:联系|找我|发来|发消息|打扰)|(?:your|this) (?:message|contact)|you (?:messaged|contacted))/i.test(text))return null;
  const negative=/(?:别再|不要再|不喜欢|不开心|被吵|(?<!没|没有)吵醒我|打扰到我|烦死|很烦|not welcome|bothered|woke me|annoy)/i.test(text);
  const positive=/(?:很开心|好开心|很喜欢|正需要|刚好需要|来得正好|没有打扰|没打扰|glad|(?<!not )welcome|good timing|helpful)/i.test(text);
  return negative===positive?null:negative?'negative':'positive';
}

export function contactFeedbackEvents(input:ContactFeedbackInput):ContactFeedbackEvent[] {
  const events:ContactFeedbackEvent[]=[];
  const {sources}=input;
  for(let index=0;index<sources.length;index++){
    const sent=sources[index];
    if(sent.role!=='assistant'||!sent.id.startsWith('proactive:'))continue;
    const reply=sources[index+1];
    if(!reply||reply.role!=='user')continue;
    const label=explicitContactFeedback(reply.text);if(!label)continue;
    const deliveryId=sent.id.slice('proactive:'.length);
    events.push({id:eventId([label,`${reply.id}@${reply.revision}`,deliveryId]),kind:label,atMs:reply.acceptedAtMs,
      deliveryId,source:{id:reply.id,revision:reply.revision},origin:'reply'});
  }
  const correction=input.correction;
  if(correction?.contactChoice&&correction.contactCorrectedAtMs!==undefined){
    const choice:RelationshipContactChoice=correction.contactChoice;
    const kind=choice==='send'||choice==='initiate'?'invitation':'boundary';
    events.push({id:eventId([kind,'contact',choice,correction.contactCorrectedAtMs]),kind,
      atMs:correction.contactCorrectedAtMs,origin:'correction',
      ...(kind==='invitation'&&correction.contactCorrectedRevision!==undefined?
        {seedKey:`invite:${correction.contactCorrectedRevision}`}:{})});
  }
  for(const boundary of input.boundaries??[])
    events.push({id:eventId(['boundary',boundary.kind,boundary.id]),kind:'boundary',atMs:boundary.atMs,origin:'control'});
  events.push(...scoreEvents(input.observations??[],input.audits??[],correction??null));
  const deliveries=new Map((input.outwardDeliveries??[]).map(item=>[item.nudgeKey,item.deliveryId]));
  for(const use of input.nudgeUses??[]){
    if(use.channel!=='rejected')continue;
    const at=use.sourceRef.lastIndexOf('@'),source={id:use.sourceRef.slice(0,at),revision:Number(use.sourceRef.slice(at+1))};
    const deliveryId=deliveries.get(use.nudgeKey);
    events.push({id:eventId(['outward_rejected',use.sourceRef,use.nudgeKey]),kind:'outward_rejected',atMs:use.atMs,
      source,nudgeKey:use.nudgeKey,...(deliveryId?{deliveryId}:{}),origin:'nudge'});
  }
  for(const audit of input.audits??[])
    events.push({id:eventId(['dependence_audit',audit.spikeKey]),kind:'dependence_audit',atMs:audit.decidedAtMs,
      metric:audit.metric,level:audit.lNew,outcome:audit.outcome,...(audit.nudge?{nudgeKey:audit.nudge.key}:{}),origin:'audit'});
  return events.sort((a,b)=>a.atMs-b.atMs||a.id.localeCompare(b.id));
}

/**
 * score_rise: the confirmed level (support at least 0.8) is at least one above the 30-day baseline. Dependence counts
 * only as a slow rise up to level 3; a spike is audited instead. A 14-day high water per metric, and a confirmed
 * audit, stop repeats while the 12-message window rolls. score_drop: user-to-agent intimacy confirmed at level 1 or
 * lower from above. A user correction produces the same events at confidence 1; its trend row never repeats them.
 */
function scoreEvents(observations:readonly RelationshipObservation[],audits:readonly RelationshipAudit[],
  correction:RelationshipCorrectionRecord|null):ContactFeedbackEvent[] {
  const rows=[...observations].sort((a,b)=>a.seq-b.seq);
  const eventMetric=(metric:string):metric is typeof EVENT_METRICS[number]=>(EVENT_METRICS as readonly string[]).includes(metric);
  const candidates:ContactFeedbackEvent[]=[];
  const drops:ContactFeedbackEvent[]=[];
  for(const row of rows){
    if(!eventMetric(row.metric)||row.origin==='user_correction'||row.origin==='audit_corrected')continue;
    const lBase=metricBaseline(rows,row.metric,row.atMs,row.seq);
    if(lBase===null)continue;
    if(row.metric==='userToAgentIntimacy'&&lBase>1&&row.level<=1&&(row.c??0)>=HIGH_CONFIDENCE){
      drops.push({id:eventId(['score_drop',row.id]),kind:'score_drop',atMs:row.atMs,metric:row.metric,level:row.level,
        confidence:row.c!,origin:'observation'});
      continue;
    }
    if(row.lConf===null||row.lConf<lBase+1)continue;
    if(row.metric==='userDependency'&&(row.lConf>DEPENDENCE_SATURATION_LEVEL||
      isDependenceSpike(row.level,spikeReference(rows,row.metric,row.atMs,row.seq))))continue;
    // The row keeps the support of its own level; a lower confirmed level is known only to be at least 0.8.
    candidates.push({id:eventId(['score_rise',row.id]),kind:'score_rise',atMs:row.atMs,metric:row.metric,level:row.lConf,
      ...(row.lConf===row.level&&row.c!==null?{confidence:row.c}:{}),origin:'observation'});
  }
  for(const metric of EVENT_METRICS){
    const fixed=correction?.metrics[metric];
    if(!fixed||fixed.atMs===null||fixed.score===null||fixed.previous===null)continue;
    // The trend correct() saw: rows before its own row (or, when it wrote none, rows not after the correction), so a
    // later observation never turns a confirmed dependence spike into a score_rise.
    const fixedAt=fixed.atMs,own=rows.find(row=>row.origin==='user_correction'&&row.metric===metric&&
      row.atMs===fixedAt&&row.level===fixed.score);
    const trend=rows.filter(row=>own?row.seq<own.seq:row.atMs<=fixedAt&&
      !(row.origin==='user_correction'&&row.metric===metric&&row.atMs===fixedAt));
    if(metric==='userToAgentIntimacy'&&fixed.previous>1&&fixed.score<=1){
      drops.push({id:eventId(['score_drop','correction',metric,fixed.atMs,fixed.score]),kind:'score_drop',atMs:fixed.atMs,
        metric,level:fixed.score,confidence:1,origin:'correction'});
      continue;
    }
    if(fixed.score<=fixed.previous)continue;
    // As in correct(): a correction to the held level is no spike.
    if(metric==='userDependency'&&(fixed.score>DEPENDENCE_SATURATION_LEVEL||latestLevel(trend,metric)!==fixed.score&&
      isDependenceSpike(fixed.score,spikeReference(trend,metric,fixed.atMs))))continue;
    candidates.push({id:eventId(['score_rise','correction',metric,fixed.atMs,fixed.score]),kind:'score_rise',
      atMs:fixed.atMs,metric,level:fixed.score,confidence:1,origin:'correction'});
  }
  const accepted:ContactFeedbackEvent[]=[];
  for(const candidate of candidates.sort((a,b)=>a.atMs-b.atMs||a.id.localeCompare(b.id))){
    const shadowed=accepted.some(other=>other.metric===candidate.metric&&other.level!>=candidate.level!&&
      candidate.atMs>=other.atMs&&candidate.atMs-other.atMs<SCORE_HIGH_WATER_MS)||
      audits.some(audit=>audit.metric===candidate.metric&&audit.outcome==='confirmed'&&audit.lNew>=candidate.level!&&
        candidate.atMs>=audit.decidedAtMs&&candidate.atMs-audit.decidedAtMs<SCORE_HIGH_WATER_MS);
    if(!shadowed)accepted.push(candidate);
  }
  return [...accepted,...drops];
}
