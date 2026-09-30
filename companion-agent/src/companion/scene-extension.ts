import {createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {Authority} from '../../../shared/src/core/store.ts';
import type {Core} from '../../../shared/src/core/service.ts';
import type {ModelTasks} from '../../../shared/src/core/models.ts';
import {scopeKey} from '../../../shared/src/core/types.ts';
import {SceneAuthority} from '../../../shared/src/scene/store.ts';
import type {SceneAuthorityExtensionFactory,SceneAuthorityHooks,SceneCompanionFeedback,SceneCompanionPort,
  SceneSubjectBinding} from '../../../shared/src/scene/extension.ts';
import type {SceneScope} from '../../../shared/src/scene/types.ts';
import {contactRestrictionWindow} from '../../../shared/src/commitments/index.ts';
import {absenceExplanationTimeline} from '../../../shared/src/emotion/absence-explanation.ts';
import {applyExpressionRelief,expressionRelief,expressionReliefHorizonMs,projectContactAffect,projectContactEmotion}
  from '../../../shared/src/emotion/contact-affect.ts';
import type {ContactOutgoing,ExpressionReliefSend} from '../../../shared/src/emotion/contact-affect.ts';
import {behavioralSignalsAt} from '../../../shared/src/emotion/openher.ts';
import {UserModelStore,decodeProfileCandidates} from '../user-model/index.ts';
import type {ProfileCandidate} from '../user-model/types.ts';
import {CompanionStore} from './store.ts';
import {CompanionPresets} from './presets.ts';
import {RelationshipAssessmentStore} from './relationship-assessment.ts';
import type {RelationshipAssessmentInput,RelationshipCorrection} from './relationship-assessment.ts';
import {PersonalWeightsStore} from './personal-weights.ts';
import {PersonalLearning} from './personal-learning.ts';
import {relationshipAuxiliaryContext} from './relationship-context.ts';
import {CompanionFlow} from './companion-flow.ts';
import {companionIdentityGuidance,companionIdentityIssue,ensureCompanionIdentityBody} from './identity-expression.ts';

/**
 * The Agent companion members of the scene authority: the user model, proactive contact, relationship assessment,
 * personal learning and onboarding presets. They exist only on an authority built with companionSceneExtension; the
 * Tavern authority has none of them and none of their tables.
 */
export interface CompanionSceneMembers {
  readonly userModel:UserModelStore;
  readonly companion:CompanionStore;
  readonly relationshipAssessments:RelationshipAssessmentStore;
  readonly personalWeights:PersonalWeightsStore;
  readonly personalLearning:PersonalLearning;
  readonly presets:CompanionPresets;
  /** Identity of the personal decision model that keys relationship reads; one accessor, never a copy. */
  personalModelIdentity:string;
  /** Explicitly bind the real user only for an active Agent companion scope. */
  bindSubject(scope:SceneScope,subjectId:string,nowMs?:number):SceneSubjectBinding;
  recordSubjectActivity(scope:SceneScope,nowMs?:number):ReturnType<CompanionStore['recordUserActivity']>;
  correctRelationshipAssessment(scope:SceneScope,characterId:string,correction:RelationshipCorrection,
    expectedRevision:number):ReturnType<RelationshipAssessmentStore['correct']>;
  relationshipAssessmentInput(scope:SceneScope,characterId:string,nowMs?:number):RelationshipAssessmentInput|null;
  markSubjectActivityReady(scope:SceneScope,activityRevision:number,nowMs?:number):ReturnType<CompanionStore['markSemanticReady']>;
  companionTarget(scope:SceneScope,actorId:string):string;
  /**
   * The seed each host-confirmed send expressed, resolved delivery -> opportunity without changing
   * ConfirmedContactDelivery: the row's stored seed kind, or for a row written before M3 the seed its kind and basis
   * express (opportunitySeedKind, the same mapping the pressure model uses). A send whose opportunity row is gone, or
   * whose row expresses nothing, releases nothing. A send whose text recorded the F_c it was queued from carries it as
   * `connection` (M3-5 item 9, proportional release); CompanionStore.expressionReliefSends is the one resolution.
   */
  expressionReliefSends(subjectId:string,targetId:string,
    confirmed?:ReturnType<CompanionStore['confirmedContactDeliveries']>):ExpressionReliefSend[];
}
export type CompanionSceneAuthority=SceneAuthority&CompanionSceneMembers;

interface CompanionPresetRow {
  presetId:string;revision:number;documentHash:string;document:string;status:string;generation:number;
  claimToken:string|null;leaseUntil:number|null;details:string|null;persona:string|null;characterId:string|null;
  error:string|null;imported:number;updated:number;
}

export const companionSceneExtension:SceneAuthorityExtensionFactory<CompanionSceneMembers>=(db,internals)=>{
  const scene=internals.scene as CompanionSceneAuthority;
  const userModel=new UserModelStore(db);
  const companion=new CompanionStore(db);
  const relationshipAssessments=new RelationshipAssessmentStore(db);
  const personalWeights=new PersonalWeightsStore(db);
  const personalLearning=new PersonalLearning(db,personalWeights);
  const presets=new CompanionPresets(db,{
    state:scope=>scene.state(scope),
    configure:(scope,roster,now)=>internals.configure(scope,roster,now),
    transaction:action=>internals.transaction(action),
  });
  let personalModelIdentity='';

  const companionContext=(scope:SceneScope):{host:'agent';baseScope:SceneScope}|null=>{
    const row=db.prepare(`SELECT i.host,i.base_scope,i.active_mode,b.mode FROM scene_interaction_bindings b
      JOIN scene_interactions i ON i.owner=b.owner WHERE b.physical_key=?`).get(scopeKey(scope)) as
      {host:string;base_scope:string;active_mode:string;mode:string}|undefined;
    if(!row||row.mode!=='companion'||row.active_mode!=='companion'||row.host!=='agent')return null;
    return {host:'agent',baseScope:JSON.parse(row.base_scope) as SceneScope};
  };
  const subject=(scope:SceneScope):SceneSubjectBinding|null=>{
    const context=companionContext(scope);if(!context)return null;
    const binding=userModel.resolveSubject(context.host,subjectBindingId(context.host,context.baseScope));
    return binding?{...context,bindingId:binding.bindingId,subjectId:binding.subjectId,createdAtMs:binding.createdAtMs}:null;
  };
  // Members call each other through `scene`, as the authority methods did through `this`, so an instance override
  // (tests replace expressionReliefSends or relationshipAnchor) is seen by every internal read.
  const companionTarget=(scope:SceneScope,actorId:string):string=>{
    if(!scene.subject(scope))throw new Error('companion_subject_not_bound');
    if(!scene.state(scope).roster.characters.some(character=>character.id===actorId))throw new Error('invalid_scene_character');
    return companionTargetId(scope,actorId);
  };
  const recordSubjectActivity=(scope:SceneScope,nowMs=Date.now())=>{
    const binding=scene.subject(scope);if(!binding)throw new Error('companion_subject_not_bound');
    return companion.recordUserActivity(binding.subjectId,nowMs);
  };
  const markSubjectActivityReady=(scope:SceneScope,activityRevision:number,nowMs=Date.now())=>{
    const binding=scene.subject(scope);if(!binding)throw new Error('companion_subject_not_bound');
    return companion.markSemanticReady(binding.subjectId,activityRevision,nowMs);
  };
  const relationshipAssessmentInput=(scope:SceneScope,characterId:string,nowMs=Date.now()):RelationshipAssessmentInput|null=>{
    const current=scene.subject(scope),state=scene.state(scope);
    if(current?.host!=='agent'||scene.interactions.modeOf(scope)!=='companion')return null;
    if(!state.roster.characters.some(character=>character.id===characterId))throw new Error('invalid_scene_character');
    const controls=userModel.controls(current.subjectId);
    if(!controls.profileLearningEnabled||!controls.personalizationEnabled)return null;
    const sources=state.sources.filter(source=>source.status==='accepted'&&source.processing==='ready'&&
      source.envelope.mode==='direct'&&source.envelope.targetId===characterId&&
      source.envelope.presentIds.length===1&&source.envelope.presentIds[0]===characterId&&
      (source.role==='user'||source.role==='assistant'&&source.speakerId===characterId))
      .slice(-12).map(source=>({id:source.id,revision:source.revision,text:source.text,role:source.role,
        acceptedAtMs:source.acceptedAtMs}));
    const projection=scene.contactEmotionProjection(scope,characterId,nowMs,state);
    // The same reading rules as the reply and proactive paths: real-user entries only (no advanced:false).
    const options={characterId,sessionId:scope.sessionId,nowMs} as const;
    const replyEntries=userModel.listEntries(current.subjectId,{purpose:'strategy',taskPurpose:'reply',...options});
    const proactiveIds=new Set(userModel.listEntries(current.subjectId,
      {purpose:'proactive',taskPurpose:'proactive',...options}).map(entry=>entry.id));
    const profileEntries=replyEntries.filter(entry=>proactiveIds.has(entry.id));
    const commitments=scene.commitments.list(scope,{readerId:characterId,status:'active',mode:'companion'});
    const contactWindowState=scene.commitments.listActiveContactRestrictions(scope,{obligorId:characterId,readerId:characterId})
      .flatMap(record=>{const window=contactRestrictionWindow(record,nowMs);
        return window?[`${window.commitmentId}@${window.revision}:${window.level}:${window.key}`]:[];});
    const auxiliaryContext=relationshipAuxiliaryContext({nowMs,timeZone:scene.interactions.clock(scope).timeZone??'UTC',
      affect:projection.affect,profileEntries,commitments,emotion:projection.emotion,contactWindowState});
    return {scope,subjectId:current.subjectId,characterId,sourceVersion:state.version,controlsRevision:controls.revision,sources,
      personalParameterVersion:personalWeights.version(personalLearning.key(scope,current.subjectId,characterId),'relationship',personalModelIdentity),
      auxiliaryContext};
  };
  // The same resolution as the pressure context reads (CompanionStore.expressionReliefSends), including the F_c each text
  // was queued from when it was recorded.
  const expressionReliefSends=(subjectId:string,targetId:string,
    confirmed=companion.confirmedContactDeliveries(subjectId,targetId)):ExpressionReliefSend[]=>
    companion.expressionReliefSends(confirmed);

  const members:CompanionSceneMembers={
    userModel,companion,relationshipAssessments,personalWeights,personalLearning,presets,
    get personalModelIdentity(){return personalModelIdentity;},
    set personalModelIdentity(value:string){personalModelIdentity=value;},
    bindSubject(scope,subjectId,nowMs=Date.now()){
      return internals.transaction(()=>{
        const context=companionContext(scope);
        if(!context)throw new Error('invalid_companion_subject_scope');
        const previousSubject=scene.subject(scope)?.subjectId;
        const binding=userModel.bindSubject(context.host,subjectBindingId(context.host,context.baseScope),subjectId,nowMs);
        scene.geography.rebindCompanionLocation(scope,previousSubject??null,binding.subjectId);
        if(previousSubject!==binding.subjectId){
          relationshipAssessments.clearModels(scope);
          if(scene.state(scope).version>0)internals.bump(scope);
        }
        internals.rebuildDerived(scope,nowMs);
        return {...context,bindingId:binding.bindingId,subjectId:binding.subjectId,createdAtMs:binding.createdAtMs};
      });
    },
    recordSubjectActivity,
    correctRelationshipAssessment(scope,characterId,correction,expectedRevision){
      return internals.transaction(()=>{
        const input=scene.relationshipAssessmentInput(scope,characterId);
        if(!input)throw new Error('relationship_assessment_disabled');
        const result=relationshipAssessments.correct(input,correction,expectedRevision);
        personalLearning.synchronizeCorrections(personalLearning.key(scope,input.subjectId,characterId),result);
        companion.cancelPendingForTarget(input.subjectId,scene.companionTarget(scope,characterId));
        return result;
      });
    },
    relationshipAssessmentInput,markSubjectActivityReady,companionTarget,expressionReliefSends,
  };

  const hooks:Partial<SceneAuthorityHooks>={
    subject,
    onConfigured:scope=>relationshipAssessments.clearModels(scope),
    onSourceErased:(scope,source)=>{
      if(!source.id.startsWith('proactive:')||source.role!=='assistant'||!source.speakerId)return;
      const binding=scene.subject(scope);
      if(binding)companion.redactDeliveryBody(source.id.slice('proactive:'.length),binding.subjectId,scene.companionTarget(scope,source.speakerId));
    },
    onUserActivity:(scope,nowMs)=>{if(scene.subject(scope))scene.recordSubjectActivity(scope,nowMs);},
    onCommitted:scope=>{
      const binding=scene.subject(scope);if(!binding)return;
      if(!scene.state(scope).sources.filter(source=>source.status==='accepted').every(source=>source.processing==='ready'))return;
      const activity=companion.activity(binding.subjectId);
      if(activity.semanticReadyRevision!==activity.revision)scene.markSubjectActivityReady(scope,activity.revision);
    },
    rebuildDerived:(scope,state,nowMs)=>{
      const binding=scene.subject(scope);
      if(!binding){relationshipAssessments.clearModels(scope);return;}
      // A binding exists only for an active Agent companion scope.
      userModel.rebuildProjection(binding.subjectId,scope,state.sources.filter(source=>source.role==='user'&&
        source.envelope.mode==='direct'&&source.envelope.presentIds.length===1&&source.envelope.presentIds[0]===source.envelope.targetId)
        .map(source=>({id:source.id,revision:source.revision,status:source.status,text:source.text,acceptedAtMs:source.acceptedAtMs,
          characterId:source.envelope.targetId,candidates:source.analysis?.userModelCandidates as ProfileCandidate[]|undefined})),nowMs,true);
      companion.invalidateSources(binding.subjectId,state.version,state.roster.characters.map(character=>companionTargetId(scope,character.id)),nowMs);
      for(const character of state.roster.characters){
        const controls=userModel.controls(binding.subjectId);
        const learningSources=state.sources.filter(source=>source.status==='accepted'&&source.processing==='ready'&&
          source.envelope.mode==='direct'&&source.envelope.targetId===character.id&&source.envelope.presentIds.length===1&&
          source.envelope.presentIds[0]===character.id&&(source.role==='user'||source.role==='assistant'&&source.speakerId===character.id));
        personalLearning.synchronize(personalLearning.key(scope,binding.subjectId,character.id),learningSources,
          controls.revision,controls.personalizationEnabled&&controls.profileLearningEnabled);
        const input=scene.relationshipAssessmentInput(scope,character.id,nowMs);
        if(input)relationshipAssessments.clearStale(input);else relationshipAssessments.clearModels(scope);
      }
    },
    contactEmotion:(scope,characterId,nowMs,state,currentReply,base)=>{
      const current=scene.subject(scope);
      if(current?.host!=='agent'||scene.interactions.modeOf(scope)!=='companion')return null;
      const targetId=scene.companionTarget(scope,characterId);
      const confirmed=companion.confirmedContactDeliveries(current.subjectId,targetId);
      const confirmedById=new Map(confirmed.map(item=>[item.deliveryId,item]));
      const outgoing:ContactOutgoing[]=state.sources.flatMap((source,index)=>{
        if(source.status!=='accepted'||source.processing!=='ready'||source.role!=='assistant'||
          source.envelope.mode!=='direct'||source.envelope.targetId!==characterId||source.speakerId!==characterId)return [];
        const delivery=source.id.startsWith('proactive:')?confirmedById.get(source.id.slice('proactive:'.length)):undefined;
        return [{id:source.id,targetId:characterId,atMs:source.acceptedAtMs,body:source.text,kind:'accepted_assistant' as const,
          sequence:index,hostMessageId:delivery?.hostMessageId,
          responseExpectation:delivery?.replyTimingKnown===false?{expected:null,quote:null}:
            source.analysis?.contactResponseExpectation??{expected:null,quote:null},quietException:delivery?.quietException??false}];
      });
      outgoing.push(...confirmed.map((item,index)=>({id:item.deliveryId,targetId:characterId,atMs:item.confirmedSentAtMs,
        body:item.body,kind:'confirmed_proactive' as const,sequence:-confirmed.length+index,
        hostMessageId:item.hostMessageId,responseExpectation:{expected:null,quote:null},quietException:item.quietException})));
      const replies=state.sources.flatMap((source,index)=>source.status==='accepted'&&source.processing==='ready'&&source.role==='user'&&
        source.envelope.mode==='direct'&&source.envelope.targetId===characterId&&source.envelope.presentIds.length===1&&
        source.envelope.presentIds[0]===characterId?[{sourceId:source.id,revision:source.revision,targetId:characterId,
          acceptedAtMs:source.acceptedAtMs,sequence:index}]:[]);
      const replySource=currentReply?state.sources.find(source=>source.id===currentReply.sourceId&&source.revision===currentReply.revision):null;
      const currentExplanation=replySource?.analysis?.absenceExplanation?.kind==='return'
        ?replySource.analysis.absenceExplanation.quote:null;
      const actor=state.roster.characters.find(item=>item.id===characterId);
      // Her own confirmed sends release tension at read time only: never trained, never persisted, gone with the receipt.
      // Sends past the release horizon release nothing measurable, so their kind is not resolved.
      const horizonMs=nowMs-expressionReliefHorizonMs(actor?.emotion);
      const applied=applyExpressionRelief(base,expressionRelief(scene.expressionReliefSends(current.subjectId,targetId,
        confirmed.filter(item=>item.confirmedSentAtMs>=horizonMs)),nowMs,actor?.emotion),actor?.emotion);
      // One basis for relieved and unrelieved reads: the signals always come from the anchor relations of `base` (a release
      // recomputes them from those already), so a vanishing release never jumps back to the persisted relations' signals.
      const relieved=applied===base?{...base,behavioralSignals:behavioralSignalsAt(base,actor?.emotion)}:applied;
      const affect=projectContactAffect({targetId:characterId,nowMs,outgoing,replies,
        explanations:absenceExplanationTimeline(state.sources,characterId),currentReply,currentExplanation,emotion:relieved});
      return {emotion:projectContactEmotion(relieved,affect,actor?.emotion),affect};
    },
    // The companion decoder rejects invalid candidates, as before the seam (the shared default drops them).
    decodeUserModelCandidates:(value,sourceText)=>
      decodeProfileCandidates(JSON.stringify({schema:'xldb-profile-candidates-v1',candidates:value}),sourceText),
    checkpoint:{
      capture:key=>(db.prepare(`SELECT preset_id AS presetId,revision,document_hash AS documentHash,document,status,generation,
        claim_token AS claimToken,lease_until AS leaseUntil,details,persona,character_id AS characterId,error,imported,updated
        FROM scene_companion_presets WHERE scope=?`).get(key) as CompanionPresetRow|undefined)??null,
      restore:(key,value,replace)=>{
        if(replace)db.prepare('DELETE FROM scene_companion_presets WHERE scope=?').run(key);
        if(!value)return;
        const row=value as CompanionPresetRow;
        db.prepare(`INSERT INTO scene_companion_presets
          (scope,preset_id,revision,document_hash,document,status,generation,claim_token,lease_until,details,persona,character_id,error,imported,updated)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(key,row.presetId,row.revision,row.documentHash,row.document,row.status,row.generation,row.claimToken,row.leaseUntil,
            row.details,row.persona,row.characterId,row.error,row.imported,row.updated);
      },
    },
  };
  return {members,hooks};
};

/**
 * CompanionFlow as the scene's companion port: the flow plus the reads SceneCore makes of the companion stores
 * (profile controls for the profile stage fingerprint, the delivery a user text answers) and the identity checks.
 */
export class CompanionSceneFlow extends CompanionFlow implements SceneCompanionPort {
  private readonly companionScene:CompanionSceneAuthority;
  constructor(authority:CompanionSceneAuthority,core:Core,models:ModelTasks){
    super(authority,core,models);
    this.companionScene=authority;
  }
  profileControls(scope:SceneScope){
    const bound=this.companionScene.subject(scope);
    return bound?this.companionScene.userModel.controls(bound.subjectId):null;
  }
  feedbackDelivery(scope:SceneScope,characterId:string,deliveryId:string):SceneCompanionFeedback {
    const delivery=this.companionScene.companion.getDelivery(deliveryId);
    const bindings=delivery?.status==='host_committed'&&delivery.targetId===this.companionScene.companionTarget(scope,characterId)
      ?this.companionScene.companion.getDeliveryExceptionBindings(deliveryId):[];
    return {delivery,bindings};
  }
  identityGuidance(currentUserText:string|null){return companionIdentityGuidance(currentUserText);}
  identityIssue(body:string,currentUserText:string|null){return companionIdentityIssue(body,currentUserText);}
  ensureIdentityBody(body:string,currentUserText:string|null,rewrite:(instruction:string,original:string)=>Promise<string>){
    return ensureCompanionIdentityBody(body,currentUserText,rewrite);
  }
}

/** An Authority whose scene carries the companion members (tests and tools that open a database directly). */
export function openCompanionAuthority(filename:string):Authority<CompanionSceneMembers> {
  return new Authority<CompanionSceneMembers>(filename,{sceneExtension:companionSceneExtension});
}

/** A SceneAuthority with the companion members, for tests that construct one on a bare database. */
export function companionSceneAuthority(db:DatabaseSync,migrateEmotionStates=true):CompanionSceneAuthority {
  return new SceneAuthority(db,migrateEmotionStates,companionSceneExtension as SceneAuthorityExtensionFactory<object>) as CompanionSceneAuthority;
}

function subjectBindingId(host:'agent'|'sillytavern',baseScope:SceneScope):string {
  return createHash('sha256').update(JSON.stringify(['xldb-subject-binding-v1',host,scopeKey(baseScope)])).digest('hex');
}
function companionTargetId(scope:SceneScope,actorId:string):string {
  return createHash('sha256').update(JSON.stringify(['xldb-companion-target-v1',scopeKey(scope),actorId])).digest('hex');
}
