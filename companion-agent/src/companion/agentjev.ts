import {AUDIT_REQUEST_ID,EMPTY_RELATIONSHIP_TREND,dependenceAuditPlanFor,hasOpposingDistanceAndCare,relationshipConfirmationPlan,
  type RelationshipAssessmentTask,type RelationshipMetric} from './relationship-assessment.ts';
import {SINCERITY_OPTIONS,spanKey,type DependenceAuditPlan,type SincerityKey} from './relationship-audit.ts';
import {CURRENT_RELATIONSHIP_EVIDENCE_SCHEMA,decodeRelationshipEvidence,projectRelationshipEvidence,relationshipEvidenceTask} from './relationship-evidence.ts';
import type {RelationshipEvidenceExtraction} from './relationship-evidence.ts';
import type {ContactContext} from './contact-context.ts';
import type {ContactJudgment} from './companion-flow.ts';
import {type LearningTrace,type PersonalTaskType,type PersonalWeightsStore} from './personal-weights.ts';
import {AgentJevClient as SharedAgentJevClient,validatePayload,validateResponse} from '../../../shared/src/agentjev/client.ts';
import type {AgentJevClientOptions,Answer,Request,Response} from '../../../shared/src/agentjev/client.ts';

// The generic client moved to shared/src/agentjev/client.ts; these re-exports keep the companion import paths.
export {DEFAULT_BACKOFF_MS,agentJevIdentityOffLoop,available,cachedFileSha256} from '../../../shared/src/agentjev/client.ts';
export type {AgentJevAvailability,AgentJevClientOptions} from '../../../shared/src/agentjev/client.ts';

// Dimension-specific anchors; missing opportunities are unknown, never a zero.
export const METRIC_LEVELS:Record<RelationshipMetric,readonly string[]>={
  agentToUserIntimacy:['Agent 明确要求疏远','Agent 只表达有限礼貌','Agent 表达个人化友善','Agent 明确表达关心与亲近','Agent 持续表达双方已接纳的深度亲近'],
  userToAgentIntimacy:['用户明确要求疏远','用户明确只接受有限交往','用户表达个人化友善','用户明确表达关心与亲近','用户持续表达双方已接纳的深度亲近'],
  informationReliability:['用户明确认为信息不可信','用户表示怀疑且只把信息作为线索','用户认可特定领域的信息但要求核对','用户明确认可多次已核实的回答','用户持续把已验证信息作为重要参考'],
  emotionalDisclosure:['用户明确不愿向 Agent 披露感受','用户明确只愿浅谈感受','用户分享具体个人感受','用户主动分享脆弱感受并寻求理解','用户多次主动分享重要内心体验并明确表示信任'],
  taskDelegation:['用户明确不愿委托任务','用户只允许逐步监督下的小任务','用户允许限定范围的任务','用户反复授权具体重要任务','用户明确授权较大任务并认可已完成结果'],
  userDependency:['用户明确表示不依赖 Agent 并能独立应对','用户明确表示有帮助但可自行处理','用户报告遇事惯常寻求 Agent 支持','用户报告缺少 Agent 时明显难以应对','用户明确报告依赖 Agent 已影响独立生活或其它关系'],
};
export function relationshipSupportQuestion(metric:RelationshipMetric,level:number,id=String(level)){
  if(!Number.isInteger(level)||level<0||level>=METRIC_LEVELS[metric].length)
    throw new Error('invalid_relationship_level');
  return {id,type:'boolean' as const,
    question:`来源原文是否直接且充分支持该关系档位：${METRIC_LEVELS[metric][level]}？只以原文事实判断。`,
    criteria:{true:'该档位所要求的限定条件都由原文直接支持',false:'原文没有充分支持该档位全部限定条件'}};
}
export interface AgentJevOptions extends AgentJevClientOptions {
  extractEvidence?:(task:ReturnType<typeof relationshipEvidenceTask>)=>Promise<unknown>;
  personalWeights?:PersonalWeightsStore;
}

