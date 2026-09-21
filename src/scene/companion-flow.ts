import type {Configurations} from '../core/types.ts';
import type {Core} from '../core/service.ts';
import type {ModelTasks} from '../core/models.ts';
import type {SceneAuthority} from './store.ts';
import type {SceneScope,SceneMessage} from './types.ts';
import {visibleText} from './perspective.ts';
import {decodeProfileCandidates,decodeCommunicationStrategy} from '../user-model/codec.ts';
import type {FrontendStrategy,ProfileCandidate} from '../user-model/types.ts';
import {companionDecisionPrompt,decodeCompanionDecision} from '../companion/codec.ts';
import {relationshipContext} from '../emotion/relationships.ts';

/** Host-neutral companion orchestration. The host alone commits an outgoing message. */
export class CompanionFlow {
  private authority:SceneAuthority;
  private core:Core;
  private models:ModelTasks;
  constructor(authority:SceneAuthority,core:Core,models:ModelTasks){this.authority=authority;this.core=core;this.models=models;}
  async extract(scope:SceneScope,source:SceneMessage,configs:Configurations,assertCurrent:()=>void):Promise<ProfileCandidate[]>{
    const subject=this.authority.subject(scope);
    if(!subject||source.role!=='user')return [];
    const controls=this.authority.userModel.controls(subject.subjectId);
    const task=this.authority.userModel.profileTask(subject.subjectId,scope,source);
    if(!task)return [];
    const raw=await this.models.structuredTask(configs.profile,task.messages);
    assertCurrent();
    if(this.authority.userModel.controls(subject.subjectId).revision!==controls.revision)throw new Error('context_changed_retry');
    return decodeProfileCandidates(raw,source.text);
  }
  async strategy(scope:SceneScope,characterId:string,currentContext:string,configs:Configurations,assertCurrent:()=>void,purpose='reply'):Promise<FrontendStrategy|null>{
    const subject=this.authority.subject(scope);if(!subject)return null;
    const target=this.target(scope,characterId);
    const task=this.authority.userModel.strategyTask(subject.subjectId,{purpose,storageKey:JSON.stringify(['xldb-user-model-strategy-v1',purpose,target]),
      currentContext,characterId,sessionId:scope.sessionId});
    if(!task)return null;
    const raw=await this.models.structuredTask(configs.strategy,task.messages);assertCurrent();
    return this.authority.userModel.saveStrategy(subject.subjectId,task,decodeCommunicationStrategy(raw,task));
  }
  async systemContext(scope:SceneScope,characterId:string,legalContext:string,configs:Configurations,assertCurrent:()=>void){
    const strategy=await this.strategy(scope,characterId,legalContext,configs,assertCurrent);
    return strategy?'\n本轮沟通建议（依据已授权资料，推断不是事实，当前用户意愿优先）：'+JSON.stringify(strategy):'';
  }
  status(scope:SceneScope,characterId:string){
    this.actor(scope,characterId);const subject=this.requireSubject(scope);
    return {subject,controls:this.authority.userModel.controls(subject.subjectId),contact:this.authority.companion.contactSettings(subject.subjectId),
      status:this.authority.companion.status(subject.subjectId,this.target(scope,characterId))};
  }
  async poll(scope:SceneScope,characterId:string,trigger:'event'|'scheduled',configs:Configurations,assertCurrent:()=>void){
    const actor=this.actor(scope,characterId),subject=this.requireSubject(scope),state=this.authority.state(scope);
    const controls=this.authority.userModel.controls(subject.subjectId);
    if(!controls.proactiveCompanionEnabled||(trigger==='scheduled'&&!controls.scheduledWakeEnabled))return {status:'disabled'};
    if(state.sources.some(source=>source.status==='accepted'&&source.processing!=='ready'))return {status:'waiting',reason:'semantic_pending'};
    const now=Date.now(),targetId=this.target(scope,characterId),companion=this.authority.companion;
    const activityNow=companion.activity(subject.subjectId),contactNow=companion.contactSettings(subject.subjectId);
    for(const receipt of companion.status(subject.subjectId,targetId).deliveries.filter(item=>item.status==='ready')){
      const pending=companion.getDelivery(receipt.deliveryId),basis=pending?companion.getOpportunity(pending.opportunityId):null;
      if(pending&&basis&&pending.sourceVersion===state.version&&pending.controlsRevision===controls.revision&&
        pending.profileRevision===this.authority.userModel.profileRevision(subject.subjectId)&&pending.activityRevision===activityNow.revision&&
        pending.contactRevision===contactNow.revision&&now<=basis.windowEndMs&&now<=basis.expiresAtMs)
        return {status:'ready',deliveryId:pending.deliveryId,body:pending.body,characterId};
    }
    // A source opportunity is limited to text this recipient actually knows.
    const lastUser=state.sources.filter(source=>source.status==='accepted'&&source.role==='user'&&source.processing==='ready').at(-1);
    const current=lastUser?.analysis?.plan?visibleText(lastUser.analysis.plan,characterId):'';
    if(current)companion.schedule({subjectId:subject.subjectId,targetId,kind:'experience',purpose:'followup',
      opportunityKey:`source:${lastUser!.id}:${lastUser!.revision}`,topic:current.slice(0,500),basis:[{kind:'source',id:lastUser!.id,revision:lastUser!.revision}],sourceVersion:state.version,nowMs:now});
    // A daily contact is an opportunity to evaluate, never an invented user event.
    if(!current)companion.schedule({subjectId:subject.subjectId,targetId,kind:'daily',purpose:'gentle_contact',
      opportunityKey:'daily',topic:'一次不要求回复的简短问候，不假定用户正在做什么。',basis:[],sourceVersion:state.version,nowMs:now});
    const reminders=this.authority.commitments.dueTodos(scope,{realNowMs:now,storyNowMs:0},'companion');
    for(const reminder of reminders){
      const record=this.authority.commitments.get(scope,reminder.commitmentId);
      if(!record?.readers.includes(characterId))continue;
      companion.schedule({subjectId:subject.subjectId,targetId,kind:'schedule',purpose:'commitment_reminder',
      opportunityKey:`commitment:${reminder.commitmentId}:${reminder.revision}`,topic:record.content.slice(0,500),
      basis:[{kind:'schedule',id:reminder.commitmentId,revision:reminder.revision}],sourceVersion:state.version,nowMs:now});
    }
    const opportunity=companion.due(subject.subjectId,trigger,now).find(item=>item.targetId===targetId);
    if(!opportunity)return {status:'waiting',state:companion.status(subject.subjectId,targetId)};
    const claim=companion.claim(opportunity.opportunityId,'scene-companion',state.version,now,180000);
    const context=await this.core.contextFrom(this.authority.snapshot(scope,characterId,state),opportunity.topic,configs,
      this.authority.responseEmotion(scope,characterId,now,state),this.authority.preferences(scope,characterId,state),assertCurrent);
    context.context+=this.authority.worldContext(scope,characterId,state);
    context.context+=relationshipContext(this.authority.relationships(scope,characterId,state));
    context.context+=this.authority.commitments.projectPersistent(scope,{characterId,purpose:'expression',mode:'companion'}).systemText;
    // Turning off personalization must not prevent an independently enabled greeting.
    const strategy=await this.strategy(scope,characterId,context.context,configs,assertCurrent,'proactive')??this.basicStrategy(subject.subjectId,opportunity.purpose);
    const activity=companion.activity(subject.subjectId);
    const task=companionDecisionPrompt(opportunity,strategy,{nowMs:Date.now(),unansweredCount:activity.unansweredCount,
      busyUntilMs:activity.busyUntilMs,lastUserActivityAtMs:activity.lastUserActivityAtMs});
    let decision=decodeCompanionDecision(await this.models.structuredTask(configs.proactiveDecision,task.messages),task);assertCurrent();
    if(decision.decision==='defer'&&(opportunity.deferCount>=3||decision.nextCheckAtMs!>Math.min(opportunity.windowEndMs,opportunity.expiresAtMs)))
      decision={schema:'xldb-companion-decision-v1',decision:'dismiss',reason:'No remaining permitted check within this opportunity.',nextCheckAtMs:null};
    if(decision.decision!=='approve'){
      companion.decide(opportunity.opportunityId,claim.claimToken,decision.decision==='defer'
        ?{decision:'defer',nextCheckAtMs:decision.nextCheckAtMs!,reason:decision.reason}:{decision:'dismiss',reason:decision.reason},state.version);
      return {status:decision.decision};
    }
    const body=await this.models.generate(`你只扮演${actor.name}。${actor.persona}\n这是没有用户新输入时、已经批准的主动联系机会，此刻应执行该机会的沟通目的。输入中的来源是过去已接受的正文，不是用户正在对你说的新消息。若目的为提醒，现在给出提醒，不要再次答应以后提醒；不要向用户解释后台检查或调度。主动发起一次简短陪伴，不替用户说话，不推测未回复原因，不催促。按真实来源和用户边界决定措辞；只输出待发给用户的角色正文。`,
      context.context+'\n沟通建议：'+JSON.stringify(strategy),JSON.stringify({purpose:opportunity.purpose,trigger,nowMs:Date.now(),acceptedBasis:opportunity.topic}),configs.proactive);assertCurrent();
    companion.decide(opportunity.opportunityId,claim.claimToken,{decision:'approve',strategy},state.version);
    const delivery=companion.queueDelivery(opportunity.opportunityId,body,state.version);
    return {status:'ready',deliveryId:delivery.deliveryId,body:delivery.body,characterId};
  }
  claim(scope:SceneScope,characterId:string,deliveryId:string,host:string){
    this.checkDelivery(scope,characterId,deliveryId);
    const claim=this.authority.companion.claimDelivery(deliveryId,host,this.authority.state(scope).version);
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
  private actor(scope:SceneScope,characterId:string){const actor=this.authority.state(scope).roster.characters.find(character=>character.id===characterId);if(!actor)throw new Error('invalid_scene_character');return actor;}
  private requireSubject(scope:SceneScope){const subject=this.authority.subject(scope);if(!subject)throw new Error('companion_subject_not_bound');return subject;}
}
