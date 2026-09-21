import { randomUUID } from 'node:crypto';
import type { Core } from '../core/service.ts';
import { ModelTasks } from '../core/models.ts';
import { integer, messageOf, object, scopeKey, text } from '../core/types.ts';
import type { Configurations, Analysis } from '../core/types.ts';
import { SceneAuthority } from './store.ts';
import { directPlan, envelopeOf, rosterOf, visibleText } from './perspective.ts';
import type { SceneScope, SceneEnvelope, SceneMessage, SceneRoster, PerspectivePlan, SceneAnalysis, SceneState, SceneWriteGuard } from './types.ts';
import {npcScope} from './types.ts';
import {commitmentTransitionTargets,extractCommitmentPrompt,foldCommitments,validateCommitmentOperations} from '../commitments/index.ts';
import {buildInitializationPrompt,decodeInitializationCandidate} from './initialization.ts';
import type {InitializationSource} from './initialization.ts';
import {CompanionFlow} from './companion-flow.ts';
import {processingFingerprint} from './processing.ts';
import type {ProcessingAddress,ProcessingProgress} from './processing.ts';
import {suggestAddress} from '../emotion/address.ts';
import {relationshipContext} from '../emotion/relationships.ts';
import {geographyBackgroundSources,geographyBackgroundSystem,decodeGeographyBackground} from './geography-background.ts';

interface Draft {
  id:string; scope:SceneScope; version:number; modelRevision:number; expires:number;
  userMessage:SceneMessage; assistantMessage:SceneMessage; assistantPlan:PerspectivePlan;
  accepted:boolean; complete:boolean;
}

interface PrepareWrite extends SceneWriteGuard {
  userMessageId:string;
  acceptedAtMs?:number;
}

export class SceneCore {
  readonly companion:CompanionFlow;
  private authority: SceneAuthority;
  private core: Core;
  private models: ModelTasks;
  private drafts = new Map<string,Draft>();
  private jobs = new Map<string,Promise<{status:string;version:number;error?:string}>>();
  private modelRevision=0;
  private nativeTickets=new Map<string,{scope:SceneScope;version:number;modelRevision:number;expires:number;envelope:SceneEnvelope;dependencies:{id:string;revision:number}[];replyTo:{id:string;revision:number};automatic:boolean;speakerId?:string;accepted?:SceneMessage}>();
  constructor(authority:SceneAuthority, core:Core, models:ModelTasks) {
    this.authority=authority;this.core=core;this.models=models;
    this.companion=new CompanionFlow(authority,core,models);
  }

  configure(scope:SceneScope, value:unknown) { return this.authority.configure(scope,rosterOf(value)); }
  async previewGeographyBackground(scope:SceneScope,value:unknown,configs:Configurations){
    const input=object(value),state=this.authority.state(scope),modelRevision=this.modelRevision;
    if(this.authority.interactions.modeOf(scope)!=='roleplay'||this.authority.geography.configuration(scope).backgroundSeed!=='enabled')throw new Error('geography_background_disabled');
    const sources=geographyBackgroundSources(input.sources),mapId=text(input.mapId,200),revision=integer(input.revision,1);
    if(input.basis!=='author_setting'&&input.basis!=='map_report')throw new Error('invalid_geography_basis');
    const actors=['player',...state.roster.characters.map(actor=>actor.id)];
    if(!Array.isArray(input.allowedReaders)||input.allowedReaders.some(id=>typeof id!=='string'||!actors.includes(id)))throw new Error('invalid_geography_readers');
    const parameters={mapId,revision,basis:input.basis,allowedReaders:input.allowedReaders as string[]};
    const raw=await this.models.structuredTask(configs.geography,[{role:'system',content:geographyBackgroundSystem},
      {role:'user',content:JSON.stringify({...parameters,sources,actors:state.roster.characters.map(({id,name})=>({id,name}))})}]);
    this.assertVersion(scope,state.version);if(modelRevision!==this.modelRevision)throw new Error('context_changed_retry');
    const candidate=decodeGeographyBackground(raw,sources,parameters);
    const preview=this.authority.geography.previewImport(scope,{...candidate.document,backgroundSources:sources});
    return {document:preview.normalized,evidence:candidate.evidence,preview};
  }
  async previewInitialization(scope:SceneScope,sources:InitializationSource[],configs:Configurations){
    const state=this.authority.state(scope),revision=this.modelRevision;
    const prompt=buildInitializationPrompt(sources,state.roster);
    const raw=await this.models.structuredTask(configs.initialization,prompt.messages);
    this.assertVersion(scope,state.version);
    if(revision!==this.modelRevision)throw new Error('context_changed_retry');
    const candidate=decodeInitializationCandidate(raw,sources);
    return {candidate,sources,preview:this.authority.initialization.preview(scope,candidate,sources)};
  }
  resources(scope:SceneScope){return this.authority.npcResources.status(scope,this.authority.state(scope).roster.characters.map(character=>character.id));}
  configureResources(scope:SceneScope,value:import('./resources.ts').NpcResourceConfiguration){
    const result=this.authority.npcResources.configure(scope,this.authority.state(scope).roster.characters.map(character=>character.id),value);
    this.invalidateModelConfiguration();return result;
  }
  async companionPoll(scope:SceneScope,characterId:string,trigger:'event'|'scheduled',configs:Configurations){
    const version=this.authority.state(scope).version,revision=this.modelRevision;
    return this.companion.poll(scope,characterId,trigger,configs,()=>{
      this.assertVersion(scope,version);if(revision!==this.modelRevision)throw new Error('context_changed_retry');
    });
  }
  async companionReceipt(scope:SceneScope,characterId:string,deliveryId:string,claimToken:string,
    outcome:{status:'sent';hostMessageId:string}|{status:'failed'|'unknown';code:string},configs:Configurations){
    const delivery=this.companion.receipt(scope,characterId,deliveryId,claimToken,outcome);
    return this.learnCompanionDelivery(scope,characterId,deliveryId,delivery,configs);
  }
  async reconcileCompanion(scope:SceneScope,characterId:string,deliveryId:string,
    outcome:{status:'sent';hostMessageId:string}|{status:'failed';code:string},configs:Configurations){
    const delivery=this.companion.reconcile(scope,characterId,deliveryId,outcome);
    return this.learnCompanionDelivery(scope,characterId,deliveryId,delivery,configs);
  }
  private async learnCompanionDelivery(scope:SceneScope,characterId:string,deliveryId:string,
    delivery:ReturnType<CompanionFlow['receipt']>,configs:Configurations){
    if(delivery.status!=='host_committed')return {delivery,...this.syncState(scope)};
    const existing=this.authority.state(scope).sources.find(source=>source.id===`proactive:${deliveryId}`);
    const source=existing??this.companion.acceptedMessage(scope,characterId,deliveryId);
    if(!existing)this.authority.reconcile(scope,[source],false);
    const processed=await this.processPending(scope,configs);
    return {delivery,source,processing:processed,...this.syncState(scope)};
  }
  async companionContext(scope:SceneScope,characterId:string,context:string,configs:Configurations){
    const version=this.authority.state(scope).version,revision=this.modelRevision;
    return this.companion.systemContext(scope,characterId,context,configs,()=>{
      this.assertVersion(scope,version);if(revision!==this.modelRevision)throw new Error('context_changed_retry');
    });
  }
  private commitmentsContext(scope:SceneScope,characterId:string){
    const mode=this.authority.interactions.modeOf(scope);
    if(!mode)return '';
    const persistent=this.authority.commitments.projectPersistent(scope,{characterId,purpose:'expression',mode}).systemText;
    const clock=this.authority.interactions.clock(scope);
    if(mode==='roleplay'&&!clock.known)return persistent;
    const due=this.authority.commitments.dueTodos(scope,{realNowMs:Date.now(),storyNowMs:mode==='roleplay'?Number(clock.timeMs):0},mode);
    const reminders=[...new Map(due.map(todo=>[todo.commitmentId,todo])).values()]
      .flatMap(todo=>{const record=this.authority.commitments.get(scope,todo.commitmentId);
        return record?.readers.includes(characterId)?[{content:record.content,stage:todo.stage,dueAtMs:todo.dueAtMs,clock:todo.clock}]:[];});
    return persistent+(reminders.length?'\n当前时钟下已到提醒时点的有效约定（不是已经履行，不替用户行动）：'+JSON.stringify(reminders):'');
  }
  configureWorld(scope:SceneScope,value:unknown) {
    if(value===null)return this.authority.configureWorld(scope,null);
    const input=object(value);
    const roster=this.authority.state(scope).roster;
    const settings={...input,actorLabels:Object.fromEntries(roster.characters.map(actor=>[actor.id,[actor.name,...actor.aliases]]))};
    return this.authority.configureWorld(scope,settings as unknown as import('./world-state.ts').WorldSettings);
  }
  inspect(scope:SceneScope, characterId?:string) { return {...this.authority.inspect(scope,characterId),
    ...(characterId?{}:{hasInitialization:this.authority.initialization.provenance(scope).sources.length>0})}; }
  progress(scope:SceneScope):ProcessingProgress {
    const state=this.authority.state(scope);
    const geography=this.authority.geography.configuration(scope);
    return this.authority.processing.progress(scope,state,Boolean(this.authority.worldSettings(scope)),this.authority.physiology.configuration(scope).config.enabled,
      this.authority.interactions.modeOf(scope)==='roleplay'&&geography.enabled&&geography.followAcceptedProse);
  }
  syncState(scope:SceneScope) { return this.authority.syncState(scope); }
  invalidateModelConfiguration() {
    this.modelRevision++;this.nativeTickets.clear();this.drafts.clear();
    this.authority.processing.clearAll();
  }
  checkpoint(scope:SceneScope,reason:string) { return this.authority.lifecycle.checkpoint(scope,text(reason,200)); }
  checkpoints(scope:SceneScope) { return this.authority.lifecycle.list(scope); }
  async restore(scope:SceneScope,id:string,expectedVersion?:number) {
    this.authority.lifecycle.restore(scope,text(id,200),expectedVersion);this.authority.processing.clearScope(scope);this.clearScopeDrafts(scope);
    const cleanup=await this.finishLifecycleCleanup();
    return {...this.authority.inspect(scope),...cleanup};
  }
  async undo(scope:SceneScope,expectedVersion?:number,checkpointId?:string) {
    const result=this.authority.lifecycle.undo(scope,expectedVersion,checkpointId);this.authority.processing.clearScope(scope);this.clearScopeDrafts(scope);
    const cleanup=await this.finishLifecycleCleanup();
    return {undone:Boolean(result),...this.authority.inspect(scope),...cleanup};
  }
  fork(scope:SceneScope,branchId:string,checkpointId?:string) {
    const target=this.authority.lifecycle.fork(scope,text(branchId,200),checkpointId);
    return {scope:target,...this.authority.inspect(target)};
  }
  private clearScopeDrafts(scope:SceneScope) {
    for(const [id,draft] of this.drafts)if(scopeKey(draft.scope)===scopeKey(scope))this.drafts.delete(id);
    for(const [id,ticket] of this.nativeTickets)if(scopeKey(ticket.scope)===scopeKey(scope))this.nativeTickets.delete(id);
    // In-flight jobs remain tracked until completion. Their old version cannot commit.
  }
  private async clearDeletedIndexes(scope:SceneScope) {
    for(const pending of this.authority.pendingIndexCleanup(scope)) {
      await this.core.clearProjection(npcScope(scope,pending.character));
      this.authority.finishIndexCleanup(scope,pending.character,pending.version);
    }
  }
  async clearPendingIndexes() {
    for(const scope of this.authority.indexCleanupScopes())await this.clearDeletedIndexes(scope);
  }
  private async finishLifecycleCleanup() {
    try { await this.clearPendingIndexes();return {cleanupPending:false}; }
    catch { return {cleanupPending:true,cleanupError:'retrieval_cleanup_failed'}; }
  }
  identityPlan(value:unknown,configs:Configurations) { return this.models.identityPlan(value,configs.identity); }
  async identityExtract(scope:SceneScope,value:unknown,configs:Configurations) {
    const state=this.authority.state(scope);
    const result=await this.models.identityExtract({...object(value),existing:state.roster},configs.identity);
    this.assertVersion(scope,state.version);
    if(result.characters.length) this.authority.configure(scope,rosterOf({characters:result.characters}));
    return {...result,roster:this.authority.state(scope).roster,...this.syncState(scope)};
  }
  setAccess(scope:SceneScope, characterId:string, memoryId:string, access:string) {
    this.authority.setAccess(scope,characterId,memoryId,access as Parameters<SceneAuthority['setAccess']>[3]);
  }
  setPreference(scope:SceneScope,characterId:string,id:string,enabled:boolean,newText?:string) {
    this.authority.setPreference(scope,characterId,id,enabled,newText);
  }