/** The companion client: relationship assessment, contact and quiet-exception decisions, and personal learning traces. */
export class AgentJevClient extends SharedAgentJevClient {
  private readonly extractEvidence?:AgentJevOptions['extractEvidence'];
  private readonly personalWeights?:PersonalWeightsStore;

  constructor(options:AgentJevOptions={}){
    super(options);
    this.extractEvidence=options.extractEvidence;
    this.personalWeights=options.personalWeights;
  }

  /** Capture the frozen decision input and the exact pre-fc2 candidate features. */
  async evaluateWithTrace(payload:unknown,learning:{scopeKey:string;taskType:PersonalTaskType}):Promise<{
    response:Response;learningTraces:LearningTrace[];
  }> {
    const expected=validatePayload(payload);
    const response=await this.evaluateRaw(expected,true);
    if(!response.learning||response.learning.length!==expected.requests.reduce((n,item)=>n+item.questions.length,0))
      throw new Error('agentjev_missing_learning_features');
    const learningTraces:LearningTrace[]=[];
    let index=0;
    for(const request of expected.requests)for(const question of request.questions){
      const raw=response.learning[index++];
      const options=question.type==='choice'?question.options:question.type==='score'?
        Object.fromEntries(question.levels.map((level,i)=>[String(i),level])):
        {true:question.criteria?.true??'TRUE',false:question.criteria?.false??'FALSE'};
      const trace:LearningTrace={scopeKey:learning.scopeKey,taskType:learning.taskType,
        modelIdentity:this.identity(),parameterVersion:this.personalWeights?.version(learning.scopeKey,
          learning.taskType,this.identity())??0,requestId:request.id,questionId:question.id,
        state:request.state,question:question.question,options,keys:Object.keys(options),
        features:raw.features,baseLogits:raw.baseLogits};
      if(trace.features.length!==trace.keys.length||trace.baseLogits.length!==trace.keys.length||
        trace.features.some(row=>row.length!==256||row.some(value=>!Number.isFinite(value)))||
        trace.baseLogits.some(value=>!Number.isFinite(value)))throw new Error('agentjev_invalid_learning_features');
      learningTraces.push(trace);
    }
    if(this.personalWeights){
      let offset=0;
      for(const result of response.results)for(let qi=0;qi<result.answers.length;qi++){
        const trace=learningTraces[offset++],logits=this.personalWeights.adjustedLogits(trace);
        if(!logits)continue;
        const probabilities=softmax(logits);
        result.answers[qi]=answerForTrace(result.answers[qi].type,trace,probabilities);
      }
      validateResponse(response,expected);
    }
    delete response.learning;
    return {response,learningTraces};
  }

