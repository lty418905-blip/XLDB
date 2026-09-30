import {createHash} from 'node:crypto';
import {scopeKey,type Configurations} from '../../../shared/src/core/types.ts';
import type {Core} from '../../../shared/src/core/service.ts';
import {hostOutputInvalid} from '../../../shared/src/core/service.ts';
import type {ModelRunner,ModelTasks} from '../../../shared/src/core/models.ts';
// The flow runs only on an authority with the companion members (companionSceneExtension).
import type {CompanionSceneAuthority as SceneAuthority} from './scene-extension.ts';
import type {SceneScope,SceneMessage,SceneSource} from '../../../shared/src/scene/types.ts';
import {visibleText} from '../../../shared/src/scene/perspective.ts';
import {decodeProfileCandidates,decodeCommunicationStrategy} from '../user-model/codec.ts';
import type {FrontendStrategy,ProfileCandidate} from '../user-model/types.ts';
import {activityGaps,receptivityAt,summarizeUserActivity} from '../user-model/activity.ts';
import {companionDecisionPrompt,decodeCompanionDecision} from './codec.ts';
import {formatRelationshipGuidance} from './relationship-assessment.ts';
import type {RelationshipAssessment,RelationshipAssessmentTask} from './relationship-assessment.ts';
import type {CompanionDecisionOutput,CompanionJudgment,CompanionOpportunity,DriveMarker,JudgmentInput,OccurrencePressure,SeedKind} from './types.ts';
import type {QuietExceptionBinding,WindowEndTone} from './types.ts';
import {dominantSeed,eligiblePressure,epochGridStart,epochStart,evaluatePressure,followupSource,gridCellStart,gridPoints,hazardRate,markerValue,NO_LIFE,
  opportunitySeedKind,PRESSURE_DEFAULTS,pressureAt,recallSource,
  resolveTendency,shareSource,thetaEffective,type LifeAvailabilityProvider,type PressureContribution,type PressureEvaluation,
  type PressureInputs,type PressureInterval,type PressureRecord} from './contact-pressure.ts';
import {absenceExplanationTimeline} from '../../../shared/src/emotion/absence-explanation.ts';
import {expressionReliefHorizonMs,type ExpressionReliefSend} from '../../../shared/src/emotion/contact-affect.ts';
import {contactRestrictionWindow} from '../../../shared/src/commitments/index.ts';
import {lastEndedContactWindow,type ContactRestrictionWindow} from '../../../shared/src/commitments/contact.ts';
import type {CommitmentRecord} from '../../../shared/src/commitments/types.ts';
import {contactSources,contactSummaryTask,decodeContactSummary,contactContext,contactContextFits,contactClock,contactPersonaDigest,explicitSleepSource} from './contact-context.ts';
import {explicitContactFeedback} from './personal-learning.ts';
import type {ContactContext} from './contact-context.ts';
import {compactOpenHerForContact} from './relationship-context.ts';
import {companionIdentityGuidance,companionIdentityIssue,ensureCompanionIdentityBody} from './identity-expression.ts';
import type {LearningTrace} from './personal-weights.ts';
import {sceneExpressionOptions} from '../../../shared/src/scene/address.ts';

export interface ContactJudgment {choice:'send'|'wait'|'skip';rawChoice?:'send'|'wait'|'skip';experience:'positive'|'uncertain'|'negative';emotion:'aligned'|'uncertain'|'conflicting';learningTraces?:LearningTrace[]}
/** The seed a contact expresses (stored on the opportunity row since M3-3); null for legacy kinds that express none. */
export type ContactSeedKind=SeedKind;
/** One opportunity materialize leaves due for evaluate; `exempt` ones (user-timed reminder, window end) are sent unjudged. */
export interface ContactDue {opportunityId:string;occurrenceId:string;kind:CompanionOpportunity['kind'];seedKind:ContactSeedKind|null;exempt:boolean;checkAtMs:number}
/** A connection reading and the unexplained waiting episode, if any (see CompanionFlow.drivePressure, the S1/S4 injection seam). */
export interface DrivePressure {connection:number;waitingEpisode:string|null}
export type MaterializeResult=ReturnType<CompanionFlow['materialize']>;

type SceneState=ReturnType<SceneAuthority['state']>;
/** What the gate read at one instant; schedule and judge work from it without reading the gate inputs again. */
interface ContactGate {
  actor:SceneState['roster']['characters'][number];subject:NonNullable<ReturnType<SceneAuthority['subject']>>;state:SceneState;
  controls:ReturnType<SceneAuthority['userModel']['controls']>;now:number;targetId:string;quiet:QuietExceptionBinding[];softOnly:boolean;
  /**
   * The judgment fingerprint (M1): the soft windows at the check instant. For pressure occurrences only, `pressureQuiet`
   * holds the soft windows as they count for them (from their start until the grid point after their end, see
   * pressureQuietAt), and `pressureFingerprint` is the fingerprint over those (see judgmentFingerprint and contactQuiet).
   */
  correction:string|null;fingerprint:string;pressureQuiet:QuietExceptionBinding[];pressureFingerprint:string;
}
interface WindowEndSeed {key:string;window:ContactRestrictionWindow;quietSinceMs:number;quietSince:string;userChattedInWindow:boolean}
type WindowEndChoice=WindowEndSeed&{tone:WindowEndTone};
/** What schedule materialized (or evaluate reads back): user-timed reminders, and the window-end instance to answer, if any. */
interface ContactPlan {userTimed:ReadonlySet<string>;windowEnd:WindowEndChoice|null;windowEndOccurrenceId:string|null}
/** Every opportunity of one seed key, generation by generation (`<key>`, `<key>~g1`, ...), with its judgment memory. */
interface SeedHistory {key:string;kind:CompanionOpportunity['kind'];generations:{opportunity:CompanionOpportunity;judgment:CompanionJudgment|null}[]}
/**
 * What one contact check reads for the pressure model (PLAN M3 section 2): the complete hazard inputs at the check time, the
 * seeds that can be materialized, the history of each seed key and the hysteresis marker. `injected` is the reading of a
 * replaced drivePressure (tests): it stands for S1 and S4 at this instant only.
 */
interface PressureContext {
  inputs:PressureInputs;epochStartMs:number;injected:DrivePressure|null;marker:DriveMarker|null;histories:SeedHistory[];
  nextGeneration:ReadonlyMap<string,number>;followup:{key:string;atMs:number;id:string;revision:number;topic:string}|null;
  memories:ReadonlyMap<string,{memoryId:string;revision:number}>;waitingEpisode:string|null;
}
type ContactSelection=ReturnType<CompanionFlow['select']>;
interface ContactPath {opportunity:CompanionOpportunity;exempt:boolean;exceptionPath:boolean;judged:boolean;invitation:boolean;
  onTimeReminder:boolean;windowEndNow:boolean;windowEnd:WindowEndChoice|null}
type PreparedContact=Exclude<Awaited<ReturnType<CompanionFlow['prepareContext']>>,{result:unknown}>;
type DecidedContact=Awaited<ReturnType<CompanionFlow['decide']>>;

/** The stored seed, or for a row written before M3 the seed its kind and basis express (shared with the scene's release). */
const contactSeedKind=(item:CompanionOpportunity):ContactSeedKind|null=>opportunitySeedKind(item);
const LONGING_TOPIC='想念对方时的一次简短联系，不要求回复，不假定用户正在做什么。';
const CHECK_IN_TOPIC='对方很久没有回复时的一次简短关心，不催促、不要求回复，也不假定原因。';
const SHARE_TOPIC='想和对方分享一点自己此刻的心情或小事时的一次简短联系，不要求回复，不编造没有经历过的事。';
const RECALL_TOPIC='想起和对方有关的一段真实记忆时的一次简短联系，不要求回复，不假定用户正在做什么。';
/** Generations of one seed key looked up at most; the pressure cap 5 and delta bound real ones far below this. */
const SEED_GENERATION_LIMIT=32;
/** A stored pressure record above this size keeps only its dominant contribution. */
const PRESSURE_RECORD_LIMIT=2048;
/** Recall events matter for 48 hours after they happened (PRESSURE_DEFAULTS.recall.horizonHours). */
const RECALL_HORIZON_MS=PRESSURE_DEFAULTS.recall.horizonHours*3_600_000;
const insideAny=(intervals:readonly PressureInterval[]|undefined,atMs:number)=>
  (intervals??[]).some(interval=>interval.startMs<=atMs&&atMs<interval.endMs);

const HOUR=3_600_000;
/** A goodnight stays a soft window while it is the latest user message inside the 12-hour contact source window. */
const SLEEP_WINDOW_MS=12*HOUR;
const SLEEP_WINDOW_CONTENT='用户刚直接说要去睡了或道了晚安；在用户下一条消息之前是软性勿扰时段。';
/** The inputs whose change invalidates a stored wait, besides its fallback check time. */
const INVALIDATE_ON='user_activity,busy,profile,controls,relationship_correction,commitments,quiet_windows';
/** How long after a hard window ends its window-end longing may still be sent when no poll came earlier. */
const WINDOW_END_GRACE_MS=6*HOUR;
/** Messages this close to the previous one continue the same conversation (see windowEndSeed). */
const CONVERSATION_GAP_MS=30*60_000;
/** A window-end longing needs at least this much quiet inside the window before its end (see windowEndSeed). */
export const WINDOW_END_MIN_QUIET_MS=60*60_000;
/**
 * The window-end message is not sent every time its conditions hold (user decision 2026-09-28: "too much like a script").
 * Its send probability rises linearly with the quiet length, from WINDOW_END_P_MIN at WINDOW_END_MIN_QUIET_MS to
 * WINDOW_END_P_MAX at WINDOW_END_FULL_QUIET_MS and above; an open connection-drive episode for the target adds
 * WINDOW_END_DRIVE_BONUS, capped at WINDOW_END_P_CAP (see windowEndProbability).
 */
export const WINDOW_END_P_MIN=0.30;
/** Below 1 so that even a nightly eight-hour window skips about one morning in seven. */
export const WINDOW_END_P_MAX=0.85;
export const WINDOW_END_FULL_QUIET_MS=8*HOUR;
export const WINDOW_END_DRIVE_BONUS=0.10;
export const WINDOW_END_P_CAP=0.95;
/** Drive occurrences in these states are an open episode. */
const OPEN_DRIVE_STATUSES:readonly CompanionOpportunity['status'][]=['waiting','deferred','evaluating','approved'];
/** At most this many stalled sources are named in one semantic_pending poll result. */
const SEMANTIC_PENDING_DIAGNOSTICS=5;
/** How long a ready proactive text stays valid for the host to take. */
const CONTACT_TEXT_MS=5*60_000;
/** Reopens of one drive episode after its pending row was cancelled before the host took it, or failed at the host. */
const DRIVE_REOPEN_LIMIT=2;
/** The start of the UTC 5-minute grid cell holding `atMs`. */
const gridFloor=gridCellStart;
/** The first UTC 5-minute grid point at or after `atMs`. */
const gridCeil=(atMs:number)=>Math.ceil(atMs/PRESSURE_DEFAULTS.gridMs)*PRESSURE_DEFAULTS.gridMs;
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0,32);

/** Send probability of a window-end message after `quietMs` of quiet before the window end (see WINDOW_END_P_MIN). */
export function windowEndProbability(quietMs:number,driveOpen:boolean):number {
  const share=Math.min(1,Math.max(0,(quietMs-WINDOW_END_MIN_QUIET_MS)/(WINDOW_END_FULL_QUIET_MS-WINDOW_END_MIN_QUIET_MS)));
  // Weighted so that both ends are exact (0.30 + 0.55 would be 0.8500000000000001).
  const base=WINDOW_END_P_MIN*(1-share)+WINDOW_END_P_MAX*share;
  return driveOpen?Math.min(WINDOW_END_P_CAP,base+WINDOW_END_DRIVE_BONUS):base;
}
/**
 * Two independent uniforms in [0,1) from sha256 of the roll seed (`subjectId:window_end:<commitment>:<instance key>:<instance end ms>`):
 * the send roll and the tone. A daily window gets a new seed each day; retries and repeated polls of one instance share it.
 */
function seededUniforms(seed:string):[number,number] {
  const hex=createHash('sha256').update(seed).digest('hex');
  return [parseInt(hex.slice(0,12),16)/2**48,parseInt(hex.slice(12,24),16)/2**48];
}
/** The seeded send roll u of one window instance: it is sent iff u < windowEndProbability(...). */
export function windowEndUniform(seed:string):number {return seededUniforms(seed)[0];}
/**
 * The tone of one window instance, drawn from the same seed as its roll: after six hours of quiet or more care 0.35,
 * longing 0.35, light 0.20, share 0.10; after less, light 0.35, care 0.30, longing 0.25, share 0.10.
 */
export function windowEndTone(seed:string,quietMs:number):WindowEndTone {
  const weights:[WindowEndTone,number][]=quietMs>=6*HOUR?[['longing',0.35],['care',0.35],['share',0.10],['light',0.20]]:
    [['longing',0.25],['care',0.30],['share',0.10],['light',0.35]];
  let draw=seededUniforms(seed)[1];
  for(const [tone,weight] of weights){if(draw<weight)return tone;draw-=weight;}
  return weights.at(-1)![0];
}
/**
 * How each tone frames the window-end message: the opportunity topic, the context query and the opening and direction of
 * the generation prompt. Only longing speaks of missing the user; light and share never word it (they would pull every
 * morning back to 想你). Share draws only on her own real experience in the context, never an invented one.
 */
const WINDOW_END_FRAMING:Record<WindowEndTone,{topic:string;query:string;opening:string;direction:string}>={
  longing:{topic:'用户指定的勿扰时段刚结束，第一时间简短问候、表达想念与关心，不追问、不抱怨、不要求回复。',
    query:'此刻适合表达想念与关心的真实共同经历',opening:'自然地表达想念与关心',direction:'这次以想念为主，可以直接说想对方'},
  care:{topic:'用户指定的勿扰时段刚结束，第一时间简短问候与关心：问问对方睡得怎么样、现在怎么样，不追问、不抱怨、不要求回复。',
    query:'此刻适合问候与关心对方的真实近况与共同经历',opening:'以问候与关心为主，问问对方睡得怎么样、现在怎么样',
    direction:'这次以关心为主，比如问对方睡得好不好、休息得怎么样'},
  light:{topic:'用户指定的勿扰时段刚结束，第一时间发一句轻松的话，不追问、不抱怨、不要求回复。',
    query:'此刻适合轻松聊起的真实共同话题',opening:'只发一句轻松的话',direction:'这次只发一句轻松的问候或俏皮话，语气轻快，不煽情'},
  share:{topic:'用户指定的勿扰时段刚结束，第一时间分享一件自己最近真实经历的小事（只取上下文里确有的所见所做，绝不编造），不追问、不抱怨、不要求回复。',
    query:'我自己最近真实经历过的事：看到的或做过的',opening:'分享一件你自己最近真实经历的小事：你看到或做过的事',
    direction:'这次分享的事只能取自上下文里确有的你自己的经历，绝不编造；上下文里没有就改为一句简单的问候'},
};

/**
 * A reply-path enrichment that was retried or left out because the host returned output that failed local
 * validation. `recovered`: the single retry succeeded; `omitted`: the reply continues without it; `cached`: the
 * stored assessment for the current sources is used instead; `reextracted`: the stored relationship extraction no
 * longer decoded, so it was discarded and extracted afresh (the reply keeps its enrichment); `dropped_counter` (stage
 * `profile`): a profile counter candidate for the current user text cited no entry the extraction was shown
 * (`profile_counter_target_missing`) or cited an entry the user corrected (`profile_counter_user_corrected`), so it was
 * dropped for that entry without storing anything; it names no entry content. Infrastructure and version errors never become diagnostics.
 */