  async retryPending(scope:SceneScope,configs:Configurations,sourceId?:string,revision?:number) {
    let target:{sourceId:string;revision:number}|undefined;
    if(sourceId!==undefined||revision!==undefined){
      if(sourceId===undefined||revision===undefined||!Number.isSafeInteger(revision)||revision<1)throw new Error('invalid_scene_processing_target');
      const source=this.authority.state(scope).sources.find(item=>item.id===sourceId&&item.status==='accepted');
      if(!source||source.revision!==revision)throw new Error('context_changed_retry');
      target={sourceId,revision};
    }
    const result=await this.processPending(scope,configs,new Map(),target);
    return {...result,progress:this.progress(scope)};
  }

  async reconcile(scope:SceneScope, value:unknown, configs:Configurations, guard?:SceneWriteGuard) {
    if (!Array.isArray(value) || value.length>10000) throw new Error('invalid_messages');
    const roster=this.authority.state(scope).roster;
    const messages=value.map(item=>sceneMessageOf(item,roster));
    const change=this.authority.reconcile(scope,messages,true,Date.now(),guard);
    const state=this.authority.state(scope);
    const acceptedStamp=sourceStamp(state);
    await this.clearDeletedIndexes(scope);
    if(sourceStamp(this.authority.state(scope))!==acceptedStamp)throw new Error('context_changed_retry');
    const result=await this.processPending(scope,configs);
    if(sourceStamp(this.authority.state(scope))!==acceptedStamp)throw new Error('context_changed_retry');
    return {...change,...result,...this.syncState(scope)};
  }

  async reconfirm(scope:SceneScope,sourceId:string,configs:Configurations,guard:SceneWriteGuard) {
    const state=this.authority.state(scope),source=state.sources.find(item=>item.id===sourceId&&item.status==='needs_review');
    if(!source)throw new Error('invalid_scene_review');
    const dependencies=(source.dependencies??[]).map(dependency=>{
      const parent=state.sources.find(item=>item.id===dependency.id&&item.status==='accepted');
      if(!parent)throw new Error('invalid_scene_dependencies');
      return {id:parent.id,revision:parent.revision};
    });
    const antecedent=source.replyTo?state.sources.find(parent=>parent.id===source.replyTo!.id&&parent.status==='accepted'):undefined;
    if(source.replyTo&&!antecedent)throw new Error('invalid_scene_reply_to');
    // The user explicitly re-accepts this response after its antecedent changed.
    const replyTo=antecedent?{id:antecedent.id,revision:antecedent.revision}:undefined;
    this.authority.reconcile(scope,[{...source,dependencies,...(replyTo?{replyTo}:{})}],false,Date.now(),{...guard,reconfirmIds:[sourceId]});
    const acceptedStamp=sourceStamp(this.authority.state(scope));
    const result=await this.processPending(scope,configs);
    if(sourceStamp(this.authority.state(scope))!==acceptedStamp)throw new Error('context_changed_retry');
    return {...result,...this.syncState(scope)};
  }