  /**
   * Relationship levels with AgentJev's own confidence. Ambiguous spans are ranked as before and every candidate's
   * support probability is kept; an event metric whose rule level moved from its 30-day baseline gets one confirmation
   * request (id = metric, the same state and head as the ambiguity and learning jobs); a dependence spike gets one
   * audit request whose id no learning job uses, so it is read by the untrained head. All go in one call, and no call
   * is made when none is needed.
   */
  async assess(task:RelationshipAssessmentTask,extracted?:unknown,personalScopeKey?:string):Promise<{
    schema:'xldb-relationship-assessment-v2';extraction:RelationshipEvidenceExtraction;
    selections:Partial<Record<RelationshipMetric,number>>;
    support?:Partial<Record<RelationshipMetric,{support:Record<string,number>}>>;
    audit?:{spikeKey:string;drivers:{ref:string;sincerity:Record<SincerityKey,number>}[];support:number};
    calibration?:string;modelIdentity?:string;parameterVersion?:number;
    rawDiagnostics?:unknown;learningTraces?:LearningTrace[];
  }> {
    if(task.schema!=='xldb-relationship-assessment-v2'||!Array.isArray(task.sources))throw new Error('invalid_agentjev_assessment_task');
    if(!extracted&&!this.extractEvidence)throw new Error('relationship_evidence_extractor_required');
    const extraction=decodeRelationshipEvidence(extracted??await this.extractEvidence!(relationshipEvidenceTask(task)),task);
    if((extraction.receipt||extracted===undefined)&&extraction.schema!==CURRENT_RELATIONSHIP_EVIDENCE_SCHEMA)
      throw new Error('relationship_evidence_current_contract_required');
    const trend=task.trend??EMPTY_RELATIONSHIP_TREND;
    const projection=projectRelationshipEvidence(extraction,task,{exclusions:trend.exclusions});
    const contextExclusions:Record<string,{profileRefs:string[];commitmentRefs:string[]}>={};
    const requests:Request[]=Object.entries(projection.ambiguous)
      .filter(([,ambiguity])=>!hasOpposingDistanceAndCare(ambiguity!.items)).map(([metric,ambiguity])=>{
      const compact=relationshipAmbiguityState(task,metric,ambiguity!.items);
      contextExclusions[metric]=compact.excluded;
      return {id:metric,state:compact.state,questions:ambiguity!.levels.map(level=>
        relationshipSupportQuestion(metric as RelationshipMetric,level))};
    });
    const ambiguous=new Set(requests.map(request=>request.id));
    for(const plan of relationshipConfirmationPlan(projection,task,trend)){
      if(ambiguous.has(plan.metric))continue;
      const compact=relationshipAmbiguityState(task,plan.metric,plan.items);
      contextExclusions[plan.metric]=compact.excluded;
      requests.push({id:plan.metric,state:compact.state,questions:plan.levels.map(level=>relationshipSupportQuestion(plan.metric,level))});
    }
    const auditPlan=dependenceAuditPlanFor(projection,task,trend);
    const auditRequest=auditPlan?.kind==='audit'?dependenceAuditRequest(task,auditPlan):null;
    if(auditRequest)requests.push(auditRequest.request);
    const selections:Partial<Record<RelationshipMetric,number>>={};
    const support:Partial<Record<RelationshipMetric,{support:Record<string,number>}>>={};
    let rawDiagnostics:unknown,learningTraces:LearningTrace[]|undefined,audit:{spikeKey:string;
      drivers:{ref:string;sincerity:Record<SincerityKey,number>}[];support:number}|undefined,
      calibration:string|undefined,parameterVersion:number|undefined;
    if(requests.length){
      const outcome=personalScopeKey?await this.evaluateWithTrace({requests},{scopeKey:personalScopeKey,taskType:'relationship'}):null;
      const reply=outcome?.response??await this.evaluate({requests});
      learningTraces=outcome?.learningTraces;rawDiagnostics={...reply,contextExclusions};
      calibration=typeof reply.calibration==='string'&&reply.calibration&&reply.calibration.length<=100?reply.calibration:undefined;
      parameterVersion=learningTraces?.[0]?.parameterVersion??0;
      for(const result of reply.results){
        if(result.id===AUDIT_REQUEST_ID&&auditRequest){
          const answers=new Map(result.answers.map(answer=>[answer.id,answer]));
          audit={spikeKey:auditPlan!.spikeKey,support:answers.get('support')?.probability??0,
            drivers:auditRequest.drivers.map((driver,index)=>{
              const distribution=answers.get(`sincere:${index}`)?.distribution??{};
              return {ref:driver,sincerity:Object.fromEntries((Object.keys(SINCERITY_OPTIONS) as SincerityKey[])
                .map(key=>[key,distribution[key]??0])) as Record<SincerityKey,number>};
            })};
          continue;
        }
        const levels=result.answers.map(answer=>({level:Number(answer.id),support:answer.probability??0}));
        support[result.id as RelationshipMetric]={support:Object.fromEntries(levels.map(item=>[String(item.level),item.support]))};
        if(!ambiguous.has(result.id))continue;
        const ranked=[...levels].sort((left,right)=>right.support-left.support);
        if(ranked[0]?.support>=.5)selections[result.id as RelationshipMetric]=ranked[0].level;
      }
    }
    return {schema:'xldb-relationship-assessment-v2',extraction,selections,
      ...(Object.keys(support).length?{support,modelIdentity:this.identity(),parameterVersion}:{}),
      ...(audit?{audit}:{}),...(calibration?{calibration}:{}),rawDiagnostics,learningTraces};
  }

