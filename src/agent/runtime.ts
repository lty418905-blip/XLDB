import {randomUUID} from 'node:crypto';
import {Authority} from '../core/store.ts';
import {Core} from '../core/service.ts';
import {ModelTasks} from '../core/models.ts';
import type {ModelRunner} from '../core/models.ts';
import {stages,scopeOf,text,scopeKey,configOf} from '../core/types.ts';
import type {Configurations} from '../core/types.ts';
import {Retrieval} from '../memory/retrieval.ts';
import type {RetrievalConfig} from '../memory/retrieval.ts';
import type {SceneScope,SceneMessage,SceneWriteGuard} from '../scene/types.ts';
import type {HostTask} from './file-host.ts';
import {sceneWorkbench,correctSceneSource} from '../scene/workbench.ts';
import {suggestAddress} from '../emotion/address.ts';
import {relationshipContext} from '../emotion/relationships.ts';
import type {CompanionPresetCompletionTask,CompanionPresetGuard} from '../companion/presets.ts';

export type HostDelegate=(task:HostTask)=>Promise<string>;
export interface AgentOptions {
  databasePath:string;
  indexPath:string;
  delegate:HostDelegate;
  retrieval?:Partial<RetrievalConfig>;
}
export interface AgentBackgroundReceipt {
  status:'ready'|'failed'|'pending';
  processing:'ready'|'failed'|'pending';
  version:number;
  messageIds?:string[];
  error?:string;
}

/** Text inference uses host workers; optional retrieval providers only embed/rank filtered memories. */
export class AgentRuntime {
  private authority:Authority;
  private retrieval:Retrieval;
  private core:Core;
  private closed=false;
  private candidates=new Map<string,{scope:SceneScope;messages:SceneMessage[]}>();
  private background=new Map<string,{pending:boolean;obsolete:boolean;work:Promise<AgentBackgroundReceipt>}>();
  private pendingJobs=new Set<Promise<AgentBackgroundReceipt>>();
  private companionWatches=new Set<()=>void>();
  private companionInFlight=0;
  private presetInitializations=new Map<string,Promise<Awaited<ReturnType<Authority['scene']['presets']['initialize']>>>>();
  private presetRunner:(task:CompanionPresetCompletionTask)=>Promise<string>;
  private config:Configurations;
  constructor(options:AgentOptions) {
    if(typeof options.delegate!=='function') throw new Error('host_delegate_required');
    this.config=Object.fromEntries(stages.map(stage=>[stage,{baseUrl:'',key:'',model:stage==='embedding'||stage==='reranker'?'':stage}])) as Configurations;
    for(const stage of ['embedding','reranker'] as const)if(options.retrieval?.[stage])this.config[stage]=configOf(options.retrieval[stage]);
    this.retrieval=new Retrieval(options.indexPath);
    this.authority=new Authority(options.databasePath);
    this.presetRunner=async task=>{
      this.assertOpen();let output:string;
      try {output=await options.delegate({id:task.jobToken,stage:'companionPreset',kind:'background',messages:structuredClone(task.messages),responseFormat:'json',isolation:'fresh-context'});}
      catch(error){
        const code=error instanceof Error?error.message:'';
        if(/^FILE_HOST_(TIMEOUT|CLOSED|WORKER_FAILED|INVALID_RESULT)$/.test(code))throw new Error(code.replace('FILE_HOST_','host_').toLowerCase());
        throw error;
      }
      this.assertOpen();if(typeof output!=='string'||!output.trim()||output.length>50000)throw new Error('model_invalid_response');return output;
    };
    const runner:ModelRunner=async(configuration,messages,json)=>{
      this.assertOpen();
      let output:string;
      try {output=await options.delegate({id:randomUUID(),stage:configuration.model,kind:configuration.model==='front'?'foreground':'background',messages:structuredClone(messages),responseFormat:json?'json':'text',isolation:'fresh-context'});}
      catch(error) {
        const code=error instanceof Error?error.message:'';
        if(/^FILE_HOST_(TIMEOUT|CLOSED|WORKER_FAILED|INVALID_RESULT)$/.test(code))throw new Error(code.replace('FILE_HOST_','host_').toLowerCase());
        throw error;
      }
      this.assertOpen();
      if(typeof output!=='string'||!output.trim()||output.length>50000) throw new Error('model_invalid_response');
      return output;
    };
    this.core=new Core(this.authority,this.retrieval,new ModelTasks(runner));
  }