  /** Native host generation uses the same authority, without running our front model. */
  async nativeContext(scope:SceneScope, envelopeValue:unknown, sourceIdValue:unknown, configs:Configurations, regenerateId?:string) {
    this.prune();
    if(this.nativeTickets.size>=100)throw new Error('invalid_scene_too_many_drafts');
    if(this.authority.state(scope).sources.some(source=>source.status==='accepted'&&source.processing!=='ready')){
      const pending=await this.processPending(scope,configs);
      if(pending.status!=='ready')throw new Error(pending.error??'invalid_scene_processing');
    }
    const modelRevision=this.modelRevision;
    const acceptedStamp=sourceStamp(this.authority.state(scope));
    const packet=await this.buildNativeContext(scope,envelopeValue,sourceIdValue,configs,regenerateId);
    if(sourceStamp(this.authority.state(scope))!==acceptedStamp)throw new Error('context_changed_retry');
    this.assertVersion(scope,packet.version);
    if(modelRevision!==this.modelRevision)throw new Error('context_changed_retry');
    const contextTicket=randomUUID();
    const antecedent=this.authority.state(scope).sources.find(source=>source.id===sourceIdValue&&source.status==='accepted'&&source.role==='user');
    if(!antecedent)throw new Error('invalid_scene_native_source');
    this.nativeTickets.set(contextTicket,{scope,version:packet.version,modelRevision,expires:Date.now()+30*60*1000,
      replyTo:{id:antecedent.id,revision:antecedent.revision},
      envelope:packet.envelope,dependencies:packet.dependencies,automatic:'automatic' in packet&&packet.automatic===true,
      speakerId:'speakerId' in packet&&typeof packet.speakerId==='string'?packet.speakerId:packet.envelope.targetId});
    return {...packet,contextTicket};
  }

  async acceptNative(scope:SceneScope,ticketId:string,value:unknown,configs:Configurations) {
    this.prune();
    const ticket=this.nativeTickets.get(ticketId);
    if(!ticket||scopeKey(ticket.scope)!==scopeKey(scope))throw new Error('invalid_scene_ticket');
    const supplied=sceneMessageOf(value,this.authority.state(scope).roster);
    if(supplied.replyTo&&JSON.stringify(supplied.replyTo)!==JSON.stringify(ticket.replyTo))throw new Error('invalid_scene_candidate_changed');
    const message={...supplied,replyTo:ticket.replyTo};
    if(ticket.modelRevision!==this.modelRevision)throw new Error('context_changed_retry');
    if(ticket.accepted){
      if(!sameMessage(ticket.accepted,message))throw new Error('invalid_scene_candidate_changed');
    }else{
      this.assertVersion(scope,ticket.version);
      if(message.role!=='assistant'||message.revision!==1||Boolean(message.automatic)!==ticket.automatic||
        (!ticket.automatic&&message.speakerId!==ticket.speakerId)||JSON.stringify(message.envelope)!==JSON.stringify(ticket.envelope)||
        JSON.stringify(message.dependencies??[])!==JSON.stringify(ticket.dependencies))throw new Error('invalid_scene_candidate_changed');
      if(this.authority.state(scope).sources.some(source=>source.id===message.id))throw new Error('invalid_scene_candidate_changed');
    }
    this.authority.reconcile(scope,[message],false,Date.now(),{expectedVersion:ticket.version,operationId:`native:${ticketId}`});
    ticket.accepted=message;
    const acceptedStamp=sourceStamp(this.authority.state(scope));
    const result=await this.processPending(scope,configs);
    if(sourceStamp(this.authority.state(scope))!==acceptedStamp)throw new Error('context_changed_retry');
    return {...result,...this.syncState(scope)};
  }

  private async buildNativeContext(scope:SceneScope, envelopeValue:unknown, sourceIdValue:unknown, configs:Configurations, regenerateId?:string) {
    let state=this.authority.state(scope);
    if(regenerateId){
      const accepted=state.sources.filter(source=>source.status==='accepted');
      const last=accepted.at(-1);
      if(!last||last.id!==regenerateId||last.role!=='assistant'||last.processing!=='ready')throw new Error('invalid_scene_regeneration');
      state={...state,sources:state.sources.slice(0,state.sources.indexOf(last))};
    }
    const sourceId=text(sourceIdValue,200);
    const source=state.sources.find(item=>item.id===sourceId && item.status==='accepted' && item.role==='user');
    this.assertReady(scope);
    if(!source?.analysis?.plan) throw new Error('invalid_scene_native_source');
    if(source.automatic) return this.nativeTheatre(scope,source,state,configs);
    const direct=await this.directorFor(state,configs);
    const envelope=envelopeOf(envelopeValue,state.roster);
    const character=state.roster.characters.find(item=>item.id===envelope.targetId)!;
    const current=visibleText(source.analysis.plan,character.id);
    if(!current.trim()) throw new Error('invalid_scene_native_visibility');
    const assertCurrent=()=>this.assertVersion(scope,state.version);
    const context=await this.core.contextFrom(this.authority.snapshot(scope,character.id,state),current,configs,
      this.authority.responseEmotion(scope,character.id,Date.now(),state),this.authority.preferences(scope,character.id,state,source.id),assertCurrent);
    context.context+=addressSuggestion(this.authority,scope,character.id,envelope,state);
    context.context+=this.authority.worldContext(scope,character.id,state);
    context.context+=this.authority.physiology.context(scope,character.id);
    context.context+=this.authority.geography.context(scope,character.id);
    context.context+=this.commitmentsContext(scope,character.id);
    context.context+=await direct(character,context.context,current);
    context.context+=await this.companionContext(scope,character.id,context.context+'\n当前用户正文：'+current,configs);
    assertCurrent();
    const dependencies=state.sources.filter(item=>item.status==='accepted' && item.processing==='ready' && item.analysis?.characters[character.id]).map(item=>({id:item.id,revision:item.revision}));
    const relevant=source.analysis.plan.observations.filter(item=>item.readers.includes(character.id));
    const readers=envelope.presentIds.filter(id=>relevant.every(item=>item.readers.includes(id)));
    const companion=this.authority.interactions.modeOf(scope)==='companion';
    const persona=companion
      ? `当前是伴侣模式，只扮演 ${character.name}，稳定身份 ${character.id}。${companionIdentity(envelope)}自然、直接地与用户交谈，按对话语境决定是否描述动作；不把用户称为玩家。只表达该角色可知的内容，不代写其他角色或用户的内心、台词和选择。\n${character.persona}`
      : `当前只扮演 ${character.name}，稳定身份 ${character.id}。${playerIdentity(envelope)}只写该角色可知的言语与可观察行为，不代写其他NPC的台词、内心或玩家选择。简体中文小说体，以玩家为第二人称感知锚点。\n${character.persona}`;
    return {version:state.version,dependencies,retrievalModes:[context.retrieval],envelope:{...envelope,presentIds:readers},messages:[
      {role:'system',content:persona},
      {role:'system',content:context.context+'\n以上为后台依据，只输出角色正文，不展示字段、JSON、日志或数值情绪。不得根据缺失信息补写历史。没有脚本结果时不要自行进行精确计算。'},
      {role:'user',content:current},
    ]};
  }