  async decideContact(input:{context:ContactContext;opportunity:{purpose:string;topic:string;basis?:unknown};candidateBody?:string},
    personalScopeKey?:string):Promise<ContactJudgment & {learningTraces?:LearningTrace[]}> {
    if(!input||typeof input!=='object'||!input.context||!input.opportunity)throw new Error('invalid_agentjev_contact_input');
    const purpose=boundedText(input.opportunity.purpose,180),topic=boundedText(input.opportunity.topic,300);
    if(!purpose||!topic)throw new Error('invalid_agentjev_contact_input');
    const candidateBody=input.candidateBody;
    if(candidateBody!==undefined&&(typeof candidateBody!=='string'||!candidateBody.trim()||candidateBody.length>300))
      throw new Error('invalid_agentjev_contact_input');
    // A current goodnight is a soft window, not a veto: `context.sleepBoundary` stays in the state and the questions decide.
    const request:Request={id:'contact',state:JSON.stringify({context:input.context,opportunity:{purpose,topic,
      basis:input.opportunity.basis??null},candidateBody}),questions:[
      {id:'clearHelp',type:'choice',question:'所给最新用户互动是否明确支持现在发送这条具体消息会受欢迎或及时帮上忙？',
        options:{yes:'有当前明确的欢迎或及时帮助依据',no:'没有当前明确的欢迎或及时帮助依据'}},
      {id:'clearHarm',type:'choice',question:'所给最新用户互动是否明确表明这条消息现在会打扰、重复已答问题、违背拒绝或不合当前处境？',
        options:{yes:'有当前明确的不适合发送依据',no:'没有当前明确的不适合发送依据'}},
      {id:'emotion',type:'choice',question:'依角色设定和当前OpenHer情绪，主动联系是否符合人物此时的情绪与立场？',
        options:{aligned:'明确符合',uncertain:'无法确认',conflicting:'明显不符'}},
      {id:'contactChoice',type:'choice',question:'硬性联系机会已许可。只有用户体验positive且人物情绪aligned才可send；否则wait或skip。不得因依赖提高频率。',
        options:{send:'现在发送',wait:'保留机会等待',skip:'放弃本次机会'}},
    ]};
    if(request.state.length>3000)throw new Error('contact_context_too_large');
    const outcome=personalScopeKey?await this.evaluateWithTrace({requests:[request]},
      {scopeKey:personalScopeKey,taskType:'contact'}):null;
    const response=outcome?.response??await this.evaluate({requests:[request]});
    const answers=response.results[0]?.answers;
    const clearHelp=answers?.[0]?.value,clearHarm=answers?.[1]?.value;
    const experience=clearHarm==='yes'?'negative':clearHelp==='yes'?'positive':'uncertain';
    const emotion=answers?.[2]?.value,choice=answers?.[3]?.value;
    if((clearHelp!=='yes'&&clearHelp!=='no')||(clearHarm!=='yes'&&clearHarm!=='no')||
      (emotion!=='aligned'&&emotion!=='uncertain'&&emotion!=='conflicting')||
      (choice!=='send'&&choice!=='wait'&&choice!=='skip'))throw new Error('agentjev_invalid_response');
    // A negative experience or conflicting emotion rules out this opportunity even when
    // the model's third answer says "wait"; that answer must not contradict its evidence judgments.
    const resolved=experience==='negative'||emotion==='conflicting'?'skip':
      choice==='send'&&(experience!=='positive'||emotion!=='aligned')?'wait':choice;
    return {experience,emotion,choice:resolved,rawChoice:choice,
      ...(outcome?{learningTraces:outcome.learningTraces}:{})};
  }