  interaction(scope:SceneScope) {
    this.assertOpen();return this.authority.scene.interactions.open(scopeOf(scope),'agent');
  }
  clock(scope:SceneScope) { return this.authority.scene.interactions.clock(this.companionScope(scope)); }
  setTimeZone(scope:SceneScope,timeZone:string|null,expectedRevision:number) {
    this.assertOpen();const result=this.authority.scene.interactions.settings(scopeOf(scope),'agent',{timeZone},expectedRevision);
    this.invalidateCandidates(result.scope);return result;
  }
  configure(scope:SceneScope,roster:unknown) {
    this.assertOpen();return this.core.scene.configure(this.companionScope(scope),roster);
  }
  configureWorld(scope:SceneScope,settings:unknown) {
    this.assertOpen();
    if(settings!==null && (typeof settings!=='object'||!settings||('mode' in settings && settings.mode!=='companion')))throw new Error('invalid_interaction_mode');
    return this.core.scene.configureWorld(this.companionScope(scope),settings);
  }
  checkpoint(scope:SceneScope,reason='手动保存点') {
    this.assertOpen();return this.core.scene.checkpoint(this.companionScope(scope),reason);
  }
  checkpoints(scope:SceneScope) {
    this.assertOpen();return this.core.scene.checkpoints(this.companionScope(scope));
  }
  workbench(scope:SceneScope,options:Parameters<typeof sceneWorkbench>[2]) {
    this.assertOpen();return sceneWorkbench(this.authority.scene,this.companionScope(scope),options);
  }
  progress(scope:SceneScope) { this.assertOpen();return this.core.scene.progress(this.companionScope(scope)); }
  resources(scope:SceneScope){this.assertOpen();return this.core.scene.resources(this.companionScope(scope));}
  initializationProvenance(scope:SceneScope){this.assertOpen();return this.authority.scene.initialization.provenance(this.companionScope(scope));}
  previewCompanionPreset(scope:SceneScope,document:unknown){this.assertOpen();return this.authority.scene.presets.preview(this.companionScope(scope),document);}
  importCompanionPreset(scope:SceneScope,document:unknown,guard:CompanionPresetGuard){
    this.assertOpen();return this.authority.scene.presets.import(this.companionScope(scope),document,guard);
  }
  companionPreset(scope:SceneScope){this.assertOpen();return this.authority.scene.presets.status(this.companionScope(scope));}
  initializeCompanionPreset(scope:SceneScope){this.assertOpen();return this.runCompanionPresetInitialization(this.companionScope(scope));}
  previewInitializationRefresh(scope:SceneScope,sources:unknown){this.assertOpen();return this.authority.scene.initialization.previewRefresh(this.companionScope(scope),sources);}
  refreshInitialization(scope:SceneScope,sources:unknown,guard:import('../scene/initialization.ts').InitializationApplyGuard){
    this.assertOpen();return this.authority.scene.initialization.refresh(this.companionScope(scope),sources,guard);
  }
  configureResources(scope:SceneScope,value:import('../scene/resources.ts').NpcResourceConfiguration){this.assertOpen();return this.core.scene.configureResources(this.companionScope(scope),value);}
  commitments(scope:SceneScope,query:import('../commitments/types.ts').CommitmentQuery={}){this.assertOpen();return this.authority.scene.commitments.list(this.companionScope(scope),{...query,mode:'companion'});}
  bindSubject(scope:SceneScope,subjectId:string){this.assertOpen();return this.authority.scene.bindSubject(this.companionScope(scope),text(subjectId,200));}
  profile(scope:SceneScope){this.assertOpen();scope=this.companionScope(scope);const subject=this.authority.scene.subject(scope);return {subject,
    controls:subject?this.authority.scene.userModel.controls(subject.subjectId):null,entries:subject?this.authority.scene.userModel.listEntries(subject.subjectId,{purpose:'user'}):[]};}
  setProfileControls(scope:SceneScope,patch:Parameters<import('../user-model/store.ts').UserModelStore['setControls']>[1],expectedRevision:number){
    this.assertOpen();const subject=this.requiredSubject(scope),result=this.authority.scene.userModel.setControls(subject,patch,expectedRevision);
    this.authority.scene.companion.refreshControls(subject);this.core.scene.invalidateModelConfiguration();return result;
  }
  correctProfile(scope:SceneScope,id:string,correction:Parameters<import('../user-model/store.ts').UserModelStore['correctEntry']>[2]){
    this.assertOpen();const subject=this.requiredSubject(scope),result=this.authority.scene.userModel.correctEntry(subject,id,correction);
    this.authority.scene.companion.refreshControls(subject);this.core.scene.invalidateModelConfiguration();return result;
  }
  deleteProfile(scope:SceneScope,id:string){this.assertOpen();const subject=this.requiredSubject(scope);this.authority.scene.userModel.deleteEntry(subject,id);
    this.authority.scene.companion.refreshControls(subject);this.core.scene.invalidateModelConfiguration();return {status:'deleted'};}
  companionStatus(scope:SceneScope,characterId:string){this.assertOpen();return this.core.scene.companion.status(this.companionScope(scope),characterId);}
  physiologyStatus(scope:SceneScope,readerId:string='player'){this.assertOpen();return this.authority.scene.physiology.status(this.companionScope(scope),{readerId});}
  configurePhysiology(scope:SceneScope,config:import('../scene/physiology.ts').PhysiologyConfiguration,expectedRevision:number){
    this.assertOpen();scope=this.companionScope(scope);const result=this.authority.scene.physiology.configure(scope,config,expectedRevision);
    this.invalidateCandidates(scope);return result;
  }
  correctPhysiology(scope:SceneScope,correction:import('../scene/physiology.ts').PhysiologyCorrectionInput,expectedRevision:number){
    this.assertOpen();scope=this.companionScope(scope);const result=this.authority.scene.physiology.correct(scope,correction,expectedRevision);
    this.invalidateCandidates(scope);return result;
  }
  clearPhysiologyCorrection(scope:SceneScope,characterId:string,id:string,expectedRevision:number){
    this.assertOpen();scope=this.companionScope(scope);const result=this.authority.scene.physiology.clearCorrection(scope,characterId,id,expectedRevision);
    this.invalidateCandidates(scope);return result;
  }
  setContactSettings(scope:SceneScope,settings:Parameters<import('../companion/store.ts').CompanionStore['setContactSettings']>[1],expectedRevision:number){
    this.assertOpen();return this.authority.scene.companion.setContactSettings(this.requiredSubject(scope),settings,expectedRevision);
  }
  setBusyUntil(scope:SceneScope,busyUntilMs:number|null,expectedRevision:number){this.assertOpen();return this.authority.scene.companion.setBusyUntil(this.requiredSubject(scope),busyUntilMs,expectedRevision);}
  pollCompanion(scope:SceneScope,characterId:string,trigger:'event'|'scheduled'='event'){
    this.assertOpen();return this.core.scene.companionPoll(this.companionScope(scope),characterId,trigger,this.config);
  }
  claimCompanion(scope:SceneScope,characterId:string,deliveryId:string){this.assertOpen();return this.core.scene.companion.claim(this.companionScope(scope),characterId,deliveryId,'agent');}
  reconcileCompanion(scope:SceneScope,characterId:string,deliveryId:string,outcome:{status:'sent';hostMessageId:string}|{status:'failed';code:string}){
    this.assertOpen();return this.core.scene.reconcileCompanion(this.companionScope(scope),characterId,deliveryId,outcome,this.config);
  }
  companionReceipt(scope:SceneScope,characterId:string,deliveryId:string,claimToken:string,outcome:{status:'sent';hostMessageId:string}|{status:'failed'|'unknown';code:string}){
    this.assertOpen();return this.core.scene.companionReceipt(this.companionScope(scope),characterId,deliveryId,claimToken,outcome,this.config);
  }
  /** All inference still uses delegate; deliver receives only the final filtered body. */
  async dispatchCompanion(scope:SceneScope,characterId:string,deliver:(message:{deliveryId:string;characterId:string;body:string})=>Promise<{hostMessageId:string}>,trigger:'event'|'scheduled'='event'){
    this.assertOpen();if(typeof deliver!=='function')throw new Error('host_delivery_required');
    this.companionInFlight++;
    try{
    const candidate=await this.pollCompanion(scope,characterId,trigger);
    if(candidate.status!=='ready'||!('deliveryId' in candidate))return candidate;
    const claim=this.claimCompanion(scope,characterId,candidate.deliveryId!);
    let result:{hostMessageId:string};
    try {result=await deliver({deliveryId:claim.deliveryId,characterId,body:claim.body});}
    catch {return await this.companionReceipt(scope,characterId,claim.deliveryId,claim.claimToken,{status:'unknown',code:'host_delivery_unconfirmed'});}
    return await this.companionReceipt(scope,characterId,claim.deliveryId,claim.claimToken,{status:'sent',hostMessageId:text(result.hostMessageId,200)});
    }finally{this.companionInFlight--;}
  }
  watchCompanion(scope:SceneScope,characterId:string,deliver:(message:{deliveryId:string;characterId:string;body:string})=>Promise<{hostMessageId:string}>,onError:(error:unknown)=>void,intervalMs=60_000){
    this.assertOpen();if(typeof deliver!=='function'||typeof onError!=='function'||!Number.isSafeInteger(intervalMs)||intervalMs<1000)throw new Error('invalid_companion_watch');
    let running=false,stopped=false;
    const timer=setInterval(async()=>{
      if(running||stopped||this.closed)return;
      const controls=this.profile(scope).controls;
      if(!controls?.scheduledWakeEnabled||!controls.proactiveCompanionEnabled)return;
      running=true;try{await this.dispatchCompanion(scope,characterId,deliver,'scheduled');}catch(error){onError(error);}finally{running=false;}
    },intervalMs);timer.unref();
    const stop=()=>{stopped=true;clearInterval(timer);this.companionWatches.delete(stop);};this.companionWatches.add(stop);return stop;
  }
  private requiredSubject(scope:SceneScope){const subject=this.authority.scene.subject(this.companionScope(scope));if(!subject)throw new Error('companion_subject_not_bound');return subject.subjectId;}
  exportTemplate(scope:SceneScope,name:string) { this.assertOpen();return this.authority.scene.transfer.exportTemplate(this.companionScope(scope),name); }
  previewTransfer(scope:SceneScope,document:unknown) { this.assertOpen();return this.authority.scene.transfer.preview(this.companionScope(scope),document); }
  applyTransfer(scope:SceneScope,document:unknown,guard:{expectedVersion:number;previewId:string;operationId:string}) {
    this.assertOpen();scope=this.companionScope(scope);const result=this.authority.scene.transfer.apply(scope,document,guard);this.invalidateCandidates(scope);return result;
  }
  deleteReference(scope:SceneScope,id:string,guard:SceneWriteGuard) {
    this.assertOpen();scope=this.companionScope(scope);const result=this.authority.scene.transfer.deleteReference(scope,id,guard);this.invalidateCandidates(scope);return result;
  }
  retryPending(scope:SceneScope,sourceId?:string,revision?:number) {
    this.assertOpen();return this.core.scene.retryPending(this.companionScope(scope),this.config,sourceId,revision);
  }
  previewRestore(scope:SceneScope,checkpointId?:string) {
    this.assertOpen();return this.authority.scene.lifecycle.preview(this.companionScope(scope),checkpointId);
  }
  correctSource(scope:SceneScope,sourceId:string,revision:number,replacement:string|null,guard:SceneWriteGuard) {
    this.assertOpen();return correctSceneSource(this.core,this.companionScope(scope),sourceId,revision,replacement,guard,this.config);
  }
  async clearPendingIndexes() { this.assertOpen();await this.core.scene.clearPendingIndexes(); }
  async restore(scope:SceneScope,checkpointId:string,expectedVersion?:number) {
    this.assertOpen();scope=this.companionScope(scope);this.invalidateCandidates(scope);
    if(expectedVersion!==undefined&&this.authority.scene.state(scope).version!==expectedVersion)throw new Error('context_changed_retry');
    const result=await this.core.scene.restore(scope,checkpointId,expectedVersion);
    return {status:'restored',version:result.version,cleanupPending:result.cleanupPending,...('cleanupError' in result?{cleanupError:result.cleanupError}:{})};
  }
  async undo(scope:SceneScope,expectedVersion?:number,checkpointId?:string) {
    this.assertOpen();scope=this.companionScope(scope);this.invalidateCandidates(scope);
    if(expectedVersion!==undefined&&this.authority.scene.state(scope).version!==expectedVersion)throw new Error('context_changed_retry');
    const result=await this.core.scene.undo(scope,expectedVersion,checkpointId);
    return {status:result.undone?'undone':'unchanged',version:result.version,cleanupPending:result.cleanupPending,...('cleanupError' in result?{cleanupError:result.cleanupError}:{})};
  }
  fork(scope:SceneScope,branchId:string,checkpointId?:string) {
    this.assertOpen();scope=this.companionScope(scope);
    const result=this.authority.scene.interactions.fork(scope,'agent',()=>this.core.scene.fork(scope,branchId,checkpointId));
    this.authority.scene.refreshDerived(result.scope);
    return {scope:result.scope,version:result.version};
  }
  syncState(scope:SceneScope) { this.assertOpen();return this.core.scene.syncState(this.companionScope(scope)); }
  async sync(scope:SceneScope,messages:unknown,guard?:SceneWriteGuard) {
    this.assertOpen();
    if(!guard)throw new Error('invalid_scene_operation');
    return this.core.scene.reconcile(this.companionScope(scope),messages,this.config,guard);
  }
  async reconfirmSource(scope:SceneScope,sourceId:string,guard:SceneWriteGuard) {
    this.assertOpen();return this.core.scene.reconfirm(this.companionScope(scope),text(sourceId,200),this.config,guard);
  }
  async retry(scope:SceneScope) {
    this.assertOpen();return this.core.scene.processPending(this.companionScope(scope),this.config);
  }
  /** Only the target's already-filtered packet is returned to the calling foreground. */
  async recall(scope:SceneScope,characterId:string,query:string) {
    this.assertOpen();scope=this.companionScope(scope);characterId=text(characterId,200);query=text(query,20000);
    await this.ensureCompanionPreset(scope);
    const state=this.authority.scene.state(scope);
    const character=state.roster.characters.find(item=>item.id===characterId);
    if(!character) throw new Error('invalid_scene_character');
    if(state.sources.some(source=>source.status==='accepted'&&source.processing!=='ready')) throw new Error('invalid_scene_processing');
    const assertCurrent=()=>{this.assertOpen();if(this.authority.scene.state(scope).version!==state.version)throw new Error('context_changed_retry');};
    const context=await this.core.contextFrom(this.authority.scene.snapshot(scope,characterId),query,this.config,this.authority.scene.responseEmotion(scope,characterId),this.authority.scene.preferences(scope,characterId),assertCurrent);
    const relations=this.authority.scene.relationships(scope,characterId,state);
    const relation=relations.find(item=>item.targetId==='player');
    const playerName=state.sources.filter(source=>source.status==='accepted').at(-1)?.envelope.playerName;
    context.context+=relationshipContext(relations)+addressSuggestion(typeof playerName==='string'&&!!playerName.trim(),relation);
    context.context+=this.authority.scene.worldContext(scope,characterId);
    context.context+=this.authority.scene.physiology.context(scope,characterId);
    context.context+=this.authority.scene.commitments.projectPersistent(scope,{characterId,purpose:'expression',mode:'companion'}).systemText;
    context.context+=await this.core.scene.companionContext(scope,characterId,context.context,this.config);
    return {scope,characterId,version:context.version,persona:character.persona,context:context.context,memories:context.memories,facts:context.facts,episodes:context.episodes,legacy:context.legacy,emotion:context.emotion,preferences:context.preferences,retrieval:context.retrieval};
  }
  /** The submitted user text is accepted now; only the generated reply awaits accept(). */
  async prepare(scope:SceneScope,envelope:unknown,input:string,submission?:{userMessageId:string;operationId?:string;expectedVersion?:number;acceptedAtMs?:number}) {
    this.assertOpen();scope=this.companionScope(scope);
    await this.ensureCompanionPreset(scope);
    const state=this.authority.scene.state(scope);
    const userMessageId=submission?.userMessageId??'agent-user-'+randomUUID();
    const existing=state.sources.find(source=>source.id===userMessageId);
    const draft=await this.core.scene.prepare(scope,envelope,input,this.config,{userMessageId,operationId:submission?.operationId??randomUUID(),
      expectedVersion:submission?.expectedVersion??state.version,acceptedAtMs:submission?.acceptedAtMs??existing?.acceptedAtMs??Date.now()});
    if(draft.status==='failed')return {status:'failed' as const,phase:draft.phase,version:draft.version,error:draft.error,userMessageId};
    if(!draft.draftId || !draft.userMessage || !draft.assistantMessage) return {status:'needs_clarification' as const,version:draft.version,reason:'Clarify the current actors and what they can observe.'};
    this.candidates.set(draft.draftId,{scope,messages:[draft.userMessage,draft.assistantMessage]});
    // World observations and raw source bundles remain behind the runtime boundary.
    return {status:'prepared' as const,draftId:draft.draftId,version:draft.version,answer:draft.answer,userMessageId:draft.userMessage.id};
  }
  async regenerate(scope:SceneScope) {
    this.assertOpen();scope=this.companionScope(scope);const draft=await this.core.scene.regenerate(scope,this.config);
    if(!draft.draftId||!draft.userMessage||!draft.assistantMessage)return {status:'needs_clarification' as const,version:draft.version};
    this.candidates.set(draft.draftId,{scope,messages:[draft.userMessage,draft.assistantMessage]});
    return {status:'prepared' as const,draftId:draft.draftId,version:draft.version,answer:draft.answer};
  }
  async accept(scope:SceneScope,draftId:string) {
    this.assertOpen();scope=this.companionScope(scope);
    const candidate=this.candidates.get(draftId);
    if(!candidate||scopeKey(candidate.scope)!==scopeKey(scope)) throw new Error('invalid_scene_draft');
    const receipt=await this.core.scene.accept(scope,draftId,candidate.messages,this.config);
    return {...receipt,messageIds:candidate.messages.map(message=>message.id)};
  }
  /**
   * Durably accepts the prepared reply; the user was already processed by prepare(). Memory/emotion/
   * preference processing continue through host delegates. Callers may display
   * prepare().answer before this, but must explicitly confirm acceptance first.
   */
  async acceptBackground(scope:SceneScope,draftId:string) {
    this.assertOpen();scope=this.companionScope(scope);
    const candidate=this.candidates.get(draftId);
    if(!candidate||scopeKey(candidate.scope)!==scopeKey(scope)) throw new Error('invalid_scene_draft');
    const work=this.core.scene.accept(scope,draftId,candidate.messages,this.config);
    const state=this.authority.scene.state(scope);
    const accepted=candidate.messages.every(message=>state.sources.some(source=>sameAcceptedSource(source,message)));
    if(!accepted) {
      await work;
      throw new Error('agent_accept_not_durable');
    }
    const messageIds=candidate.messages.map(message=>message.id);
    const tracked:Promise<AgentBackgroundReceipt>=work.then(receipt=>receipt.status==='committed'||receipt.status==='duplicate'
      ? {status:'ready',processing:'ready',version:receipt.version,messageIds}
      : {status:'failed',processing:'failed',version:receipt.version,messageIds,...(receipt.error?{error:receipt.error}:{})},
    error=>({status:'failed',processing:'failed',version:this.authority.scene.state(scope).version,messageIds,error:backgroundError(error)}));
    const job={pending:true,obsolete:false,work:tracked};
    this.background.set(scopeKey(scope),job);
    this.pendingJobs.add(tracked);
    tracked.then(()=>{job.pending=false;this.pendingJobs.delete(tracked);},()=>{job.pending=false;this.pendingJobs.delete(tracked);});
    // Attach a rejection observer even when a caller delays waitForBackground.
    tracked.catch(()=>{});
    const sources=this.authority.scene.state(scope).sources.filter(source=>messageIds.includes(source.id));
    const processing=sources.every(source=>source.processing==='ready')?'ready':'pending';
    return {status:'accepted' as const,processing,version:state.version,messageIds};
  }
  /** Waits for this runtime's latest background acceptance for the scope. */
  async waitForBackground(scope:SceneScope):Promise<AgentBackgroundReceipt> {
    this.assertOpen();scope=this.companionScope(scope);
    const job=this.background.get(scopeKey(scope));
    if(job&&!job.obsolete)return job.work;
    const state=this.authority.scene.state(scope);
    const pending=state.sources.filter(source=>source.status==='accepted'&&source.processing!=='ready');
    if(pending.some(source=>source.processing==='failed'))return {status:'failed',processing:'failed',version:state.version,error:'background_processing_failed'};
    if(pending.length)return {status:'pending',processing:'pending',version:state.version};
    return {status:'ready',processing:'ready',version:state.version};
  }
  reject(scope:SceneScope,draftId:string) {
    this.assertOpen();scope=this.companionScope(scope);
    const result=this.core.scene.reject(scope,draftId);this.candidates.delete(draftId);return result;
  }
  setAccess(scope:SceneScope,characterId:string,memoryId:string,access:string) {
    this.assertOpen();this.core.scene.setAccess(this.companionScope(scope),text(characterId,200),text(memoryId,500),text(access,20));
  }
  setPreference(scope:SceneScope,characterId:string,id:string,enabled:boolean,newText?:string) {
    this.assertOpen();this.core.scene.setPreference(this.companionScope(scope),text(characterId,200),text(id,500),enabled,newText===undefined?undefined:text(newText,500));
  }
  async editSource(scope:SceneScope,messageId:string,replacement:string|null) {
    this.assertOpen();scope=this.companionScope(scope);messageId=text(messageId,200);
    if(replacement!==null)replacement=text(replacement,20000);
    const state=this.authority.scene.state(scope);
    const sources=state.sources.filter(source=>source.status!=='deleted');
    if(!sources.some(source=>source.id===messageId))throw new Error('record_not_found');
    const messages=sources.filter(source=>replacement!==null||source.id!==messageId).map(source=>({...source,text:source.id===messageId?replacement!:source.text}));
    return this.core.scene.reconcile(scope,messages,this.config,{expectedVersion:state.version,operationId:randomUUID()});
  }
  close() {
    if(this.closed)return;
    if(this.pendingJobs.size||this.companionInFlight||this.presetInitializations.size)throw new Error('agent_background_pending');
    for(const stop of this.companionWatches)stop();
    this.closed=true;this.candidates.clear();this.background.clear();this.retrieval.close();this.authority.close();
  }
  private companionScope(value:SceneScope):SceneScope {
    this.assertOpen();const interaction=this.authority.scene.interactions.open(scopeOf(value),'agent');
    if(interaction.mode!=='companion')throw new Error('invalid_interaction_mode');
    this.authority.scene.interactions.assertActive(interaction.scope,interaction.revision);return interaction.scope;
  }
  private assertOpen(){if(this.closed)throw new Error('agent_runtime_closed');}
  private runCompanionPresetInitialization(scope:SceneScope){
    const key=scopeKey(scope),existing=this.presetInitializations.get(key);if(existing)return existing;
    const work=this.authority.scene.presets.initialize(scope,this.presetRunner);
    this.presetInitializations.set(key,work);
    void work.finally(()=>{if(this.presetInitializations.get(key)===work)this.presetInitializations.delete(key);}).catch(()=>{});
    return work;
  }
  private async ensureCompanionPreset(scope:SceneScope):Promise<void>{
    const status=this.authority.scene.presets.status(scope);if(!status||status.status==='ready')return;
    const result=await this.runCompanionPresetInitialization(scope);
    if(result.status!=='ready')throw new Error('error' in result&&result.error?result.error:'companion_preset_initialization_failed');
  }
  private invalidateCandidates(scope:SceneScope) {
    const key=scopeKey(scope);
    for(const [id,candidate] of this.candidates)if(scopeKey(candidate.scope)===key)this.candidates.delete(id);
    const job=this.background.get(key);if(job)job.obsolete=true;
  }
}