  private async nativeTheatre(scope:SceneScope,source:import('./types.ts').SceneSource,state:import('./types.ts').SceneState,configs:Configurations) {
    const direct=await this.directorFor(state,configs);
    const plan=source.analysis!.plan!;
    const retrievalModes=new Set<string>();
    const activeIds=new Set(plan.observations.filter(item=>item.playerVisible).flatMap(item=>item.readers));
    const actors=state.roster.characters.filter(item=>activeIds.has(item.id));
    if(!actors.length) throw new Error('invalid_scene_native_visibility');
    const assertCurrent=()=>this.assertVersion(scope,state.version);
    const dependencies=state.sources.filter(item=>item.status==='accepted' && (item.id===source.id || actors.some(actor=>item.analysis?.characters[actor.id]))).map(item=>({id:item.id,revision:item.revision}));
    // Direct streaming is safe only when every source known to this actor is
    // player-visible. Private current or historical knowledge needs the staged
    // actor response and outward filter below, even for one active actor.
    const directActor=actors.length===1 ? actors[0] : undefined;
    const publicOnly=directActor && !this.authority.worldSettings(scope) && !this.authority.transfer.references(scope,directActor.id).length && [plan,...state.sources.filter(item=>item.status==='accepted' && item.id!==source.id).map(item=>item.analysis?.plan)]
      .every(item=>item && item.observations.filter(observation=>observation.readers.includes(directActor.id))
        .every(observation=>observation.playerVisible && (observation.kind==='heard'||observation.kind==='observed')));
    if(directActor && publicOnly) {
      const actor=directActor;
      const prepared=await this.authority.npcResources.runActivationBatches(scope,{
        rosterIds:state.roster.characters.map(item=>item.id),npcIds:[actor.id],interactionIds:[actor.id],presentIds:source.envelope.presentIds,
      },{
        materialize:actorId=>this.authority.responseEmotion(scope,actorId,Date.now(),state),
        onInvalidated:()=>this.invalidateModelConfiguration(),
        runBatch:async batch=>{
      const current=visibleText(plan,actor.id);
      const context=await this.core.contextFrom(this.authority.snapshot(scope,actor.id,state),current,configs,
        batch[0]!.group,this.authority.preferences(scope,actor.id,state,source.id),assertCurrent);
      context.context+=addressSuggestion(this.authority,scope,actor.id,source.envelope,state);
      context.context+=this.authority.worldContext(scope,actor.id,state);
      context.context+=this.authority.physiology.context(scope,actor.id);
      context.context+=this.authority.geography.context(scope,actor.id);
      context.context+=this.commitmentsContext(scope,actor.id);
      context.context+=await direct(actor,context.context,current);
      context.context+=await this.companionContext(scope,actor.id,context.context,configs);
      assertCurrent();
      return {version:state.version,automatic:false,speakerId:actor.id,dependencies,retrievalModes:[context.retrieval],envelope:{...source.envelope,targetId:actor.id,presentIds:[actor.id]},messages:[
        {role:'system',content:`本轮只扮演${actor.name}。${playerIdentity(source.envelope)}这是有来源的身份画像，不是共同经历：\n${actor.persona}\n用简体中文、玩家第二人称有限视角，只输出该角色愿意让玩家听见的台词和可见行动。叙述自己的动作时使用自己的姓名，不用容易混淆的第一人称；台词可以用第一人称。不要输出内心、秘密、后台字段、其他NPC言行或玩家选择。未知不补写；没有脚本结果时不自行精确计算。通常200—400字，在需要玩家回应时停笔。`},
        {role:'system',content:context.context+'\n以上只属于当前角色，不代表玩家已知；不得将私密记忆或情绪解释直接写给玩家。'},
        {role:'user',content:current},
      ]};
        },
      });
      return prepared[0]!;
    }
    const publicResponses=[];
    const prepareActor=async(actor:import('./types.ts').SceneCharacter,emotion:import('../emotion/openher.ts').EmotionState)=>{
      const current=visibleText(plan,actor.id);
      const context=await this.core.contextFrom(this.authority.snapshot(scope,actor.id,state),current,configs,
        emotion,this.authority.preferences(scope,actor.id,state,source.id),assertCurrent);
      context.context+=addressSuggestion(this.authority,scope,actor.id,source.envelope,state);
      context.context+=this.authority.worldContext(scope,actor.id,state);
      context.context+=this.authority.physiology.context(scope,actor.id);
      context.context+=this.authority.geography.context(scope,actor.id);
      context.context+=this.commitmentsContext(scope,actor.id);
      context.context+=await direct(actor,context.context,current);
      context.context+=await this.companionContext(scope,actor.id,context.context,configs);
      const persona=`你只扮演${actor.name}。${playerIdentity(source.envelope)}以下是有资料来源的身份和性格，不是已发生的剧情或新知识。\n${actor.persona}\n只回应你实际感知的当前正文。根据你的记忆、情绪与性格，写你此刻愿意让玩家听见的一至三句台词，可配一个简短可见动作，通常60—120字。当前正文的地点、时段、物品状态和已发生行动优先于旧回忆；不要为润色添出手中物品、书本、餐具或转场，不把用户已经明确完成的告知写成尚未决定。叙述自己的动作时使用自己的姓名，不用容易混淆的第一人称；台词可以用第一人称。不要输出内心、后台解释、其他角色的行为、玩家的选择。秘密不会因为被召回就必须透露。没有行动理由可以保持沉默。`;
      const result=await this.core.respond(context,current,persona,configs,assertCurrent);
      retrievalModes.add(context.retrieval);
      const prose=await this.models.outward(result.answer,{id:actor.id,name:actor.name},source.envelope.playerName,configs.outward);
      assertCurrent();
      return prose ? {name:actor.name,prose} : null;
    };
    const batches=await this.authority.npcResources.runActivationBatches(scope,{
      rosterIds:state.roster.characters.map(actor=>actor.id),npcIds:actors.map(actor=>actor.id),
      interactionIds:[source.envelope.targetId],presentIds:source.envelope.presentIds,
    },{
      materialize:actorId=>this.authority.responseEmotion(scope,actorId,Date.now(),state,null),
      runBatch:batch=>Promise.all(batch.map(({npcId,group})=>prepareActor(actors.find(actor=>actor.id===npcId)!,group))),
      onInvalidated:()=>this.invalidateModelConfiguration(),
    });
    for(const results of batches) {
      publicResponses.push(...results.filter((item):item is {name:string;prose:string}=>item!==null));
    }
    if(!publicResponses.length) throw new Error('invalid_scene_native_visibility');
    const playerScene=plan.observations.filter(item=>item.playerVisible && item.kind==='observed')
      .map(item=>({quote:item.quote,observers:item.readers.map(id=>state.roster.characters.find(actor=>actor.id===id)!.name)}));
    return {version:state.version,automatic:true,dependencies,retrievalModes:[...retrievalModes].sort(),envelope:source.envelope,messages:[
      {role:'system',content:'你是当前剧场的正文叙述者。用简体中文小说体、玩家第二人称有限视角，把各NPC已确定的公开言行自然串联。playerScene是已发生且玩家可见的当前场景与动作，仅标注的观察者知情；它只约束连续性，不授权添加台词或向其它NPC转述。只能使用给出的公开回应，不新增秘密、内心、事实、承诺、新角色或未提供的台词，不替玩家行动或选择。保留给定地点和姿态；没有地点信息就不描写地点，不添加转场、机构或玩家动作。身份设定不是共同经历；未知细节保持未知。不要输出字段、JSON、后台计划、角色标题或处理说明。通常200—600字，在需要玩家回应处停笔。'},
      {role:'user',content:JSON.stringify({playerName:source.envelope.playerName??null,playerScene,publicResponses})},
    ]};
  }