  async decideQuietException(input:{context:ContactContext;quiet:{content:string;windowKey:string}[];candidateBody:string}):Promise<'positive'|'uncertain'|'negative'>;
  async decideQuietException(input:{context:ContactContext;quiet:{content:string;windowKey:string}[];candidateBody:string},
    personalScopeKey:string):Promise<{verdict:'positive'|'uncertain'|'negative';learningTraces:LearningTrace[]}>;
  async decideQuietException(input:{context:ContactContext;quiet:{content:string;windowKey:string}[];candidateBody:string},
    personalScopeKey?:string):Promise<'positive'|'uncertain'|'negative'|{verdict:'positive'|'uncertain'|'negative';learningTraces:LearningTrace[]}> {
    if(!input||!input.context||!Array.isArray(input.quiet)||!input.quiet.length||
      typeof input.candidateBody!=='string'||!input.candidateBody.trim()||input.candidateBody.length>300)
      throw new Error('invalid_agentjev_contact_input');
    const state=JSON.stringify(input);
    if(state.length>3000)throw new Error('contact_context_too_large');
    const request:Request={id:'quiet-exception',state,questions:[{id:'longingExperience',type:'choice',
      question:'当前是用户约定的勿扰时段。按context.clock的此刻当地时间及用户当前说明，简短诉说思念且不要求回复能否明确让用户现在开心？用户明确说要睡觉或道晚安且目前仍适用时，通知可能吵醒，应判 negative；仅凭作息、时间或未回复不可断定已睡，无其它明确依据可判 uncertain。不得借提醒或依赖提高频率。',
      options:{positive:'有明确证据此刻会让用户开心',uncertain:'证据不足或利弊不明',negative:'可能打扰、施压或让用户不快'}}]};
    const outcome=personalScopeKey?await this.evaluateWithTrace({requests:[request]},
      {scopeKey:personalScopeKey,taskType:'contact'}):null;
    const answer=(outcome?.response??await this.evaluate({requests:[request]})).results[0]?.answers[0]?.value;
    if(answer!=='positive'&&answer!=='uncertain'&&answer!=='negative')throw new Error('agentjev_invalid_response');
    return outcome?{verdict:answer,learningTraces:outcome.learningTraces}:answer;
  }
}

function relationshipAmbiguityState(task:RelationshipAssessmentTask,metric:string,
  items:readonly {eventKind:string;domain:string;ref:{sourceId:string;revision:number;quote:string}}[]):
  {state:string;excluded:{profileRefs:string[];commitmentRefs:string[]}} {
  const evidence=items.map(item=>({kind:item.eventKind,domain:item.domain,ref:`${item.ref.sourceId}@${item.ref.revision}`,
    quote:item.ref.quote}));
  const auxiliary=task.auxiliaryContext;
  const excluded={profileRefs:[...(auxiliary?.excluded.profileRefs??[])],
    commitmentRefs:[...(auxiliary?.excluded.commitmentRefs??[])]};
  const omitted={profile:auxiliary?.excluded.profileCount??excluded.profileRefs.length,
    commitments:auxiliary?.excluded.commitmentCount??excluded.commitmentRefs.length};
  if(!auxiliary){
    const state=JSON.stringify({mode:'relationship-ambiguity',metric,evidence});
    if(state.length>1800)throw new Error('agentjev_assessment_context_too_large');
    return {state,excluded};
  }
  const context={clock:auxiliary.clock,waiting:auxiliary.waiting,emotion:auxiliary.emotion,
    contactWindowState:auxiliary.contactWindowState,commitments:[] as typeof auxiliary.commitments,
    profileFacts:[] as typeof auxiliary.profileFacts,excludedCounts:{profile:0,commitments:0}};
  const shape={mode:'relationship-ambiguity',metric,evidence,context};
  const serialize=()=>JSON.stringify(shape);
  if(serialize().length>1800)throw new Error('agentjev_assessment_context_too_large');
  for(const record of auxiliary.commitments){
    context.commitments.push(record);
    if(serialize().length>1800){context.commitments.pop();excluded.commitmentRefs.push(record.ref);omitted.commitments++;}
  }
  for(const entry of auxiliary.profileFacts){
    context.profileFacts.push(entry);
    if(serialize().length>1800){context.profileFacts.pop();excluded.profileRefs.push(entry.ref);omitted.profile++;}
  }
  context.excludedCounts=omitted;
  const state=serialize();
  if(state.length>1800)throw new Error('agentjev_assessment_context_too_large');
  return {state,excluded};
}
/**
 * The dependence audit: for each driving span, the span with 80 characters of its source on either side (shrinking to
 * fit 1800 characters), one five-way sincerity question, and one support question re-asked at the spike level. The
 * state carries no flag, score or level number.
 */