export interface ReplyDiagnostic {stage:'strategy'|'relationship'|'profile';code:string;attempts:number;outcome:'recovered'|'omitted'|'cached'|'reextracted'|'dropped_counter'}

export interface CompanionDecisionProvider {
  assess(task:RelationshipAssessmentTask,extraction:unknown,personalScopeKey?:string):Promise<unknown>;
  evaluateWithTrace?:(payload:unknown,learning:{scopeKey:string;taskType:'contact'|'relationship'})=>Promise<{learningTraces:LearningTrace[]}>;
  identity?():string;
  summarizeContact?(messages:{role:'system'|'user';content:string}[]):Promise<string>;
  decideContact(input:{context:ContactContext;opportunity:Pick<CompanionOpportunity,'purpose'|'topic'|'basis'>;candidateBody?:string},personalScopeKey?:string):Promise<ContactJudgment>;
  decideQuietException?(input:{context:ContactContext;quiet:{content:string;windowKey:string}[];candidateBody:string},personalScopeKey?:string):Promise<'positive'|'uncertain'|'negative'|{verdict:'positive'|'uncertain'|'negative';learningTraces:LearningTrace[]}>;
  close():void;
}

/** Host-neutral companion orchestration. The host alone commits an outgoing message. */
export class CompanionFlow {
  private authority:SceneAuthority;
  private core:Core;
  private models:ModelTasks;
  private relationshipInFlight=new Map<string,Promise<RelationshipAssessment|null>>();
  /** Profile extraction diagnostics per scope and user source, drained into the reply diagnostics of that source's turn. */
  private profileDiagnostics=new Map<string,ReplyDiagnostic[]>();
  decisionProvider:CompanionDecisionProvider|null=null;
  evidenceExtractor:((task:RelationshipAssessmentTask)=>Promise<unknown>)|null=null;
  /** A supplied runner lets the scene batch this extraction with sibling observation parts. */
  responseExpectationExtractor:((messages:{role:'system'|'user';content:string}[],run?:ModelRunner)=>Promise<string>)|null=null;
  absenceExplanationExtractor:((messages:{role:'system'|'user';content:string}[],run?:ModelRunner)=>Promise<string>)|null=null;
  requireLocalDecisions=false;
  /**
   * Tests only: replaces the seeded uniform of the window-end roll (`seed` is `subjectId:window_end:...:<end ms>`); a returned u
   * below the probability sends. Null in production, where the roll comes from sha256 of the seed.
   */
  windowEndRoll:((seed:string)=>number)|null=null;
  /**
   * Tests only: replaces the seeded uniform u of a hazard epoch (`seed` is `subjectId:targetId:hazard:<T0 ms>`), in (0, 1];
   * the epoch fires at the first grid point with lambda > 0 and integrated hazard >= -ln u, so 1 fires at once. Null in
   * production, where u comes from sha256 of the seed (contact-pressure hazardUniform).
   */
  hazardUniform:((seed:string)=>number)|null=null;
  /** S7, her own life (L1): availability multiplies the hazard (off 0, busy 0.2, glance 0.6). M3 ships the null stub. */
  lifeProvider:LifeAvailabilityProvider=NO_LIFE;
  /** Fired hazard evaluations by target, epoch and input digest (PLAN M3 section 11.4); a fired epoch never changes. */
  private pressureCache=new Map<string,PressureEvaluation>();
  constructor(authority:SceneAuthority,core:Core,models:ModelTasks){this.authority=authority;this.core=core;this.models=models;}
  async extract(scope:SceneScope,source:SceneMessage,configs:Configurations,assertCurrent:()=>void,run?:ModelRunner):Promise<ProfileCandidate[]>{
    const subject=this.authority.subject(scope);
    if(!subject||subject.host!=='agent'||source.role!=='user'||this.authority.interactions.modeOf(scope)!=='companion'||
      source.envelope.mode!=='direct'||source.envelope.presentIds.length!==1||source.envelope.presentIds[0]!==source.envelope.targetId)return [];
    const controls=this.authority.userModel.controls(subject.subjectId);
    // Every visible entry, unbounded: the prompt codec deduplicates and samples 40 of them, while a counter must reach
    // every scope of a shown fact, including older scopes that fall outside that sample.
    const entries=this.authority.userModel.profileExtractionEntries(subject.subjectId,
      {characterId:source.envelope.targetId,sessionId:scope.sessionId},Number.POSITIVE_INFINITY);
    const task=this.authority.userModel.profileTask(subject.subjectId,scope,source,entries);
    if(!task)return [];
    const shown=new Set((JSON.parse(task.messages.at(-1)!.content) as {existingEntries:{key:string;category:string}[]}).existingEntries
      .map(entry=>JSON.stringify([entry.key,entry.category])));
    const raw=await this.models.structuredTask(configs.profile,task.messages,run);
    assertCurrent();
    if(this.authority.userModel.controls(subject.subjectId).revision!==controls.revision)throw new Error('context_changed_retry');
    // A counter only withdraws facts the host was shown. One fact can be stored under several scopes, so a counter citing a
    // shown (key, category) is expanded to every visible entry with it, each copy taking that entry's scope so its identity matches;
    // copies are deduplicated by scope and ordered by it so the result does not depend on listing order. A counter citing
    // no shown (key, category) is dropped instead of storing an invalid entry that would move the profile, and a copy for
    // an entry the user corrected is dropped too, because a counter can never withdraw a user correction.
    const dropped:ReplyDiagnostic[]=[];
    const countered=new Set<string>();
    const candidates=decodeProfileCandidates(raw,source.text).flatMap(candidate=>{
      const scoped={...candidate,characterIds:[source.envelope.targetId],sessionIds:[scope.sessionId]};
      if(candidate.polarity!=='counter')return [scoped];
      const targets=shown.has(JSON.stringify([candidate.key,candidate.category]))
        ?entries.filter(entry=>entry.key===candidate.key&&entry.category===candidate.category):[];
      if(!targets.length){dropped.push({stage:'profile',code:'profile_counter_target_missing',attempts:1,outcome:'dropped_counter'});return [];}
      if(targets.some(target=>target.corrected))
        dropped.push({stage:'profile',code:'profile_counter_user_corrected',attempts:1,outcome:'dropped_counter'});
      const aligned=targets.filter(target=>!target.corrected).map(target=>({...scoped,purposes:[...target.purposes],
        characterIds:target.characterIds.length?[...target.characterIds]:scoped.characterIds,
        sessionIds:target.sessionIds.length?[...target.sessionIds]:scoped.sessionIds}));
      const identity=(item:typeof scoped)=>JSON.stringify([item.key,item.category,
        ...[item.purposes,item.characterIds,item.sessionIds].map(values=>[...values].sort())]);
      return aligned.map(item=>({item,identity:identity(item)}))
        .sort((left,right)=>left.identity<right.identity?-1:left.identity>right.identity?1:0)
        .filter(({identity})=>!countered.has(identity)&&!!countered.add(identity)).map(({item})=>item);
    });
    const key=JSON.stringify([scopeKey(scope),source.id]);
    this.profileDiagnostics.delete(key);
    if(dropped.length){
      this.profileDiagnostics.set(key,dropped);
      while(this.profileDiagnostics.size>64)this.profileDiagnostics.delete(this.profileDiagnostics.keys().next().value!);
    }
    return candidates;
  }
  async strategy(scope:SceneScope,characterId:string,currentContext:string,configs:Configurations,assertCurrent:()=>void,purpose='reply'):Promise<FrontendStrategy|null>{
    return (await this.strategyWithAssessment(scope,characterId,currentContext,configs,assertCurrent,purpose)).strategy;
  }
  /**
   * Supplying `diagnostics` opts into reply degradation: invalid host output for the strategy is retried once and
   * then omitted, and an invalid relationship extraction falls back to the stored assessment for the current
   * sources, or is omitted when there is none. Each such
   * event is appended to `diagnostics`; every other error propagates unchanged.
   */
  private async strategyWithAssessment(scope:SceneScope,characterId:string,currentContext:string,configs:Configurations,
    assertCurrent:()=>void,purpose='reply',diagnostics?:ReplyDiagnostic[]):Promise<{strategy:FrontendStrategy|null;assessment?:RelationshipAssessment|null}>{
    const subject=this.authority.subject(scope);if(!subject||subject.host!=='agent'||this.authority.interactions.modeOf(scope)!=='companion')return {strategy:null};
    const target=this.target(scope,characterId);
    const assessment=await this.replyAssessment(scope,characterId,diagnostics);assertCurrent();
    if(assessment)currentContext+='\n'+formatRelationshipGuidance(assessment,purpose==='proactive'?'proactive':'reply');
    const activity=summarizeUserActivity(this.authority.state(scope).sources.filter(source=>source.envelope.mode==='direct'&&
      source.envelope.targetId===characterId&&source.envelope.presentIds.length===1&&source.envelope.presentIds[0]===characterId)
      .map(source=>({id:source.id,revision:source.revision,role:source.role,status:source.status,acceptedAtMs:source.acceptedAtMs})),
      {timeZone:this.authority.interactions.clock(scope).timeZone??'UTC'});
    const task=this.authority.userModel.strategyTask(subject.subjectId,{purpose,storageKey:JSON.stringify(['xldb-user-model-strategy-v1',purpose,target]),
      currentContext,characterId,sessionId:scope.sessionId,advanced:true,activity});
    if(!task)return {strategy:null,assessment};
    const run=async()=>{
      const raw=await this.models.structuredTask(configs.strategy,task.messages);assertCurrent();
      return this.authority.userModel.saveStrategy(subject.subjectId,task,decodeCommunicationStrategy(raw,task));
    };
    if(!diagnostics)return {strategy:await run(),assessment};
    let first:string;
    try{return {strategy:await run(),assessment};}
    catch(error){const code=hostOutputInvalid(error);if(!code)throw error;first=code;}
    try{
      const strategy=await run();
      diagnostics.push({stage:'strategy',code:first,attempts:2,outcome:'recovered'});
      return {strategy,assessment};
    }catch(error){
      const code=hostOutputInvalid(error);if(!code)throw error;
      diagnostics.push({stage:'strategy',code,attempts:2,outcome:'omitted'});
      return {strategy:null,assessment};
    }
  }
  /** Reply-path assessment. Without a diagnostics sink it is exactly assessRelationship(). */
  private async replyAssessment(scope:SceneScope,characterId:string,diagnostics?:ReplyDiagnostic[]):Promise<RelationshipAssessment|null>{
    if(!diagnostics)return this.assessRelationship(scope,characterId);
    try{return await this.assessRelationship(scope,characterId,diagnostics);}
    catch(error){
      const code=hostOutputInvalid(error);if(!code)throw error;
      const input=this.authority.relationshipAssessmentInput(scope,characterId);
      // Only the authority's stored view may stand in: it is keyed to the current sources, so deleted or rewritten
      // sources never reach the reply through an older in-process copy.
      const cached=input?this.authority.relationshipAssessments.read(input):null;
      diagnostics.push({stage:'relationship',code,attempts:1,outcome:cached?'cached':'omitted'});
      return cached;
    }
  }
  async systemContext(scope:SceneScope,characterId:string,legalContext:string,configs:Configurations,assertCurrent:()=>void,
    currentUserSourceId?:string,nowMs=Date.now(),diagnostics?:ReplyDiagnostic[]){
    if(diagnostics&&currentUserSourceId!==undefined){
      const key=JSON.stringify([scopeKey(scope),currentUserSourceId]);
      diagnostics.push(...this.profileDiagnostics.get(key)??[]);this.profileDiagnostics.delete(key);
    }
    const reply=await this.strategyWithAssessment(scope,characterId,legalContext,configs,assertCurrent,'reply',diagnostics);
    const strategy=reply.strategy;
    const input=this.authority.relationshipAssessmentInput(scope,characterId);
    // A degraded reply keeps the assessment it actually used; otherwise read the current stored view.
    const assessment=reply.assessment!==undefined&&diagnostics?.some(item=>item.stage==='relationship')?reply.assessment:
      input?this.authority.relationshipAssessments.read(input):null;
    const latest=this.authority.state(scope).sources.filter(source=>source.status==='accepted'&&source.processing==='ready').at(-1);
    const harden=latest?.role==='user'&&latest.envelope.mode==='direct'&&latest.envelope.targetId===characterId&&
      latest.analysis?.commitmentOperations?.some(operation=>operation.action==='harden');
    const sleepHarden=latest?.role==='user'&&latest.envelope.mode==='direct'&&latest.envelope.targetId===characterId&&
      this.sleepHardening(scope,characterId,nowMs)?.id===latest.id;
    const subject=this.authority.subject(scope);
    const agentCompanion=subject?.host==='agent'&&this.authority.interactions.modeOf(scope)==='companion';
    const clock=agentCompanion?contactClock(nowMs,this.authority.interactions.clock(scope).timeZone??'UTC'):null;
    return (clock?'\n当前伴侣现实时间：'+JSON.stringify(clock):'')+
      (strategy?'\n本轮沟通建议（依据已授权资料，推断不是事实；用户当前意愿是重要依据，角色保留自己的判断与不同意）：'+JSON.stringify(strategy):'')+
      (assessment?'\n'+formatRelationshipGuidance(assessment,'reply'):'')+
      (harden?'\n用户刚明确表示此前勿扰时段的破例联系让其不快。请按当前角色人设在本轮正常回复中真诚、简短道歉，承认已收到边界；不要主动补发道歉，也不要再把该承诺当作可破例。':
        sleepHarden?'\n用户刚明确表示此前睡眠时段的破例联系让其不快。请按当前角色人设在本轮正常回复中真诚、简短道歉，承认已收到边界；不要主动补发道歉，在用户再次发来消息前不再主动联系。':'');
  }
  /** A supplied diagnostics sink records a stored extraction that no longer decoded and was extracted afresh. */
  async assessRelationship(scope:SceneScope,characterId:string,diagnostics?:ReplyDiagnostic[]){
    const learningKey=this.learningScope(scope,characterId);
    if(learningKey&&this.decisionProvider?.identity)this.authority.personalLearning.contactFeedback(learningKey,
      this.learningSources(scope,characterId),this.decisionProvider.identity());
    const input=this.authority.relationshipAssessmentInput(scope,characterId);
    if(!input)return null;
    const task=this.authority.relationshipAssessments.task(input);
    if(task&&input.sources.length&&this.decisionProvider){
      if(!this.evidenceExtractor)throw new Error('relationship_evidence_extractor_required');
      const key=JSON.stringify([scope,input.subjectId,characterId,task.sourceFingerprint]);
      const running=this.relationshipInFlight.get(key);if(running)return running;
      const work=(async()=>{
        const extraction=this.authority.relationshipAssessments.reusableEvidence(input,
          code=>diagnostics?.push({stage:'relationship',code,attempts:1,outcome:'reextracted'}))??await this.evidenceExtractor!(task);
        if(learningKey){
          const correction=this.authority.relationshipAssessments.read(input);
          this.authority.personalLearning.relationship(learningKey,input,extraction,correction,()=>{
              if(this.authority.state(scope).version!==input.sourceVersion||
                this.authority.relationshipAssessments.read(input)?.revision!==correction?.revision||
                this.learningScope(scope,characterId)!==learningKey||
                this.authority.userModel.controls(input.subjectId).revision!==input.controlsRevision)
                throw new Error('context_changed_retry');
            });
        }
        const refreshed=this.authority.relationshipAssessmentInput(scope,characterId);
        if(!refreshed)throw new Error('context_changed_retry');
        const effectiveTask=this.authority.relationshipAssessments.task(refreshed)??task;
        const result=await this.decisionProvider!.assess(effectiveTask,extraction,learningKey??undefined);
        const current=this.authority.relationshipAssessmentInput(scope,characterId);
        if(!current)throw new Error('context_changed_retry');
        try{return this.authority.relationshipAssessments.save(effectiveTask,result,current);}
        catch(error){
          if(error instanceof Error&&error.message==='context_changed_retry')return this.authority.relationshipAssessments.read(current);
          throw error;
        }
      })();
      this.relationshipInFlight.set(key,work);
      try{return await work;}finally{if(this.relationshipInFlight.get(key)===work)this.relationshipInFlight.delete(key);}
    }
    return this.authority.relationshipAssessments.read(input);
  }
  private learningSources(scope:SceneScope,characterId:string){
    return this.authority.state(scope).sources.filter(s=>s.status==='accepted'&&s.processing==='ready'&&
      s.envelope.mode==='direct'&&s.envelope.targetId===characterId&&s.envelope.presentIds.length===1&&
      s.envelope.presentIds[0]===characterId&&(s.role==='user'||s.role==='assistant'&&s.speakerId===characterId));
  }
  private learningScope(scope:SceneScope,characterId:string){
    const subject=this.authority.subject(scope);
    if(subject?.host!=='agent'||this.authority.interactions.modeOf(scope)!=='companion')return null;
    const controls=this.authority.userModel.controls(subject.subjectId),key=this.authority.personalLearning.key(scope,subject.subjectId,characterId);
    const enabled=controls.profileLearningEnabled&&controls.personalizationEnabled;
    this.authority.personalLearning.synchronize(key,this.learningSources(scope,characterId),controls.revision,enabled);
    return enabled?key:null;
  }
  status(scope:SceneScope,characterId:string){
    this.actor(scope,characterId);const subject=this.requireSubject(scope);
    return {subject,controls:this.authority.userModel.controls(subject.subjectId),contact:this.authority.companion.contactSettings(subject.subjectId),
      contactPaused:subject.host==='agent'&&this.authority.userModel.contactPaused(subject.subjectId,this.target(scope,characterId)),
      status:this.authority.companion.status(subject.subjectId,this.target(scope,characterId)),
      // The latest window-end rolls (a skipped one leaves no opportunity row), newest first.
      windowEndRolls:this.authority.companion.windowEndRolls(subject.subjectId,this.target(scope,characterId),5)};
  }
  contactEmotion(scope:SceneScope,characterId:string,nowMs:number,state=this.authority.state(scope),
    currentReply:{sourceId:string;revision:number}|null=null){
    return this.authority.contactEmotionProjection(scope,characterId,nowMs,state,currentReply);
  }
  /**
   * The projected (relieved) connection frustration and the unexplained unanswered episode, if any. The pressure model does
   * not read it: it integrates S1 and S4 from E0, her sends and the wait itself. Replacing it on an instance is the S1/S4
   * injection seam: the reading then stands for S1 (a longing seed of that value) and S4 (a check-in seed for a new waiting
   * episode) at the check instant only, and the hazard is evaluated at that instant as one grid step (hysteresis read and
   * cleared there, no refractory), with u from hazardUniform or 1.
   */
  drivePressure(scope:SceneScope,characterId:string,nowMs:number,state=this.authority.state(scope)):DrivePressure{
    const {emotion,affect}=this.contactEmotion(scope,characterId,nowMs,state);
    return {connection:emotion.frustration.connection,
      waitingEpisode:affect?.phase==='waiting'&&affect.absence==='unexplained'&&affect.episode?affect.episode.deliveryId:null};
  }
  /**
   * One contact check (PLAN M3 §4): gate, then schedule, then, unless the scheduled state already settles the check, the
   * judgment. The gate is not run again before the judgment, so the side effects are exactly those of the former single pass.
   */
  async poll(scope:SceneScope,characterId:string,trigger:'event'|'scheduled',configs:Configurations,assertCurrent:()=>void){
    const gated=this.gate(scope,characterId,trigger,Date.now());
    if(gated.terminal)return gated.result;
    const plan=this.schedule(scope,characterId,gated.gate);
    const selection=this.select(gated.gate,trigger,plan),settled=this.settle(gated.gate,selection);
    if(settled)return settled;
    return this.judge(scope,characterId,trigger,configs,assertCurrent,gated.gate,plan,selection,selection.opportunity!);
  }
  /**
   * The synchronous half of a contact check: the gate and the scheduling of what is due (at most one new pressure
   * occurrence from the hazard, the rebuilt pending one, reminders, the window-end roll and row, revived waits), never a
   * context read, host job, local judgment, generation, claim or queue. `terminal` carries the result a poll would return
   * now (disabled, semantic_pending, a boundary, a pending ready text, a soft window without a user-timed reminder, or
   * nothing due); otherwise `due` lists what evaluate would judge, in its selection order, with the pressure occurrence
   * this call opened (`materialized`) and the pressure record it read (`pressure`: the trigger, or the state now; also on
   * a terminal result reached after scheduling). Idempotent for one state and time.
   */
  materialize(scope:SceneScope,characterId:string,trigger:'event'|'scheduled',nowMs=Date.now()){
    const gated=this.gate(scope,characterId,trigger,nowMs);
    if(gated.terminal)return {terminal:true as const,result:gated.result};
    const gate=gated.gate,plan=this.schedule(scope,characterId,gate);
    const selection=this.select(gate,trigger,plan),settled=this.settle(gate,selection);
    if(settled)return {terminal:true as const,result:settled,pressure:plan.pressure};
    const due:ContactDue[]=selection.ordered.filter(item=>!gate.softOnly||selection.isUserTimed(item)).map(item=>({
      opportunityId:item.opportunityId,occurrenceId:item.occurrenceId,kind:item.kind,seedKind:contactSeedKind(item),
      exempt:selection.isUserTimed(item)||item.kind==='window_end',checkAtMs:item.checkAtMs}));
    return {terminal:false as const,due,materialized:plan.materialized,pressure:plan.pressure};
  }
  /**
   * The judging half of a contact check: the gate again (nothing may have changed since materialize, or everything), then
   * the judgment of what materialize left due. It never creates an opportunity row: the user-timed reminders and the
   * window-end choice are read back (the stored roll, never a new one), not scheduled.
   */
  async evaluate(scope:SceneScope,characterId:string,trigger:'event'|'scheduled',configs:Configurations,assertCurrent:()=>void){
    const gated=this.gate(scope,characterId,trigger,Date.now());
    if(gated.terminal)return gated.result;
    const plan=this.recordedPlan(scope,characterId,gated.gate);
    const selection=this.select(gated.gate,trigger,plan),settled=this.settle(gated.gate,selection);
    if(settled)return settled;
    return this.judge(scope,characterId,trigger,configs,assertCurrent,gated.gate,plan,selection,selection.opportunity!);
  }
  /**
   * Gate: switches, stalled sources, pause, the user's wait or skip, a hard window (cancelling pending contact), and the
   * revalidation of a ready text (returned while current, cancelled otherwise). Synchronous; reads everything at `nowMs`.
   */
  private gate(scope:SceneScope,characterId:string,trigger:'event'|'scheduled',nowMs:number):
    {terminal:true;result:{status:string;reason?:string;pendingReason?:string;diagnostics?:unknown[];deliveryId?:string;body?:string;characterId?:string}}|
    {terminal:false;gate:ContactGate}{
    const actor=this.actor(scope,characterId),subject=this.requireSubject(scope),state=this.authority.state(scope);
    const controls=this.authority.userModel.controls(subject.subjectId);
    if(!controls.proactiveCompanionEnabled||(trigger==='scheduled'&&!controls.scheduledWakeEnabled))return {terminal:true,result:{status:'disabled'}};
    const unresolved=state.sources.filter(source=>source.status==='accepted'&&source.processing!=='ready');
    // Diagnostics of a source that is ready again (or gone) are dropped, and none are kept longer than seven days.
    this.authority.companion.prunePollDiagnostics(subject.subjectId,this.target(scope,characterId),
      unresolved.map(source=>source.id),nowMs);
    if(unresolved.length)return {terminal:true,result:this.semanticPending(scope,subject.subjectId,this.target(scope,characterId),state,nowMs)};
    const now=nowMs,targetId=this.target(scope,characterId),companion=this.authority.companion;
    if(subject.host==='agent'&&this.authority.userModel.contactPaused(subject.subjectId,targetId))
      return {terminal:true,result:{status:'disabled',reason:'user_feedback_pause'}};
    const initialAssessmentInput=this.authority.relationshipAssessmentInput(scope,characterId);
    const initialAssessment=initialAssessmentInput?this.authority.relationshipAssessments.read(initialAssessmentInput):null;
    // "Wait" or "skip" from the user is a boundary and holds before anything is materialized; "send" is only an invitation.
    if(initialAssessment?.contactCorrected&&['wait','skip'].includes(initialAssessment.contactChoice))
      return {terminal:true,result:{status:initialAssessment.contactChoice==='skip'?'skipped':'waiting',reason:'relationship_contact_correction'}};
    const quiet=this.quietAt(scope,characterId,now,state);
    if(quiet===null){companion.cancelPendingForTarget(subject.subjectId,targetId,'contact_restriction_hard',now);
      return {terminal:true,result:{status:'waiting',reason:'contact_restriction_hard'}};}
    // Without a local exception judgment, a soft window closes a non-Agent host to everything but a user-timed reminder.
    const softOnly=subject.host!=='agent'&&quiet.length>0;
    const pressureQuiet=this.pressureQuietAt(scope,characterId,now,state)??quiet;
    const activityNow=companion.activity(subject.subjectId),contactNow=companion.contactSettings(subject.subjectId);
    for(const receipt of companion.status(subject.subjectId,targetId).deliveries.filter(item=>item.status==='ready')){
      const pending=companion.getDelivery(receipt.deliveryId),basis=pending?companion.getOpportunity(pending.opportunityId):null;
      if(pending&&companionIdentityIssue(pending.body,null))throw new Error('companion_identity_expression_invalid');
      if(!pending)continue;
      const contextSame=Boolean(basis)&&pending.sourceVersion===state.version&&pending.controlsRevision===controls.revision&&
        pending.profileRevision===this.authority.userModel.profileRevision(subject.subjectId)&&pending.activityRevision===activityNow.revision&&
        pending.contactRevision===contactNow.revision&&this.contactSourcesSame(state.sources,characterId,pending.createdAtMs,now)&&
        this.sameQuietBindings(companion.getDeliveryExceptionBindings(pending.deliveryId),basis?.pressure?pressureQuiet:quiet);
      if(contextSame&&basis&&now<=basis.windowEndMs&&now<=basis.expiresAtMs&&now-pending.createdAtMs<=CONTACT_TEXT_MS)
        return {terminal:true,result:{status:'ready',deliveryId:pending.deliveryId,body:pending.body,characterId}};
      // Only text that lapsed unchanged reopens its own drive episode; a changed context does not.
      companion.cancelPendingForTarget(subject.subjectId,targetId,'contact_context_expired',now,
        {opportunityId:pending.opportunityId,cause:contextSame?'body_expired':'context_changed'});
    }
    const correction=initialAssessment?.contactCorrected?initialAssessment.contactChoice:null;
    const fingerprint=this.contactFingerprint(scope,characterId,subject.subjectId,quiet,correction);
    // For a pressure occurrence a soft window lasts until the grid point after its end, in its fingerprint and in every
    // soft-window rule of its judgment, so a window that ends off the grid (a goodnight 12 hours on, a duration window)
    // is judged, and revives a wait, the same way whichever tick of its last cell sees it. Every other opportunity keeps
    // the M1 reading at the check instant (its re-checks keep raw times too).
    const pressureFingerprint=this.contactFingerprint(scope,characterId,subject.subjectId,pressureQuiet,correction);
    return {terminal:false,gate:{actor,subject,state,controls,now,targetId,quiet,softOnly,correction,fingerprint,pressureQuiet,pressureFingerprint}};
  }
  /**
   * Schedule: materializes what is due now (at most one new pressure occurrence from the hazard, the reminders, the
   * window-end roll and its row), rebuilds the pending pressure occurrence, and revives waits whose judgment inputs changed.
   * Synchronous and model-free.
   */
  private schedule(scope:SceneScope,characterId:string,gate:ContactGate):ContactPlan&{pressure:PressureRecord|null;materialized:ContactDue|null}{
    const {subject,state,now,targetId,softOnly,fingerprint}=gate,companion=this.authority.companion;
    // Event and scheduled polls share one gate: a pressure contact is materialized only when the hazard fires, never per
    // poll, and a contact is always an opportunity to evaluate, never an invented user event.
    const drive=softOnly?null:this.materializePressure(scope,characterId,gate);
    const reminders=this.authority.commitments.dueTodos(scope,{realNowMs:now,storyNowMs:0},'companion');
    const userTimed=new Set<string>();
    for(const reminder of reminders){
      const record=this.authority.commitments.get(scope,reminder.commitmentId);
      if(!record?.readers.includes(characterId))continue;
      const timedByUser=this.userTimedReminder(state.sources,record);
      // A soft window on a non-Agent host only lets a user-timed reminder through; others are materialized after it.
      if(softOnly&&!timedByUser)continue;
      companion.schedule({subjectId:subject.subjectId,targetId,kind:'schedule',purpose:'commitment_reminder',
      opportunityKey:`commitment:${reminder.commitmentId}:${reminder.revision}`,topic:record.content.slice(0,500),
      basis:[{kind:'schedule',id:reminder.commitmentId,revision:reminder.revision}],sourceVersion:state.version,nowMs:now,fingerprint,
      seedKind:'reminder'});
      if(timedByUser)userTimed.add(`${reminder.commitmentId}@${reminder.revision}`);
    }
    // A hard window the user set has just ended and the user has not written since it began: she may reach out first, at
    // most once per window instance, when its one seeded roll says so (user decision 2026-09-28). Whether to send is not
    // asked; what to say is generated in the tone drawn from the same seed.
    const windowEnd=softOnly?null:this.windowEndGate(scope,characterId,subject.subjectId,targetId,state,now);
    const windowEndRow=windowEnd?companion.schedule({subjectId:subject.subjectId,targetId,kind:'window_end',purpose:'window_end_longing',
      opportunityKey:windowEnd.key,topic:WINDOW_END_FRAMING[windowEnd.tone].topic,
      basis:[{kind:'window',id:windowEnd.window.commitmentId,revision:windowEnd.window.revision}],sourceVersion:state.version,nowMs:now,
      expiresAtMs:windowEnd.window.endsAtMs+WINDOW_END_GRACE_MS,fingerprint,seedKind:'window_end'}):null;
    companion.reviveDeferred(subject.subjectId,targetId,fingerprint,now,gate.pressureFingerprint);
    const opened=drive?.opened??null;
    return {userTimed,windowEnd,windowEndOccurrenceId:windowEndRow?.occurrenceId??null,pressure:drive?.record??null,
      materialized:opened?{opportunityId:opened.opportunityId,occurrenceId:opened.occurrenceId,kind:opened.kind,
        seedKind:contactSeedKind(opened),exempt:false,checkAtMs:opened.checkAtMs}:null};
  }
  /**
   * The plan evaluate judges against, read back without scheduling: the user-timed reminders due now and the window-end
   * seed whose recorded roll says send (its tone and quiet start recomputed from that roll, never rolled again). A row
   * schedule() would not have built (its lifetime already over) is not named either.
   */
  private recordedPlan(scope:SceneScope,characterId:string,gate:ContactGate):ContactPlan{
    const {subject,state,now,targetId,softOnly}=gate,companion=this.authority.companion;
    const userTimed=new Set<string>();
    for(const reminder of this.authority.commitments.dueTodos(scope,{realNowMs:now,storyNowMs:0},'companion')){
      const record=this.authority.commitments.get(scope,reminder.commitmentId);
      if(record?.readers.includes(characterId)&&this.userTimedReminder(state.sources,record))userTimed.add(`${reminder.commitmentId}@${reminder.revision}`);
    }
    const windowEnd=softOnly?null:this.recordedWindowEnd(scope,characterId,subject.subjectId,targetId,state,now);
    const row=windowEnd&&windowEnd.window.endsAtMs+WINDOW_END_GRACE_MS>now?
      companion.latestOccurrence(subject.subjectId,targetId,windowEnd.key,'window_end'):null;
    return {userTimed,windowEnd,windowEndOccurrenceId:row?.occurrenceId??null};
  }
  /** What is due for this target, and the one opportunity a check takes first. */
  private select(gate:ContactGate,trigger:'event'|'scheduled',plan:ContactPlan){
    // A window-end row whose window no longer qualifies (the user wrote, another window followed) is never judged as an
    // ordinary contact; it is left to expire.
    const due=this.authority.companion.due(gate.subject.subjectId,trigger,gate.now).filter(item=>item.targetId===gate.targetId&&
      (item.kind!=='window_end'||item.occurrenceId===plan.windowEndOccurrenceId));
    const isUserTimed=(item:CompanionOpportunity)=>item.purpose==='commitment_reminder'&&
      item.basis.some(basis=>basis.kind==='schedule'&&plan.userTimed.has(`${basis.id}@${basis.revision}`));
    const isWindowEnd=(item:CompanionOpportunity)=>item.kind==='window_end';
    // A reminder at a time the user chose is her keeping her word: it goes first, on time, and is never rewritten as longing.
    const opportunity=due.find(isUserTimed)??due.find(isWindowEnd)??due[0];
    const ordered=[...due.filter(isUserTimed),...due.filter(item=>!isUserTimed(item)&&isWindowEnd(item)),
      ...due.filter(item=>!isUserTimed(item)&&!isWindowEnd(item))];
    return {due,ordered,opportunity,isUserTimed,onTimeReminder:opportunity!==undefined&&isUserTimed(opportunity),
      windowEndNow:opportunity!==undefined&&isWindowEnd(opportunity)};
  }
  /**
   * A check that ends before any judgment: a soft window closes a non-Agent host to all but a user-timed reminder
   * (cancelling pending contact), and nothing due leaves the target waiting.
   */
  private settle(gate:ContactGate,selection:ContactSelection){
    const companion=this.authority.companion;
    if(gate.softOnly&&!selection.onTimeReminder){
      companion.cancelPendingForTarget(gate.subject.subjectId,gate.targetId,'contact_restriction_soft',gate.now);
      return {status:'waiting',reason:'contact_restriction_soft'};
    }
    if(!selection.opportunity)return {status:'waiting',state:companion.status(gate.subject.subjectId,gate.targetId)};
    return null;
  }
  /**
   * Judge: the pathology guards, the soft-window rules and the G3 budget, then prepareContext -> decide -> recordJudgment
   * -> generate -> queue. Never creates an opportunity row.
   */
  private async judge(scope:SceneScope,characterId:string,trigger:'event'|'scheduled',configs:Configurations,assertCurrent:()=>void,
    gate:ContactGate,plan:ContactPlan,selection:ContactSelection,opportunity:CompanionOpportunity){
    const {subject,state,now,targetId,correction}=gate,companion=this.authority.companion;
    const {onTimeReminder,windowEndNow}=selection,fingerprint=this.judgmentFingerprint(gate,opportunity);
    const quiet=this.contactQuiet(gate,opportunity);
    // Neither asks the local judgment; both record the soft windows they are sent in without using their exception.
    const exempt=onTimeReminder||windowEndNow;
    // Only a drive contact may ask to break a soft window, and only as a longing message on the Agent host (any other host
    // reaches this with soft windows only for a pressure occurrence in the last cell of a window, which then waits for it).
    const exceptionPath=quiet.length>0&&!exempt&&opportunity.purpose==='gentle_contact'&&subject.host==='agent';
    // The window-end longing still stops at the pathology guards; a user-timed reminder does not.
    if(!onTimeReminder){
      const guard=companion.contactGuard(subject.subjectId,targetId,now);
      if(guard)return {status:'waiting',reason:`guard_${guard.guard}`,...(guard.untilMs===null?{}:{untilMs:guard.untilMs})};
    }
    if(quiet.length&&!exempt&&!exceptionPath)
      return this.deferOpportunity(opportunity,state.version,this.contactQuietEnd(scope,characterId,now,state,opportunity),'soft_window',fingerprint);
    // One exception per window instance: once it is used, or was declined for this window, the contact waits for the
    // window to end instead of standing at the head of the queue on every poll.
    const exceptionStatuses=exceptionPath?quiet.map(binding=>companion.quietExceptionStatus(subject.subjectId,targetId,binding)):[];
    if(exceptionStatuses.some(status=>status!=='available'))
      return this.deferOpportunity(opportunity,state.version,this.contactQuietEnd(scope,characterId,now,state,opportunity),
        exceptionStatuses.includes('declined')?'contact_exception_declined':'contact_exception_used',fingerprint);
    // An invitation ("you may contact me") raises permission but is no obligation: it reaches the judgment as contact
    // state, and her own judgment still decides, inside and outside soft windows alike.
    const invitation=correction==='send'||correction==='initiate';
    const judged=!exempt;
    if(subject.host==='agent'&&this.requireLocalDecisions&&!this.decisionProvider&&judged)throw new Error('agentjev_unavailable');
    if(judged){
      const budget=companion.evaluationBudget(subject.subjectId,targetId,exceptionPath&&this.decisionProvider?2:1,now);
      if(!budget.allowed)return {status:'waiting',reason:'guard_G3',untilMs:budget.untilMs};
    }
    const path:ContactPath={opportunity,exempt,exceptionPath,judged,invitation,onTimeReminder,windowEndNow,windowEnd:plan.windowEnd};
    const prepared=await this.prepareContext(scope,characterId,configs,assertCurrent,gate,path);
    if('result' in prepared)return prepared.result;
    const decided=await this.decide(scope,characterId,configs,assertCurrent,gate,path,prepared);
    const recorded=this.recordJudgment(scope,characterId,gate,path,decided);
    if('result' in recorded)return recorded.result;
    const body=await this.generate(trigger,configs,assertCurrent,gate,path,prepared);
    return this.queue(scope,characterId,gate,path,prepared,decided,recorded.judgment,body);
  }
  /**
   * The judged context: retrieval, strategy, the decision task, the quiet-exception candidate and, for the local judgment,
   * the bounded contact context with its summary (the only host job before the decision besides the candidate).
   */
  private async prepareContext(scope:SceneScope,characterId:string,configs:Configurations,assertCurrent:()=>void,
    gate:ContactGate,path:ContactPath){
    const {actor,subject,state,now,targetId}=gate,companion=this.authority.companion;
    const {opportunity,exceptionPath,windowEndNow,windowEnd,judged,invitation}=path,fingerprint=this.judgmentFingerprint(gate,opportunity);
    const contactEmotion=this.contactEmotion(scope,characterId,now,state);
    const priorAddress=state.sources.filter(source=>source.status==='accepted'&&source.envelope.targetId===characterId).at(-1);
    const context=await this.core.contextFrom(this.authority.snapshot(scope,characterId,state),exceptionPath?'此刻适合表达思念的真实共同经历':
      windowEndNow?WINDOW_END_FRAMING[windowEnd?.tone??'care'].query:opportunity.topic,configs,
      contactEmotion.emotion,this.authority.preferences(scope,characterId,state),assertCurrent,now,
      sceneExpressionOptions(this.authority,scope,characterId,
        priorAddress?.envelope??{targetId:characterId,mode:'direct',presentIds:[characterId]},state,
        contactEmotion.emotion,now,contactEmotion.affect));
    context.context+=this.authority.worldContext(scope,characterId,state);
    context.context+=this.authority.commitments.projectPersistent(scope,{characterId,purpose:'expression',mode:'companion'}).systemText;
    // Turning off personalization must not prevent an independently enabled greeting.
    const strategy=await this.strategy(scope,characterId,context.context,configs,assertCurrent,'proactive')??this.basicStrategy(subject.subjectId,opportunity.purpose);
    const activity=companion.activity(subject.subjectId);
    const task=companionDecisionPrompt(opportunity,strategy,{nowMs:now,unansweredCount:activity.unansweredCount,
      busyUntilMs:activity.busyUntilMs,lastUserActivityAtMs:activity.lastUserActivityAtMs});
    const assessmentInput=this.authority.relationshipAssessmentInput(scope,characterId);
    const assessment=assessmentInput?this.authority.relationshipAssessments.read(assessmentInput):null;
    const correctedChoice=assessment?.contactCorrected?assessment.contactChoice:null;
    const quietCandidate=exceptionPath?await this.quietExceptionCandidate(actor,context.context,strategy,configs,now):null;
    const personalKey=this.learningScope(scope,characterId);
    let detail:ContactContext|null=null;
    if(judged&&this.decisionProvider&&subject.host==='agent'){
      if(!this.decisionProvider.summarizeContact)throw new Error('contact_summary_provider_required');
      const sources=contactSources(state.sources,characterId,now);
      // The judged context is bounded (a persona digest, the newest direct sources that fit the summary input, at most
      // CONTACT_SOURCE_REF_LIMIT cited refs). What can never be left out (the contact windows) is checked before any summary
      // job runs; if it, or the finished context, does not fit, the opportunity waits an hour (one diagnostic row per
      // target, cleared after seven days) instead of rejecting the poll or rerunning the summary job on every poll.
      const tooLarge=()=>{
        companion.recordPollDiagnostic(subject.subjectId,targetId,'contact_context_too_large',
          {stage:'contact_context',code:'contact_context_too_large'},now);
        const deferred=this.deferOpportunity(opportunity,state.version,(opportunity.pressure?gridFloor(now):now)+HOUR,
          'contact_context_too_large',fingerprint);
        return {result:deferred.status==='deferred'?{status:'waiting',reason:'contact_context_too_large',nextCheckAtMs:deferred.nextCheckAtMs}:deferred};
      };
      // Same reading rules as the reply strategy (real-user entries past the same evidence threshold); guesses reach the
      // judgment marked uncertain by contactContext, never as facts.
      const entries=this.authority.userModel.listEntries(subject.subjectId,{purpose:'proactive',taskPurpose:'proactive',
        characterId,sessionId:scope.sessionId,nowMs:now});
      const commitments=this.authority.commitments.list(scope,{readerId:characterId,status:'active',mode:'companion'});
      const currentEmotion=JSON.stringify(compactOpenHerForContact(contactEmotion.emotion));
      const preset=this.authority.presets.status(scope);
      const fixed={sources,nowMs:now,commitments,
        persona:contactPersonaDigest(actor.persona,preset?.status==='ready'&&preset.characterId===characterId?preset.preset:null),
        emotion:currentEmotion,timeZone:this.authority.interactions.clock(scope).timeZone??'UTC',affect:contactEmotion.affect,
        ...(invitation?{contactState:{invitation:true}}:{})};
      if(!contactContextFits(fixed))return tooLarge();
      try{
        const summary=sources.length?await (async()=>{
          const summaryTask=contactSummaryTask(sources,now);
          const raw=await this.decisionProvider!.summarizeContact!(summaryTask.messages);assertCurrent();
          return decodeContactSummary(raw,summaryTask.sources);
        })():{summary:'无近期互动',sources:[]};
        detail=contactContext({...fixed,summary,entries});
      }catch(error){
        if(!(error instanceof Error)||error.message!=='contact_context_too_large')throw error;
        return tooLarge();
      }
    }
    return {context,strategy,task,assessment,correctedChoice,quietCandidate,personalKey,detail};
  }
  /** Decide: the local judgment (and the quiet-exception judgment), the user's boundary, or the host-model decision. */
  private async decide(scope:SceneScope,characterId:string,configs:Configurations,assertCurrent:()=>void,
    gate:ContactGate,path:ContactPath,prepared:PreparedContact){
    const {subject,state,controls,now,targetId}=gate,companion=this.authority.companion;
    const {opportunity,exempt,exceptionPath,judged,onTimeReminder,windowEndNow}=path,quiet=this.contactQuiet(gate,opportunity);
    const {task,assessment,correctedChoice,quietCandidate,personalKey,detail}=prepared;
    let judgment:ContactJudgment|null=null;
    const learningTraces:LearningTrace[]=[];
    if(judged&&this.decisionProvider&&subject.host==='agent'){
      companion.recordEvaluation(subject.subjectId,targetId,opportunity.occurrenceId,'contact',now);
      judgment=await this.decisionProvider.decideContact({context:detail!,
        opportunity:exceptionPath?{purpose:'longing_exception',topic:'仅简短诉说思念，不提醒或要求回复',basis:opportunity.basis}:
          {purpose:opportunity.purpose,topic:opportunity.topic,basis:opportunity.basis},
        ...(quietCandidate===null?{}:{candidateBody:quietCandidate})},personalKey??undefined);
      learningTraces.push(...judgment.learningTraces??[]);
      if(!judgment||!['send','wait','skip'].includes(judgment.choice)||
        !['positive','uncertain','negative'].includes(judgment.experience)||
        !['aligned','uncertain','conflicting'].includes(judgment.emotion))throw new Error('agentjev_invalid_response');
      if(judgment.choice==='send'&&(judgment.experience!=='positive'||judgment.emotion!=='aligned'))
        judgment={...judgment,rawChoice:'send',choice:judgment.experience==='negative'||judgment.emotion==='conflicting'?'skip':'wait'};
    }
    // Only the user's boundary (wait/skip) overrides her judgment; an invitation never approves by itself.
    let choice:'send'|'wait'|'skip'|null=exempt?'send':
      correctedChoice==='wait'||correctedChoice==='skip'?correctedChoice:judgment?.choice??null;
    let quietVerdict:'positive'|'uncertain'|'negative'|null=null;
    if(exceptionPath&&choice==='send'){
      if(!this.decisionProvider?.decideQuietException||!detail||!quietCandidate)throw new Error('agentjev_quiet_exception_unavailable');
      const restrictions=quiet.map(binding=>({windowKey:binding.key,content:binding.kind==='sleep'?SLEEP_WINDOW_CONTENT:
        this.authority.commitments.get(scope,binding.commitmentId)?.content??''}));
      companion.recordEvaluation(subject.subjectId,targetId,opportunity.occurrenceId,'quiet_exception',now);
      const result=await this.decisionProvider.decideQuietException({context:detail,quiet:restrictions,candidateBody:quietCandidate},personalKey??undefined);
      quietVerdict=typeof result==='string'?result:result.verdict;
      if(typeof result!=='string')learningTraces.push(...result.learningTraces);
      if(quietVerdict!=='positive'&&quietVerdict!=='uncertain'&&quietVerdict!=='negative')throw new Error('agentjev_invalid_response');
      if(quietVerdict!=='positive')choice=quietVerdict==='negative'?'skip':'wait';
    }
    this.assertContactCurrent(scope,characterId,state.version,controls.revision,opportunity,assessment?.revision??0,quiet);
    let decision:CompanionDecisionOutput;
    if(choice){
      const reason=onTimeReminder?'user_timed_reminder':windowEndNow?'window_end_longing':judgment?
        `AgentJev: experience=${judgment.experience}; emotion=${judgment.emotion}; choice=${choice}; raw=${judgment.rawChoice??judgment.choice}; quiet=${quietVerdict??'none'}`:'用户明确联系纠正';
      // A wait keeps the opportunity: it is re-judged at the fallback check or as soon as a substantive input changes.
      decision=choice==='send'?{schema:'xldb-companion-decision-v1',decision:'approve',reason,nextCheckAtMs:null}:
        choice==='wait'?{schema:'xldb-companion-decision-v1',decision:'defer',reason:`${reason}; invalidateOn=${INVALIDATE_ON}`,
          nextCheckAtMs:this.fallbackCheckAt(subject.subjectId,targetId,now,!!opportunity.pressure)}:
        {schema:'xldb-companion-decision-v1',decision:'dismiss',reason,nextCheckAtMs:null};
    }else{
      companion.recordEvaluation(subject.subjectId,targetId,opportunity.occurrenceId,'host',now);
      decision=decodeCompanionDecision(await this.models.structuredTask(configs.proactiveDecision,task.messages),task);
      // A pressure occurrence measures the host's delay from the start of the grid cell (see deferOpportunity).
      if(decision.decision==='defer'&&opportunity.pressure)decision={...decision,nextCheckAtMs:decision.nextCheckAtMs!-(now-gridFloor(now))};
      // The host-model path keeps its own bound on repeated defers.
      if(decision.decision==='defer'&&(opportunity.deferCount>=3||decision.nextCheckAtMs!>Math.min(opportunity.windowEndMs,opportunity.expiresAtMs)))
        decision={schema:'xldb-companion-decision-v1',decision:'dismiss',reason:'No remaining permitted check within this opportunity.',nextCheckAtMs:null};
    }
    assertCurrent();
    return {decision,quietVerdict,learningTraces};
  }
  /**
   * The one point where a judged decision is recorded in the occurrence's judgment memory: a wait is stored as a defer, a
   * skip dismisses the row (a declined exception holds for the whole window instance), and a send hands the judgment to
   * queue, which records it with the delivery.
   */
  private recordJudgment(scope:SceneScope,characterId:string,gate:ContactGate,path:ContactPath,decided:DecidedContact):
    {result:{status:string;reason:string;nextCheckAtMs?:number}}|{judgment:JudgmentInput}{
    const {subject,state,targetId}=gate,companion=this.authority.companion,{opportunity}=path,{decision,quietVerdict}=decided;
    const quiet=this.contactQuiet(gate,opportunity);
    const fingerprint=this.judgmentFingerprint(gate,opportunity);
    const choice=decision.decision==='approve'?'send':decision.decision==='defer'?'wait':'skip';
    // A skip of a pressure occurrence records the pressure at the decision (P_dec): its seed opens a next generation only
    // above P_dec + delta. Other seeds are not affected.
    const recorded:JudgmentInput={choice,fingerprint,...this.seedJudgment(opportunity),
      ...(choice==='skip'&&opportunity.pressure?{pressureAtDecision:this.currentPressure(scope,characterId,gate)}:{})};
    if(decision.decision==='defer')
      return {result:this.deferOpportunity(opportunity,state.version,decision.nextCheckAtMs!,decision.reason,fingerprint)};
    if(decision.decision==='dismiss'){
      const claim=companion.claim(opportunity.opportunityId,'scene-companion',state.version);
      companion.decide(opportunity.opportunityId,claim.claimToken,{decision:'dismiss',reason:decision.reason},state.version,Date.now(),recorded);
      // A declined exception holds for the whole window instance, not only for the occurrence that asked.
      if(quietVerdict==='negative')companion.declineQuietException(subject.subjectId,targetId,opportunity.occurrenceId,quiet,Date.now());
      return {result:{status:'dismissed',reason:decision.reason}};
    }
    return {judgment:recorded};
  }
  /** Generate: the approved text, one method per purpose (the quiet-exception candidate was written before the decision). */
  private async generate(trigger:'event'|'scheduled',configs:Configurations,assertCurrent:()=>void,
    gate:ContactGate,path:ContactPath,prepared:PreparedContact):Promise<string>{
    const {actor,now}=gate,{opportunity,windowEndNow,windowEnd}=path,{context,strategy,quietCandidate}=prepared;
    let body=quietCandidate??(windowEndNow?await this.windowEndBody(actor,context.context,strategy,configs,trigger,now,windowEnd):null)??
      await this.contactBody(actor,context.context,strategy,configs,trigger,now,opportunity);assertCurrent();
    body=await ensureCompanionIdentityBody(body,null,(instruction,original)=>this.models.generate(instruction,
      context.context,JSON.stringify({original}),configs.proactive));assertCurrent();
    return body;
  }
  /** Queue: the approved text becomes the one pending delivery the host may take. */
  private queue(scope:SceneScope,characterId:string,gate:ContactGate,path:ContactPath,prepared:PreparedContact,decided:DecidedContact,
    judgment:JudgmentInput,body:string){
    const {state,controls}=gate,companion=this.authority.companion,{opportunity,exempt}=path;
    const fingerprint=this.judgmentFingerprint(gate,opportunity),quiet=this.contactQuiet(gate,opportunity);
    this.assertContactCurrent(scope,characterId,state.version,controls.revision,opportunity,prepared.assessment?.revision??0,quiet);
    const claim=companion.claim(opportunity.opportunityId,'scene-companion',state.version);
    let delivery;
    // A user-timed reminder or window-end longing records the soft windows it was sent in but does not use their one exception.
    try{delivery=companion.approveAndQueueDelivery(opportunity.opportunityId,claim.claimToken,prepared.strategy,body,state.version,Date.now(),quiet,
      {exemptQuiet:exempt,judgment});}
    catch(error){
      // Another delivery took this window's exception meanwhile: wait for the window to end like any used exception.
      if(error instanceof Error&&error.message==='companion_quiet_exception_unavailable')
        return this.deferOpportunity(opportunity,state.version,this.contactQuietEnd(scope,characterId,Date.now(),this.authority.state(scope),opportunity),
          'contact_exception_used',fingerprint,claim.claimToken);
      throw error;
    }
    if(prepared.personalKey)this.authority.personalLearning.captureDelivery(prepared.personalKey,delivery.deliveryId,decided.learningTraces);
    return {status:'ready',deliveryId:delivery.deliveryId,body:delivery.body,characterId};
  }
  private async quietExceptionCandidate(actor:ContactGate['actor'],context:string,strategy:FrontendStrategy,configs:Configurations,
    nowMs:number):Promise<string|null>{
    let candidate:string|null=await this.models.generate(
      `你只扮演${actor.name}。${actor.persona}${companionIdentityGuidance(null)}\n现在是你已承诺不主动联系的时段。只有在另行审定这条候选正文确实会让用户开心后才可能破例。请写一条最多300字的简短思念表达，不要求用户回复，不提醒其它事情，不催促，不解释后台判断，也不编造用户此刻的情况。只输出将实际发送的角色正文。`,
      context+'\n沟通建议：'+JSON.stringify(strategy),JSON.stringify({purpose:'quiet_exception_longing',nowMs}),configs.proactive);
    if(candidate!==null)candidate=await ensureCompanionIdentityBody(candidate,null,
      (instruction,original)=>this.models.generate(instruction,context,JSON.stringify({original}),configs.proactive));
    if(candidate!==null&&(!candidate.trim()||candidate.length>300))throw new Error('invalid_quiet_exception_body');
    return candidate;
  }
  private windowEndBody(actor:ContactGate['actor'],context:string,strategy:FrontendStrategy,configs:Configurations,
    trigger:'event'|'scheduled',nowMs:number,windowEnd:WindowEndChoice|null){
    return this.models.generate(
      `你只扮演${actor.name}。${actor.persona}${companionIdentityGuidance(null)}\n用户先前明确指定的勿扰时段刚刚结束。输入中的 quietSince 是对方安静下来的当地时间（HH:MM）：从那时起对方没有再来消息，你也没有打扰对方；userChattedInWindow 为 true 表示时段内你们还聊过。现在第一时间主动发一条简短消息（最多300字），${WINDOW_END_FRAMING[windowEnd?.tone??'care'].opening}。输入中的 tone 是这次的语气方向：${WINDOW_END_FRAMING[windowEnd?.tone??'care'].direction}。可以用“自从你 quietSince 左右安静下来”这样的说法；不要说自己整晚或整段时间都没联系对方，不编造你没有经历过的事，不追问对方在做什么或为什么没消息，不抱怨，不催促或要求回复，不提醒其它事情，不解释后台检查，也不编造用户此刻的情况。只输出将实际发送的角色正文。`,
      context+'\n沟通建议：'+JSON.stringify(strategy),JSON.stringify({purpose:'window_end_longing',trigger,nowMs,
        windowEndedAtMs:windowEnd?.window.endsAtMs??null,quietSince:windowEnd?.quietSince??null,quietSinceMs:windowEnd?.quietSinceMs??null,
        userChattedInWindow:windowEnd?.userChattedInWindow??false,tone:windowEnd?.tone??null}),configs.proactive);
  }
  private contactBody(actor:ContactGate['actor'],context:string,strategy:FrontendStrategy,configs:Configurations,
    trigger:'event'|'scheduled',nowMs:number,opportunity:CompanionOpportunity){
    return this.models.generate(`你只扮演${actor.name}。${actor.persona}${companionIdentityGuidance(null)}\n这是没有用户新输入时、已经批准的主动联系机会，此刻应执行该机会的沟通目的。输入中的来源是过去已接受的正文，不是用户正在对你说的新消息。若目的为提醒，现在给出提醒，不要再次答应以后提醒；不要向用户解释后台检查或调度。主动发起一次简短陪伴，不替用户说话，不推测未回复原因，不催促。按真实来源和用户边界决定措辞；只输出待发给用户的角色正文。`,
      context+'\n沟通建议：'+JSON.stringify(strategy),JSON.stringify({purpose:opportunity.purpose,trigger,nowMs,acceptedBasis:opportunity.topic}),configs.proactive);
  }
  claim(scope:SceneScope,characterId:string,deliveryId:string,host:string){
    const subject=this.requireSubject(scope);
    if(subject.host==='agent'&&this.authority.userModel.contactPaused(subject.subjectId,this.target(scope,characterId)))
      throw new Error('companion_contact_paused');
    const assessmentInput=this.authority.relationshipAssessmentInput(scope,characterId);
    const assessment=assessmentInput?this.authority.relationshipAssessments.read(assessmentInput):null;
    if(assessment?.contactCorrected&&['wait','skip'].includes(assessment.contactChoice))throw new Error('companion_contact_paused');
    const delivery=this.checkDelivery(scope,characterId,deliveryId);
    if(companionIdentityIssue(delivery.body,null))throw new Error('companion_identity_expression_invalid');
    if(!this.contactWindowCurrent(this.authority.state(scope).sources,characterId,delivery.createdAtMs,Date.now()))
      throw new Error('companion_delivery_unavailable');
    // A pressure occurrence's text is claimed against the soft windows as they count for it (see pressureQuietAt).
    const pressure=Boolean(this.authority.companion.getOpportunity(delivery.opportunityId)?.pressure);
    const claim=this.authority.companion.claimDelivery(deliveryId,host,this.authority.state(scope).version,Date.now(),60_000,
      ()=>pressure?this.pressureQuietAt(scope,characterId,Date.now()):this.quietAt(scope,characterId,Date.now()));
    return {deliveryId,claimToken:claim.claimToken,body:claim.delivery.body,characterId};
  }
  receipt(scope:SceneScope,characterId:string,deliveryId:string,claimToken:string,outcome:{status:'sent';hostMessageId:string}|{status:'failed'|'unknown';code:string}){
    this.checkDelivery(scope,characterId,deliveryId);
    return this.authority.companion.recordDelivery(deliveryId,claimToken,outcome);
  }
  reconcile(scope:SceneScope,characterId:string,deliveryId:string,outcome:{status:'sent';hostMessageId:string}|{status:'failed';code:string}){
    this.checkDelivery(scope,characterId,deliveryId);
    return this.authority.companion.reconcileUnknown(deliveryId,outcome);
  }
  acceptedMessage(scope:SceneScope,characterId:string,deliveryId:string):SceneMessage{
    const delivery=this.checkDelivery(scope,characterId,deliveryId);
    if(delivery.status!=='host_committed')throw new Error('companion_delivery_not_accepted');
    // Accepted at the exact confirmation time: the OpenHer state this send persists (E0 of the pressure model) is anchored
    // at her raw confirmation, never moved to a grid cell (controller decision 12).
    return {id:`proactive:${deliveryId}`,revision:1,role:'assistant',text:delivery.body,acceptedAtMs:delivery.updatedAtMs,
      envelope:{targetId:characterId,mode:'direct',presentIds:[characterId]},speakerId:characterId};
  }
  private checkDelivery(scope:SceneScope,characterId:string,deliveryId:string){
    this.actor(scope,characterId);const subject=this.requireSubject(scope),delivery=this.authority.companion.getDelivery(deliveryId);
    if(!delivery||delivery.subjectId!==subject.subjectId||delivery.targetId!==this.target(scope,characterId))throw new Error('companion_delivery_not_found');
    return delivery;
  }
  private basicStrategy(subjectId:string,purpose:string):FrontendStrategy{
    const controls=this.authority.userModel.controls(subjectId);
    return {strategyId:'basic',purpose,supportMode:'gentle',allowedTopics:[],knownFacts:[],uncertainFacts:[],tone:'温和自然',length:'short',questionBudget:0,
      avoidRepeating:[],stopConditions:['用户忙碌、拒绝或不想回复时停止。'],sourceVersions:{profileRevision:this.authority.userModel.profileRevision(subjectId),controlsRevision:controls.revision,entryRevisions:{}}};
  }
  private target(scope:SceneScope,characterId:string){return this.authority.companionTarget(scope,characterId);}
  private assertRelationshipRevision(scope:SceneScope,characterId:string,revision:number):void {
    const input=this.authority.relationshipAssessmentInput(scope,characterId);
    if(!input)return;
    if((this.authority.relationshipAssessments.read(input)?.revision??0)!==revision)throw new Error('context_changed_retry');
  }
  private assertContactCurrent(scope:SceneScope,characterId:string,sourceVersion:number,controlsRevision:number,
    opportunity:CompanionOpportunity,relationshipRevision:number,quiet:readonly QuietExceptionBinding[]):void {
    const subject=this.requireSubject(scope);
    if(this.authority.state(scope).version!==sourceVersion||this.authority.userModel.controls(subject.subjectId).revision!==controlsRevision||
      this.authority.userModel.profileRevision(subject.subjectId)!==opportunity.profileRevision||
      this.authority.companion.activity(subject.subjectId).revision!==opportunity.activityRevision||
      this.authority.companion.contactSettings(subject.subjectId).revision!==opportunity.contactRevision||
      this.authority.userModel.contactPaused(subject.subjectId,this.target(scope,characterId)))
      throw new Error('context_changed_retry');
    // A pressure occurrence compares the soft windows as they count for it (see pressureQuietAt), any other the M1 reading.
    const current=opportunity.pressure?this.pressureQuietAt(scope,characterId,Date.now()):this.quietAt(scope,characterId,Date.now());
    if(current===null||!this.sameQuietBindings(current,quiet))throw new Error('context_changed_retry');
    this.assertRelationshipRevision(scope,characterId,relationshipRevision);
  }
  private contactWindowCurrent(sources:readonly import('../../../shared/src/scene/types.ts').SceneSource[],characterId:string,createdAtMs:number,nowMs:number):boolean {
    return nowMs-createdAtMs<=CONTACT_TEXT_MS&&this.contactSourcesSame(sources,characterId,createdAtMs,nowMs);
  }
  /** The recent direct exchange a pending text was written against is still exactly the recent exchange now. */
  private contactSourcesSame(sources:readonly import('../../../shared/src/scene/types.ts').SceneSource[],characterId:string,createdAtMs:number,nowMs:number):boolean {
    const refs=(atMs:number)=>contactSources(sources,characterId,atMs).map(source=>`${source.id}@${source.revision}`);
    return JSON.stringify(refs(createdAtMs))===JSON.stringify(refs(nowMs));
  }
  /**
   * Current soft windows, or null when contact is strictly closed. Besides quiet promises, the user's own fresh goodnight
   * is a soft window (one exception at most, judged like a promise); displeasure at such an exception closes contact until
   * the user writes again.
   */
  private quietAt(scope:SceneScope,characterId:string,nowMs:number,state=this.authority.state(scope)):QuietExceptionBinding[]|null {
    const current=this.authority.commitments.listActiveContactRestrictions(scope,{obligorId:characterId,readerId:characterId})
      .map(record=>contactRestrictionWindow(record,nowMs)).filter(window=>window!==null);
    if(current.some(window=>window.level==='hard'))return null;
    if(this.sleepHardening(scope,characterId,nowMs,state))return null;
    const bindings:QuietExceptionBinding[]=current.map(window=>({scopeKey:scopeKey(scope),commitmentId:window.commitmentId,revision:window.revision,
      key:window.key,sourceId:window.sourceId,sourceRevision:window.sourceRevision,kind:'commitment'}));
    const sleep=this.sleepSource(scope,state,characterId,nowMs);
    if(sleep)bindings.push({scopeKey:scopeKey(scope),commitmentId:`sleep:${sleep.id}`,revision:sleep.revision,
      key:`sleep:${sleep.id}@${sleep.revision}`,sourceId:sleep.id,sourceRevision:sleep.revision,kind:'sleep'});
    return bindings;
  }
  /**
   * The goodnight window only exists for the Agent host, whose soft windows reach the local exception judgment; any other
   * host would have to close contact entirely, including the reminders the user asked for.
   */
  private sleepSource(scope:SceneScope,state:ReturnType<SceneAuthority['state']>,characterId:string,nowMs:number){
    if(this.authority.subject(scope)?.host!=='agent')return null;
    return explicitSleepSource(contactSources(state.sources,characterId,nowMs));
  }
  /** The latest user message when it is the first, explicitly negative reply to a delivered sleep-window exception. */
  private sleepHardening(scope:SceneScope,characterId:string,nowMs:number,state=this.authority.state(scope)):SceneMessage|null {
    const subject=this.authority.subject(scope);if(subject?.host!=='agent')return null;
    const users=state.sources.filter(source=>source.status==='accepted'&&source.processing==='ready'&&source.role==='user'&&
      source.envelope.mode==='direct'&&source.envelope.targetId===characterId&&source.envelope.presentIds.length===1&&
      source.envelope.presentIds[0]===characterId&&source.acceptedAtMs<=nowMs);
    const latest=users.at(-1);
    if(!latest||explicitContactFeedback(latest.text)!=='negative')return null;
    const previousAtMs=users.at(-2)?.acceptedAtMs??-1,companion=this.authority.companion;
    return companion.confirmedContactDeliveries(subject.subjectId,this.target(scope,characterId)).some(delivery=>delivery.quietException&&
      delivery.confirmedSentAtMs>previousAtMs&&delivery.confirmedSentAtMs<=latest.acceptedAtMs&&
      companion.getDeliveryExceptionBindings(delivery.deliveryId).some(binding=>binding.key.startsWith('sleep:')))?latest:null;
  }
  /**
   * The soft windows as they count for a pressure occurrence at `nowMs`: a soft window counts from its start until the
   * grid point after its end (the windows at `nowMs` and those still open at the start of its grid cell), so a window that
   * ends off the grid inside a cell, such as a goodnight 12 hours on, is read the same by every tick of that cell. Null
   * when contact is strictly closed at `nowMs`; a hard window is never extended. Only windows that end by time are
   * extended: a direct user message after the cell start (at or before `nowMs`) ends a goodnight at once, so the cell-start
   * sleep binding is dropped then (a user message is a state change, so tick equivalence is unaffected).
   */
  private pressureQuietAt(scope:SceneScope,characterId:string,nowMs:number,state=this.authority.state(scope)):QuietExceptionBinding[]|null {
    const current=this.quietAt(scope,characterId,nowMs,state);
    if(current===null)return null;
    const cellStart=gridFloor(nowMs),atCellStart=cellStart===nowMs?null:this.quietAt(scope,characterId,cellStart,state);
    if(!atCellStart)return current;
    const userSince=contactSources(state.sources,characterId,nowMs).some(source=>source.role==='user'&&source.acceptedAtMs>cellStart);
    const key=(binding:QuietExceptionBinding)=>`${binding.commitmentId}@${binding.revision}:${binding.key}`,seen=new Set(current.map(key));
    return [...current,...atCellStart.filter(binding=>!seen.has(key(binding))&&!(userSince&&binding.kind==='sleep'))];
  }
  /** The soft windows one opportunity is judged under: the grid reading for a pressure occurrence, else M1's. */
  private contactQuiet(gate:ContactGate,opportunity:CompanionOpportunity):QuietExceptionBinding[] {
    return opportunity.pressure?gate.pressureQuiet:gate.quiet;
  }
  /** When the soft windows an opportunity waits for end; a pressure occurrence also waits for those of its cell start. */
  private contactQuietEnd(scope:SceneScope,characterId:string,nowMs:number,state:ReturnType<SceneAuthority['state']>,
    opportunity:CompanionOpportunity):number {
    const end=this.quietWindowEnd(scope,characterId,nowMs,state);
    return opportunity.pressure?Math.max(end,this.quietWindowEnd(scope,characterId,gridFloor(nowMs),state)):end;
  }
  private quietWindowEnd(scope:SceneScope,characterId:string,nowMs:number,state:ReturnType<SceneAuthority['state']>):number {
    const ends=this.authority.commitments.listActiveContactRestrictions(scope,{obligorId:characterId,readerId:characterId})
      .map(record=>contactRestrictionWindow(record,nowMs)).flatMap(window=>window?[window.endsAtMs]:[]);
    const sleep=this.sleepSource(scope,state,characterId,nowMs);
    if(sleep)ends.push(sleep.acceptedAtMs+SLEEP_WINDOW_MS+1);
    return Math.max(nowMs+1,...ends);
  }
  /**
   * The waiting result while an accepted source is not ready. A source whose processing failed (for example commitment
   * decoding threw `invalid_contact_time`, failing closed) stalls proactive contact until it is reprocessed, so the result
   * says why: `pendingReason:"source_processing_failed"` with one diagnostic per failed source (at most
   * SEMANTIC_PENDING_DIAGNOSTICS, in source order) naming the source, the failed stage and its error code, and one row per
   * failed source revision, stage and code is written to the companion poll diagnostics. Sources still being processed keep
   * the plain result.
   */
  private semanticPending(scope:SceneScope,subjectId:string,targetId:string,state:ReturnType<SceneAuthority['state']>,nowMs:number){
    const failed=state.sources.filter(source=>source.status==='accepted'&&source.processing==='failed').slice(0,SEMANTIC_PENDING_DIAGNOSTICS);
    if(!failed.length)return {status:'waiting',reason:'semantic_pending'};
    const progress=this.authority.processing.progress(scope,state,false).sources;
    const diagnostics=failed.map(source=>{
      const stage=progress.find(item=>item.sourceId===source.id&&item.revision===source.revision)?.stages
        .find(item=>item.status==='failed'&&item.failure);
      const diagnostic={sourceId:source.id,revision:source.revision,stage:stage?.stage??null,code:stage?.failure?.code??'operation_failed'};
      this.authority.companion.recordPollDiagnostic(subjectId,targetId,'source_processing_failed',diagnostic,nowMs);
      return diagnostic;
    });
    return {status:'waiting',reason:'semantic_pending',pendingReason:'source_processing_failed',diagnostics};
  }
  /**
   * The window-end seed that may be answered now, or null. Once all conditions of windowEndSeed hold, the window instance is
   * rolled once (user decision 2026-09-28): p = windowEndProbability(quiet before the end, an open drive episode), u the
   * seeded uniform of `subjectId:<key>:<instance end ms>` (or the test override), sent iff u < p, with the tone drawn from
   * the same seed. The roll is recorded in the judgment memory the first time and read back afterwards, so a retry or a
   * later poll never rolls again; a skip is also written once to the poll diagnostics and the instance is never evaluated
   * again.
   */
  private windowEndGate(scope:SceneScope,characterId:string,subjectId:string,targetId:string,
    state:ReturnType<SceneAuthority['state']>,nowMs:number){
    const seed=this.windowEndSeed(scope,characterId,state,nowMs);
    if(!seed)return null;
    const companion=this.authority.companion;
    let roll=companion.windowEndRoll(subjectId,targetId,seed.key);
    if(!roll){
      const rollSeed=`${subjectId}:${seed.key}:${seed.window.endsAtMs}`,quietMs=seed.window.endsAtMs-seed.quietSinceMs;
      const driveOpen=this.driveEpisodeOpen(subjectId,targetId),p=windowEndProbability(quietMs,driveOpen);
      const u=this.windowEndRoll?this.windowEndRoll(rollSeed):windowEndUniform(rollSeed);
      if(typeof u!=='number'||!Number.isFinite(u)||u<0||u>=1)throw new Error('invalid_window_end_roll');
      roll=companion.recordWindowEndRoll(subjectId,targetId,seed.key,{kind:'window_end_roll',decision:u<p?'send':'skip',p,u,
        tone:windowEndTone(rollSeed,quietMs),quietMs,driveOpen,decidedAtMs:nowMs,instanceEndMs:seed.window.endsAtMs},nowMs);
    }
    return roll.decision==='send'?{...seed,tone:roll.tone}:null;
  }
  /** The window-end seed answerable now by its recorded roll, or null (also before it was rolled): read only, never rolls. */
  private recordedWindowEnd(scope:SceneScope,characterId:string,subjectId:string,targetId:string,state:SceneState,nowMs:number):WindowEndChoice|null {
    const seed=this.windowEndSeed(scope,characterId,state,nowMs);
    if(!seed)return null;
    const roll=this.authority.companion.windowEndRoll(subjectId,targetId,seed.key);
    return roll?.decision==='send'?{...seed,tone:roll.tone}:null;
  }
  /**
   * The current drive episode of this target has a drive occurrence (longing, share or check-in, any generation) still
   * pending: waiting, deferred, being judged or approved. Only drive occurrences count (PLAN M3 section 11.12).
   */
  private driveEpisodeOpen(subjectId:string,targetId:string):boolean {
    const companion=this.authority.companion,episode=this.episodeDigest(subjectId,targetId);
    return [`drive:${targetId}:${episode}`,`check_in:${targetId}:${episode}`].some(key=>{
      for(let generation=0;generation<SEED_GENERATION_LIMIT;generation++){
        const occurrence=companion.latestOccurrence(subjectId,targetId,this.generationKey(key,generation),'drive');
        if(!occurrence)return false;
        if(OPEN_DRIVE_STATUSES.includes(occurrence.status)&&!companion.driveOccurrenceClosed(occurrence.occurrenceId))return true;
      }
      return false;
    });
  }
  /**
   * The hard window whose end should be answered with a longing message now, or null. Only on the Agent host, only for a
   * window the user worded (origin `user`; her own windows and hardened ones never), only the latest such instance that
   * ended within the grace period. The instance's quiet start is the later of its effective start (the instance start, or
   * the time the commitment's terms took effect, the acceptance time of the source that set them, when that is later) and
   * the end of the conversation the user was having then: direct user messages after the terms took effect, chained while
   * each comes within CONVERSATION_GAP_MS of the previous one or of the effective start (so the message the commitment
   * answers, a goodnight right after it, or a chat that runs on into the window all count as that conversation), capped at
   * the instance end. It is answered only when:
   * - the instance ends after the terms took effect (a window agreed on midway is answered that same night);
   * - no direct user message came after the quiet start, inside the instance or after its end before this poll;
   * - the quiet lasted at least WINDOW_END_MIN_QUIET_MS before the instance end;
   * - she sent no confirmed contact to the user between the effective start and the instance end;
   * - no other hard window was already running when it ended.
   * The seed carries the quiet start and whether the user chatted inside the instance before it, so the text never claims
   * she stayed silent the whole window. Keyed by commitment and instance, without the revision, so a later revision never
   * answers the same instance again. Pause, a relationship boundary and a running hard window are checked by the caller.
   */
  private windowEndSeed(scope:SceneScope,characterId:string,state:ReturnType<SceneAuthority['state']>,nowMs:number):WindowEndSeed|null {
    const subject=this.authority.subject(scope);
    if(subject?.host!=='agent')return null;
    const records=this.authority.commitments.listActiveContactRestrictions(scope,{obligorId:characterId,readerId:characterId});
    const users=state.sources.filter(source=>source.status==='accepted'&&source.role==='user'&&source.acceptedAtMs<=nowMs&&
      source.envelope.mode==='direct'&&source.envelope.targetId===characterId&&source.envelope.presentIds.length===1&&
      source.envelope.presentIds[0]===characterId).map(source=>source.acceptedAtMs).sort((a,b)=>a-b);
    const sends=this.authority.companion.confirmedContactDeliveries(subject.subjectId,this.target(scope,characterId));
    const ended=records.flatMap(record=>{
      if(record.contactRestriction?.origin!=='user')return [];
      const window=lastEndedContactWindow(record,nowMs);
      if(!window||window.level!=='hard'||nowMs-window.endsAtMs>WINDOW_END_GRACE_MS)return [];
      const effective=state.sources.find(source=>source.id===record.createdSourceId&&source.revision===record.createdSourceRevision)??
        state.sources.find(source=>source.id===record.latestSourceId&&source.revision===record.latestSourceRevision);
      if(!effective||window.endsAtMs<=effective.acceptedAtMs)return [];
      const effectiveStart=Math.max(window.startsAtMs,effective.acceptedAtMs);
      if(sends.some(send=>send.confirmedSentAtMs>=effectiveStart&&send.confirmedSentAtMs<window.endsAtMs))return [];
      if(records.some(other=>contactRestrictionWindow(other,window.endsAtMs)?.level==='hard'))return [];
      let quiet=effective.acceptedAtMs;
      for(const at of users){
        if(at<=quiet)continue;
        if(at-Math.max(quiet,effectiveStart)>CONVERSATION_GAP_MS)break;
        quiet=at;
      }
      const quietSinceMs=Math.min(Math.max(quiet,effectiveStart),window.endsAtMs);
      if(users.some(at=>at>quietSinceMs))return [];
      // A few quiet minutes before the end (「七点前别找我」 at 06:50, or chat until 06:30) are not a kept window.
      if(window.endsAtMs-quietSinceMs<WINDOW_END_MIN_QUIET_MS)return [];
      return [{window,quietSinceMs,userChattedInWindow:users.some(at=>at>=window.startsAtMs&&at<=quietSinceMs)}];
    }).sort((a,b)=>b.window.endsAtMs-a.window.endsAtMs);
    const chosen=ended[0];
    if(!chosen)return null;
    const key=`window_end:${chosen.window.commitmentId}:${chosen.window.key}`;
    const quietSince=new Intl.DateTimeFormat('en-GB',{timeZone:this.authority.interactions.clock(scope).timeZone??'UTC',
      hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(chosen.quietSinceMs);
    return {key:key.length<=200?key:`window_end:${digest(key)}`,...chosen,quietSince};
  }
  /** A reminder whose time the user set in their own words (the deadline or reminder quote is in their accepted source). */
  private userTimedReminder(sources:readonly SceneSource[],record:CommitmentRecord):boolean {
    if(record.term.kind!=='deadline'||record.term.clock!=='real')return false;
    const quote=record.term.reminderQuote??record.term.deadlineQuote;
    const refs=new Set([`${record.createdSourceId}@${record.createdSourceRevision}`,`${record.latestSourceId}@${record.latestSourceRevision}`]);
    return sources.some(source=>source.status==='accepted'&&source.role==='user'&&refs.has(`${source.id}@${source.revision}`)&&
      source.text.includes(quote));
  }
  /**
   * Substantive judgment inputs other than the scene version: user activity, busy state, profile and controls revisions,
   * the user's relationship contact correction, active commitments, the current soft windows and the contact tendency revision.
   */
  private contactFingerprint(scope:SceneScope,characterId:string,subjectId:string,quiet:readonly QuietExceptionBinding[],correction:string|null):string {
    const activity=this.authority.companion.activity(subjectId);
    const commitments=this.authority.commitments.list(scope,{readerId:characterId,status:'active',mode:'companion'})
      .map(record=>`${record.id}@${record.revision}`).sort();
    return JSON.stringify({v:1,user:activity.lastUserActivityAtMs,busy:activity.busyUntilMs,
      profile:this.authority.userModel.profileRevision(subjectId),controls:this.authority.userModel.controls(subjectId).revision,correction,
      commitments:digest(commitments),quiet:digest(quiet.map(binding=>`${binding.commitmentId}@${binding.revision}:${binding.key}`).sort()),
      tendency:this.authority.companion.contactTendency(subjectId,this.target(scope,characterId)).revision});
  }
  /**
   * Fallback re-check after a wait: twice the time since the last interaction with this companion (the user's latest
   * activity or the latest confirmed send to this target; sends to other companions do not count), clamped to one to
   * twelve hours. For a pressure occurrence (`onGrid`) both ends are read as their 5-minute grid cells, so the re-check is a
   * grid point that any tick of five minutes or less reaches in the same cell, whenever inside its cell it judged.
   */
  private fallbackCheckAt(subjectId:string,targetId:string,nowMs:number,onGrid=false):number {
    const activity=this.authority.companion.activity(subjectId);
    let last=Math.max(activity.lastUserActivityAtMs??-1,this.authority.companion.lastConfirmedSendAt(subjectId,targetId)??-1);
    if(onGrid){nowMs=gridFloor(nowMs);if(last>=0)last=gridFloor(last);}
    return nowMs+Math.max(HOUR,Math.min(12*HOUR,last<0?12*HOUR:2*Math.max(0,nowMs-last)));
  }
  /**
   * Stores a wait: the row is deferred and the judgment is kept for its occurrence; a check past its lifetime ends it. A
   * caller that still holds the row's claim passes its token. For a pressure occurrence every re-check lies on the UTC
   * 5-minute grid: a time measured from the check (the wait fallback, the context-too-large hour, a host-model delay) is
   * measured from the start of the check's grid cell by its caller, and every re-check, including the end of a soft window
   * or exception, is rounded up to the next grid point here (its lifetime is on the grid too). Any tick of five minutes or
   * less then re-judges it inside the same grid cell. Other opportunities keep their exact times (M1 behaviour).
   */
  private deferOpportunity(opportunity:CompanionOpportunity,sourceVersion:number,untilMs:number,reason:string,fingerprint:string,
    claimToken?:string){
    const companion=this.authority.companion;
    const token=claimToken??companion.claim(opportunity.opportunityId,'scene-companion',sourceVersion).claimToken;
    const nextCheckAtMs=Math.min(opportunity.pressure?gridCeil(untilMs):untilMs,opportunity.windowEndMs,opportunity.expiresAtMs);
    if(nextCheckAtMs<=Date.now()){
      companion.decide(opportunity.opportunityId,token,{decision:'dismiss',reason:'opportunity_expired'},sourceVersion);
      return {status:'dismissed',reason:'opportunity_expired'};
    }
    companion.decide(opportunity.opportunityId,token,{decision:'defer',nextCheckAtMs,reason},sourceVersion,Date.now(),
      {choice:'wait',fingerprint,...this.seedJudgment(opportunity)});
    return {status:'deferred',reason,nextCheckAtMs};
  }
  /** The fingerprint a judgment of this opportunity stores: the grid-cell reading for a pressure occurrence, else M1's. */
  private judgmentFingerprint(gate:ContactGate,opportunity:CompanionOpportunity):string {
    return opportunity.pressure?gate.pressureFingerprint:gate.fingerprint;
  }
  /** The seed fields a judgment of a pressure occurrence records (none for other opportunities). */
  private seedJudgment(opportunity:CompanionOpportunity):Pick<JudgmentInput,'seedKey'|'seedKind'|'generation'> {
    const pressure=opportunity.pressure,seedKind=contactSeedKind(opportunity);
    return pressure&&seedKind?{seedKey:pressure.seedKey,seedKind,generation:pressure.generation}:{};
  }
  /**
   * The pressure gate (PLAN M3 sections 2 and 5), synchronous and model-free. First the pending pressure occurrence of a
   * current seed is rebuilt exactly as M1 rebuilt a drive episode (a row cancelled by a source, activity or controls
   * change is scheduled again and reuses its stored wait or skip; one closed by a reopen event is not), without the hazard.
   * While one is pending the hazard is zero. Otherwise the hazard of the current epoch is integrated from T0 over the UTC
   * 5-minute grid with the epoch's seeded u; once it fired, at most one new occurrence is materialized for the dominant
   * seed at the trigger, in the next generation of its seed key. The trigger depends only on the state and the seed, so
   * how often anyone polls changes nothing. Returns the pressure record read (the trigger, or the state now) and the
   * occurrence opened by this call, if any.
   */
  private materializePressure(scope:SceneScope,characterId:string,gate:ContactGate):{record:PressureRecord|null;opened:CompanionOpportunity|null} {
    const {subject,state,now,targetId}=gate,fingerprint=gate.pressureFingerprint,subjectId=subject.subjectId,companion=this.authority.companion;
    const context=this.pressureContext(scope,characterId,gate);
    // An injected reading has no history: its hysteresis is read and cleared at this instant, as the M1 gate did.
    const point=context.injected?this.injectedPoint(context,true):null;
    let pending=false;
    for(const history of context.histories){
      const latest=history.generations.at(-1),last=latest?.opportunity;
      // A drive row written before M3 (no pressure record) keeps the M1 fingerprint, as its judgment does.
      const rowFingerprint=last?.pressure?fingerprint:gate.fingerprint;
      // Fingerprint re-judgment (M1, PLAN section 5): a skipped generation whose substantive judgment inputs changed is
      // scheduled again under its own key like any rebuilt row; the store judges it anew when the row is rebuilt (a source,
      // activity, profile, controls or contact-settings change) and keeps the skip otherwise.
      const rejudge=last?.status==='dismissed'&&latest!.judgment?.lastChoice==='skip'&&latest!.judgment.lastFingerprint!==null&&
        latest!.judgment.lastFingerprint!==rowFingerprint&&!companion.driveOccurrenceClosed(last.occurrenceId);
      if(!last||!rejudge&&!this.occurrenceLive(last,now))continue;
      const rebuilt=companion.schedule({subjectId,targetId,kind:last.kind,purpose:last.purpose,
        opportunityKey:last.pressure?.opportunityKey??this.generationKey(history.key,history.generations.length-1),topic:last.topic,
        basis:last.basis,sourceVersion:state.version,nowMs:gridFloor(now),fingerprint:rowFingerprint,seedKind:contactSeedKind(last),pressure:last.pressure});
      if(rebuilt&&OPEN_DRIVE_STATUSES.includes(rebuilt.status))pending=true;
    }
    if(pending||companion.pressureOccurrencePending(subjectId,targetId,now))return {record:point,opened:null};
    let fired:PressureRecord|null;
    if(point)fired=point.firedAtMs===null?null:point;
    else {
      const evaluation=this.evaluateHazard(context);
      // A marker seen below theta_off on a grid point of this epoch is cleared there, and that time is kept, so a later
      // recomputation never moves a trigger before the clear.
      if(context.marker?.fired&&evaluation.hysteresisClearedAtMs!==null)companion.setDriveMarker(subjectId,targetId,
        {fired:false,episode:context.marker.episode,clearedAtMs:evaluation.hysteresisClearedAtMs},now);
      fired=evaluation.fired;
      if(!fired)return {record:evaluation.current,opened:null};
    }
    if(!fired?.dominant)return {record:point,opened:null};
    return {record:fired,opened:this.materializeSeed(context,gate,fired)};
  }
  /**
   * A pressure occurrence that is still pending (waiting, deferred, being judged, or approved within its lifetime) or was
   * cancelled without being closed by a reopen event: it is rebuilt rather than judged anew. A consumed, dismissed or
   * closed one is finished (a failed host send closes it, see the store's finishDelivery); so is an approved one past
   * its lifetime.
   */
  private occurrenceLive(opportunity:CompanionOpportunity,nowMs:number):boolean {
    if(this.authority.companion.driveOccurrenceClosed(opportunity.occurrenceId))return false;
    if(opportunity.status==='approved')return nowMs<=opportunity.expiresAtMs;
    return ['waiting','deferred','evaluating','cancelled'].includes(opportunity.status);
  }
  /** Opens the occurrence of the dominant seed at the trigger, in the next generation of its seed key. */
  private materializeSeed(context:PressureContext,gate:ContactGate,fired:PressureRecord):CompanionOpportunity|null {
    const {subject,state,now,targetId}=gate,fingerprint=gate.pressureFingerprint,subjectId=subject.subjectId,companion=this.authority.companion;
    const dominant=fired.dominant!,generation=context.nextGeneration.get(dominant.key)??0;
    const revision=companion.activity(subjectId).revision;
    let spec:{kind:CompanionOpportunity['kind'];purpose:string;topic:string;basis:CompanionOpportunity['basis']};
    if(dominant.seedKind==='followup'){
      const followup=context.followup;if(!followup||followup.key!==dominant.key)return null;
      spec={kind:'experience',purpose:'followup',topic:followup.topic,basis:[{kind:'source',id:followup.id,revision:followup.revision}]};
    }else if(dominant.seedKind==='recall'){
      const memory=context.memories.get(dominant.key);if(!memory)return null;
      spec={kind:'recall',purpose:'recall',topic:RECALL_TOPIC,basis:[{kind:'memory',id:memory.memoryId,revision:memory.revision}]};
    }else if(dominant.seedKind==='check_in'){
      if(!context.waitingEpisode)return null;
      spec={kind:'drive',purpose:'gentle_contact',topic:CHECK_IN_TOPIC,basis:[{kind:'drive',id:`waiting:${context.waitingEpisode}`,revision}]};
    }else if(dominant.seedKind==='share'){
      spec={kind:'drive',purpose:'gentle_contact',topic:SHARE_TOPIC,basis:[{kind:'drive',id:'expression',revision}]};
    }else spec={kind:'drive',purpose:'gentle_contact',topic:LONGING_TOPIC,basis:[{kind:'drive',id:'connection',revision}]};
    const opportunityKey=this.generationKey(dominant.key,generation);
    let pressure:OccurrencePressure={...fired,seedKey:dominant.key,generation,opportunityKey};
    if(JSON.stringify(pressure).length>PRESSURE_RECORD_LIMIT)pressure={...pressure,contributions:[dominant]};
    // Scheduled at the start of the grid cell of this check, so its lifetime is the same whichever tick inside the cell opens it.
    return companion.schedule({subjectId,targetId,...spec,opportunityKey,sourceVersion:state.version,nowMs:gridFloor(now),fingerprint,
      seedKind:dominant.seedKind,pressure});
  }
  /**
   * Everything the pressure model reads at the check time: E0 and her sends (S1), reply-origin recall events of memories
   * still in the snapshot (S2), the unanswered wait and the user's gaps (S4), the user's rhythm at T0 (S5), the latest
   * direct user source with a plan (S6), her life (S7), the tendency, the epoch start, the hard windows and busy time
   * (blocked) and soft windows (mu), the hysteresis marker, the seed keys, their generations and what each has spent.
   */
  private pressureContext(scope:SceneScope,characterId:string,gate:ContactGate):PressureContext {
    const {subject,state,now,targetId,controls}=gate,subjectId=subject.subjectId,companion=this.authority.companion;
    const activity=companion.activity(subjectId),marker=companion.driveMarker(subjectId,targetId);
    const injected=this.drivePressure!==CompanionFlow.prototype.drivePressure?this.drivePressure(scope,characterId,now,state):null;
    const base=this.authority.emotionBase(scope,characterId,state),signals=base.emotion.behavioralSignals as Record<string,number>;
    const emotion={atMs:base.emotion.updatedAtMs,frustration:base.emotion.frustration,initiative:signals.initiative??0.5,
      warmth:signals.warmth??0.5,settings:base.settings};
    const tendencyRow=companion.contactTendency(subjectId,targetId);
    const tendency={...tendencyRow.disposition,openness:tendencyRow.openness,revision:tendencyRow.revision};
    // A busy time set, changed or cleared early is a control change like a pause: the epoch restarts after it, so a clear
    // never lets the hazard integrate over the hours that were blocked (busy that simply runs out changes nothing).
    const controlChanges=[companion.contactPauseChangedAt(subjectId,targetId),tendencyRow.revision>0?tendencyRow.updatedAtMs:null,
      controls.updatedAtMs>0?controls.updatedAtMs:null,companion.busyChangedAt(subjectId)].filter((value):value is number=>typeof value==='number');
    // Each epoch event is aligned to the next grid point (epochGridStart), so a send or skip confirmed by a 1-minute or a
    // 5-minute tick inside the same grid cell starts the same epoch with the same u.
    const aligned=(value:number|null)=>value===null?null:epochGridStart(value);
    const epoch={lastUserActivityMs:aligned(activity.lastUserActivityAtMs),lastConfirmedSendMs:aligned(companion.lastConfirmedSendAt(subjectId,targetId)),
      lastSkipMs:aligned(companion.lastPressureSkipAt(subjectId,targetId)),lastControlChangeMs:aligned(controlChanges.length?Math.max(...controlChanges):null)};
    const epochStartMs=Math.trunc(epochStart({epoch,emotion}));
    const episode=this.episodeDigest(subjectId,targetId);
    const keys={drive:`drive:${targetId}:${episode}`,checkIn:`check_in:${targetId}:${episode}`};
    const direct=state.sources.filter(source=>source.envelope.mode==='direct'&&source.envelope.targetId===characterId&&
      source.envelope.presentIds.length===1&&source.envelope.presentIds[0]===characterId);
    // S6: a source opportunity is limited to text this recipient actually knows.
    const lastUser=direct.filter(source=>source.status==='accepted'&&source.role==='user'&&source.processing==='ready'&&
      source.acceptedAtMs<=now).at(-1);
    const topic=lastUser?.analysis?.plan?visibleText(lastUser.analysis.plan,characterId):'';
    const followup=lastUser&&topic?{key:`source:${lastUser.id}:${lastUser.revision}`,atMs:lastUser.acceptedAtMs,id:lastUser.id,
      revision:lastUser.revision,topic:topic.slice(0,500)}:null;
    // S2: only reply-origin events of memories still in the current snapshot.
    const reactivations=this.core.authority.memoryReactivations(this.authority.snapshot(scope,characterId,state),
      {origin:'reply',fromMs:Math.max(0,epochStartMs-RECALL_HORIZON_MS),toMs:now});
    const recall=reactivations.map(event=>({memoryId:event.memoryId,revision:event.messageRevision,atMs:event.atMs,access:event.access}));
    const memories=new Map(recall.map(event=>[`memory:${event.memoryId}:${event.revision}`,{memoryId:event.memoryId,revision:event.revision}]));
    // S4: the current unanswered episode, as projectContactAffect rebuilds it.
    let absence:PressureInputs['absence']=null,waitingEpisode:string|null=injected?injected.waitingEpisode:null;
    if(!injected){
      const affect=this.contactEmotion(scope,characterId,now,state).affect;
      if(affect?.phase==='waiting'&&affect.episode){
        waitingEpisode=affect.episode.deliveryId;
        absence={episodeId:waitingEpisode,sentAtMs:affect.episode.sentAtMs,spent:marker?.episode===waitingEpisode,
          explanations:absenceExplanationTimeline(state.sources,characterId).map(item=>({fromMs:item.validFromMs,
            untilMs:item.effectiveUntilMs??item.validUntilMs,certainty:item.certainty}))};
      }
    }
    // S5 and the gaps are read at T0, so the whole epoch sees one rhythm.
    const timeZone=this.authority.interactions.clock(scope).timeZone??'UTC';
    const events=direct.map(source=>({id:source.id,revision:source.revision,role:source.role,status:source.status,acceptedAtMs:source.acceptedAtMs}));
    const summary=summarizeUserActivity(events,{timeZone,nowMs:epochStartMs}),gaps=activityGaps(events,{timeZone,nowMs:epochStartMs});
    const windows=this.pressureWindows(scope,characterId,state,epochStartMs,now);
    const busyUntil=activity.busyUntilMs;
    // Her sends release pressure by the seed each one expressed, each from its raw confirmation time (as the scene
    // projection reads it); sends past the release horizon release nothing measurable.
    const horizon=now-expressionReliefHorizonMs(base.settings),confirmed=companion.confirmedContactDeliveries(subjectId,targetId);
    const sentOpportunity=(deliveryId:string)=>{
      const delivery=companion.getDelivery(deliveryId);
      return delivery?companion.getOpportunity(delivery.opportunityId):null;
    };
    const sends:ExpressionReliefSend[]=confirmed.filter(item=>item.confirmedSentAtMs>=horizon).flatMap(item=>{
      const opportunity=sentOpportunity(item.deliveryId),kind=opportunity?contactSeedKind(opportunity):null;
      return kind?[{atMs:item.confirmedSentAtMs,kind}]:[];
    });
    // A fired marker reads the seed that the latest send able to fire it (drive, recall, follow-up, window end) expressed.
    let hysteresisSeed:PressureInputs['hysteresisSeed']=null;
    if(marker?.fired)for(const item of [...confirmed].reverse()){
      const opportunity=sentOpportunity(item.deliveryId);
      if(!opportunity||!['drive','window_end','recall','experience'].includes(opportunity.kind))continue;
      const seedKind=contactSeedKind(opportunity);
      hysteresisSeed=seedKind?{seedKind,key:opportunity.pressure?.seedKey??null}:null;
      break;
    }
    // The history of each seed key: a finished generation spends its key (a send or a closed identity for good, a skip at
    // P_dec, another dismissal at the pressure it fired with), and the next occurrence of that key is the next generation.
    const candidates:{key:string;kind:CompanionOpportunity['kind']}[]=[{key:keys.drive,kind:'drive'},{key:keys.checkIn,kind:'drive'},
      ...(followup?[{key:followup.key,kind:'experience' as const}]:[]),...[...memories.keys()].map(key=>({key,kind:'recall' as const}))];
    const histories:SeedHistory[]=[],spent:Record<string,number>={},nextGeneration=new Map<string,number>();
    for(const candidate of candidates){
      const generations:SeedHistory['generations']=[];
      for(let generation=0;generation<SEED_GENERATION_LIMIT;generation++){
        const opportunity=companion.latestOccurrence(subjectId,targetId,this.generationKey(candidate.key,generation),candidate.kind);
        if(!opportunity)break;
        generations.push({opportunity,judgment:companion.judgment(opportunity.occurrenceId)});
      }
      histories.push({...candidate,generations});nextGeneration.set(candidate.key,generations.length);
      const last=generations.at(-1);
      if(!last||this.occurrenceLive(last.opportunity,now))continue;
      const {opportunity,judgment}=last;
      // A recall whose host send failed, or whose ready text lapsed unchanged (both closed as pressure_delivery_failed),
      // expressed nothing: like a drive reopen, its next generation may open at once, at most DRIVE_REOPEN_LIMIT times per
      // key. A failed follow-up is not retried (as in M1).
      const unexpressed=(occurrenceId:string)=>companion.occurrenceClosedReason(occurrenceId)==='pressure_delivery_failed';
      const failedSends=generations.filter(item=>unexpressed(item.opportunity.occurrenceId)).length;
      if(candidate.kind==='recall'&&unexpressed(opportunity.occurrenceId)&&failedSends<=DRIVE_REOPEN_LIMIT)continue;
      // A skip holds its seed at P_dec (a skipped generation whose judgment inputs changed is rebuilt and judged again by
      // materializePressure, as M1 did); another dismissal at the total pressure it fired with.
      spent[candidate.key]=opportunity.status==='consumed'||companion.driveOccurrenceClosed(opportunity.occurrenceId)?Number.POSITIVE_INFINITY:
        judgment?.lastChoice==='skip'?judgment.pressureAtDecision??PRESSURE_DEFAULTS.thetaOn:
          opportunity.pressure?.total??opportunity.pressure?.P??PRESSURE_DEFAULTS.thetaOn;
    }
    const seed=`${subjectId}:${targetId}:hazard:${epochStartMs}`;
    let uniform:number|undefined;
    if(this.hazardUniform){
      uniform=this.hazardUniform(seed);
      if(typeof uniform!=='number'||!Number.isFinite(uniform)||!(uniform>0)||uniform>1)throw new Error('invalid_hazard_uniform');
    }
    // A finished seed (sent, or closed by a failed send and not reopened) contributes nothing more, as S4 does once its
    // waiting episode led to a delivery: its kernel may not carry another seed over theta. A skipped seed stays in the total
    // P (which eligibility and P_dec compare against) but the hazard reads it only once it is eligible again (above P_dec +
    // delta), so neither can a small seed ride a spent one over theta.
    const finished=(key:string)=>spent[key]===Number.POSITIVE_INFINITY;
    const inputs:PressureInputs={subjectId,targetId,nowMs:now,emotion,sends,
      recall:recall.filter(event=>!finished(`memory:${event.memoryId}:${event.revision}`)),absence,gaps,
      followup:followup&&!finished(followup.key)?{key:followup.key,atMs:followup.atMs}:null,activity:summary,receptivityEnabled:tendencyRow.receptivity,
      life:this.lifeProvider,tendency,epoch,
      blocked:[...windows.blocked,...(busyUntil!==null&&busyUntil>epochStartMs?[{startMs:0,endMs:busyUntil}]:[])],soft:windows.soft,
      hysteresisFired:marker?.fired??false,hysteresisClearedAtMs:marker?.clearedAtMs??null,
      hysteresisSeed,openOccurrence:false,spent,keys,
      ...(uniform===undefined?{}:{uniform})};
    return {inputs,epochStartMs,injected,marker,histories,nextGeneration,followup,memories,waitingEpisode};
  }
  /**
   * The injected reading at the check instant (see drivePressure): S1 and S4 from the reading, S2 and S6 from the state,
   * the M1 hysteresis (read, and cleared when the injected connection is below theta_off and `clear`), and one grid step
   * of hazard with u from hazardUniform or 1.
   */
  private injectedPoint(context:PressureContext,clear:boolean):PressureRecord {
    const {inputs,injected:reading,marker}=context,now=inputs.nowMs,companion=this.authority.companion;
    const tendency=resolveTendency(inputs.tendency),theta=thetaEffective(tendency),thetaOff=theta-PRESSURE_DEFAULTS.thetaOffGap;
    const contributions:PressureContribution[]=[];
    if(inputs.followup)contributions.push({seedKind:'followup',key:inputs.followup.key,
      value:followupSource(inputs.followup,now,tendency.followupAmplitude)});
    const recall=recallSource(inputs.recall??[],now,tendency.recallWeight);
    if(recall.top)contributions.push({seedKind:'recall',key:recall.top.key,value:recall.value});
    if(reading!.waitingEpisode!==null)contributions.push({seedKind:'check_in',key:inputs.keys!.checkIn!,
      value:reading!.waitingEpisode===marker?.episode?0:tendency.checkInWeight*PRESSURE_DEFAULTS.checkIn.amplitude});
    contributions.push({seedKind:'longing',key:inputs.keys!.drive!,value:reading!.connection});
    contributions.push(...shareSource(this.lifeProvider.shareSeeds(context.epochStartMs,now),now));
    const total=contributions.reduce((sum,item)=>sum+item.value,0),pressure=eligiblePressure(contributions,total,inputs.spent);
    // The marker reads the expressed seed alone, S1 being the injected connection (as in M1 and evaluatePressure).
    let locked=marker?.fired??false;
    if(locked&&markerValue(inputs.hysteresisSeed,reading!.connection,contributions)<thetaOff){
      locked=false;
      if(clear)companion.setDriveMarker(inputs.subjectId,inputs.targetId,{fired:false,episode:marker!.episode,clearedAtMs:now},now);
    }
    const dominant=dominantSeed(contributions,total,inputs.spent);
    const receptivity=receptivityAt(inputs.activity??null,now,{enabled:inputs.receptivityEnabled!==false});
    const availability=this.lifeProvider.availabilityAt(now),alpha=availability?PRESSURE_DEFAULTS.life[availability.availability]:1;
    const soft=insideAny(inputs.soft,now)?tendency.softWindowFactor:1;
    const lambda=!locked&&!insideAny(inputs.blocked,now)&&dominant?
      hazardRate(pressure,theta,tendency.hazardScale*tendency.openness*receptivity.factor*alpha*soft):0;
    const u=inputs.uniform??1,H=lambda*PRESSURE_DEFAULTS.gridMs/3_600_000;
    return {firedAtMs:lambda>0&&H>=-Math.log(u)?now:null,epochStartMs:context.epochStartMs,atMs:now,u,H,P:pressure,total,thetaEff:theta,lambda,
      dominant,contributions,receptivity,life:{availability:availability?.availability??null,factor:alpha,ledgerRef:availability?.ledgerRef??null},
      ...(availability&&alpha<1?{lifeSuppression:{ledgerRef:availability.ledgerRef}}:{}),softFactor:soft,tendencyRevision:tendency.revision};
  }
  /** The hazard of the context's epoch; a fired evaluation is kept by target, epoch and input digest. */
  private evaluateHazard(context:PressureContext):PressureEvaluation {
    const {inputs}=context;
    const key=inputs.life===NO_LIFE?digest([inputs.subjectId,inputs.targetId,context.epochStartMs,{...inputs,nowMs:null,life:null}]):null;
    const cached=key===null?undefined:this.pressureCache.get(key);
    if(cached?.fired&&cached.fired.firedAtMs!<=inputs.nowMs)return cached;
    const evaluation=evaluatePressure(inputs);
    if(key!==null&&evaluation.fired){
      this.pressureCache.delete(key);this.pressureCache.set(key,evaluation);
      if(this.pressureCache.size>64)this.pressureCache.delete(this.pressureCache.keys().next().value!);
    }
    return evaluation;
  }
  /**
   * The total P (spent seeds included) as a skip records it (P_dec), read at the start of the grid cell of the judgment
   * (not before E0), so a skip judged anywhere inside one cell records the same P_dec; read only. An injected reading
   * (drivePressure) is read at the check instant.
   */
  private currentPressure(scope:SceneScope,characterId:string,gate:ContactGate):number {
    const context=this.pressureContext(scope,characterId,gate);
    if(context.injected)return this.injectedPoint(context,false).total;
    const atMs=Math.max(gridFloor(gate.now),context.inputs.emotion.atMs);
    return pressureAt(context.inputs,atMs,resolveTendency(context.inputs.tendency),
      this.lifeProvider.shareSeeds(context.epochStartMs,atMs)).total;
  }
  /**
   * The contact windows between T0 and now as grid intervals: hard windows block the hazard, soft windows (hers, a
   * no-contact promise, the user's fresh goodnight) scale it by mu.
   */
  private pressureWindows(scope:SceneScope,characterId:string,state:SceneState,fromMs:number,toMs:number):{blocked:PressureInterval[];soft:PressureInterval[]} {
    const blocked:PressureInterval[]=[],soft:PressureInterval[]=[],seen=new Set<string>();
    const points=[...gridPoints(fromMs,toMs),toMs];
    for(const record of this.authority.commitments.listActiveContactRestrictions(scope,{obligorId:characterId,readerId:characterId})){
      let skipUntil=-Infinity;
      for(const atMs of points){
        if(atMs<skipUntil)continue;
        const window=contactRestrictionWindow(record,atMs);
        if(!window)continue;
        skipUntil=window.endsAtMs;
        const key=`${window.commitmentId}@${window.revision}:${window.key}`;
        if(seen.has(key))continue;
        seen.add(key);
        (window.level==='hard'?blocked:soft).push({startMs:window.startsAtMs,endMs:window.endsAtMs});
      }
    }
    // The goodnight is read at both ends of the range, so a later check does not drop it once it left the 12-hour window.
    for(const atMs of new Set([fromMs,toMs])){
      const sleep=this.sleepSource(scope,state,characterId,atMs),key=sleep?`sleep:${sleep.id}@${sleep.revision}`:null;
      if(!sleep||seen.has(key!))continue;
      seen.add(key!);soft.push({startMs:sleep.acceptedAtMs,endMs:sleep.acceptedAtMs+SLEEP_WINDOW_MS+1});
    }
    return {blocked,soft};
  }
  /** `<key>` for generation 0 (the M1 key), `<key>~g<n>` after; a key too long for an opportunity key is digested. */
  private generationKey(key:string,generation:number):string {
    const suffix=generation>0?`~g${generation}`:'';
    return key.length+suffix.length<=200?key+suffix:`${key.slice(0,key.indexOf(':')+1)}${digest(key)}${suffix}`;
  }
  /**
   * The identity of the current drive episode of this target, shared by its longing and check-in seed keys. A pending
   * drive row closed before a confirmed send (the host never took its text in time, a hard window began, or the host send
   * failed) restarts the episode identity, so the episode is judged again; at most twice per episode, after which it waits
   * for user activity or a confirmed send.
   */
  private episodeDigest(subjectId:string,targetId:string):string {
    const companion=this.authority.companion,activity=companion.activity(subjectId);
    const lastSent=companion.lastConfirmedSendAt(subjectId,targetId);
    const reopens=companion.driveReopenTimes(subjectId,targetId,Math.max(activity.lastUserActivityAtMs??-1,lastSent??-1))
      .slice(0,DRIVE_REOPEN_LIMIT);
    return digest([activity.lastUserActivityAtMs,lastSent,...reopens]);
  }
  private sameQuietBindings(left:readonly QuietExceptionBinding[],right:readonly QuietExceptionBinding[]):boolean {
    const canonical=(rows:readonly QuietExceptionBinding[])=>rows.map(row=>JSON.stringify([row.scopeKey,row.commitmentId,row.revision,
      row.key,row.sourceId,row.sourceRevision])).sort();
    return JSON.stringify(canonical(left))===JSON.stringify(canonical(right));
  }
  private actor(scope:SceneScope,characterId:string){const actor=this.authority.state(scope).roster.characters.find(character=>character.id===characterId);if(!actor)throw new Error('invalid_scene_character');return actor;}
  private requireSubject(scope:SceneScope){const subject=this.authority.subject(scope);if(!subject)throw new Error('companion_subject_not_bound');return subject;}
}