  async prepare(scope:SceneScope, envelopeValue:unknown, inputValue:unknown, configs:Configurations, write?:PrepareWrite) {
    const modelRevision=this.modelRevision;
    this.prune();
    if (this.drafts.size>=100) throw new Error('invalid_scene_too_many_drafts');
    const initial=this.authority.state(scope);
    const requestId=randomUUID();
    const submission:PrepareWrite=write??{expectedVersion:initial.version,operationId:`prepare:${requestId}`,userMessageId:`scene-${requestId}:user`,acceptedAtMs:Date.now()};
    const userMessageId=text(submission.userMessageId,200);
    const envelope=envelopeOf(envelopeValue,initial.roster);
    const input=text(inputValue,20000);
    const existing=initial.sources.find(source=>source.id===userMessageId);
    let userMessage:SceneMessage;
    if(existing){
      const latest=initial.sources.filter(source=>source.status==='accepted').at(-1);
      if(existing.status!=='accepted'||existing.role!=='user'||latest?.id!==existing.id||existing.text!==input||
        JSON.stringify(existing.envelope)!==JSON.stringify(envelope)||(submission.acceptedAtMs!==undefined&&existing.acceptedAtMs!==submission.acceptedAtMs))
        throw new Error('invalid_scene_candidate_changed');
      userMessage=sceneMessageOf(existing,initial.roster);
    }else{
      this.assertReady(scope);
      userMessage=sceneMessageOf({id:userMessageId,revision:1,role:'user',text:input,
        acceptedAtMs:submission.acceptedAtMs??Date.now(),envelope},initial.roster);
      this.authority.reconcile(scope,[userMessage],false,Date.now(),submission);
    }
    const userStamp=sourceStamp(this.authority.state(scope));
    const synchronized=await this.processPending(scope,configs);
    if(sourceStamp(this.authority.state(scope))!==userStamp)throw new Error('context_changed_retry');
    const state=this.authority.state(scope);
    const storedUser=state.sources.find(source=>source.id===userMessage.id&&source.status==='accepted'&&source.role==='user');
    if(!storedUser)throw new Error('context_changed_retry');
    userMessage=sceneMessageOf(storedUser,state.roster);
    if(synchronized.status!=='ready')return {status:'failed',phase:'user-sync',version:synchronized.version,error:synchronized.error??'operation_failed',
      userMessage,progress:this.progress(scope)};
    if(modelRevision!==this.modelRevision)throw new Error('context_changed_retry');
    this.assertVersion(scope,synchronized.version);
    const latest=state.sources.filter(source=>source.status==='accepted').at(-1);
    if(latest?.id!==userMessage.id||!storedUser.analysis?.plan)throw new Error('context_changed_retry');
    const userPlan=storedUser.analysis.plan;
    const character=state.roster.characters.find(item=>item.id===envelope.targetId)!;
    const current=visibleText(userPlan,character.id);
    if (!current.trim()) return {status:'failed',phase:'generation-input',version:state.version,error:'invalid_scene_native_visibility',userMessage,
      progress:this.progress(scope),observations:userPlan.observations};
    const snapshot=this.authority.snapshot(scope,character.id,state);
    const direct=await this.directorFor(state,configs);
    const assertCurrent=()=>this.assertVersion(scope,state.version);
    const context=await this.core.contextFrom(snapshot,current,configs,
      this.authority.responseEmotion(scope,character.id,Date.now(),state),this.authority.preferences(scope,character.id,state,userMessage.id),assertCurrent);
    context.context+=addressSuggestion(this.authority,scope,character.id,envelope,state);
    context.context+=this.authority.worldContext(scope,character.id,state);
    context.context+=this.authority.physiology.context(scope,character.id);
    context.context+=this.authority.geography.context(scope,character.id);
    context.context+=this.commitmentsContext(scope,character.id);
    context.context+=await direct(character,context.context,current);
    context.context+=await this.companionContext(scope,character.id,context.context+'\n当前用户正文：'+current,configs);
    const companion=this.authority.interactions.modeOf(scope)==='companion';
    const persona=companion
      ? `当前是伴侣模式，只扮演 ${character.name}，稳定身份 ${character.id}。${companionIdentity(envelope)}自然、直接地与用户交谈，按对话语境决定是否描述动作；不把用户称为玩家。只表达这个角色实际可知的内容，不代写其他角色或用户的内心、台词和选择。用户正文中明确已经完成的事件已经发生，不再重演；只回应此刻。\n${character.persona}`
      : `当前只扮演 ${character.name}，稳定身份 ${character.id}。${playerIdentity(envelope)}只写这个角色实际可知的言语和行为，不替其它角色写内心或台词。用户正文中明确已经完成的购买、等待或其它事件已经发生，不再重演或再次推进时间；只回应此刻。\n${character.persona}`;
    const result=await this.core.respond(context,current,persona,configs,assertCurrent);
    const relevant=userPlan.observations.filter(observation=>observation.readers.includes(character.id));
    // A private input never becomes public merely because more NPCs share the chat.
    const replyReaders=[...new Set([character.id,...relevant[0]!.readers.filter(reader=>relevant.every(observation=>observation.readers.includes(reader)))])];
    // Emotion and preferences also affect the response, even with no extracted memory.
    const dependencies=state.sources.filter(source=>source.status==='accepted' && source.processing==='ready' && source.analysis?.characters[character.id])
      .map(source=>({id:source.id,revision:source.revision}));
    const id=randomUUID();
    const assistantMessage:SceneMessage={id:`scene-${id}:assistant`,revision:1,role:'assistant',text:result.answer,
      acceptedAtMs:userMessage.acceptedAtMs,envelope:{...envelope,presentIds:replyReaders},speakerId:character.id,dependencies,
      replyTo:{id:userMessage.id,revision:userMessage.revision}};
    const assistantPlan=await this.plan(assistantMessage,state.roster,configs);
    this.assertVersion(scope,state.version);
    if (assistantPlan.unresolved.length) return {status:'failed',phase:'assistant-plan',version:state.version,error:'invalid_scene_unresolved',
      userMessage,progress:this.progress(scope),unresolved:assistantPlan.unresolved,observations:assistantPlan.observations};
    if(modelRevision!==this.modelRevision)throw new Error('context_changed_retry');
    const draft:Draft={id,scope,version:state.version,modelRevision,expires:Date.now()+30*60*1000,userMessage,assistantMessage,assistantPlan,accepted:false,complete:false};
    this.drafts.set(id,draft);
    return {status:'ready',draftId:id,answer:result.answer,version:state.version,userMessage,assistantMessage,observations:userPlan.observations,unresolved:[]};
  }

  /** Regenerate the last accepted reply against the state before that reply, without mutating it. */
  async regenerate(scope:SceneScope,configs:Configurations) {
    const modelRevision=this.modelRevision;
    this.assertReady(scope);this.clearScopeDrafts(scope);
    const state=this.authority.state(scope);
    const accepted=state.sources.filter(source=>source.status==='accepted');
    const previous=accepted.at(-1),user=accepted.at(-2);
    if(!previous||previous.role!=='assistant'||!user||user.role!=='user'||!user.analysis?.plan)throw new Error('invalid_scene_regeneration');
    const packet=await this.nativeContext(scope,user.envelope,user.id,configs,previous.id);
    const input=packet.messages.filter(message=>message.role==='user').map(message=>message.content).join('\n');
    const context=packet.messages.filter(message=>message.role==='system').map(message=>message.content).join('\n');
    const answer=await this.models.generate('重新生成当前回复。只回应用户已经发生的最后一条正文；不重演已经完成的交易或重复推进时间。',context,input,configs.front);
    this.assertVersion(scope,state.version);
    const assistantMessage=sceneMessageOf({...previous,text:answer,revision:previous.revision+1,dependencies:packet.dependencies,
      replyTo:previous.replyTo??{id:user.id,revision:user.revision}},state.roster);
    const userMessage=sceneMessageOf(user,state.roster);
    const assistantPlan=await this.plan(assistantMessage,state.roster,configs,accepted.slice(0,-1).slice(-6));
    this.assertVersion(scope,state.version);
    if(assistantPlan.unresolved.length)return {version:state.version,unresolved:assistantPlan.unresolved};
    const id=randomUUID();
    if(modelRevision!==this.modelRevision)throw new Error('context_changed_retry');
    this.drafts.set(id,{id,scope,version:state.version,modelRevision,expires:Date.now()+30*60*1000,userMessage,assistantMessage,assistantPlan,accepted:false,complete:false});
    return {draftId:id,answer,version:state.version,userMessage,assistantMessage,unresolved:[],replacementId:previous.id};
  }