function addressSuggestion(identityKnown:boolean,relation:import('../emotion/relationships.ts').FoldedRelationship|undefined):string {
  const suggestion=suggestAddress({visibility:'private',presentCount:2,formality:'casual',addresseeIdentityKnown:identityKnown},relation?{
    sourceId:relation.sourceId,revision:relation.revision,status:'accepted',direction:'speaker-to-addressee',relations:relation.relations,
  }:undefined);
  return `\n[XLDB 称谓建议] 当前上下文中已列明的显式称谓、拒绝和边界偏好优先于本建议。${suggestion.instruction}`;
}

function sameAcceptedSource(source:ReturnType<Authority['scene']['state']>['sources'][number],message:SceneMessage):boolean {
  return source.status==='accepted' && source.id===message.id && source.revision===message.revision
    && source.role===message.role && source.text===message.text && source.acceptedAtMs===message.acceptedAtMs
    && source.speakerId===message.speakerId && source.automatic===message.automatic
    && JSON.stringify(source.envelope)===JSON.stringify(message.envelope)
    && JSON.stringify(source.dependencies??[])===JSON.stringify(message.dependencies??[]);
}

function backgroundError(error:unknown):string {
  const message=error instanceof Error?error.message:'';
  return /^(invalid_scene_[a-z_]+|context_changed_retry|model_[a-z_0-9]+|host_(timeout|closed|worker_failed|invalid_result))$/.test(message)
    ? message : 'background_processing_failed';
}
