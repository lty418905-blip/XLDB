import {createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import type {SceneScope} from '../../../shared/src/scene/types.ts';
import {decodeRelationshipEvidence,projectRelationshipEvidence,RELATIONSHIP_EVALUATION_VERSION,
  RELATIONSHIP_EVIDENCE_PROMPT_HASH,relationshipEventLevel} from './relationship-evidence.ts';
import type {EvidenceProjection,RelationshipEvidenceExtraction,RelationshipEvidenceItem} from './relationship-evidence.ts';
import {relationshipContextFingerprint,type RelationshipAuxiliaryContext} from './relationship-context.ts';
import {DAY_MS,EVENT_METRICS,OUTWARD_LIFETIME_MS,OUTWARD_READY_DELAY_MS,SINCERITY_OPTIONS,auditFlags,auditVerdict,
  confidenceWord,confirmationLevels,confirmedLevel,e1Marker,isDependenceSpike,latestLevel,metricBaseline,nudgeKeyFor,
  planDependenceAudit,sourceRefOf,spanKey,spikeReference,type AuditDriver,type DependenceAuditPlan,type EvidenceSpan,
  type NudgeChannel,type ObservationOrigin,type RelationshipAudit,type RelationshipNudgeUse,type RelationshipObservation,
  type RelationshipTrend,type SincerityKey} from './relationship-audit.ts';

export const RELATIONSHIP_METRICS = [
  'agentToUserIntimacy','userToAgentIntimacy','informationReliability',
  'emotionalDisclosure','taskDelegation','userDependency',
] as const;
export type RelationshipMetric = typeof RELATIONSHIP_METRICS[number];
export type RelationshipContactChoice = 'initiate'|'send'|'wait'|'skip';
export type RelationshipConfidence = 'low'|'medium'|'high';
export interface RelationshipSource {
  id:string;revision:number;text:string;role:'user'|'assistant';acceptedAtMs:number;
}
export interface RelationshipAssessmentInput {
  scope:SceneScope;subjectId:string;characterId:string;sourceVersion:number;controlsRevision:number;
  /** Already accepted, authorized conversation sources for this one companion and real user. */
  sources:readonly RelationshipSource[];
  /** Bounded, authorized OpenHer state description; it is context, not user evidence. */
  openHerSummary?:string;
  /** Current, scope-filtered context for interpretation only. Scores still require a literal source ref. */
  auxiliaryContext?:RelationshipAuxiliaryContext;
  personalParameterVersion?:number;
}
export interface RelationshipEvidence {sourceId:string;revision:number;quote:string}
/** AgentJev's own support probabilities for the candidate levels of one metric, with what produced them. */
export interface RelationshipAgentJevSupport {
  support:Record<string,number>;calibration:string|null;modelIdentity:string|null;parameterVersion:number|null;
}
export interface RelationshipMetricValue {
  score:number|null;confidence:RelationshipConfidence;rationale:string;evidence:RelationshipEvidence[];
  corrected?:boolean;origin?:'evidence_rule'|'agentjev_constrained'|'user_correction';
  domains?:Array<{domain:string;status?:'current'|'historical'|'conflicted';score?:number|null;
    levels:number[];evidence:RelationshipEvidence[];qualifiers?:string[]}>;
  /** Never an input to generation or contact judgments; it only grounds confidence and feedback events. */
  agentJev?:RelationshipAgentJevSupport;
}
export type RelationshipMetrics = Record<RelationshipMetric,RelationshipMetricValue>;
/** A present distance boundary and present care can coexist; one score would erase either fact. */
export function hasOpposingDistanceAndCare(items:readonly {eventKind:string}[]):boolean {
  return items.some(item=>item.eventKind==='distance_boundary')&&
    items.some(item=>item.eventKind==='explicit_care'||item.eventKind==='mutual_closeness');
}
export interface RelationshipAssessment {
  schema:'xldb-relationship-assessment-v2';scope:SceneScope;subjectId:string;characterId:string;
  sourceVersion:number;controlsRevision:number;sourceFingerprint:string;revision:number;
  metrics:RelationshipMetrics;contactChoice:RelationshipContactChoice;contactReason:string;
  corrected:boolean;contactCorrected:boolean;modelCurrent:boolean;
}
export interface RelationshipAssessmentTask extends RelationshipAssessmentInput {
  schema:'xldb-relationship-assessment-v2';sourceFingerprint:string;revision:number;
  prompt:string;
  /** Per-metric history for confirmations and the dependence audit; never part of the host extraction payload. */
  trend?:RelationshipTrend;
}
export interface RelationshipCorrection {
  metrics?:Partial<Record<RelationshipMetric,{score:number|null;note:string}>>;
  contactChoice?:RelationshipContactChoice;
  note?:string;
}
/** The stored correction with the times feedback events need; an old correction without times keeps only its permission. */
export interface RelationshipCorrectionRecord {
  contactChoice?:RelationshipContactChoice;contactCorrectedAtMs?:number;
  /** The assessment revision the contact correction wrote; it keys the one-off invitation seed (invite:<revision>). */
  contactCorrectedRevision?:number;
  metrics:Partial<Record<RelationshipMetric,{score:number|null;previous:number|null;atMs:number|null}>>;
}
interface AssessmentRow {fingerprint:string;revision:number;model:string|null;correction:string|null}
interface StoredCorrection extends RelationshipCorrection {
  semanticsVersion?:string;contactCorrectedAtMs?:number;contactCorrectedRevision?:number;
  metricCorrectedAtMs?:Partial<Record<RelationshipMetric,number>>;previousScores?:Partial<Record<RelationshipMetric,number|null>>;
}

const SCHEMA='xldb-relationship-assessment-v2';
const DECISION_VERSION='relationship-boolean-support-v2';
export const AUDIT_REQUEST_ID='audit:userDependency';
const RETENTION_MS=90*DAY_MS;
type NormalizedInput=RelationshipAssessmentInput&{sourceFingerprint:string};
type Keyed={scope:SceneScope;subjectId:string;characterId:string};

/** One projection per real-user / companion / scene scope. The scene remains the source authority. */
export class RelationshipAssessmentStore {
  private readonly db:DatabaseSync;
  private providerIdentity='unspecified';
  constructor(db:DatabaseSync){
    this.db=db;
    db.exec(`CREATE TABLE IF NOT EXISTS companion_relationship_assessments (
      scope TEXT NOT NULL, subject TEXT NOT NULL, character TEXT NOT NULL,
      fingerprint TEXT NOT NULL, revision INTEGER NOT NULL,
      model TEXT, correction TEXT,
      PRIMARY KEY(scope,subject,character)
    )`);
    // Level changes, dependence audits and outward-line uses. Written only here, in save/correct/recordNudgeUse;
    // rows keep identifiers, flags and probabilities, never quotes.
    db.exec(`CREATE TABLE IF NOT EXISTS companion_relationship_observations (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      scope TEXT NOT NULL, subject TEXT NOT NULL, character TEXT NOT NULL,
      id TEXT NOT NULL, metric TEXT NOT NULL, level INTEGER NOT NULL, c REAL, l_conf INTEGER,
      origin TEXT NOT NULL, evidence_refs TEXT NOT NULL, at_ms INTEGER NOT NULL, assessment_revision INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS companion_relationship_observations_scope
      ON companion_relationship_observations(scope,subject,character,metric,seq);
    CREATE TABLE IF NOT EXISTS companion_relationship_audits (
      scope TEXT NOT NULL, subject TEXT NOT NULL, character TEXT NOT NULL, spike_key TEXT NOT NULL,
      metric TEXT NOT NULL, record TEXT NOT NULL, refs TEXT NOT NULL, decided_at_ms INTEGER NOT NULL,
      PRIMARY KEY(scope,subject,character,spike_key)
    );
    CREATE TABLE IF NOT EXISTS companion_relationship_nudge_uses (
      scope TEXT NOT NULL, subject TEXT NOT NULL, character TEXT NOT NULL, nudge_key TEXT NOT NULL,
      channel TEXT NOT NULL, source_ref TEXT NOT NULL, at_ms INTEGER NOT NULL,
      PRIMARY KEY(scope,subject,character,nudge_key,channel)
    )`);
  }
  setProviderIdentity(identity:string):void {
    if(!identity||identity.length>500)throw new Error('invalid_relationship_provider_identity');
    this.providerIdentity=identity;
  }

  task(input:RelationshipAssessmentInput):RelationshipAssessmentTask|null {
    const {exclusions,...current}=this.normalized(input),row=this.row(current);
    if(row?.fingerprint===current.sourceFingerprint&&row.model)return null;
    return {...current,schema:SCHEMA,revision:row?.revision??0,
      prompt:assessmentPrompt(current),trend:this.trend(current,exclusions)};
  }

  save(task:RelationshipAssessmentTask,output:unknown,currentInput:RelationshipAssessmentInput):RelationshipAssessment {
    const {exclusions,...current}=this.normalized(currentInput);
    if(task.schema!==SCHEMA||task.subjectId!==current.subjectId||task.characterId!==current.characterId||
      scopeKey(task.scope)!==scopeKey(current.scope)||task.sourceFingerprint!==current.sourceFingerprint||
      task.sourceVersion!==current.sourceVersion||task.controlsRevision!==current.controlsRevision)
      throw new Error('context_changed_retry');
    // A trend that moved since the task voids this round's confirmations and audit; it never fails the save.
    const trend=this.trend(current,exclusions),trendValid=JSON.stringify(task.trend??null)===JSON.stringify(trend);
    let decoded=decodeModel(output,current,{exclusions,trend,trendValid});
    const row=this.row(current);
    if(row?.fingerprint===current.sourceFingerprint&&row.model)return this.view(current,row)!;
    if((row?.revision??0)!==task.revision)throw new Error('context_changed_retry');
    const nextRevision=(row?.revision??0)+1;
    const plan=dependenceAuditPlanFor(decoded.projected,current,trend);
    const audit=plan?.kind==='audit'&&trendValid?decodeAuditOutput(output,plan):null;
    return this.transaction(()=>{
      let audited:RelationshipAudit|null=null,skipDependence=false,correctedSpike=false,after:NormalizedInput=current;
      if(plan?.kind==='audit'&&!audit)skipDependence=true; // audited on the next successful evaluation
      else if(plan?.kind==='audit'&&audit){
        audited=this.auditRecord(current,plan,audit);
        if(audited.outcome==='corrected'){
          // Re-project the stored extraction without the misread evidence; the host is not called again.
          // A corrected spike excludes every audited driver (auditRecord), so no sound driver carries it on. Unaudited
          // spans beyond the drivers that still hold the spike level keep it out of the observations.
          decoded=decodeModel(withoutDependenceJudgments(output),current,
            {exclusions:[...new Set([...exclusions,...audited.excludedRefs])].sort(),trend,trendValid,lenient:true});
          correctedSpike=stillSpike(decoded.projected,plan);
        }
        this.writeAudit(current,audited);
        if(audited.outcome==='corrected'){const {exclusions:_,...refreshed}=this.normalized(currentInput);after=refreshed;}
      }else if(plan?.kind==='reuse')this.writeAudit(current,{...this.auditBase(current,plan),outcome:plan.reuse!.outcome,
        origin:'reused',reusedFrom:plan.reuse!.spikeKey});
      const model={...decoded.model,evidenceFingerprint:evidenceFingerprint(current,this.providerIdentity)};
      this.db.prepare(`INSERT INTO companion_relationship_assessments
        (scope,subject,character,fingerprint,revision,model,correction) VALUES(?,?,?,?,?,?,?)
        ON CONFLICT(scope,subject,character) DO UPDATE SET fingerprint=excluded.fingerprint,
        revision=excluded.revision,model=excluded.model`).run(scopeKey(current.scope),current.subjectId,current.characterId,
          after.sourceFingerprint,nextRevision,JSON.stringify(model),row?.correction??null);
      const correctedDependence=audited?.outcome==='corrected';
      for(const metric of RELATIONSHIP_METRICS){
        // A corrected spike level is never observed, even when unaudited spans beyond the four drivers keep it.
        if(metric==='userDependency'&&(skipDependence||correctedSpike))continue;
        const value=decoded.model.metrics[metric];
        if(value.score===null)continue;
        const items=decoded.projected.currentItems[metric]??[];
        const support=metric==='userDependency'&&correctedDependence?undefined:decoded.support[metric];
        // The confirmed level never exceeds the level observed (an ambiguous metric's selection may be lower).
        const confirmed=confirmedLevel(support),lConf=confirmed===null?null:Math.min(confirmed,value.score);
        this.observe(current,{metric,level:value.score,c:support?.[value.score]??null,lConf,
          origin:metric==='userDependency'&&correctedDependence?'audit_corrected':value.origin==='agentjev_constrained'?
            'agentjev_constrained':'evidence_rule',
          evidenceRefs:items.slice(0,8).map(item=>spanOf(item)),atMs:itemsAtMs(items,current.sources),assessmentRevision:nextRevision});
      }
      this.prune(current,latestSourceMs(current.sources));
      return this.view(after,this.row(after)!)!;
    });
  }

  read(input:RelationshipAssessmentInput):RelationshipAssessment|null {
    const {exclusions:_,...current}=this.normalized(input);return this.view(current,this.row(current));
  }

  /**
   * Reuse grounded extraction when only the decision clock/emotion has moved. A stored extraction that no longer
   * decodes is not reusable: `onUnusable` receives its fixed code and the caller extracts afresh, so a damaged cache
   * never fails or degrades the assessment.
   */
  reusableEvidence(input:RelationshipAssessmentInput,onUnusable?:(code:string)=>void):RelationshipEvidenceExtraction|null {
    const {exclusions:_,...current}=this.normalized(input),row=this.row(current);
    if(!row?.model)return null;
    const saved=JSON.parse(row.model);
    if(saved.evidenceFingerprint!==evidenceFingerprint(current,this.providerIdentity))return null;
    try{return decodeRelationshipEvidence(saved.extraction,current);}
    catch(error){
      const message=error instanceof Error?error.message:'';
      onUnusable?.(/^(invalid_relationship_[a-z_]+|relationship_evidence_[a-z_]+)$/.test(message)?message:'invalid_relationship_evidence');
      return null;
    }
  }
  diagnostics(input:RelationshipAssessmentInput):{evaluationVersion:string;sourceFingerprint:string;extraction:RelationshipEvidenceExtraction;
    rawDiagnostics:unknown}|null {
    const {exclusions:_,...current}=this.normalized(input),row=this.row(current);
    if(!row?.model||row.fingerprint!==current.sourceFingerprint)return null;
    const model=JSON.parse(row.model) as StoredModel;
    return {evaluationVersion:`${RELATIONSHIP_EVALUATION_VERSION}+${DECISION_VERSION}`,sourceFingerprint:current.sourceFingerprint,
      extraction:model.extraction,rawDiagnostics:model.rawDiagnostics??null};
  }

  /** Remove obsolete model evidence while preserving explicit user corrections. */
  clearStale(input:RelationshipAssessmentInput):void {
    const {exclusions:_,...current}=this.normalized(input),row=this.row(current);
    if(row?.model&&row.fingerprint!==current.sourceFingerprint)
      this.db.prepare('UPDATE companion_relationship_assessments SET model=NULL,revision=revision+1 WHERE scope=? AND subject=? AND character=?')
        .run(scopeKey(current.scope),current.subjectId,current.characterId);
  }

  /** A binding change or disabled learning also drops the observation, audit and outward-use history of the scope. */
  clearModels(scope:SceneScope):void {
    this.db.prepare('UPDATE companion_relationship_assessments SET model=NULL,revision=revision+1 WHERE scope=? AND model IS NOT NULL')
      .run(scopeKey(scope));
    for(const table of ['companion_relationship_observations','companion_relationship_audits','companion_relationship_nudge_uses'])
      this.db.prepare(`DELETE FROM ${table} WHERE scope=?`).run(scopeKey(scope));
  }

  /** `atMs` is when the user corrected; it defaults to the input clock. */
  correct(input:RelationshipAssessmentInput,correction:RelationshipCorrection,expectedRevision:number,
    atMs?:number):RelationshipAssessment {
    const {exclusions:_,...current}=this.normalized(input),row=this.row(current);
    if(!Number.isSafeInteger(expectedRevision)||expectedRevision<0||(row?.revision??0)!==expectedRevision)
      throw new Error('context_changed_retry');
    const checked=decodeCorrection(correction);
    const at=atMs??current.auxiliaryContext?.clock.nowMs??Date.now();
    if(!Number.isSafeInteger(at)||at<0)throw new Error('invalid_relationship_correction');
    const before=this.view(current,row);
    const observations=this.observationRows(current);
    const previous=row?.correction?JSON.parse(row.correction) as StoredCorrection:{};
    const metricCorrectedAtMs={...previous.metricCorrectedAtMs},previousScores={...previous.previousScores};
    for(const key of Object.keys(checked.metrics??{}) as RelationshipMetric[]){
      metricCorrectedAtMs[key]=at;
      previousScores[key]=before?.metrics[key].score??metricBaseline(observations,key,at);
    }
    const merged:StoredCorrection={...previous,...checked,metrics:{...previous.metrics,...checked.metrics},
      semanticsVersion:RELATIONSHIP_EVALUATION_VERSION,metricCorrectedAtMs,previousScores,
      contactCorrectedAtMs:checked.contactChoice!==undefined?at:undefined};
    const nextRevision=expectedRevision+1;
    merged.contactCorrectedRevision=checked.contactChoice!==undefined?nextRevision:undefined;
    return this.transaction(()=>{
      this.db.prepare(`INSERT INTO companion_relationship_assessments
        (scope,subject,character,fingerprint,revision,model,correction) VALUES(?,?,?,?,?,NULL,?)
        ON CONFLICT(scope,subject,character) DO UPDATE SET revision=excluded.revision,
        correction=excluded.correction,fingerprint=''`).run(scopeKey(current.scope),current.subjectId,current.characterId,
          row?.fingerprint??current.sourceFingerprint,nextRevision,JSON.stringify(merged));
      for(const [key,item] of Object.entries(checked.metrics??{}) as [RelationshipMetric,{score:number|null}][]){
        if(item.score===null)continue;
        // A dependence spike the user set is not her scoring: it is confirmed as it stands, never audited. Only a
        // level change is classified; re-affirming the held or shown level is no spike, however old its rows are.
        const lRef=spikeReference(observations,key,at);
        const held=latestLevel(observations,key)===item.score||before?.metrics[key].score===item.score;
        if(key==='userDependency'&&!held&&isDependenceSpike(item.score,lRef)){
          const spikeKey='spike:'+digest(['correction',lRef,item.score,at]);
          const selfHarm=current.sources.some(source=>source.role==='user'&&source.acceptedAtMs>=at-OUTWARD_READY_DELAY_MS&&
            source.acceptedAtMs<=at&&e1Marker(source.text)==='self_harm');
          this.writeAudit(current,{spikeKey,metric:'userDependency',lRef,lNew:item.score,outcome:'confirmed',origin:'user_correction',
            excludedRefs:[],drivers:[],support:1,calibration:null,decidedAtMs:at,
            nudge:selfHarm?null:{key:nudgeKeyFor(spikeKey),createdAtMs:at,expiresAtMs:at+OUTWARD_LIFETIME_MS}});
        }
        this.observe(current,{metric:key,level:item.score,c:1,lConf:item.score,origin:'user_correction',evidenceRefs:[],
          atMs:at,assessmentRevision:nextRevision});
      }
      this.prune(current,Math.max(at,latestSourceMs(current.sources)));
      return this.view(current,this.row(current)!)!;
    });
  }

  /** Call on source edit/delete, rollback or a new branch when the old projection must disappear. */
  invalidate(scope:SceneScope,subjectId?:string,characterId?:string):number {
    const clauses=['scope=?'],args:(string)[]=[scopeKey(scope)];
    if(subjectId!==undefined){clauses.push('subject=?');args.push(id(subjectId));}
    if(characterId!==undefined){clauses.push('character=?');args.push(id(characterId));}
    return Number(this.db.prepare(`DELETE FROM companion_relationship_assessments WHERE ${clauses.join(' AND ')}`).run(...args).changes);
  }

  /**
   * Level changes, oldest first. `live` is the current source id@revision set; without it only a revision change
   * visible in this input's window drops a row. Rows older than 90 days are pruned on the next save or correction,
   * except the newest row of each metric.
   */
  observations(input:RelationshipAssessmentInput,live?:Iterable<string>):RelationshipObservation[] {
    const {exclusions:_,...current}=this.normalized(input);return this.observationRows(current,liveSet(live));
  }
  audits(input:RelationshipAssessmentInput,live?:Iterable<string>):RelationshipAudit[] {
    const {exclusions:_,...current}=this.normalized(input);return this.auditRows(current,liveSet(live));
  }
  nudgeUses(input:RelationshipAssessmentInput,live?:Iterable<string>):RelationshipNudgeUse[] {
    const {exclusions:_,...current}=this.normalized(input);return this.nudgeUseRows(current,liveSet(live));
  }
  /** The stored correction with its times and previous scores, for contactFeedbackEvents. */
  corrections(input:RelationshipAssessmentInput):RelationshipCorrectionRecord|null {
    const {exclusions:_,...current}=this.normalized(input),row=this.row(current);
    if(!row?.correction)return null;
    const stored=JSON.parse(row.correction) as StoredCorrection;
    const metrics:RelationshipCorrectionRecord['metrics']={};
    for(const [key,item] of Object.entries(stored.metrics??{}) as [RelationshipMetric,{score:number|null}][])
      metrics[key]={score:item.score,previous:stored.previousScores?.[key]??null,atMs:stored.metricCorrectedAtMs?.[key]??null};
    return {...(stored.contactChoice?{contactChoice:stored.contactChoice}:{}),
      ...(stored.contactChoice&&stored.contactCorrectedAtMs!==undefined?{contactCorrectedAtMs:stored.contactCorrectedAtMs}:{}),
      ...(stored.contactChoice&&stored.contactCorrectedRevision!==undefined?{contactCorrectedRevision:stored.contactCorrectedRevision}:{}),
      metrics};
  }
  /**
   * Record that an outward line was carried (reply), answered warmly (responded) or read as pushing away (rejected).
   * Idempotent; a reply use moves to a newer source only when its earlier reply was never kept. The key must name a
   * confirmed audit of this scope.
   */
  recordNudgeUse(input:RelationshipAssessmentInput,nudgeKey:string,channel:NudgeChannel,sourceRef:string,atMs:number):boolean {
    const {exclusions:_,...current}=this.normalized(input);
    if(channel!=='reply'&&channel!=='responded'&&channel!=='rejected'||typeof sourceRef!=='string'||
      !/^[^@]{1,200}@\d+$/.test(sourceRef)||!Number.isSafeInteger(atMs)||atMs<0)throw new Error('invalid_relationship_nudge_use');
    if(!this.auditRows(current).some(audit=>audit.outcome==='confirmed'&&audit.nudge?.key===nudgeKey))
      throw new Error('invalid_relationship_nudge');
    const args=[scopeKey(current.scope),current.subjectId,current.characterId,nudgeKey,channel,sourceRef,atMs] as const;
    if(channel==='reply'){
      const existing=this.db.prepare(`SELECT source_ref,at_ms FROM companion_relationship_nudge_uses
        WHERE scope=? AND subject=? AND character=? AND nudge_key=? AND channel='reply'`)
        .get(...args.slice(0,4)) as {source_ref:string;at_ms:number}|undefined;
      if(existing){
        if(existing.source_ref===sourceRef||existing.at_ms>=atMs)return false;
        // A reply kept after its user source (an accepted assistant source follows it) stays the use.
        const trigger=current.sources.find(source=>sourceRefOf({sourceId:source.id,revision:source.revision})===existing.source_ref);
        if(trigger&&current.sources.some(source=>source.role==='assistant'&&source.acceptedAtMs>trigger.acceptedAtMs))return false;
        return Number(this.db.prepare(`UPDATE companion_relationship_nudge_uses SET source_ref=?,at_ms=?
          WHERE scope=? AND subject=? AND character=? AND nudge_key=? AND channel='reply'`)
          .run(sourceRef,atMs,...args.slice(0,4)).changes)>0;
      }
    }
    return Number(this.db.prepare('INSERT OR IGNORE INTO companion_relationship_nudge_uses VALUES(?,?,?,?,?,?,?)')
      .run(...args).changes)>0;
  }

  private normalized(input:RelationshipAssessmentInput):NormalizedInput&{exclusions:string[]} {
    const first=normalize(input,this.providerIdentity,[]);
    // Misread dependence spans from corrected audits change what the evaluation means, so they enter the fingerprint.
    const exclusions=[...new Set(this.auditRows(first).flatMap(audit=>audit.outcome==='corrected'?audit.excludedRefs:[]))].sort();
    return {...(exclusions.length?normalize(input,this.providerIdentity,exclusions):first),exclusions};
  }
  private trend(input:NormalizedInput,exclusions:string[]):RelationshipTrend {
    return {observations:this.observationRows(input).filter(row=>(EVENT_METRICS as readonly string[]).includes(row.metric))
      .map(row=>({metric:row.metric,level:row.level,atMs:row.atMs,seq:row.seq})),
      audits:this.auditRows(input).map(audit=>({spikeKey:audit.spikeKey,metric:audit.metric,outcome:audit.outcome,
        decidedAtMs:audit.decidedAtMs})),exclusions};
  }
  private observationRows(input:Keyed&{sources:readonly RelationshipSource[]},live?:ReadonlySet<string>):RelationshipObservation[] {
    const rows=this.db.prepare(`SELECT seq,id,metric,level,c,l_conf,origin,evidence_refs,at_ms,assessment_revision
      FROM companion_relationship_observations WHERE scope=? AND subject=? AND character=? ORDER BY seq`)
      .all(scopeKey(input.scope),input.subjectId,input.characterId) as unknown as {seq:number;id:string;metric:RelationshipMetric;
        level:number;c:number|null;l_conf:number|null;origin:ObservationOrigin;evidence_refs:string;at_ms:number;assessment_revision:number}[];
    return rows.map(row=>({id:row.id,seq:row.seq,metric:row.metric,level:row.level,c:row.c,lConf:row.l_conf,origin:row.origin,
      evidenceRefs:JSON.parse(row.evidence_refs) as EvidenceSpan[],atMs:row.at_ms,assessmentRevision:row.assessment_revision}))
      .filter(row=>refsLive(row.evidenceRefs.map(sourceRefOf),input.sources,live));
  }
  private auditRows(input:Keyed&{sources:readonly RelationshipSource[]},live?:ReadonlySet<string>):RelationshipAudit[] {
    const rows=this.db.prepare(`SELECT record,refs FROM companion_relationship_audits WHERE scope=? AND subject=? AND character=?
      ORDER BY decided_at_ms,spike_key`).all(scopeKey(input.scope),input.subjectId,input.characterId) as unknown as {record:string;refs:string}[];
    return rows.filter(row=>refsLive(JSON.parse(row.refs) as string[],input.sources,live))
      .map(row=>JSON.parse(row.record) as RelationshipAudit);
  }
  private nudgeUseRows(input:Keyed&{sources:readonly RelationshipSource[]},live?:ReadonlySet<string>):RelationshipNudgeUse[] {
    const rows=this.db.prepare(`SELECT nudge_key,channel,source_ref,at_ms FROM companion_relationship_nudge_uses
      WHERE scope=? AND subject=? AND character=? ORDER BY at_ms,nudge_key,channel`)
      .all(scopeKey(input.scope),input.subjectId,input.characterId) as unknown as {nudge_key:string;channel:NudgeChannel;source_ref:string;at_ms:number}[];
    return rows.filter(row=>refsLive([row.source_ref],input.sources,live))
      .map(row=>({nudgeKey:row.nudge_key,channel:row.channel,sourceRef:row.source_ref,atMs:row.at_ms}));
  }
  /** Writes a row only when the metric's level differs from its latest live row. */
  private observe(input:NormalizedInput,row:Omit<RelationshipObservation,'id'|'seq'>):void {
    if(this.observationRows(input).filter(item=>item.metric===row.metric).at(-1)?.level===row.level)return;
    this.db.prepare(`INSERT INTO companion_relationship_observations
      (scope,subject,character,id,metric,level,c,l_conf,origin,evidence_refs,at_ms,assessment_revision) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(scopeKey(input.scope),input.subjectId,input.characterId,
        'observation:'+digest([scopeKey(input.scope),input.subjectId,input.characterId,row.metric,row.level,row.atMs,
          row.assessmentRevision,row.origin]),
        row.metric,row.level,row.c,row.lConf,row.origin,JSON.stringify(row.evidenceRefs),row.atMs,row.assessmentRevision);
  }
  private auditBase(input:NormalizedInput,plan:DependenceAuditPlan):Omit<RelationshipAudit,'outcome'|'origin'> {
    const texts=new Map(input.sources.map(source=>[sourceRefOf({sourceId:source.id,revision:source.revision}),source.text]));
    return {spikeKey:plan.spikeKey,metric:'userDependency',lRef:plan.lRef,lNew:plan.lNew,excludedRefs:[],
      drivers:plan.drivers.map(item=>({ref:spanKey(item.ref),...item.ref,
        flags:auditFlags(texts.get(sourceRefOf(item.ref))??'',item.ref.start,item.ref.end),sincerity:null,misread:false})),
      support:null,calibration:null,decidedAtMs:plan.decidedAtMs,nudge:null};
  }
  private auditRecord(input:NormalizedInput,plan:DependenceAuditPlan,audit:AuditOutput):RelationshipAudit {
    const base=this.auditBase(input,plan);
    const drivers:AuditDriver[]=base.drivers.slice(0,audit.sincerity.length)
      .map((driver,index)=>({...driver,sincerity:audit.sincerity[index]}));
    const verdict=auditVerdict({drivers:drivers.map(driver=>({flags:driver.flags,sincerity:driver.sincerity!})),support:audit.support});
    drivers.forEach((driver,index)=>{driver.misread=verdict.misread[index];});
    // A spike the re-evaluation does not support (below 0.5), or one with no misread span, has no sound reading to
    // keep: every audited span goes. Otherwise only the misread spans go.
    const excludedRefs=verdict.outcome!=='corrected'?[]:audit.support>=0.5&&drivers.some(driver=>driver.misread)?
      drivers.filter(driver=>driver.misread).map(driver=>driver.ref):drivers.map(driver=>driver.ref);
    const decided=plan.decidedAtMs,driverRefs=new Set(drivers.map(driver=>sourceRefOf(driver)));
    const selfHarm=input.sources.some(source=>source.role==='user'&&e1Marker(source.text)==='self_harm'&&
      (driverRefs.has(sourceRefOf({sourceId:source.id,revision:source.revision}))||
        source.acceptedAtMs>=decided-OUTWARD_READY_DELAY_MS&&source.acceptedAtMs<=decided));
    return {...base,drivers,outcome:verdict.outcome,origin:'audit',excludedRefs,support:audit.support,calibration:audit.calibration,
      nudge:verdict.outcome==='confirmed'&&!selfHarm?{key:nudgeKeyFor(plan.spikeKey),createdAtMs:decided,
        expiresAtMs:decided+OUTWARD_LIFETIME_MS}:null};
  }
  private writeAudit(input:NormalizedInput,audit:RelationshipAudit):void {
    const refs=[...new Set(audit.drivers.map(driver=>sourceRefOf(driver)))];
    this.db.prepare(`INSERT OR IGNORE INTO companion_relationship_audits(scope,subject,character,spike_key,metric,record,refs,decided_at_ms)
      VALUES(?,?,?,?,?,?,?,?)`).run(scopeKey(input.scope),input.subjectId,input.characterId,audit.spikeKey,audit.metric,
        JSON.stringify(audit),JSON.stringify(refs),audit.decidedAtMs);
  }
  private prune(input:NormalizedInput,referenceMs:number):void {
    const cutoff=referenceMs-RETENTION_MS,key=[scopeKey(input.scope),input.subjectId,input.characterId,cutoff] as const;
    // The newest row of each metric stays: it is the held level, so the prune never turns a stable level into no history.
    this.db.prepare(`DELETE FROM companion_relationship_observations WHERE scope=? AND subject=? AND character=? AND at_ms<?
      AND seq NOT IN (SELECT MAX(seq) FROM companion_relationship_observations WHERE scope=? AND subject=? AND character=?
        GROUP BY metric)`).run(...key,...key.slice(0,3));
    this.db.prepare('DELETE FROM companion_relationship_audits WHERE scope=? AND subject=? AND character=? AND decided_at_ms<?').run(...key);
    // A rejection is kept past 90 days: once read as pushing away, the longing is never raised again in this scope
    // (PLAN §12.1 point 4). Deleting or revising that message still voids it on read; clearModels drops it.
    this.db.prepare(`DELETE FROM companion_relationship_nudge_uses WHERE scope=? AND subject=? AND character=? AND at_ms<?
      AND channel<>'rejected'`).run(...key);
  }
  /** A savepoint, so the assessment, observation and audit writes commit together inside or outside a caller's transaction. */
  private transaction<T>(work:()=>T):T {
    this.db.exec('SAVEPOINT relationship_assessment');
    try{const result=work();this.db.exec('RELEASE relationship_assessment');return result;}
    catch(error){this.db.exec('ROLLBACK TO relationship_assessment');this.db.exec('RELEASE relationship_assessment');throw error;}
  }

  private row(input:Keyed):AssessmentRow|undefined {
    return this.db.prepare(`SELECT fingerprint,revision,model,correction FROM companion_relationship_assessments
      WHERE scope=? AND subject=? AND character=?`).get(scopeKey(input.scope),input.subjectId,input.characterId) as AssessmentRow|undefined;
  }

  private view(input:NormalizedInput,row:AssessmentRow|undefined):RelationshipAssessment|null {
    if(!row)return null;
    const modelCurrent=row.fingerprint===input.sourceFingerprint&&!!row.model;
    const correction=row.correction?JSON.parse(row.correction) as RelationshipCorrection:null;
    if(!modelCurrent&&!correction)return null;
    const model=modelCurrent?JSON.parse(row.model!) as StoredModel:null;
    const metrics=unknownMetrics();
    for(const key of RELATIONSHIP_METRICS){
      if(model)metrics[key]=model.metrics[key];
      const override=correction?.metrics?.[key];
      if(override)metrics[key]={score:override.score,confidence:'high',rationale:override.note,evidence:[],corrected:true,origin:'user_correction'};
    }
    return {schema:SCHEMA,scope:input.scope,subjectId:input.subjectId,characterId:input.characterId,
      sourceVersion:input.sourceVersion,controlsRevision:input.controlsRevision,sourceFingerprint:input.sourceFingerprint,
      revision:row.revision,metrics,contactChoice:correction?.contactChoice??model?.contactChoice??'wait',
      contactReason:correction?.note??model?.contactReason??'当前来源不足，等待更多互动。',
      corrected:!!correction,contactCorrected:correction?.contactChoice!==undefined,modelCurrent};
  }
}

/** Confirmation requests: an event metric whose rule level moved from its 30-day baseline, when not already ambiguous. */
export function relationshipConfirmationPlan(projection:EvidenceProjection,input:RelationshipAssessmentInput,
  trend:RelationshipTrend):{metric:RelationshipMetric;levels:number[];items:RelationshipEvidenceItem[]}[] {
  return EVENT_METRICS.flatMap(metric=>{
    const level=projection.metrics[metric].score,items=projection.currentItems[metric]??[];
    if(projection.ambiguous[metric]||level===null||!items.length)return [];
    const levels=confirmationLevels(metricBaseline(trend.observations,metric,itemsAtMs(items,input.sources)),level);
    return levels.length?[{metric,levels,items}]:[];
  });
}
/** The dependence spike of this projection, if any; an ambiguous level is judged at its highest candidate. */
export function dependenceAuditPlanFor(projection:EvidenceProjection,input:RelationshipAssessmentInput,
  trend:RelationshipTrend):DependenceAuditPlan|null {
  const times=new Map(input.sources.map(source=>[sourceRefOf({sourceId:source.id,revision:source.revision}),source.acceptedAtMs]));
  const items=(projection.currentItems.userDependency??[]).map(item=>({ref:spanOf(item),level:relationshipEventLevel(item.eventKind),
    acceptedAtMs:times.get(sourceRefOf(item.ref))??0}));
  const ambiguity=projection.ambiguous.userDependency;
  const level=projection.metrics.userDependency.score??(ambiguity?Math.max(...ambiguity.levels):null);
  return planDependenceAudit({items,level,trend});
}
/** Whether a re-projected dependence level is still the audited spike against its L_ref. */
function stillSpike(projection:EvidenceProjection,plan:DependenceAuditPlan):boolean {
  const ambiguity=projection.ambiguous.userDependency;
  const level=projection.metrics.userDependency.score??(ambiguity?Math.max(...ambiguity.levels):null);
  return level!==null&&isDependenceSpike(level,plan.lRef);
}
/** The empty history of a scope that has never been assessed. */
export const EMPTY_RELATIONSHIP_TREND:RelationshipTrend={observations:[],audits:[],exclusions:[]};

/** Expression preferences, not score-derived permissions or prohibited phrases. */
export function relationshipExpression(value:RelationshipAssessment|null,purpose:'reply'|'proactive') {
  if(!value)return [];
  const guidance:Record<RelationshipMetric,readonly string[]>={
    agentToUserIntimacy:['角色此时倾向保留距离，表达可克制而清楚','角色目前表达较含蓄，可用礼貌和轻关心','可流露个人化的友善和关注','可自然表达关心、想念和情绪','可结合共同经历表达熟悉与持续亲近'],
    userToAgentIntimacy:['用户有疏远信号，可先回应当下需要并留空间','用户接受的亲近较有限，可从轻松自然的交流开始','用户表达友善，可适度呼应亲昵与玩笑','用户表达关心，可更温暖地回应并分享角色感受','用户表达持续亲近，可沿用双方喜欢的称呼与默契'],
    informationReliability:['在这个信息领域可多解释依据并邀请核对','在这个信息领域可主动说明不确定处','在这个信息领域可给简明结论并保留核对路径','在这个信息领域可接续已建立的理解，减少重复铺垫','在这个信息领域可熟悉直接地交流，重要新事实仍说明依据'],
    emotionalDisclosure:['用户当前不愿多谈感受，可给空间并回应其选的话题','可先轻声回应感受，追问尺度随用户反应调整','可针对具体感受回应，适度问一个贴近当下的问题','可多倾听和共情，顺着用户主动分享的深度回应','可结合共同经历细致回应，避免机械重复安慰'],
    taskDelegation:['在这个任务领域可先提供选择，让用户决定如何做','在这个任务领域可把步骤讲清并配合逐步确认','在这个任务领域可围绕已授权范围直接协助','在这个任务领域可减少重复介绍，按已约定方式协作','在这个任务领域可用熟悉的协作语气汇报进展'],
    userDependency:['用户表现出独立应对倾向，可提供可选帮助并肯定其决定','陪伴是用户可选的支持，可自然回应而不假定需要介入','用户习惯来寻求支持，可先接住其诉求并共同梳理','用户缺少支持时较难应对，可更稳定耐心地陪其理清下一步','用户报告应对受到依赖影响，可更细致回应具体困难，并结合其意愿支持生活中的行动'],
  };
  return RELATIONSHIP_METRICS.flatMap(metric=>{
    if(purpose==='proactive'&&metric==='userDependency')return [];
    const item=value.metrics[metric];
    // User corrections are authoritative; stale model values cannot guide speech.
    if(!value.modelCurrent&&!item.corrected)return [];
    const candidates=item.corrected||!item.domains?.length
      ?item.score===null?[]:[{domain:'当前适用范围',score:item.score}]
      :item.domains.flatMap(domain=>{
        if(domain.status!=='current')return [];
        const score=domain.score===undefined?(domain.levels.length===1?domain.levels[0]:null):domain.score;
        return score===null?[]:[{domain:domain.domain,score}];
      });
    return candidates.slice(0,3).map(({domain,score})=>({metric,domain,score,
      suggestion:guidance[metric][score],basis:item.corrected?'用户纠正':'有来源的关系线索'}));
  });
}

export function formatRelationshipGuidance(value:RelationshipAssessment|null,purpose:'reply'|'proactive'):string {
  if(!value)return '';
  const keys=RELATIONSHIP_METRICS.filter(key=>purpose!=='proactive'||key!=='userDependency');
  const known=keys.filter(key=>value.metrics[key].score!==null||value.metrics[key].domains?.length).map(key=>{
    const item=value.metrics[key];
    const domainText=(item.domains??[]).slice(0,3).map(domain=>{
      const quote=domain.evidence[0]?.quote.slice(0,60),qualifier=domain.qualifiers?.filter(Boolean).slice(0,2).join('、');
      const timing=domain.status==='historical'?'（仅历史，不代表当前）':domain.status==='conflicted'?'（当前有冲突，暂不定档）':'';
      return `${domain.domain}${timing}${quote?`「${quote}」`:''}${qualifier?`（${qualifier}）`:''}`;
    }).join('；');
    return `${key}：${item.score===null?'不同证据暂不合并':`${item.score}/4（${item.origin??'evidence_rule'}）`}`+
      `${domainText?`，领域依据 ${domainText}`:''}`;
  });
  const caveat='这些只是有来源的互动线索；明确意愿、边界和联系设置优先。';
  const relationship=known.length?`当前关系参考：${known.join('；')}。`:'关系证据不足。';
  const expression=relationshipExpression(value,purpose);
  const style=expression.length?`话术倾向（不是固定台词、禁词或硬限制；结合人设、当前情绪、用户偏好和语境灵活选择）：${JSON.stringify(expression)}。关系分数不改变明确授权与承诺，不向用户播报评分。`:'';
  const lowBoundary=expression.some(item=>(item.metric==='userToAgentIntimacy'||item.metric==='userDependency')&&item.score<=1)
    ?'负面提示：当前有明确低亲密或低依赖依据，避免向用户索取情感回应、承诺或关注，避免排他与占有式表达。':'';
  if(purpose==='reply')return `${relationship}${caveat}${style}${lowBoundary}按证据限定语自然回应，不把推断当作用户自述。`;
  const choice=value.contactChoice;
  return `${relationship}${style}${lowBoundary}主动联系建议：${choice}；${value.contactReason}。${caveat}拿不准时等待或跳过。`;
}

function assessmentPrompt(input:NormalizedInput):string {
  return `关系证据任务 ${SCHEMA}；先用 relationshipEvidence 宿主阶段提取可验证行为命题。此 prompt 只用于可追溯任务说明；来源指纹 ${input.sourceFingerprint}。`;
}

type DecodeContext={exclusions:readonly string[];trend:RelationshipTrend;trendValid:boolean;
  /** After a corrected audit: judgments of a metric the exclusion made unambiguous are dropped, not rejected. */
  lenient?:boolean};
type StoredModel={metrics:RelationshipMetrics;contactChoice:'wait';contactReason:string;extraction:RelationshipEvidenceExtraction;
  rawDiagnostics?:unknown;evidenceFingerprint?:string};
function decodeModel(raw:unknown,input:NormalizedInput,context:DecodeContext):{model:StoredModel;projected:EvidenceProjection;
  support:Partial<Record<RelationshipMetric,Record<string,number>>>} {
  let value:unknown=raw;
  if(typeof value==='string'){try{value=JSON.parse(value);}catch{throw new Error('invalid_relationship_assessment');}}
  if(!record(value)||value.schema!==SCHEMA||!record(value.extraction))throw new Error('invalid_relationship_assessment');
  const extraction=decodeRelationshipEvidence(value.extraction,input,{allowLegacy:false}) as RelationshipEvidenceExtraction;
  const projected=projectRelationshipEvidence(extraction,input,{exclusions:context.exclusions}),metrics=projected.metrics;
  if(value.selections!==undefined){
    if(!record(value.selections))throw new Error('invalid_relationship_selection');
    for(const [key,selected] of Object.entries(value.selections)){
      const ambiguity=projected.ambiguous[key as RelationshipMetric];
      if(!ambiguity&&context.lenient)continue;
      if(!ambiguity||!Number.isInteger(selected)||!ambiguity.levels.includes(selected as number))
        throw new Error('invalid_relationship_selection');
      if(hasOpposingDistanceAndCare(ambiguity.items))throw new Error('invalid_relationship_selection');
      const domain=ambiguity.items[0]?.domain;
      const domains=metrics[key as RelationshipMetric].domains?.map(item=>
        item.domain===domain&&item.status==='current'?{...item,score:selected as number}:item);
      if(!domain||domains?.filter(item=>item.domain===domain&&item.status==='current'&&
        item.score===selected).length!==1)throw new Error('invalid_relationship_selection');
      const evidence=ambiguity.items.slice(0,5).map(item=>({sourceId:item.ref.sourceId,revision:item.ref.revision,quote:item.ref.quote}));
      metrics[key as RelationshipMetric]={...metrics[key as RelationshipMetric],score:selected as number,evidence,domains,
        origin:'agentjev_constrained',rationale:'同一行为片段的多个有依据解释经本地模型约束排序'};
    }
  }
  // AgentJev's support for candidate levels: the ambiguous levels, or the confirmation levels of a moved event metric.
  const support:Partial<Record<RelationshipMetric,Record<string,number>>>={};
  if(value.support!==undefined){
    if(!record(value.support))throw new Error('invalid_relationship_support');
    const confirmations=new Map(relationshipConfirmationPlan(projected,input,context.trend).map(plan=>[plan.metric,plan.levels]));
    for(const [key,entry] of Object.entries(value.support)){
      if(!RELATIONSHIP_METRICS.includes(key as RelationshipMetric)||!record(entry)||!record(entry.support))
        throw new Error('invalid_relationship_support');
      const metric=key as RelationshipMetric,ambiguity=projected.ambiguous[metric];
      // Confirmations asked against a trend that has since moved are void for this round.
      if(!ambiguity&&!context.trendValid)continue;
      const candidates=ambiguity?.levels??confirmations.get(metric);
      if(!candidates){if(context.lenient)continue;throw new Error('invalid_relationship_support');}
      const levels=Object.entries(entry.support);
      if(!levels.length||levels.some(([level,p])=>!candidates.includes(Number(level))||String(Number(level))!==level||
        typeof p!=='number'||!Number.isFinite(p)||p<0||p>1))throw new Error('invalid_relationship_support');
      support[metric]=Object.fromEntries(levels) as Record<string,number>;
    }
  }
  const calibration=optionalText(value.calibration,100),modelIdentity=optionalText(value.modelIdentity,500);
  if(value.parameterVersion!==undefined&&!revision(value.parameterVersion))throw new Error('invalid_relationship_support');
  const parameterVersion=value.parameterVersion===undefined?null:value.parameterVersion as number;
  for(const [key,levels] of Object.entries(support) as [RelationshipMetric,Record<string,number>][]){
    const score=metrics[key].score;
    metrics[key]={...metrics[key],confidence:confidenceWord(score===null?null:levels[String(score)]),
      agentJev:{support:levels,calibration,modelIdentity,parameterVersion}};
  }
  if(value.rawDiagnostics!==undefined&&JSON.stringify(value.rawDiagnostics).length>50_000)
    throw new Error('invalid_relationship_diagnostics');
  return {model:{metrics,contactChoice:'wait' as const,contactReason:'关系证据本身不授权主动联系',
    extraction,rawDiagnostics:value.rawDiagnostics},projected,support};
}

type AuditOutput={sincerity:Record<SincerityKey,number>[];support:number;calibration:string|null};
/**
 * The audit request's answers for this exact spike. A different spike key (the trend moved) yields null and the audit
 * waits for the next evaluation; a malformed answer for the right key is rejected.
 */
function decodeAuditOutput(raw:unknown,plan:DependenceAuditPlan):AuditOutput|null {
  let value:unknown=raw;
  if(typeof value==='string'){try{value=JSON.parse(value);}catch{return null;}}
  if(!record(value)||value.audit===undefined)return null;
  const audit=value.audit;
  if(!record(audit)||typeof audit.spikeKey!=='string')throw new Error('invalid_relationship_audit');
  if(audit.spikeKey!==plan.spikeKey)return null;
  const keys=Object.keys(SINCERITY_OPTIONS) as SincerityKey[];
  if(!Array.isArray(audit.drivers)||!audit.drivers.length||audit.drivers.length>plan.drivers.length||
    typeof audit.support!=='number'||!Number.isFinite(audit.support)||audit.support<0||audit.support>1)
    throw new Error('invalid_relationship_audit');
  const sincerity=audit.drivers.map((driver:unknown,index:number)=>{
    if(!record(driver)||driver.ref!==spanKey(plan.drivers[index].ref)||!record(driver.sincerity)||
      Object.keys(driver.sincerity).length!==keys.length||keys.some(key=>typeof driver.sincerity[key]!=='number'||
        !Number.isFinite(driver.sincerity[key])||driver.sincerity[key]<0||driver.sincerity[key]>1))
      throw new Error('invalid_relationship_audit');
    return Object.fromEntries(keys.map(key=>[key,driver.sincerity[key] as number])) as Record<SincerityKey,number>;
  });
  return {sincerity,support:audit.support,calibration:optionalText(value.calibration,100)};
}
/** The same output with its dependence judgments removed, for the re-projection after a corrected audit. */
function withoutDependenceJudgments(raw:unknown):unknown {
  let value:unknown=raw;
  if(typeof value==='string'){try{value=JSON.parse(value);}catch{return raw;}}
  if(!record(value))return raw;
  const strip=(entry:unknown)=>record(entry)?Object.fromEntries(Object.entries(entry).filter(([key])=>key!=='userDependency')):entry;
  return {...value,selections:strip(value.selections),support:strip(value.support)};
}

function decodeCorrection(input:RelationshipCorrection):RelationshipCorrection {
  if(!record(input))throw new Error('invalid_relationship_correction');
  const metrics:RelationshipCorrection['metrics']={};
  if(input.metrics!==undefined){
    if(!record(input.metrics))throw new Error('invalid_relationship_correction');
    for(const [key,item] of Object.entries(input.metrics)){
      if(!RELATIONSHIP_METRICS.includes(key as RelationshipMetric)||!record(item))throw new Error('invalid_relationship_correction');
      if(item.score!==null&&(!Number.isInteger(item.score)||Number(item.score)<0||Number(item.score)>4))throw new Error('invalid_relationship_correction');
      metrics[key as RelationshipMetric]={score:item.score as number|null,note:bounded(item.note,300,false)};
    }
  }
  const contactChoice=input.contactChoice===undefined?undefined:choice(input.contactChoice);
  const note=input.note===undefined?undefined:bounded(input.note,240,false);
  if(!Object.keys(metrics).length&&contactChoice===undefined&&note===undefined)throw new Error('invalid_relationship_correction');
  return {metrics,contactChoice,note};
}

function normalize(input:RelationshipAssessmentInput,providerIdentity:string,auditExclusions:readonly string[]):NormalizedInput {
  if(!record(input)||!record(input.scope)||!Array.isArray(input.sources))throw new Error('invalid_relationship_input');
  const scope={worldId:id(input.scope.worldId),sessionId:id(input.scope.sessionId),branchId:id(input.scope.branchId),characterId:id(input.scope.characterId)};
  const subjectId=id(input.subjectId),characterId=id(input.characterId);
  if(!revision(input.sourceVersion)||!revision(input.controlsRevision)||input.sources.length>24)
    throw new Error('invalid_relationship_input');
  const seen=new Set<string>();
  const sources=input.sources.map(source=>{
    if(!record(source)||source.role!=='user'&&source.role!=='assistant'||!revision(source.revision)||!Number.isSafeInteger(source.acceptedAtMs)||source.acceptedAtMs<0)
      throw new Error('invalid_relationship_source');
    const idValue=id(source.id),textValue=bounded(source.text,20000,false);
    if(seen.has(idValue))throw new Error('duplicate_relationship_source');seen.add(idValue);
    return {id:idValue,revision:source.revision,text:textValue,role:source.role,acceptedAtMs:source.acceptedAtMs};
  });
  const openHerSummary=input.openHerSummary===undefined?undefined:bounded(input.openHerSummary,1000,true);
  const auxiliaryContext=input.auxiliaryContext;
  if(auxiliaryContext&&(typeof auxiliaryContext!=='object'||!Number.isSafeInteger(auxiliaryContext.clock?.nowMs)||
    auxiliaryContext.clock.nowMs<0||JSON.stringify(auxiliaryContext).length>4000))throw new Error('invalid_relationship_context');
  const normalized={scope,subjectId,characterId,sourceVersion:input.sourceVersion,controlsRevision:input.controlsRevision,
    sources,openHerSummary,auxiliaryContext,personalParameterVersion:input.personalParameterVersion??0};
  return {...normalized,sourceFingerprint:createHash('sha256').update(JSON.stringify({version:RELATIONSHIP_EVALUATION_VERSION,
    decisionVersion:DECISION_VERSION,
    prompt:RELATIONSHIP_EVIDENCE_PROMPT_HASH,
    providerIdentity,...normalized,auxiliaryContext:relationshipContextFingerprint(auxiliaryContext),
    ...(auditExclusions.length?{auditExclusions}:{})})).digest('hex')};
}

function evidenceFingerprint(input:NormalizedInput,providerIdentity:string):string {
  const auxiliary=input.auxiliaryContext;
  return createHash('sha256').update(JSON.stringify({prompt:RELATIONSHIP_EVIDENCE_PROMPT_HASH,providerIdentity,
    scope:input.scope,subjectId:input.subjectId,characterId:input.characterId,controlsRevision:input.controlsRevision,sources:input.sources,
    // Clock and OpenHer changes affect current evaluation, not what the same
    // accepted words said. Revised contextual facts still require extraction.
    context:auxiliary?{timeZone:auxiliary.clock.timeZone,profileFacts:auxiliary.profileFacts,commitments:auxiliary.commitments,
      waitingSources:auxiliary.waiting?.sourceRefs??[],excluded:auxiliary.excluded}:null})).digest('hex');
}

function unknownMetrics():RelationshipMetrics {
  return Object.fromEntries(RELATIONSHIP_METRICS.map(key=>[key,{score:null,confidence:'low',rationale:'证据不足',evidence:[]}])) as unknown as RelationshipMetrics;
}
function scopeKey(scope:SceneScope){return JSON.stringify([scope.worldId,scope.sessionId,scope.branchId,scope.characterId]);}
function record(value:unknown):value is Record<string,any>{return typeof value==='object'&&value!==null&&!Array.isArray(value);}
function id(value:unknown):string{if(typeof value!=='string'||!value.trim()||value.length>200)throw new Error('invalid_relationship_id');return value;}
function bounded(value:unknown,max:number,allowEmpty:boolean):string{
  if(typeof value!=='string'||value.length>max||!allowEmpty&&!value.trim())throw new Error('invalid_relationship_text');return value;
}
function revision(value:unknown):value is number{return Number.isSafeInteger(value)&&Number(value)>=0;}
function optionalText(value:unknown,max:number):string|null {
  if(value===undefined||value===null)return null;
  if(typeof value!=='string'||!value||value.length>max)throw new Error('invalid_relationship_support');return value;
}
function digest(value:unknown):string {return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0,24);}
function spanOf(item:{ref:EvidenceSpan}):EvidenceSpan {
  return {sourceId:item.ref.sourceId,revision:item.ref.revision,start:item.ref.start,end:item.ref.end};
}
function latestSourceMs(sources:readonly RelationshipSource[]):number {
  return sources.reduce((latest,source)=>Math.max(latest,source.acceptedAtMs),0);
}
/** An observation is dated by the newest accepted source among its evidence. */
function itemsAtMs(items:readonly {ref:{sourceId:string;revision:number}}[],sources:readonly RelationshipSource[]):number {
  const times=items.flatMap(item=>sources.filter(source=>source.id===item.ref.sourceId&&source.revision===item.ref.revision)
    .map(source=>source.acceptedAtMs));
  return times.length?Math.max(...times):latestSourceMs(sources);
}
function liveSet(live:Iterable<string>|undefined):ReadonlySet<string>|undefined {return live===undefined?undefined:new Set(live);}
/**
 * With the current source set, every cited id@revision must be in it. Without it, only a revision change visible in
 * this input's own window drops the row; sources outside the window keep it until the 90-day prune or clearModels.
 */
function refsLive(refs:readonly string[],sources:readonly {id:string;revision:number}[],live?:ReadonlySet<string>):boolean {
  if(live)return refs.every(ref=>live.has(ref));
  const visible=new Map(sources.map(source=>[source.id,source.revision]));
  return refs.every(ref=>{
    const at=ref.lastIndexOf('@'),current=visible.get(ref.slice(0,at));
    return current===undefined||current===Number(ref.slice(at+1));
  });
}
function choice(value:unknown):RelationshipContactChoice{
  if(value!=='initiate'&&value!=='send'&&value!=='wait'&&value!=='skip')throw new Error('invalid_relationship_contact_choice');return value;
}