  async accept(scope:SceneScope, draftId:string, value:unknown, configs:Configurations) {
    const draft=this.draft(scope,draftId);
    if(draft.modelRevision!==this.modelRevision)throw new Error('context_changed_retry');
    if (!Array.isArray(value) || value.length!==2) throw new Error('invalid_scene_messages');
    const roster=this.authority.state(scope).roster;
    const messages=value.map(item=>sceneMessageOf(item,roster));
    if (!sameMessage(messages[0]!,draft.userMessage) || !sameMessage(messages[1]!,draft.assistantMessage)) throw new Error('invalid_scene_candidate_changed');
    if (draft.complete) {
      const state=this.authority.state(scope);
      if (!messages.every(message=>state.sources.some(source=>source.id===message.id && source.revision===message.revision && source.status==='accepted' && sameMessage(source,message)))) throw new Error('context_changed_retry');
      return {status:'duplicate',...this.syncState(scope)};
    }
    if (!draft.accepted) {
      this.assertVersion(scope,draft.version);
      this.authority.reconcile(scope,[messages[1]!],false);
      draft.accepted=true;
    } else {
      const sources=this.authority.state(scope).sources;
      if (!messages.every(message=>sources.some(source=>source.id===message.id && source.revision===message.revision && source.status==='accepted' && source.text===message.text))) throw new Error('context_changed_retry');
    }
    const acceptedStamp=sourceStamp(this.authority.state(scope));
    const result=await this.processPending(scope,configs,new Map([[draft.assistantMessage.id,draft.assistantPlan]]));
    if(sourceStamp(this.authority.state(scope))!==acceptedStamp)throw new Error('context_changed_retry');
    if (result.status==='ready') draft.complete=true;
    return {...result,...this.syncState(scope),status:result.status==='ready'?'committed':'failed'};
  }

  reject(scope:SceneScope,draftId:string) {
    const draft=this.draft(scope,draftId);
    if (draft.accepted) throw new Error('invalid_scene_already_accepted');
    this.drafts.delete(draftId);
    return {status:'rejected'};
  }

  private async directorFor(state:import('./types.ts').SceneState,configs:Configurations){
    if(this.authority.interactions.modeOf(state.scope)!=='roleplay')
      return async(_actor:import('./types.ts').SceneCharacter,_context:string,_current:string)=>'';
    const control=this.authority.interactions.get(state.scope,'sillytavern');
    this.authority.interactions.assertActive(state.scope,control.revision);
    if(!control.directorEnabled)
      return async(_actor:import('./types.ts').SceneCharacter,_context:string,_current:string)=>'';
    if(!configs.director?.baseUrl||!configs.director.model)throw new Error('director_model_not_configured');
    const revision=this.modelRevision;
    const assertCurrent=()=>{
      this.assertVersion(state.scope,state.version);
      const current=this.authority.interactions.assertActive(state.scope,control.revision);
      if(revision!==this.modelRevision||!current?.directorEnabled||current.mode!=='roleplay')throw new Error('context_changed_retry');
    };
    const run:import('../core/models.ts').ModelRunner=(config,prompts)=>this.models.structuredTask(config,prompts);
    const plan=await this.authority.director.plan(state,control.revision,revision,configs.director,run,assertCurrent);
    return (actor:import('./types.ts').SceneCharacter,context:string,current:string)=>
      this.authority.director.actorGuidance(actor,context,current,plan,state,configs.director,run,assertCurrent);
  }

