import {createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {PersonalWeightsStore,personalScopeKey,type LearningTrace} from './personal-weights.ts';
import type {SceneScope,SceneSource} from '../scene/types.ts';
import {decodeRelationshipEvidence} from './relationship-evidence.ts';
import {METRIC_LEVELS} from './agentjev.ts';
import type {RelationshipAssessment,RelationshipAssessmentInput,RelationshipMetric} from './relationship-assessment.ts';

export interface LearningEvaluator {
  identity():string;
  evaluateWithTrace(payload:unknown,learning:{scopeKey:string;taskType:'contact'|'relationship'}):Promise<{learningTraces:LearningTrace[]}>;
}
export interface LearningJob {
  scopeKey:string;jobKey:string;taskType:'contact'|'relationship';token:number;
  payload:string;
}
const GROUPS:Partial<Record<RelationshipMetric,readonly string[]>>={
  userToAgentIntimacy:['distance_boundary','limited_contact','personal_warmth','explicit_care','mutual_closeness'],
  informationReliability:['information_distrust','information_doubt','domain_verification','repeated_verification','sustained_reference'],
  emotionalDisclosure:['disclosure_refusal','shallow_feeling','specific_feeling','vulnerable_disclosure','repeated_deep_disclosure'],
  taskDelegation:['delegation_refusal','supervised_task','bounded_delegation','repeated_important_delegation','broad_completed_delegation'],
  userDependency:['independent_coping','optional_support','habitual_support','coping_difficulty','dependency_harm'],
};

/** Only explicit reactions referring to this contact become contact labels. */
export function explicitContactFeedback(text:string):'positive'|'negative'|null {
  if(/[“”「」『』"<>]|(?:如果|假如|他说|她说|假设|if you|would you)/i.test(text))return null;
  if(!/(?:这条消息|这次联系|你.{0,6}(?:联系|找我|发来|发消息|打扰)|(?:your|this) (?:message|contact)|you (?:messaged|contacted))/i.test(text))return null;
  const negative=/(?:别再|不要再|不喜欢|不开心|被吵|(?<!没|没有)吵醒我|打扰到我|烦死|很烦|not welcome|bothered|woke me|annoy)/i.test(text);
  const positive=/(?:很开心|好开心|很喜欢|正需要|刚好需要|来得正好|没有打扰|没打扰|glad|(?<!not )welcome|good timing|helpful)/i.test(text);
  return negative===positive?null:negative?'negative':'positive';
}

export function interactionBehaviorSummary(sources:RelationshipAssessmentInput['sources']){
  const users=sources.filter(s=>s.role==='user');
  let initiated=0,affection=0,requestResponses=0,playfulResponses=0,positiveResponses=0,negativeResponses=0;
  for(let i=0;i<sources.length;i++){
    const source=sources[i];if(source.role!=='user')continue;
    const previous=sources[i-1];
    if(!previous||source.acceptedAtMs-previous.acceptedAtMs>4*3600_000)initiated++;
    if(/(?:想你|在乎你|喜欢你|亲爱的|宝贝|miss you|love you|darling)/i.test(source.text))affection++;
    const request=previous?.role==='assistant'&&/(?:愿意|可以.{0,8}吗|能.{0,8}吗|帮我|would you|could you)/i.test(previous.text);
    const playful=previous?.role==='assistant'&&/(?:开玩笑|逗你|玩笑|哈哈|just kidding|teas|jok)/i.test(previous.text);
    if(request)requestResponses++;if(playful)playfulResponses++;
    if(request||playful){
      if(/(?:好呀|当然|愿意|哈哈|喜欢|sure|haha|glad)/i.test(source.text))positiveResponses++;
      if(/(?:不要|不愿意|不喜欢|别这样|不想|stop|don't|do not)/i.test(source.text))negativeResponses++;
    }
  }
  return {userMessages:users.length,days:new Set(users.map(s=>Math.floor(s.acceptedAtMs/86400000))).size,
    observedStartMs:users[0]?.acceptedAtMs??null,observedEndMs:users.at(-1)?.acceptedAtMs??null,
    initiatedAfterGap:initiated,affectionMentions:affection,requestResponses,playfulResponses,positiveResponses,negativeResponses,
    limitation:'有界片段的词面观察，可能含引述/反话；不是用户意图或评分标签，不能单独证明信任亲密依赖'};
}

export class PersonalLearning {
  private readonly db:DatabaseSync;
  readonly weights:PersonalWeightsStore;
  constructor(db:DatabaseSync,weights:PersonalWeightsStore){
    this.db=db;this.weights=weights;
    db.exec(`CREATE TABLE IF NOT EXISTS companion_learning_state(scope_key TEXT PRIMARY KEY,sources TEXT NOT NULL,controls INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS companion_learning_deliveries(scope_key TEXT NOT NULL,id TEXT NOT NULL,PRIMARY KEY(scope_key,id));
      CREATE TABLE IF NOT EXISTS companion_learning_corrections(scope_key TEXT NOT NULL,metric TEXT NOT NULL,source_id TEXT NOT NULL,PRIMARY KEY(scope_key,metric));
      CREATE TABLE IF NOT EXISTS companion_learning_tokens(scope_key TEXT PRIMARY KEY,version INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS companion_learning_jobs(scope_key TEXT NOT NULL,job_key TEXT NOT NULL,
        task_type TEXT NOT NULL,token INTEGER NOT NULL,payload TEXT NOT NULL,
        PRIMARY KEY(scope_key,job_key));`);
  }
  hasPending():boolean {
    return this.db.prepare('SELECT 1 FROM companion_learning_jobs LIMIT 1').get()!==undefined;
  }
  nextJob():LearningJob|undefined {
    const row=this.db.prepare(`SELECT scope_key,job_key,task_type,token,payload FROM companion_learning_jobs
      ORDER BY rowid LIMIT 1`).get() as
      {scope_key:string;job_key:string;task_type:'contact'|'relationship';token:number;payload:string}|undefined;
    return row&&{scopeKey:row.scope_key,jobKey:row.job_key,taskType:row.task_type,token:row.token,payload:row.payload};
  }
  token(key:string):number {
    return (this.db.prepare('SELECT version FROM companion_learning_tokens WHERE scope_key=?').get(key) as
      {version:number}|undefined)?.version??0;
  }
  jobCurrent(job:LearningJob,sourceId?:string,revision?:number):boolean {
    if(this.token(job.scopeKey)!==job.token)return false;
    const row=this.db.prepare('SELECT sources FROM companion_learning_state WHERE scope_key=?').get(job.scopeKey) as
      {sources:string}|undefined;
    if(!row)return false;
    if(!sourceId)return true;
    if(sourceId.startsWith('correction:'))return this.db.prepare(`SELECT 1 FROM companion_learning_corrections
      WHERE scope_key=? AND source_id=?`).get(job.scopeKey,sourceId)!==undefined;
    return (JSON.parse(row.sources) as Array<{id:string;revision:number}>).some(s=>s.id===sourceId&&s.revision===revision);
  }
  finishJob(job:LearningJob):void {
    this.db.prepare('DELETE FROM companion_learning_jobs WHERE scope_key=? AND job_key=? AND token=?')
      .run(job.scopeKey,job.jobKey,job.token);
  }
  private bumpToken(key:string):void {
    this.db.prepare(`INSERT INTO companion_learning_tokens VALUES(?,1) ON CONFLICT(scope_key)
      DO UPDATE SET version=version+1`).run(key);
    this.db.prepare('DELETE FROM companion_learning_jobs WHERE scope_key=?').run(key);
  }
  private queue(key:string,jobKey:string,taskType:'contact'|'relationship',payload:unknown):void {
    this.db.prepare(`INSERT INTO companion_learning_jobs VALUES(?,?,?,?,?) ON CONFLICT(scope_key,job_key)
      DO UPDATE SET token=excluded.token,payload=excluded.payload`)
      .run(key,jobKey,taskType,this.token(key),JSON.stringify(payload));
  }
  key(scope:SceneScope,subjectId:string,characterId:string){return personalScopeKey({...scope,subjectId,characterId});}
  synchronize(key:string,sources:readonly {id:string;revision:number}[],controlsRevision:number,enabled:boolean){
    const previous=this.db.prepare('SELECT sources,controls FROM companion_learning_state WHERE scope_key=?').get(key) as {sources:string;controls:number}|undefined;
    const current=new Map(sources.map(s=>[s.id,s.revision]));
    const revised=previous&&(JSON.parse(previous.sources) as {id:string;revision:number}[]).some(s=>current.get(s.id)!==s.revision);
    // Rebuild, rather than leave deleted context embedded in a learned head.
    if(!enabled||revised||previous&&previous.controls!==controlsRevision){
      this.bumpToken(key);
      this.weights.reset(key);this.db.prepare('DELETE FROM companion_learning_deliveries WHERE scope_key=?').run(key);
    }
    this.db.prepare(`INSERT INTO companion_learning_state VALUES(?,?,?) ON CONFLICT(scope_key) DO UPDATE SET sources=excluded.sources,controls=excluded.controls`)
      .run(key,JSON.stringify(sources.map(s=>({id:s.id,revision:s.revision}))),controlsRevision);
  }
  captureDelivery(key:string,deliveryId:string,traces:LearningTrace[]){
    const relevant=traces.filter(t=>t.questionId==='experience'||t.questionId==='longingExperience');
    if(!relevant.length)return;
    this.weights.capture({scopeKey:key,taskType:'contact',bindingId:deliveryId,traces:relevant});
    this.db.prepare('INSERT OR IGNORE INTO companion_learning_deliveries VALUES(?,?)').run(key,deliveryId);
  }
  synchronizeCorrections(key:string,correction:RelationshipAssessment|null){
    let changed=false;
    for(const metric of Object.keys(GROUPS)){
      const fixed=correction?.metrics[metric as RelationshipMetric];
      const correctionId=fixed?.corrected&&fixed.score!==null?correctionSource(metric,fixed.score,fixed.rationale):null;
      const previous=this.db.prepare('SELECT source_id FROM companion_learning_corrections WHERE scope_key=? AND metric=?').get(key,metric) as {source_id:string}|undefined;
      if(previous&&previous.source_id!==correctionId){
        changed=true;
        this.weights.reconcileSource(key,previous.source_id,null);
        this.db.prepare('DELETE FROM companion_learning_corrections WHERE scope_key=? AND metric=?').run(key,metric);
      }
      if(correctionId&&!previous)changed=true;
      if(correctionId)this.db.prepare('INSERT OR REPLACE INTO companion_learning_corrections VALUES(?,?,?)').run(key,metric,correctionId);
    }
    if(changed){
      this.bumpToken(key);this.weights.reset(key,'relationship');
      const models=this.db.prepare(`SELECT DISTINCT json_extract(trace,'$.modelIdentity') AS model
        FROM companion_personal_samples WHERE scope_key=? AND task_type='contact'`).all(key) as {model:string}[];
      for(const {model} of models)if(model)this.queue(key,`contact:${model}`,'contact',{modelIdentity:model});
    }
  }
  contactFeedback(key:string,sources:readonly SceneSource[],modelIdentity:string){
    const bindings=this.db.prepare('SELECT id FROM companion_learning_deliveries WHERE scope_key=?').all(key) as {id:string}[];
    for(const binding of bindings){
      const index=sources.findIndex(s=>s.id===`proactive:${binding.id}`&&s.role==='assistant');
      if(index<0)continue; // Queued or unknown deliveries are never feedback opportunities.
      const reply=sources[index+1];
      if(!reply||reply.role!=='user')continue;
      const label=explicitContactFeedback(reply.text);if(!label)continue;
      for(const trace of this.weights.captured(key,'contact',binding.id)){
        if(trace.modelIdentity!==modelIdentity||this.weights.hasFeedback(key,'contact',reply.id,reply.revision,trace.questionId))continue;
        if(this.weights.recordFeedback({trace,labelKey:label,sourceId:reply.id,sourceRevision:reply.revision,kind:'explicit'}))
          this.queue(key,`contact:${modelIdentity}`,'contact',{modelIdentity});
      }
    }
  }
  relationship(key:string,input:RelationshipAssessmentInput,raw:unknown,
    correction:RelationshipAssessment|null,assertCurrent:()=>void){
    assertCurrent();
    const extraction=decodeRelationshipEvidence(raw,input);
    this.synchronizeCorrections(key,correction);
    const userSources=input.sources.filter(s=>s.role==='user');
    // Repeated, source-grounded observations are weak supervision, never model scores.
    type Candidate={metric:string;level:number;sourceId:string;revision:number;kind:'explicit'|'behavior';evidence:{quote:string}[];domain:string};
    const candidates=Object.entries(GROUPS).flatMap<Candidate>(([metric,kinds])=>{
      const fixed=correction?.metrics[metric as RelationshipMetric];
      if(fixed?.corrected&&fixed.score!==null){
        return [{metric,level:fixed.score,sourceId:correctionSource(metric,fixed.score,fixed.rationale),revision:1,kind:'explicit' as const,
          evidence:[{quote:fixed.rationale}],domain:'用户明确纠正'}];
      }
      const items=extraction.items.filter(item=>kinds!.includes(item.eventKind)&&item.attribution==='self'&&
        item.polarity==='affirmed'&&item.timeBasis==='current'&&userSources.some(s=>s.id===item.ref.sourceId));
      const domains=new Map<string,typeof items>();for(const item of items)domains.set(item.domain,[...(domains.get(item.domain)??[]),item]);
      return [...domains].flatMap(([domain,group])=>{
        const levels=[...new Set(group.map(item=>kinds!.indexOf(item.eventKind)))];
        if(levels.length!==1||new Set(group.map(i=>i.ref.sourceId)).size<2)return [];
        const latest=group.at(-1)!;
        return [{metric,level:levels[0],sourceId:latest.ref.sourceId,revision:latest.ref.revision,kind:'behavior' as const,
          evidence:group.slice(-3).map(i=>({quote:i.ref.quote})),domain}];
      });
    });
    const pending=candidates.filter(c=>!this.weights.hasFeedback(key,'relationship',c.sourceId,c.revision,`${c.metric}:${c.domain}`));
    if(!pending.length)return;
    for(const candidate of pending){
    const state=JSON.stringify({metric:candidate.metric,domain:candidate.domain,evidence:candidate.evidence,
      observed:interactionBehaviorSummary(input.sources),
      clock:input.auxiliaryContext?.clock,context:'行为频率仅为背景，不单独证明亲密、信任或依赖'});
    if(state.length>1600)continue;
    const payload={requests:[{id:candidate.metric,state,questions:[{
      id:`${candidate.metric}:${candidate.domain}`,type:'choice',question:`所给来源在${candidate.domain}中支持哪一类${candidate.metric}行为？不超出原文推断。`,
      options:Object.fromEntries([['unknown','证据仍不足'],...METRIC_LEVELS[candidate.metric as RelationshipMetric].map((label,index)=>[String(index),label])])}]}]};
    assertCurrent();
    this.queue(key,`relationship:${candidate.metric}:${candidate.domain}:${candidate.sourceId}`,'relationship',
      {request:payload,sourceId:candidate.sourceId,sourceRevision:candidate.revision,
        labelKey:String(candidate.level),kind:candidate.kind});
    }
  }
}

function correctionSource(metric:string,score:number,rationale:string){
  return 'correction:'+createHash('sha256').update(JSON.stringify([metric,score,rationale])).digest('hex').slice(0,20);
}