function dependenceAuditRequest(task:RelationshipAssessmentTask,plan:DependenceAuditPlan):{request:Request;drivers:string[]} {
  const texts=new Map(task.sources.map(source=>[`${source.id}@${source.revision}`,source.text]));
  for(const radius of [80,40,20,0])for(let count=plan.drivers.length;count>0;count--){
    const drivers=plan.drivers.slice(0,count);
    const evidence=drivers.map((driver,index)=>{
      const text=texts.get(`${driver.ref.sourceId}@${driver.ref.revision}`)??'';
      return {index,ref:`${driver.ref.sourceId}@${driver.ref.revision}`,
        text:text.slice(Math.max(0,driver.ref.start-radius),Math.min(text.length,driver.ref.end+radius))};
    });
    const state=JSON.stringify({mode:'dependence-audit',evidence});
    if(state.length>1800)continue;
    return {drivers:drivers.map(driver=>spanKey(driver.ref)),request:{id:AUDIT_REQUEST_ID,state,questions:[
      ...drivers.map((_,index)=>({id:`sincere:${index}`,type:'choice' as const,
        question:`evidence[${index}] 里用户关于离不开或只能依靠对方的这句话，结合前后原文的语气，最可能是哪一种？只依原文判断。`,
        options:{...SINCERITY_OPTIONS}})),
      relationshipSupportQuestion('userDependency',plan.lNew,'support')]}};
  }
  throw new Error('agentjev_assessment_context_too_large');
}
function boundedText(value:unknown,max:number):string{
  if(typeof value!=='string')throw new Error('invalid_agentjev_text');return value.trim().slice(0,max);
}
function softmax(logits:number[]):number[] {
  const top=Math.max(...logits),exp=logits.map(value=>Math.exp(value-top));
  const sum=exp.reduce((total,value)=>total+value,0);
  return exp.map(value=>value/sum);
}
function answerForTrace(type:Answer['type'],trace:LearningTrace,probabilities:number[]):Answer {
  const distribution=Object.fromEntries(trace.keys.map((key,index)=>[key,probabilities[index]]));
  const top=Math.max(...probabilities),index=probabilities.indexOf(top);
  if(type==='boolean')return {id:trace.questionId,type,value:probabilities[0]>=0.5,
    probability:probabilities[0],distribution};
  if(type==='score')return {id:trace.questionId,type,score:probabilities.reduce((sum,p,i)=>sum+i*p,0),
    level:index,distribution};
  const ranked=[...probabilities].sort((a,b)=>b-a);
  return {id:trace.questionId,type,value:trace.keys[index],distribution,
    top_probability:top,margin:ranked[0]-ranked[1]};
}