  async processPending(scope:SceneScope,configs:Configurations,plans=new Map<string,PerspectivePlan>(),target?:{sourceId:string;revision:number}):Promise<{status:string;version:number;error?:string}> {
    await this.clearPendingIndexes();
    const key=scopeKey(scope);
    const existing=this.jobs.get(key);
    if (existing) { await existing; return this.processPending(scope,configs,plans,target); }
    const state=this.authority.state(scope);
    const accepted=state.sources.filter(source=>source.status==='accepted');
    const targetIndex=target?accepted.findIndex(source=>source.id===target.sourceId&&source.revision===target.revision):accepted.length-1;
    if(target&&targetIndex<0)throw new Error('context_changed_retry');
    const pending=accepted.filter((source,index)=>index<=targetIndex&&source.processing!=='ready');
    if (!pending.length) return {status:'ready',version:state.version};
    const job=(async()=>{
      let activeSource:string|undefined;
      try {
        const results:{id:string;revision:number;analysis:SceneAnalysis}[]=[];
        const processed:import('./types.ts').SceneSource[]=[];
        for (const [sourceIndex,source] of accepted.entries()) {
          if(sourceIndex>targetIndex)break;
          if(source.processing==='ready'&&source.analysis){
            processed.push(source);
            continue;
          }
          activeSource=source.id;
          const history=accepted.slice(0,accepted.indexOf(source)).slice(-6);
          const suppliedPlan=plans.get(source.id)??source.analysis?.plan??undefined;
          const perspectiveConfig=source.automatic&&source.role==='user'&&configs.inputPerspective.model?configs.inputPerspective:configs.perspective;
          const plan=await this.stage(scope,source,'perspective',undefined,
            {schema:1,source:this.modelSource(source),roster:state.roster,history:history.map(item=>this.modelSource(item)),config:perspectiveConfig,suppliedPlan:suppliedPlan??null},
            async()=>{
              const candidate=suppliedPlan??await this.plan(source,state.roster,configs,history);
              if(candidate.unresolved.length)throw new Error('invalid_scene_unresolved');
              return candidate;
            });
          this.assertVersion(scope,state.version);
          const characters:Record<string,Analysis>={};
          const subject=this.authority.subject(scope);
          const userModelCandidates=subject&&source.role==='user'?await this.stage(scope,source,'profile',undefined,
            {source:this.modelSource(source),controls:this.authority.userModel.controls(subject.subjectId),config:configs.profile},
            ()=>this.companion.extract(scope,source,configs,()=>this.assertVersion(scope,state.version))):undefined;
          const interactionMode=this.authority.interactions.modeOf(scope);
          const settings=this.authority.worldSettings(scope);
          const worldHistory=processed;
          const purchaseRefs=worldPurchaseReferences(worldHistory);
          const worldEffects=settings?await this.stage(scope,source,'world',undefined,
            {schema:2,source:this.modelSource(source),settings,history:worldHistory.slice(-6).map(item=>this.modelSource(item)),purchaseRefs,config:configs.world},
            ()=>this.models.worldEffects(source,settings,configs.world,worldHistory)):undefined;
          const clockTimeMs=interactionMode==='companion'?source.acceptedAtMs:settings?.mode==='story'
            ?this.authority.emotionTime(scope,[...processed,{...source,processing:'ready',analysis:{plan,characters,worldEffects}}],source.acceptedAtMs):undefined;
          const timeZone=interactionMode?this.authority.interactions.clock(scope).timeZone:undefined;
          const physiologyConfiguration=this.authority.physiology.configuration(scope);
          const physiologyAtMs=clockTimeMs??(interactionMode==='roleplay'?null
            :this.authority.emotionTime(scope,[...processed,{...source,processing:'ready',analysis:{plan,characters,...(worldEffects?{worldEffects}:{})}}],source.acceptedAtMs));
          const physiologyOperations=physiologyConfiguration.config.enabled?await this.stage(scope,source,'physiology',undefined,
            {schema:1,source:this.modelSource(source),plan,configuration:physiologyConfiguration,atMs:physiologyAtMs,config:configs.physiology},
            ()=>this.authority.physiology.extract(source,plan,state.roster,physiologyConfiguration.config,physiologyAtMs,configs.physiology,
              (config,prompts,json)=>this.models.structuredTask(config,prompts))):undefined;
          const geographyConfiguration=this.authority.geography.configuration(scope);
          const geographyOperations=interactionMode==='roleplay'&&geographyConfiguration.enabled&&geographyConfiguration.followAcceptedProse
            ?await this.stage(scope,source,'geography',undefined,
              {schema:1,source:this.modelSource(source),plan,configuration:geographyConfiguration,version:state.version,config:configs.geography},
              ()=>this.authority.geography.extract(scope,source,plan,state.roster,geographyConfiguration,configs.geography,
                (config,prompts)=>this.models.structuredTask(config,prompts),results.flatMap(result=>result.analysis.geographyOperations??[]))):undefined;
          const preceding=processed.at(-1);
          // Generation tickets bind replyTo. Strict adjacency is the fallback
          // for an older accepted assistant source that lacks the binding.
          const responseTo=source.replyTo??(source.role==='assistant'&&preceding?.role==='user'
            ?{id:preceding.id,revision:preceding.revision}:undefined);
          const antecedent=responseTo?processed.find(item=>item.id===responseTo.id&&item.revision===responseTo.revision):undefined;
          const responseContext=antecedent?{id:antecedent.id,revision:antecedent.revision,role:antecedent.role,text:antecedent.text}:undefined;
          const existingCommitments=interactionMode
            ?commitmentTransitionTargets(foldCommitments(scope,processed).filter(record=>record.mode===interactionMode),responseTo):[];
          const commitmentOperations=interactionMode?await this.stage(scope,source,'commitment',undefined,
            {schema:5,source:this.modelSource(source),plan,mode:interactionMode,clockTimeMs,timeZone,responseTo:responseTo??null,responseContext,existing:existingCommitments,config:configs.commitment},async()=>{
              const validation={source,plan,actorIds:['player',...state.roster.characters.map(character=>character.id)],userActorId:'player',mode:interactionMode,
                clockTimeMs,timeZone,contractVersion:2 as const,responseTo,responseContext,existing:existingCommitments};
              const prompt=extractCommitmentPrompt(validation);
              const raw=await this.models.structuredTask(configs.commitment,[{role:'system',content:prompt.system+'\nJSON schema: '+JSON.stringify(prompt.schema)},
                {role:'user',content:JSON.stringify(prompt.input)}]);
              const operations=validateCommitmentOperations(validation,JSON.parse(raw.trim().replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,'')));
              // Validate lifecycle transitions before the stage result becomes retryable cache.
              // Otherwise a syntactically valid operation against a proposed/completed target
              // fails only during the final projection and is then reused forever on retry.
              foldCommitments(scope,[...processed,{...source,processing:'ready',analysis:{plan,characters,...(worldEffects?{worldEffects}:{}),commitmentOperations:operations}}]);
              return operations;
            }):undefined;
          this.assertVersion(scope,state.version);
           processed.push({...source,processing:'ready',analysis:{plan,characters,...(worldEffects?{worldEffects}:{}),...(commitmentOperations?{commitmentOperations}:{}),
             ...(userModelCandidates?{userModelCandidates}:{}),...(physiologyOperations?{physiologyOperations}:{}),...(geographyOperations?{geographyOperations}:{})}});
          const eventTime=this.authority.emotionTime(scope,processed,source.acceptedAtMs);
          // No character model is ever given the world source or another profile.
          const analyzeCharacter=async(character:import('./types.ts').SceneCharacter,experienceState:import('../emotion/openher.ts').EmotionState)=>{
            const visible=visibleText(plan,character.id);
            if (!visible) return;
            const scoped={id:source.id,revision:source.revision,role:source.role,text:visible,acceptedAtMs:source.acceptedAtMs};
            const profile={id:character.id,name:character.name,persona:character.persona,experienceState};
            const excerpts=plan.observations.filter(observation=>observation.readers.includes(character.id)).map(observation=>observation.quote);
            if(typeof this.models.analyzeMemory!=='function'||typeof this.models.analyzeEmotion!=='function'||typeof this.models.analyzePreference!=='function'){
              const analysis=await this.models.analyze(scoped,configs,profile,excerpts);
              characters[character.id]={...analysis,emotion:{...analysis.emotion,stableRelationDelta:{}}};
              this.assertVersion(scope,state.version);
              return;
            }
            const relationshipScene=relationshipSceneInput(plan,character,state.roster,profile);
            const common={schema:1,source:scoped,character:profile,excerpts,plan,dependencies:source.dependencies??[]};
            const sceneEmotion=(this.models as {sceneEmotion?:ModelTasks['sceneEmotion']}).sceneEmotion;
            const [memories,emotionResult,preferences]=await settled([
              this.stage(scope,source,'memory',character.id,{...common,config:configs.memory},()=>this.models.analyzeMemory(scoped,configs.memory,profile,excerpts)),
              this.stage(scope,source,'emotion',character.id,{...common,schema:2,relationshipScene,config:configs.emotion},()=>sceneEmotion
                ? sceneEmotion.call(this.models,scoped,relationshipScene,configs.emotion)
                : this.models.analyzeEmotion(scoped,configs.emotion,profile).then(emotion=>({emotion,relationships:[]}))),
              this.stage(scope,source,'preference',character.id,{...common,schema:2,config:configs.preference},()=>this.models.analyzePreference(scoped,configs.preference)),
            ] as const);
            characters[character.id]={memories,emotion:{...emotionResult.emotion,stableRelationDelta:{}},preferences,
              ...(emotionResult.relationships.length?{relationships:emotionResult.relationships}:{})};
            this.assertVersion(scope,state.version);
          };
          await this.authority.npcResources.runActivationBatches(scope,{
            rosterIds:state.roster.characters.map(character=>character.id),
            npcIds:state.roster.characters.filter(character=>visibleText(plan,character.id)).map(character=>character.id),
            interactionIds:[source.envelope.targetId],presentIds:source.envelope.presentIds,
          },{
            materialize:characterId=>this.authority.emotion(scope,characterId,eventTime,{...state,sources:processed.slice(0,-1)}),
            runBatch:batch=>settled(batch.map(({npcId,group})=>analyzeCharacter(state.roster.characters.find(character=>character.id===npcId)!,group))),
            onInvalidated:()=>this.invalidateModelConfiguration(),
          });
          this.assertVersion(scope,state.version);
           results.push({id:source.id,revision:source.revision,analysis:{plan,characters,...(worldEffects?{worldEffects}:{}),...(commitmentOperations?{commitmentOperations}:{}),
             ...(userModelCandidates?{userModelCandidates}:{}),...(physiologyOperations?{physiologyOperations}:{}),...(geographyOperations?{geographyOperations}:{})}});
        }
        return {status:'ready',version:this.authority.commit(scope,state.version,results)};
      } catch(error) {
        const message=error instanceof Error?error.message:'';
        if(activeSource&&message.startsWith('invalid_world_')){
          const source=accepted.find(item=>item.id===activeSource);
          if(source)this.authority.processing.failStored({scope,sourceId:source.id,revision:source.revision,stage:'world'},error);
        }
        this.authority.fail(scope,state.version,activeSource?[activeSource]:undefined);
        return {status:'failed',version:this.authority.state(scope).version,error:/^(invalid_[a-z_]+|[a-z_]+_missing_source|unsafe_episode_projection|context_changed_retry|model_[a-z_0-9]+|host_(timeout|closed|worker_failed|invalid_result))$/.test(message)?message:'operation_failed'};
      } finally { this.jobs.delete(key); }
    })();
    this.jobs.set(key,job);
    return job;
  }

  private async stage<T>(scope:SceneScope,source:SceneMessage,stage:ProcessingAddress['stage'],characterId:string|undefined,input:unknown,work:()=>Promise<T>|T):Promise<T> {
    const address:ProcessingAddress={scope,sourceId:source.id,revision:source.revision,stage,...(characterId?{characterId}:{})};
    const fingerprint=processingFingerprint(input);
    const version=this.authority.state(scope).version,modelRevision=this.modelRevision;
    const cached=this.authority.processing.load<T>(address,fingerprint);
    if(cached!==undefined)return cached;
    this.authority.processing.start(address,fingerprint);
    try{
      const result=await work();
      if(this.authority.state(scope).version!==version||this.modelRevision!==modelRevision)throw new Error('context_changed_retry');
      this.authority.processing.complete(address,fingerprint,result);
      return result;
    }catch(error){
      if(this.authority.state(scope).version===version&&this.modelRevision===modelRevision)this.authority.processing.fail(address,fingerprint,error);
      throw error;
    }
  }

  private modelSource(source:SceneMessage) {
    return {id:source.id,revision:source.revision,role:source.role,text:source.text,acceptedAtMs:source.acceptedAtMs,
      envelope:source.envelope,automatic:source.automatic??false,speakerId:source.speakerId??null,dependencies:source.dependencies??[]};
  }

  private plan(message:SceneMessage,roster:SceneRoster,configs:Configurations,history:SceneMessage[]=[]) {
    const configuredInput=configs.inputPerspective;
    const config=message.automatic && message.role==='user' && configuredInput.model ? configuredInput : configs.perspective;
    return message.envelope.mode==='direct'
      ? Promise.resolve(directPlan(message,roster)) : this.models.perspective(message,roster,config,history);
  }
  private assertReady(scope:SceneScope) {
    const state=this.authority.state(scope);
    if (!state.roster.characters.length) throw new Error('invalid_scene_not_configured');
    if (state.sources.some(source=>source.status==='accepted' && source.processing!=='ready')) throw new Error('invalid_scene_processing');
  }
  private assertVersion(scope:SceneScope,version:number) {
    if (this.authority.state(scope).version!==version) throw new Error('context_changed_retry');
  }
  private draft(scope:SceneScope,id:string) {
    this.prune();
    const draft=this.drafts.get(id);
    if (!draft || scopeKey(draft.scope)!==scopeKey(scope)) throw new Error('invalid_scene_draft');
    return draft;
  }
  private prune() {
    for (const [id,draft] of this.drafts) if (draft.expires<Date.now()) this.drafts.delete(id);
    for(const [id,ticket] of this.nativeTickets)if(ticket.expires<Date.now())this.nativeTickets.delete(id);
  }
}

/** Finish sibling stages before releasing the job; successful siblings remain retryable cache entries. */
async function settled<T extends readonly unknown[]>(tasks:{[K in keyof T]:Promise<T[K]>}):Promise<T> {
  const results=await Promise.allSettled(tasks);
  const failure=results.find(result=>result.status==='rejected');
  if(failure?.status==='rejected')throw failure.reason;
  return results.map(result=>(result as PromiseFulfilledResult<unknown>).value) as unknown as T;
}

/** Only actors that actually participate in this subject's visible observations reach the emotion model. */
function relationshipSceneInput(plan:PerspectivePlan,subject:import('./types.ts').SceneCharacter,roster:SceneRoster,
  profile:{id:string;name:string;persona:string;experienceState:import('../emotion/openher.ts').EmotionState}) {
  const visible=plan.observations.filter(observation=>observation.readers.includes(subject.id));
  const participants=new Set<string>([subject.id]);
  for(const observation of visible) {
    if(observation.actorId)participants.add(observation.actorId);
    for(const recipient of observation.recipients??[])participants.add(recipient);
  }
  const actors=roster.characters.filter(character=>participants.has(character.id));
  return {subjectId:subject.id,actorIds:roster.characters.map(character=>character.id),userActorId:'player',actors,plan,character:profile};
}

function worldPurchaseReferences(sources:readonly import('./types.ts').SceneSource[]):{sourceId:string;revision:number;effectId:string}[] {
  return sources.flatMap(source=>(source.analysis?.worldEffects??[]).flatMap(effect=>{
    if (!effect||typeof effect!=='object'||Array.isArray(effect)) return [];
    const candidate=effect as Record<string,unknown>;
    return candidate.kind==='purchase'&&typeof candidate.effectId==='string'&&candidate.effectId
      ?[{sourceId:source.id,revision:source.revision,effectId:candidate.effectId}]:[];
  }));
}

function sourceStamp(state:import('./types.ts').SceneState) {
  return JSON.stringify(state.sources.map(source=>[source.id,source.revision,source.status]));
}

function sceneMessageOf(value:unknown,roster:SceneRoster):SceneMessage {
  const input=object(value);
  const base=messageOf({...input,revision:input.revision??1});
  if (base.acceptedAtMs>Date.now()+5000) throw new Error('invalid_future_time');
  const envelope=envelopeOf(input.envelope,roster);
  const speakerId=input.speakerId===undefined?undefined:text(input.speakerId,200);
  const automatic=input.automatic===true;
  if(automatic && envelope.mode!=='scene') throw new Error('invalid_scene_envelope');
  if (base.role==='assistant' && !automatic && speakerId!==envelope.targetId) throw new Error('invalid_scene_speaker');
  if (base.role==='user' && speakerId!==undefined) throw new Error('invalid_scene_speaker');
    if (input.dependencies!==undefined && (!Array.isArray(input.dependencies)||input.dependencies.length>10000)) throw new Error('invalid_scene_dependencies');
  const dependencies=((input.dependencies??[]) as unknown[]).map(value=>{
    const item=object(value);return {id:text(item.id,200),revision:integer(item.revision,1)};
  });
  if (dependencies.some(item=>item.id===base.id)) throw new Error('invalid_scene_dependencies');
  const reply=input.replyTo===undefined?undefined:object(input.replyTo);
  const replyTo=reply?{id:text(reply.id,200),revision:integer(reply.revision,1)}:undefined;
  if(replyTo&&(replyTo.id===base.id||base.role!=='assistant'))throw new Error('invalid_scene_reply_to');
  return {...base,envelope,...(automatic?{automatic:true}:{}),...(speakerId===undefined?{}:{speakerId}),
    ...(replyTo?{replyTo}:{}),
    ...(input.dependencies===undefined?{}:{dependencies})};
}
function sameMessage(left:SceneMessage,right:SceneMessage) {
  return left.id===right.id && left.revision===right.revision && left.role===right.role && left.text===right.text && left.acceptedAtMs===right.acceptedAtMs &&
    left.speakerId===right.speakerId && JSON.stringify(left.envelope)===JSON.stringify(right.envelope) && JSON.stringify(left.dependencies??[])===JSON.stringify(right.dependencies??[]) && JSON.stringify(left.replyTo)===JSON.stringify(right.replyTo);
}

function playerIdentity(envelope:SceneEnvelope) {
  return `玩家姓名：${JSON.stringify(envelope.playerName??'未提供')}。玩家与NPC是不同身份，即使同名也不能混同。当前用户正文里的“我”指玩家；角色对玩家说话时“你”也指玩家，不能改称另一名NPC。\n`;
}

function companionIdentity(envelope:SceneEnvelope) {
  return `用户姓名：${JSON.stringify(envelope.playerName??'未提供')}。用户与角色是不同身份，即使同名也不能混同。当前用户正文里的“我”指用户；角色对用户说话时“你”也指用户，不能改称另一名角色。回应当前话题；未来约定没有到期依据时不要当成眼前行动。根据当前情境和用户明确要求自然交流，可以正常追问。\n`;
}

/** Directional source anchors, not aggregate OpenHer scores, govern the relationship and address guidance. */
function addressSuggestion(authority:SceneAuthority,scope:SceneScope,speakerId:string,envelope:SceneEnvelope,state:SceneState):string {
  const presentCount=envelope.presentIds.length+1;
  const relation=authority.relationshipAnchor(scope,speakerId,'player',state);
  const suggestion=suggestAddress({
    visibility:presentCount>2?'public':'private',presentCount,formality:'casual',
    addresseeIdentityKnown:typeof envelope.playerName==='string'&&!!envelope.playerName.trim(),
  },relation===undefined?undefined:{sourceId:relation.sourceId,revision:relation.revision,status:'accepted',
    direction:'speaker-to-addressee',relations:relation.relations});
  const relationship=relationshipContext(authority.relationships(scope,speakerId,state));
  return relationship+`\n[XLDB 称谓建议] 当前上下文中已列明的显式称谓、拒绝和边界偏好优先于本建议。${suggestion.instruction}`;
}
