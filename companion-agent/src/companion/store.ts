import {createHash,randomUUID} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {ensureUserModelSchema,readProfileControls,writeProfileControls} from '../user-model/schema.ts';
import type {FrontendStrategy,ProfileControls} from '../user-model/types.ts';
import {validateContactWindows,validateDate,validateTimeZone} from './time.ts';
import {PRESSURE_DEFAULTS,opportunitySeedKind,resolveTendency} from './contact-pressure.ts';
import type {ExpressionReliefSend} from '../../../shared/src/emotion/contact-affect.ts';
import type {CompanionActivity,CompanionBasis,CompanionDecision,CompanionDelivery,CompanionJudgment,CompanionOpportunity,CompanionState,
  ConfirmedContactDelivery,CompanionStatus,ContactException,ContactSettings,ContactTendencyDisposition,ContactTendencySettings,
  DeliveryClaim,DriveMarker,GuardBlock,GuardEvent,GuardKey,GuardSetting,GuardSettings,GuardValues,JudgmentInput,OccurrencePressure,
  OpportunityClaim,QuietExceptionBinding,QuietExceptionStatus,ScheduleOpportunityInput,SeedKind,WindowEndRoll,WindowEndRollView} from './types.ts';

interface ContactRow {subject:string;revision:number;time_zone:string;windows:string;exceptions:string;minimum_interval:number;max_unanswered:number;updated:number}
interface ActivityRow {subject:string;revision:number;semantic_ready_revision:number;last_user_activity:number|null;busy_until:number|null;unanswered_count:number;last_sent:number|null}
interface StateRow {subject:string;target:string;state:CompanionState;revision:number;opportunity_id:string|null;reason:string|null;next_check:number|null;updated:number}
interface OpportunityRow {
  id:string;subject:string;target:string;kind:CompanionOpportunity['kind'];purpose:string;topic:string;basis:string;occurrence_id:string;
  source_version:number;profile_revision:number;activity_revision:number;controls_revision:number;contact_revision:number;
  check_at:number;window_start:number;window_end:number;expires_at:number;status:CompanionOpportunity['status'];defer_count:number;
  decision:CompanionOpportunity['decision'];strategy:string|null;claim_token:string|null;claim_until:number|null;created:number;updated:number;
  seed_kind:SeedKind|null;pressure:string|null;
}
interface DeliveryRow {
  id:string;opportunity_id:string;subject:string;target:string;body:string;status:CompanionDelivery['status'];source_version:number;
  profile_revision:number;activity_revision:number;controls_revision:number;contact_revision:number;claim_token:string|null;
  claim_until:number|null;host:string|null;host_message_id:string|null;result_code:string|null;created:number;updated:number;
  /** M3-5 (relief_v1); absent on a row read before the column exists, NULL when none was recorded. */
  relief_connection?:number|null;
}
interface QuietExceptionRow {
  delivery_id:string;subject:string;target:string;scope_key:string;commitment_id:string;commitment_revision:number;
  window_key:string;source_id:string;source_revision:number;
  /** `exempt`: a user-timed reminder sent inside the window; it records the window but never uses its one exception. */
  status:'reserved'|'consumed'|'released'|'exempt';updated:number;
}
interface JudgmentRow {
  occurrence_id:string;subject:string;target:string;last_choice:JudgmentInput['choice']|null;last_fingerprint:string|null;
  pressure_marker:string|null;next_check:number|null;updated:number;
  seed_key:string|null;seed_kind:SeedKind|null;generation:number|null;pressure_at_decision:number|null;
}
interface GuardSettingRow {subject:string;key:GuardKey;enabled:number;value:string;revision:number;updated:number}
interface TendencyRow {subject:string;target:string;disposition:string;openness:number;receptivity:number;origin:ContactTendencySettings['origin'];
  revision:number;updated:number}

const GUARD_KEYS:readonly GuardKey[]=['G1','G2','G3'];
/** Pathology guards only; defaults are deliberately loose and every guard can be switched off. */
const GUARD_DEFAULTS:GuardValues={G1:{windowMinutes:60,count:4},G2:{windowMinutes:10,count:2},G3:{perHour:6}};
const SCHEDULER_MIGRATION='scheduler_v3';
/** M3 schema: companion_tendencies, the seed columns of opportunities and judgments (see ensureSchema). */
const PRESSURE_SCHEMA='pressure_v1';
/** M3-5 schema: companion_outbox.relief_connection, the F_c a text was queued from (see ensureSchema). */
const RELIEF_SCHEMA='relief_v1';
const WINDOW_END_TONES=['longing','care','share','light','topic'] as const;
/** Upper bound of a recorded window-end delay: the message expires six hours after the instance end. */
const WINDOW_END_DELAY_LIMIT_MS=6*3_600_000;
const SEED_KINDS:readonly SeedKind[]=['longing','share','recall','check_in','followup','reminder','window_end'];
const DISPOSITION_KEYS:readonly (keyof ContactTendencyDisposition)[]=['thetaScale','hazardScale','followupAmplitude','recallWeight',
  'checkInWeight','softWindowFactor'];
/** A pressure record larger than this is rejected rather than stored. */
const PRESSURE_RECORD_LIMIT=2048;

export class CompanionStore {
  private db:DatabaseSync;
  private savepointSequence=0;
  constructor(db:DatabaseSync){this.db=db;ensureUserModelSchema(db);this.ensureSchema();this.migrateScheduler();}

  controls(subjectId:string):ProfileControls{return readProfileControls(this.db,id(subjectId));}

  setControls(subjectId:string,patch:{proactiveCompanionEnabled?:boolean;scheduledWakeEnabled?:boolean},expectedRevision:number,nowMs=Date.now()):ProfileControls {
    subjectId=id(subjectId);assertRevision(expectedRevision);nowMs=time(nowMs);
    if(patch.proactiveCompanionEnabled===undefined&&patch.scheduledWakeEnabled===undefined)throw new Error('invalid_companion_controls');
    return this.transaction(()=>{
      const current=readProfileControls(this.db,subjectId);if(current.revision!==expectedRevision)throw new Error('context_changed_retry');
      const proactive=flag(patch.proactiveCompanionEnabled,current.proactiveCompanionEnabled);
      const scheduled=flag(patch.scheduledWakeEnabled,current.scheduledWakeEnabled);
      if(scheduled&&!proactive)throw new Error('invalid_scheduled_wake_without_proactive');
      const next={...current,proactiveCompanionEnabled:proactive,scheduledWakeEnabled:scheduled,revision:current.revision+1,updatedAtMs:nowMs};
      writeProfileControls(this.db,next);
      if(!proactive) {
        this.cancelUnsent(subjectId,'proactive_disabled',nowMs);
        for(const row of this.states(subjectId))this.writeState(subjectId,row.target,this.hasUncertainDelivery(subjectId,row.target)?'suspended':'disabled',
          null,'proactive_disabled',null,nowMs);
      } else {
        for(const row of this.states(subjectId))if(row.state==='disabled')this.writeState(subjectId,row.target,'waiting',null,'enabled',null,nowMs);
      }
      return next;
    });
  }

  contactSettings(subjectId:string):ContactSettings {
    subjectId=id(subjectId);const row=this.db.prepare(`SELECT subject,revision,time_zone,windows,exceptions,minimum_interval,max_unanswered,updated
      FROM companion_contact_settings WHERE subject=?`).get(subjectId) as ContactRow|undefined;
    return row?contactOf(row):{subjectId,revision:0,timeZone:'UTC',windows:[],exceptions:[],minimumIntervalMs:4*3_600_000,maxUnanswered:2,updatedAtMs:0};
  }

  setContactSettings(subjectId:string,patch:{timeZone?:string;windows?:unknown;exceptions?:unknown;minimumIntervalMs?:number;maxUnanswered?:number},
    expectedRevision:number,nowMs=Date.now()):ContactSettings {
    subjectId=id(subjectId);assertRevision(expectedRevision);nowMs=time(nowMs);
    return this.transaction(()=>{
      const current=this.contactSettings(subjectId);if(current.revision!==expectedRevision)throw new Error('context_changed_retry');
      const timeZone=patch.timeZone??current.timeZone;validateTimeZone(timeZone);
      const windows=patch.windows===undefined?current.windows:validateContactWindows(patch.windows);
      const exceptions=patch.exceptions===undefined?current.exceptions:validateExceptions(patch.exceptions);
      const minimumIntervalMs=patch.minimumIntervalMs??current.minimumIntervalMs;
      if(!Number.isSafeInteger(minimumIntervalMs)||minimumIntervalMs<60_000||minimumIntervalMs>30*86_400_000)throw new Error('invalid_contact_interval');
      const maxUnanswered=patch.maxUnanswered??current.maxUnanswered;
      if(!Number.isSafeInteger(maxUnanswered)||maxUnanswered<0||maxUnanswered>20)throw new Error('invalid_contact_unanswered');
      const next:ContactSettings={subjectId,revision:current.revision+1,timeZone,windows,exceptions,minimumIntervalMs,maxUnanswered,updatedAtMs:nowMs};
      this.db.prepare(`INSERT INTO companion_contact_settings VALUES(?,?,?,?,?,?,?,?)
        ON CONFLICT(subject) DO UPDATE SET revision=excluded.revision,time_zone=excluded.time_zone,windows=excluded.windows,
        exceptions=excluded.exceptions,minimum_interval=excluded.minimum_interval,max_unanswered=excluded.max_unanswered,updated=excluded.updated`)
        .run(subjectId,next.revision,timeZone,JSON.stringify(windows),JSON.stringify(exceptions),minimumIntervalMs,maxUnanswered,nowMs);
      this.cancelUnsent(subjectId,'contact_settings_changed',nowMs);
      return next;
    });
  }

  activity(subjectId:string):CompanionActivity {
    subjectId=id(subjectId);const row=this.db.prepare(`SELECT subject,revision,semantic_ready_revision,last_user_activity,busy_until,unanswered_count,last_sent
      FROM companion_activity WHERE subject=?`).get(subjectId) as ActivityRow|undefined;
    return row?activityOf(row):{subjectId,revision:0,semanticReadyRevision:0,lastUserActivityAtMs:null,busyUntilMs:null,unansweredCount:0,lastSentAtMs:null};
  }

  recordUserActivity(subjectId:string,atMs=Date.now()):CompanionActivity {
    subjectId=id(subjectId);atMs=time(atMs);
    return this.transaction(()=>{
      const current=this.activity(subjectId),next={...current,revision:current.revision+1,semanticReadyRevision:-1,
        lastUserActivityAtMs:atMs,busyUntilMs:current.busyUntilMs&&current.busyUntilMs>atMs?current.busyUntilMs:null,unansweredCount:0};
      this.writeActivity(next);this.cancelUnsent(subjectId,'user_activity',atMs);
      const controls=readProfileControls(this.db,subjectId);
      for(const row of this.states(subjectId))this.writeState(subjectId,row.target,controls.proactiveCompanionEnabled?'suspended':'disabled',
        null,'semantic_processing_pending',null,atMs);
      return next;
    });
  }

  markSemanticReady(subjectId:string,activityRevision:number,nowMs=Date.now()):CompanionActivity {
    subjectId=id(subjectId);assertRevision(activityRevision);nowMs=time(nowMs);
    return this.transaction(()=>{
      const current=this.activity(subjectId);if(current.revision!==activityRevision)throw new Error('context_changed_retry');
      const next={...current,semanticReadyRevision:activityRevision};this.writeActivity(next);
      const controls=readProfileControls(this.db,subjectId);
      if(controls.proactiveCompanionEnabled&&!this.hasUnknown(subjectId))for(const row of this.states(subjectId))
        if(row.state==='suspended'&&row.reason==='semantic_processing_pending')this.writeState(subjectId,row.target,'waiting',null,'semantic_ready',row.next_check,nowMs);
      return next;
    });
  }

  setBusyUntil(subjectId:string,busyUntilMs:number|null,expectedActivityRevision:number,nowMs=Date.now()):CompanionActivity {
    subjectId=id(subjectId);assertRevision(expectedActivityRevision);nowMs=time(nowMs);if(busyUntilMs!==null)time(busyUntilMs);
    return this.transaction(()=>{
      const current=this.activity(subjectId);if(current.revision!==expectedActivityRevision)throw new Error('context_changed_retry');
      const revision=current.revision+1,next={...current,revision,semanticReadyRevision:revision,busyUntilMs};
      this.writeActivity(next);this.cancelUnsent(subjectId,'busy_changed',nowMs);
      // A set, extended, shortened or cleared busy time is a control change: it starts a new hazard epoch (M3-3).
      if(busyUntilMs!==current.busyUntilMs)this.db.prepare(`INSERT INTO companion_busy_changes(subject,updated) VALUES(?,?)
        ON CONFLICT(subject) DO UPDATE SET updated=excluded.updated`).run(subjectId,nowMs);
      return next;
    });
  }

  schedule(input:ScheduleOpportunityInput):CompanionOpportunity|null {
    const subjectId=id(input.subjectId),targetId=id(input.targetId),opportunityKey=id(input.opportunityKey),nowMs=time(input.nowMs??Date.now());
    assertRevision(input.sourceVersion);const purpose=text(input.purpose,200),topic=text(input.topic,500),basis=validateBasis(input.basis,input.kind);
    const fingerprint=input.fingerprint===undefined?undefined:text(input.fingerprint,2000);
    const seedKind=input.seedKind==null?null:validateSeedKind(input.seedKind);
    const pressure=input.pressure==null?null:validatePressure(input.pressure);
    return this.transaction(()=>{
      const controls=readProfileControls(this.db,subjectId);if(!controls.proactiveCompanionEnabled)throw new Error('proactive_companion_disabled');
      if(this.hasUnknown(subjectId))return null;
      const activity=this.activity(subjectId);if(activity.semanticReadyRevision!==activity.revision)throw new Error('companion_semantic_pending');
      const settings=this.contactSettings(subjectId);
      const checkAtMs=Math.max(nowMs,input.notBeforeMs===undefined?0:time(input.notBeforeMs),activity.busyUntilMs??0);
      // The former contact windows and frequency fields remain readable for old data, but do not authorize or limit contact.
      const expiresAtMs=input.expiresAtMs===undefined?checkAtMs+86_400_000:time(input.expiresAtMs);
      if(expiresAtMs<=checkAtMs)return null;
      const profileRevision=this.profileRevision(subjectId);
      const occurrenceId=hash([subjectId,targetId,opportunityKey,input.kind]);
      // Accepting our own delivery changes the scene version, but does not create
      // another reason to send the same opportunity. New source revisions and
      // scheduler wakes already have distinct caller-supplied opportunity keys.
      const consumed=this.db.prepare("SELECT * FROM companion_opportunities WHERE subject=? AND target=? AND occurrence_id=? AND status='consumed' LIMIT 1")
        .get(subjectId,targetId,occurrenceId) as OpportunityRow|undefined;
      if(consumed)return opportunityOf(consumed);
      const opportunityId=hash([subjectId,targetId,opportunityKey,input.kind,occurrenceId,input.sourceVersion,
        profileRevision,activity.revision,controls.revision,settings.revision]);
      const existing=this.opportunityRow(opportunityId);if(existing)return opportunityOf(existing);
      // A source change cancels rows, not judgments: a rebuilt row of an occurrence last judged with the same substantive
      // inputs keeps that wait (and its next check) or skip instead of asking the provider again.
      const judgment=fingerprint===undefined?undefined:this.judgmentRow(occurrenceId);
      const same=judgment!==undefined&&judgment.last_fingerprint===fingerprint;
      const deferUntil=same&&judgment.last_choice==='wait'&&judgment.next_check!==null&&judgment.next_check>checkAtMs&&
        judgment.next_check<=expiresAtMs?judgment.next_check:null;
      const skipped=same&&judgment.last_choice==='skip';
      const status=skipped?'dismissed':deferUntil!==null?'deferred':'waiting';
      this.db.prepare(`INSERT INTO companion_opportunities
        (id,subject,target,kind,purpose,topic,basis,occurrence_id,source_version,profile_revision,activity_revision,controls_revision,contact_revision,
        check_at,window_start,window_end,expires_at,status,defer_count,decision,strategy,claim_token,claim_until,created,updated,seed_kind,pressure)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,NULL,NULL,NULL,?,?,?,?)`)
        .run(opportunityId,subjectId,targetId,input.kind,purpose,topic,JSON.stringify(basis),occurrenceId,input.sourceVersion,
          profileRevision,activity.revision,controls.revision,settings.revision,deferUntil??checkAtMs,checkAtMs,expiresAtMs,expiresAtMs,
          status,skipped?'dismiss':deferUntil!==null?'defer':null,nowMs,nowMs,seedKind,pressure===null?null:JSON.stringify(pressure));
      if(status==='waiting')this.writeState(subjectId,targetId,'waiting',opportunityId,'scheduled',checkAtMs,nowMs);
      else this.writeState(subjectId,targetId,'cooldown',opportunityId,'judgment_reused',deferUntil,nowMs);
      return opportunityOf(this.opportunityRow(opportunityId)!);
    });
  }

  due(subjectId:string,trigger:'event'|'scheduled',nowMs=Date.now(),limit=20):CompanionOpportunity[] {
    subjectId=id(subjectId);nowMs=time(nowMs);if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw new Error('invalid_companion_limit');
    const controls=readProfileControls(this.db,subjectId);if(!controls.proactiveCompanionEnabled||(trigger==='scheduled'&&!controls.scheduledWakeEnabled))return [];
    const activity=this.activity(subjectId);if(activity.semanticReadyRevision!==activity.revision||(activity.busyUntilMs??0)>nowMs||this.hasUnknown(subjectId))return [];
    const contact=this.contactSettings(subjectId),profileRevision=this.profileRevision(subjectId);
    const rows=this.db.prepare(`SELECT * FROM companion_opportunities WHERE subject=? AND status IN ('waiting','deferred','evaluating')
      AND check_at<=? AND window_start<=? AND window_end>=? AND expires_at>=? ORDER BY check_at,id LIMIT ?`)
      .all(subjectId,nowMs,nowMs,nowMs,nowMs,limit) as unknown as OpportunityRow[];
    return rows.filter(row=>row.controls_revision===controls.revision&&row.contact_revision===contact.revision&&
      row.profile_revision===profileRevision&&row.activity_revision===activity.revision&&
      (row.status!=='evaluating'||row.claim_until===null||row.claim_until<=nowMs)).map(opportunityOf);
  }

  claim(opportunityId:string,owner:string,currentSourceVersion:number,nowMs=Date.now(),leaseMs=60_000):OpportunityClaim {
    opportunityId=id(opportunityId);owner=id(owner);assertRevision(currentSourceVersion);nowMs=time(nowMs);lease(leaseMs);
    return this.transaction(()=>{
      const row=this.opportunityRow(opportunityId);if(!row)throw new Error('companion_opportunity_not_found');
      this.assertOpportunityCurrent(row,currentSourceVersion,nowMs);
      if(!['waiting','deferred','evaluating'].includes(row.status))throw new Error('companion_opportunity_unavailable');
      if(row.status==='evaluating'&&(row.claim_until??0)>nowMs)throw new Error('companion_opportunity_claimed');
      if(nowMs<row.check_at)throw new Error('companion_opportunity_not_due');
      if(nowMs>row.window_end||nowMs>row.expires_at){this.dismissExpired(row,nowMs);throw new Error('companion_opportunity_expired');}
      const claimToken=randomUUID(),claimUntilMs=nowMs+leaseMs;
      this.db.prepare("UPDATE companion_opportunities SET status='evaluating',claim_token=?,claim_until=?,updated=? WHERE id=?")
        .run(claimToken,claimUntilMs,nowMs,opportunityId);
      this.writeState(row.subject,row.target,'evaluating',row.id,`claimed:${owner}`,row.check_at,nowMs);
      return {opportunity:opportunityOf(this.opportunityRow(opportunityId)!),claimToken,claimUntilMs};
    });
  }

  /**
   * A supplied judgment is stored for the opportunity's occurrence in the same transaction. The defer count is kept for
   * observation only; a caller that wants a cap (the host-model path) applies it before deciding.
   */
  decide(opportunityId:string,claimToken:string,decision:CompanionDecision,currentSourceVersion:number,nowMs=Date.now(),
    judgment?:JudgmentInput):CompanionOpportunity {
    opportunityId=id(opportunityId);claimToken=id(claimToken);assertRevision(currentSourceVersion);nowMs=time(nowMs);
    const recorded=judgment===undefined?undefined:validateJudgment(judgment);
    return this.transaction(()=>{
      const row=this.opportunityRow(opportunityId);if(!row)throw new Error('companion_opportunity_not_found');
      this.assertClaim(row,claimToken,nowMs);this.assertOpportunityCurrent(row,currentSourceVersion,nowMs);
      if(decision.decision==='approve') {
        validateStrategy(decision.strategy,row);
        this.db.prepare("UPDATE companion_opportunities SET status='approved',decision='approve',strategy=?,claim_token=NULL,claim_until=NULL,updated=? WHERE id=?")
          .run(JSON.stringify(decision.strategy),nowMs,row.id);
        this.writeState(row.subject,row.target,'evaluating',row.id,'approved_generation_pending',null,nowMs);
      } else if(decision.decision==='defer') {
        const next=time(decision.nextCheckAtMs);text(decision.reason,300);
        if(next<=nowMs||next>row.window_end||next>row.expires_at)throw new Error('invalid_companion_defer');
        this.db.prepare("UPDATE companion_opportunities SET status='deferred',decision='defer',defer_count=defer_count+1,check_at=?,claim_token=NULL,claim_until=NULL,updated=? WHERE id=?")
          .run(next,nowMs,row.id);
        this.writeState(row.subject,row.target,'cooldown',row.id,decision.reason,next,nowMs);
      } else {
        text(decision.reason,300);
        this.db.prepare("UPDATE companion_opportunities SET status='dismissed',decision='dismiss',claim_token=NULL,claim_until=NULL,updated=? WHERE id=?")
          .run(nowMs,row.id);
        this.writeState(row.subject,row.target,'cooldown',row.id,decision.reason,null,nowMs);
      }
      if(recorded)this.writeJudgment(row,recorded,decision.decision==='defer'?decision.nextCheckAtMs:null,nowMs);
      return opportunityOf(this.opportunityRow(row.id)!);
    });
  }

  /**
   * `exemptQuiet` records the current soft windows for a user-timed reminder without reserving their one exception;
   * claim still rechecks that the same windows apply. `reliefConnection` is her connection frustration F_c the text was
   * written from (M3-5 item 9, a finite value >= 0), stored with the text as relief_connection; without it the column stays
   * NULL and the send releases the table amount. A repeated queue of the same text returns the stored row unchanged.
   */
  queueDelivery(opportunityId:string,body:string,currentSourceVersion:number,nowMs=Date.now(),
    quietExceptions:readonly QuietExceptionBinding[]=[],options:{exemptQuiet?:boolean;reliefConnection?:number}={}):CompanionDelivery {
    opportunityId=id(opportunityId);body=text(body,20_000);assertRevision(currentSourceVersion);nowMs=time(nowMs);
    const bindings=validateQuietBindings(quietExceptions);
    const reliefConnection=options.reliefConnection===undefined?null:validateReliefConnection(options.reliefConnection);
    return this.transaction(()=>{
      const opportunity=this.opportunityRow(opportunityId);if(!opportunity)throw new Error('companion_opportunity_not_found');
      this.assertOpportunityCurrent(opportunity,currentSourceVersion,nowMs);
      if(opportunity.status!=='approved'||!opportunity.strategy)throw new Error('companion_opportunity_not_approved');
      const deliveryId=hash([opportunityId,body]);const existing=this.deliveryRow(deliveryId);
      if(existing){
        if(!sameQuietBindings(this.getDeliveryExceptionBindings(deliveryId),bindings))throw new Error('companion_quiet_exception_changed');
        return deliveryOf(existing);
      }
      this.db.prepare(`INSERT INTO companion_outbox
        (id,opportunity_id,subject,target,body,status,source_version,profile_revision,activity_revision,controls_revision,contact_revision,
        claim_token,claim_until,host,host_message_id,result_code,created,updated,relief_connection)
        VALUES(?,?,?,?,?,'ready',?,?,?,?,?,NULL,NULL,NULL,NULL,NULL,?,?,?)`)
        .run(deliveryId,opportunityId,opportunity.subject,opportunity.target,body,opportunity.source_version,opportunity.profile_revision,
          opportunity.activity_revision,opportunity.controls_revision,opportunity.contact_revision,nowMs,nowMs,reliefConnection);
      for(const binding of bindings){
        if(options.exemptQuiet){
          this.db.prepare(`INSERT INTO companion_quiet_exceptions
            (delivery_id,subject,target,scope_key,commitment_id,commitment_revision,window_key,source_id,source_revision,status,updated)
            VALUES(?,?,?,?,?,?,?,?,?,'exempt',?)`)
            .run(deliveryId,opportunity.subject,opportunity.target,binding.scopeKey,binding.commitmentId,binding.revision,
              binding.key,binding.sourceId,binding.sourceRevision,nowMs);
          continue;
        }
        const claimed=this.db.prepare(`SELECT status FROM companion_quiet_exceptions WHERE subject=? AND target=? AND scope_key=?
          AND commitment_id=? AND commitment_revision=? AND window_key=? AND status IN ('reserved','consumed') LIMIT 1`)
          .get(opportunity.subject,opportunity.target,binding.scopeKey,binding.commitmentId,binding.revision,binding.key);
        if(claimed)throw new Error('companion_quiet_exception_unavailable');
        this.db.prepare(`INSERT INTO companion_quiet_exceptions
          (delivery_id,subject,target,scope_key,commitment_id,commitment_revision,window_key,source_id,source_revision,status,updated)
          VALUES(?,?,?,?,?,?,?,?,?,'reserved',?)`)
          .run(deliveryId,opportunity.subject,opportunity.target,binding.scopeKey,binding.commitmentId,binding.revision,
            binding.key,binding.sourceId,binding.sourceRevision,nowMs);
      }
      return deliveryOf(this.deliveryRow(deliveryId)!);
    });
  }

  approveAndQueueDelivery(opportunityId:string,claimToken:string,strategy:FrontendStrategy,body:string,
    currentSourceVersion:number,nowMs=Date.now(),quietExceptions:readonly QuietExceptionBinding[]=[],
    options:{exemptQuiet?:boolean;judgment?:JudgmentInput;reliefConnection?:number}={}):CompanionDelivery {
    return this.transaction(()=>{
      this.decide(opportunityId,claimToken,{decision:'approve',strategy},currentSourceVersion,nowMs,options.judgment);
      return this.queueDelivery(opportunityId,body,currentSourceVersion,nowMs,quietExceptions,{exemptQuiet:options.exemptQuiet,
        ...(options.reliefConnection===undefined?{}:{reliefConnection:options.reliefConnection})});
    });
  }

  quietExceptionStatus(subjectId:string,targetId:string,binding:QuietExceptionBinding):QuietExceptionStatus {
    subjectId=id(subjectId);targetId=id(targetId);const current=validateQuietBindings([binding])[0]!;
    const row=this.db.prepare(`SELECT status FROM companion_quiet_exceptions WHERE subject=? AND target=? AND scope_key=?
      AND commitment_id=? AND commitment_revision=? AND window_key=? AND status IN ('reserved','consumed') LIMIT 1`)
      .get(subjectId,targetId,current.scopeKey,current.commitmentId,current.revision,current.key) as {status:'reserved'|'consumed'}|undefined;
    if(row)return row.status;
    return this.db.prepare(`SELECT 1 FROM companion_quiet_declines WHERE subject=? AND target=? AND scope_key=?
      AND commitment_id=? AND commitment_revision=? AND window_key=?`)
      .get(subjectId,targetId,current.scopeKey,current.commitmentId,current.revision,current.key)?'declined':'available';
  }

  /**
   * A negative exception judgment belongs to the window instance, not to the occurrence that asked: every current window
   * is marked declined, so no other occurrence applies again until the window (or its revision) changes.
   */
  declineQuietException(subjectId:string,targetId:string,occurrenceId:string,bindings:readonly QuietExceptionBinding[],nowMs=Date.now()):void {
    subjectId=id(subjectId);targetId=id(targetId);occurrenceId=id(occurrenceId);nowMs=time(nowMs);
    const rows=validateQuietBindings(bindings);
    this.transaction(()=>{
      for(const binding of rows)this.db.prepare(`INSERT OR IGNORE INTO companion_quiet_declines
        (subject,target,scope_key,commitment_id,commitment_revision,window_key,occurrence_id,created) VALUES(?,?,?,?,?,?,?,?)`)
        .run(subjectId,targetId,binding.scopeKey,binding.commitmentId,binding.revision,binding.key,occurrenceId,nowMs);
    });
  }

  getDeliveryExceptionBindings(deliveryId:string):QuietExceptionBinding[] {
    deliveryId=id(deliveryId);
    const rows=this.db.prepare('SELECT * FROM companion_quiet_exceptions WHERE delivery_id=? ORDER BY rowid')
      .all(deliveryId) as unknown as QuietExceptionRow[];
    return rows.map(row=>({scopeKey:row.scope_key,commitmentId:row.commitment_id,revision:row.commitment_revision,
      key:row.window_key,sourceId:row.source_id,sourceRevision:row.source_revision}));
  }

  claimDelivery(deliveryId:string,host:string,currentSourceVersion:number,nowMs=Date.now(),leaseMs=60_000,
    currentQuietExceptions?:()=>readonly QuietExceptionBinding[]|null):DeliveryClaim {
    deliveryId=id(deliveryId);host=id(host);assertRevision(currentSourceVersion);nowMs=time(nowMs);lease(leaseMs);
    const result=this.transaction(()=>{
      const row=this.deliveryRow(deliveryId);if(!row)throw new Error('companion_delivery_not_found');
      if(row.status==='unknown')throw new Error('companion_delivery_unknown');
      if(row.status==='sending'&&(row.claim_until??0)>nowMs)throw new Error('companion_delivery_claimed');
      if(row.status==='sending')return {unknown:this.finishDelivery(row,{status:'unknown',code:'claim_lease_expired'},nowMs)} as const;
      if(row.status!=='ready')throw new Error('companion_delivery_unavailable');
      this.assertDeliveryCurrent(row,currentSourceVersion,nowMs);
      if(!currentQuietExceptions&&this.getDeliveryExceptionBindings(deliveryId).length)
        throw new Error('companion_quiet_validation_required');
      const claimToken=randomUUID(),claimUntilMs=nowMs+leaseMs;
      this.db.prepare("UPDATE companion_outbox SET status='sending',claim_token=?,claim_until=?,host=?,updated=? WHERE id=?")
        .run(claimToken,claimUntilMs,host,nowMs,deliveryId);
      if(currentQuietExceptions){
        const current=currentQuietExceptions();
        if(current===null||!sameQuietBindings(this.getDeliveryExceptionBindings(deliveryId),validateQuietBindings(current))){
          this.db.prepare(`UPDATE companion_outbox SET status='cancelled',claim_token=NULL,claim_until=NULL,
            result_code='quiet_rule_changed',updated=? WHERE id=?`).run(nowMs,deliveryId);
          this.releaseQuietExceptions(deliveryId,nowMs);
          return {blocked:true} as const;
        }
      }
      return {claim:{delivery:deliveryOf(this.deliveryRow(deliveryId)!),claimToken,claimUntilMs}} as const;
    });
    if('unknown' in result)throw new Error('companion_delivery_unknown');
    if('blocked' in result)throw new Error('companion_quiet_exception_changed');
    return result.claim;
  }

  recordDelivery(deliveryId:string,claimToken:string,outcome:{status:'sent';hostMessageId:string}|{status:'failed';code:string}|{status:'unknown';code:string},
    nowMs=Date.now()):CompanionDelivery {
    deliveryId=id(deliveryId);claimToken=id(claimToken);nowMs=time(nowMs);
    return this.transaction(()=>{
      const row=this.deliveryRow(deliveryId);if(!row)throw new Error('companion_delivery_not_found');
      if(row.status==='host_committed'&&outcome.status==='sent'&&row.host_message_id===id(outcome.hostMessageId))return deliveryOf(row);
      if(row.status!=='sending'||row.claim_token!==claimToken)throw new Error('companion_delivery_claim_mismatch');
      return this.finishDelivery(row,outcome,nowMs);
    });
  }

  reconcileUnknown(deliveryId:string,outcome:{status:'sent';hostMessageId:string}|{status:'failed';code:string},nowMs=Date.now()):CompanionDelivery {
    deliveryId=id(deliveryId);nowMs=time(nowMs);
    return this.transaction(()=>{
      const row=this.deliveryRow(deliveryId);if(!row)throw new Error('companion_delivery_not_found');
      if(row.status!=='unknown')throw new Error('companion_delivery_not_unknown');
      return this.finishDelivery(row,outcome,nowMs);
    });
  }

  invalidateSources(subjectId:string,currentSourceVersion:number,targetIdsOrNow?:readonly string[]|number,atMs=Date.now()):void {
    subjectId=id(subjectId);assertRevision(currentSourceVersion);
    const targetIds=Array.isArray(targetIdsOrNow)?[...new Set(targetIdsOrNow.map(target=>id(target)))]:undefined;
    const nowMs=time(typeof targetIdsOrNow==='number'?targetIdsOrNow:atMs);
    if(targetIds?.length===0)return;
    this.transaction(()=>{
      const targetClause=targetIds?` AND target IN (${targetIds.map(()=>'?').join(',')})`:'';
      this.db.prepare(`UPDATE companion_opportunities SET status='cancelled',claim_token=NULL,claim_until=NULL,updated=?
        WHERE subject=? AND source_version<>?${targetClause} AND status IN ('waiting','deferred','evaluating','approved')`)
        .run(nowMs,subjectId,currentSourceVersion,...(targetIds??[]));
      this.db.prepare(`UPDATE companion_outbox SET status='cancelled',claim_token=NULL,claim_until=NULL,result_code='source_changed',updated=?
        WHERE subject=? AND source_version<>?${targetClause} AND status IN ('draft','ready')`)
        .run(nowMs,subjectId,currentSourceVersion,...(targetIds??[]));
      this.releaseCancelledQuietExceptions(subjectId,nowMs);
      const selected=targetIds?new Set(targetIds):null;
      for(const row of this.states(subjectId))if((!selected||selected.has(row.target))&&!this.hasUncertainDelivery(subjectId,row.target))
        this.writeState(subjectId,row.target,readProfileControls(this.db,subjectId).proactiveCompanionEnabled?'waiting':'disabled',null,'source_changed',null,nowMs);
    });
  }

  /** Apply profile/control/contact revisions changed through another same-DB module. */
  refreshControls(subjectId:string,nowMs=Date.now()):void {
    subjectId=id(subjectId);nowMs=time(nowMs);
    this.transaction(()=>{
      const controls=readProfileControls(this.db,subjectId),contact=this.contactSettings(subjectId),profileRevision=this.profileRevision(subjectId);
      const parameters=[subjectId,controls.revision,contact.revision,profileRevision] as const;
      const staleTargets=new Set<string>();
      for(const row of this.db.prepare(`SELECT DISTINCT target FROM companion_opportunities WHERE subject=?
        AND (controls_revision<>? OR contact_revision<>? OR profile_revision<>?)
        AND status IN ('waiting','deferred','evaluating','approved')`).all(...parameters) as {target:string}[])staleTargets.add(row.target);
      for(const row of this.db.prepare(`SELECT DISTINCT target FROM companion_outbox WHERE subject=?
        AND (controls_revision<>? OR contact_revision<>? OR profile_revision<>?) AND status IN ('draft','ready')`).all(...parameters) as {target:string}[])staleTargets.add(row.target);
      this.db.prepare(`UPDATE companion_opportunities SET status='cancelled',claim_token=NULL,claim_until=NULL,updated=? WHERE subject=?
        AND (controls_revision<>? OR contact_revision<>? OR profile_revision<>?) AND status IN ('waiting','deferred','evaluating','approved')`)
        .run(nowMs,...parameters);
      this.db.prepare(`UPDATE companion_outbox SET status='cancelled',claim_token=NULL,claim_until=NULL,result_code='controls_changed',updated=? WHERE subject=?
        AND (controls_revision<>? OR contact_revision<>? OR profile_revision<>?) AND status IN ('draft','ready')`)
        .run(nowMs,...parameters);
      this.releaseCancelledQuietExceptions(subjectId,nowMs);
      for(const row of this.states(subjectId))if(!controls.proactiveCompanionEnabled||staleTargets.has(row.target))
        this.writeState(subjectId,row.target,this.hasUncertainDelivery(subjectId,row.target)?'suspended':controls.proactiveCompanionEnabled?'waiting':'disabled',
          null,'controls_changed',null,nowMs);
    });
  }

  /**
   * A revised relationship assessment invalidates unsent wording for this one companion. Reopen events (see
   * driveReopenTimes), which let a drive episode be judged again later instead of staying cancelled, are recorded only for
   * drive occurrences not yet handed to the host: for `contact_restriction_hard`, every pending one of this target; for
   * `contact_context_expired`, only the one opportunity named in `expired` whose ready text lapsed unchanged
   * (`body_expired`). A cancellation because the context changed (`context_changed`: a new source, activity, profile,
   * controls or quiet windows) reopens nothing, like a user correction or a switch-off; other pending rows, such as a
   * deferred drive beside an expired follow-up, keep their occurrence and stored judgment. A recall pressure occurrence
   * whose ready text lapsed unchanged is closed as well, like a failed send of it (reason `pressure_delivery_failed`, which
   * never enters the drive episode identity): it expressed nothing, so the flow lets its next generation open at most
   * DRIVE_REOPEN_LIMIT times instead of rebuilding and judging the same occurrence on every poll.
   */
  cancelPendingForTarget(subjectId:string,targetId:string,reason='relationship_corrected',nowMs=Date.now(),
    expired?:{opportunityId:string;cause:'body_expired'|'context_changed'}):void {
    subjectId=id(subjectId);targetId=id(targetId);reason=id(reason);nowMs=time(nowMs);
    const expiredId=expired?.cause==='body_expired'&&reason==='contact_context_expired'?id(expired.opportunityId):null;
    this.transaction(()=>{
      const pendingOf=(kinds:string)=>`INSERT OR IGNORE INTO companion_drive_reopens(occurrence_id,subject,target,reason,at)
        SELECT DISTINCT p.occurrence_id,p.subject,p.target,?,? FROM companion_opportunities p WHERE p.subject=? AND p.target=? AND ${kinds}
        AND p.status IN ('waiting','deferred','evaluating','approved') AND NOT EXISTS (SELECT 1 FROM companion_outbox o
        WHERE o.opportunity_id=p.id AND o.status IN ('sending','unknown','host_committed'))`;
      const pendingDrive=pendingOf("p.kind='drive'");
      if(reason==='contact_restriction_hard')this.db.prepare(pendingDrive).run(reason,nowMs,subjectId,targetId);
      else if(expiredId!==null){
        this.db.prepare(`${pendingDrive} AND p.id=?`).run('body_expired',nowMs,subjectId,targetId,expiredId);
        this.db.prepare(`${pendingOf("p.kind='recall' AND p.pressure IS NOT NULL")} AND p.id=?`)
          .run('pressure_delivery_failed',nowMs,subjectId,targetId,expiredId);
      }
      this.db.prepare(`UPDATE companion_opportunities SET status='cancelled',claim_token=NULL,claim_until=NULL,updated=?
        WHERE subject=? AND target=? AND status IN ('waiting','deferred','evaluating','approved')`).run(nowMs,subjectId,targetId);
      this.db.prepare(`UPDATE companion_outbox SET status='cancelled',claim_token=NULL,claim_until=NULL,result_code=?,updated=?
        WHERE subject=? AND target=? AND status IN ('draft','ready')`).run(reason,nowMs,subjectId,targetId);
      this.releaseCancelledQuietExceptions(subjectId,nowMs);
      this.writeState(subjectId,targetId,this.hasUncertainDelivery(subjectId,targetId)?'suspended':
        readProfileControls(this.db,subjectId).proactiveCompanionEnabled?'waiting':'disabled',null,reason,null,nowMs);
    });
  }

  status(subjectId:string,targetId:string):CompanionStatus {
    subjectId=id(subjectId);targetId=id(targetId);const state=this.stateRow(subjectId,targetId),controls=readProfileControls(this.db,subjectId);
    const deliveries=(this.db.prepare(`SELECT id,status,host_message_id,result_code,updated FROM companion_outbox
      WHERE subject=? AND target=? ORDER BY rowid`).all(subjectId,targetId) as unknown as {id:string;status:CompanionDelivery['status'];host_message_id:string|null;result_code:string|null;updated:number}[])
      .map(row=>({deliveryId:row.id,status:row.status,hostMessageId:row.host_message_id,resultCode:row.result_code,updatedAtMs:row.updated}));
    return {subjectId,targetId,state:state?.state??(controls.proactiveCompanionEnabled?'waiting':'disabled'),revision:state?.revision??0,
      opportunityId:state?.opportunity_id??null,reason:state?.reason??null,nextCheckAtMs:state?.next_check??null,activity:this.activity(subjectId),deliveries};
  }

  getOpportunity(opportunityId:string):CompanionOpportunity|null {
    const row=this.opportunityRow(id(opportunityId));return row?opportunityOf(row):null;
  }

  getDelivery(deliveryId:string):CompanionDelivery|null {
    const row=this.deliveryRow(id(deliveryId));return row?deliveryOf(row):null;
  }

  /** Remove the derived text when its accepted scene source is deleted. Keep the receipt for deduplication. */
  redactDeliveryBody(deliveryId:string,subjectId:string,targetId:string):void {
    this.db.prepare("UPDATE companion_outbox SET body='' WHERE id=? AND subject=? AND target=? AND status='host_committed'")
      .run(id(deliveryId),id(subjectId),id(targetId));
  }

  /** Only actual host-confirmed sends can begin a wait-for-reply episode. */
  confirmedContactDeliveries(subjectId:string,targetId:string):ConfirmedContactDelivery[] {
    subjectId=id(subjectId);targetId=id(targetId);
    const rows=this.db.prepare(`SELECT o.id,o.body,o.host_message_id,o.updated,o.result_code,
      EXISTS(SELECT 1 FROM companion_quiet_exceptions q WHERE q.delivery_id=o.id AND q.status='consumed') AS quiet_exception
      FROM companion_outbox o WHERE o.subject=? AND o.target=? AND o.status='host_committed'
      ORDER BY o.updated,o.id`).all(subjectId,targetId) as unknown as
      {id:string;body:string;host_message_id:string;updated:number;result_code:string;quiet_exception:number}[];
    return rows.map(row=>({deliveryId:row.id,subjectId,targetId,body:row.body,hostMessageId:row.host_message_id,
      confirmedSentAtMs:row.updated,replyTimingKnown:row.result_code!=='sent_time_unknown',quietException:Boolean(row.quiet_exception)}));
  }

  /**
   * The seed each host-confirmed send expressed, resolved delivery -> opportunity through getDelivery and getOpportunity
   * (so an instance override is seen): the row's stored seed kind, or for a row written before M3 the seed its kind and
   * basis express (opportunitySeedKind). A send carries `connection` when its text recorded the F_c it was queued from
   * (M3-5 item 9). A send whose opportunity row is gone, or whose row expresses nothing, releases nothing. The one reading
   * of the release inputs for the scene projection and the pressure context.
   */
  expressionReliefSends(confirmed:readonly ConfirmedContactDelivery[]):ExpressionReliefSend[] {
    return confirmed.flatMap(item=>{
      const delivery=this.getDelivery(item.deliveryId);
      const opportunity=delivery?this.getOpportunity(delivery.opportunityId):null;
      const kind=opportunity?opportunitySeedKind(opportunity):null;
      if(!kind)return [];
      const connection=delivery?.reliefConnection;
      return [{atMs:item.confirmedSentAtMs,kind,...(connection===undefined?{}:{connection})}];
    });
  }

  /** When the latest proactive message to this one target was confirmed sent, or null. */
  lastConfirmedSendAt(subjectId:string,targetId:string):number|null {
    subjectId=id(subjectId);targetId=id(targetId);
    return (this.db.prepare(`SELECT MAX(updated) AS at FROM companion_outbox WHERE subject=? AND target=? AND status='host_committed'`)
      .get(subjectId,targetId) as {at:number|null}).at;
  }

  /** When the latest drive delivery to this one target failed at the host, or null. */
  lastDriveFailureAt(subjectId:string,targetId:string):number|null {
    subjectId=id(subjectId);targetId=id(targetId);
    return (this.db.prepare(`SELECT MAX(o.updated) AS at FROM companion_outbox o JOIN companion_opportunities p ON p.id=o.opportunity_id
      WHERE o.subject=? AND o.target=? AND o.status='failed' AND p.kind='drive'`).get(subjectId,targetId) as {at:number|null}).at;
  }

  /**
   * Times after `sinceMs` at which a pending drive occurrence of this target was closed before a confirmed send: a failed
   * host delivery, or a cancellation before the host took the text (expired text, a hard window starting). Ascending and
   * distinct; the caller folds a bounded prefix into the episode identity.
   */
  driveReopenTimes(subjectId:string,targetId:string,sinceMs:number):number[] {
    subjectId=id(subjectId);targetId=id(targetId);if(!Number.isSafeInteger(sinceMs))throw new Error('invalid_companion_time');
    return (this.db.prepare(`SELECT at FROM companion_drive_reopens WHERE subject=? AND target=? AND at>?
      AND reason<>'pressure_delivery_failed' UNION SELECT o.updated AS at FROM companion_outbox o JOIN companion_opportunities p ON p.id=o.opportunity_id
      WHERE o.subject=? AND o.target=? AND o.status='failed' AND p.kind='drive' AND o.updated>? ORDER BY at`)
      .all(subjectId,targetId,sinceMs,subjectId,targetId,sinceMs) as {at:number}[]).map(row=>row.at);
  }

  /**
   * Whether this target has a pressure occurrence (one materialized by the hazard) that a check may still judge or send:
   * waiting, deferred, being judged, or approved within its lifetime, on the current revisions, and not closed (an
   * approved row whose host send failed is finished). While one is pending the hazard is zero (M3: at most one open
   * pressure occurrence per target). An `unknown` send keeps its row pending.
   */
  pressureOccurrencePending(subjectId:string,targetId:string,nowMs=Date.now()):boolean {
    subjectId=id(subjectId);targetId=id(targetId);nowMs=time(nowMs);
    const controls=readProfileControls(this.db,subjectId),contact=this.contactSettings(subjectId),activity=this.activity(subjectId);
    return Boolean(this.db.prepare(`SELECT 1 FROM companion_opportunities WHERE subject=? AND target=? AND pressure IS NOT NULL
      AND (status IN ('waiting','deferred','evaluating') OR (status='approved' AND expires_at>=?)) AND controls_revision=?
      AND contact_revision=? AND profile_revision=? AND activity_revision=?
      AND occurrence_id NOT IN (SELECT occurrence_id FROM companion_drive_reopens WHERE subject=? AND target=?) LIMIT 1`)
      .get(subjectId,targetId,nowMs,controls.revision,contact.revision,this.profileRevision(subjectId),activity.revision,subjectId,targetId));
  }

  /** A drive occurrence closed by a reopen event is never rebuilt; only a new episode identity can follow it. */
  driveOccurrenceClosed(occurrenceId:string):boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM companion_drive_reopens WHERE occurrence_id=?').get(id(occurrenceId)));
  }

  /**
   * Why an occurrence was closed (a reopen event, or `pressure_delivery_failed` for a pressure seed whose send failed or
   * whose ready text lapsed unchanged), or null while it is not closed.
   */
  occurrenceClosedReason(occurrenceId:string):string|null {
    const row=this.db.prepare('SELECT reason FROM companion_drive_reopens WHERE occurrence_id=?').get(id(occurrenceId)) as {reason:string}|undefined;
    return row?.reason??null;
  }

  /** Occurrence identity used by schedule(); a caller can look up an occurrence before deciding to materialize it. */
  latestOccurrence(subjectId:string,targetId:string,opportunityKey:string,kind:CompanionOpportunity['kind']):CompanionOpportunity|null {
    subjectId=id(subjectId);targetId=id(targetId);opportunityKey=id(opportunityKey);
    const row=this.db.prepare('SELECT * FROM companion_opportunities WHERE occurrence_id=? ORDER BY created DESC,rowid DESC LIMIT 1')
      .get(hash([subjectId,targetId,opportunityKey,kind])) as OpportunityRow|undefined;
    return row?opportunityOf(row):null;
  }

  judgment(occurrenceId:string):CompanionJudgment|null {
    const row=this.judgmentRow(id(occurrenceId));
    return row?{occurrenceId:row.occurrence_id,subjectId:row.subject,targetId:row.target,lastChoice:row.last_choice,
      lastFingerprint:row.last_fingerprint,pressureMarker:row.pressure_marker?JSON.parse(row.pressure_marker) as DriveMarker:null,
      nextCheckAtMs:row.next_check,updatedAtMs:row.updated,seedKey:row.seed_key??null,seedKind:row.seed_kind??null,
      generation:row.generation??null,pressureAtDecision:row.pressure_at_decision??null}:null;
  }

  /** When the latest skip of a pressure occurrence of this target was decided (it starts a new hazard epoch), or null. */
  lastPressureSkipAt(subjectId:string,targetId:string):number|null {
    subjectId=id(subjectId);targetId=id(targetId);
    return (this.db.prepare(`SELECT MAX(updated) AS at FROM companion_judgments WHERE subject=? AND target=? AND last_choice='skip'
      AND seed_key IS NOT NULL`).get(subjectId,targetId) as {at:number|null}).at;
  }

  /** When the user last paused or resumed contact with this target (user_model_contact_pauses), or null. */
  contactPauseChangedAt(subjectId:string,targetId:string):number|null {
    const row=this.db.prepare('SELECT updated FROM user_model_contact_pauses WHERE subject=? AND target=?')
      .get(id(subjectId),text(targetId,500)) as {updated:number}|undefined;
    return row?.updated??null;
  }

  /** When the user's busy time was last set, changed or cleared through setBusyUntil, or null. */
  busyChangedAt(subjectId:string):number|null {
    const row=this.db.prepare('SELECT updated FROM companion_busy_changes WHERE subject=?').get(id(subjectId)) as {updated:number}|undefined;
    return row?.updated??null;
  }

  /** The contact tendency of one companion: the stored row, or the defaults (origin `default`, revision 0). */
  contactTendency(subjectId:string,targetId:string):ContactTendencySettings {
    subjectId=id(subjectId);targetId=id(targetId);
    const row=this.db.prepare('SELECT * FROM companion_tendencies WHERE subject=? AND target=?').get(subjectId,targetId) as TendencyRow|undefined;
    const defaults=PRESSURE_DEFAULTS.tendency;
    if(!row)return {subjectId,targetId,disposition:Object.fromEntries(DISPOSITION_KEYS.map(key=>[key,defaults[key].value])) as
      unknown as ContactTendencyDisposition,openness:defaults.openness.value,receptivity:true,origin:'default',revision:0,updatedAtMs:0};
    return {subjectId,targetId,disposition:JSON.parse(row.disposition) as ContactTendencyDisposition,openness:row.openness,
      receptivity:row.receptivity===1,origin:row.origin,revision:row.revision,updatedAtMs:row.updated};
  }

  /**
   * Writes the contact tendency of one companion. Only the SDK/CLI workspace operation (`workspace`) and initialization
   * (`init`) call this; no conversation, decoder, reply or correction path does. An unknown key, a non-finite or an
   * out-of-bounds value is rejected (`invalid_contact_tendency`), never clamped; a stale revision is `context_changed_retry`.
   */
  setContactTendency(subjectId:string,targetId:string,patch:{disposition?:Partial<ContactTendencyDisposition>;openness?:number;receptivity?:boolean},
    expectedRevision:number,origin:'init'|'workspace',nowMs=Date.now()):ContactTendencySettings {
    subjectId=id(subjectId);targetId=id(targetId);assertRevision(expectedRevision);nowMs=time(nowMs);
    if(origin!=='init'&&origin!=='workspace')throw new Error('invalid_contact_tendency');
    if(!patch||typeof patch!=='object'||Array.isArray(patch)||Object.keys(patch).some(key=>!['disposition','openness','receptivity'].includes(key))||
      (patch.disposition===undefined&&patch.openness===undefined&&patch.receptivity===undefined))throw new Error('invalid_contact_tendency');
    if(patch.disposition!==undefined&&(!patch.disposition||typeof patch.disposition!=='object'||Array.isArray(patch.disposition)||
      Object.keys(patch.disposition).some(key=>!DISPOSITION_KEYS.includes(key as keyof ContactTendencyDisposition))))
      throw new Error('invalid_contact_tendency');
    if(patch.receptivity!==undefined&&typeof patch.receptivity!=='boolean')throw new Error('invalid_contact_tendency');
    return this.transaction(()=>{
      const current=this.contactTendency(subjectId,targetId);
      if(current.revision!==expectedRevision)throw new Error('context_changed_retry');
      const disposition={...current.disposition,...patch.disposition};
      const openness=patch.openness??current.openness;
      try{resolveTendency({...disposition,openness});}catch{throw new Error('invalid_contact_tendency');}
      const next:ContactTendencySettings={subjectId,targetId,disposition:Object.fromEntries(DISPOSITION_KEYS.map(key=>[key,disposition[key]])) as
        unknown as ContactTendencyDisposition,openness,receptivity:patch.receptivity??current.receptivity,origin,revision:current.revision+1,updatedAtMs:nowMs};
      this.db.prepare(`INSERT INTO companion_tendencies(subject,target,disposition,openness,receptivity,origin,revision,updated) VALUES(?,?,?,?,?,?,?,?)
        ON CONFLICT(subject,target) DO UPDATE SET disposition=excluded.disposition,openness=excluded.openness,receptivity=excluded.receptivity,
        origin=excluded.origin,revision=excluded.revision,updated=excluded.updated`)
        .run(subjectId,targetId,JSON.stringify(next.disposition),openness,next.receptivity?1:0,origin,next.revision,nowMs);
      return next;
    });
  }

  /** The per-target drive hysteresis marker (stored as the pressure marker of a synthetic judgment row). */
  driveMarker(subjectId:string,targetId:string):DriveMarker|null {
    const row=this.judgmentRow(driveMarkerId(id(subjectId),id(targetId)));
    return row?.pressure_marker?JSON.parse(row.pressure_marker) as DriveMarker:null;
  }

  setDriveMarker(subjectId:string,targetId:string,marker:DriveMarker,nowMs=Date.now()):void {
    subjectId=id(subjectId);targetId=id(targetId);const value=validateMarker(marker);nowMs=time(nowMs);
    this.transaction(()=>this.writeDriveMarker(subjectId,targetId,value,nowMs));
  }

  /**
   * The seeded send roll of one window-end occurrence (`opportunityKey` is its `window_end:` key), or null before it was
   * rolled. It is kept in the judgment memory as a synthetic occurrence row (like the drive marker): last_choice holds the
   * decision and last_fingerprint the roll.
   */
  windowEndRoll(subjectId:string,targetId:string,opportunityKey:string):WindowEndRoll|null {
    const row=this.judgmentRow(windowEndRollId(id(subjectId),id(targetId),id(opportunityKey)));
    return row?.last_fingerprint?JSON.parse(row.last_fingerprint) as WindowEndRoll:null;
  }

  /**
   * Records the roll of a window-end occurrence once: the first write wins and is returned, so a retry or a repeated poll
   * never rolls again. A skip also writes one `window_end_roll` poll diagnostic naming the occurrence with its p and u (a
   * judgment, never an error), and its reason when it has one. A roll without the M3-5 fields is stored exactly as before;
   * each M3-5 field is validated when present (see WindowEndRoll), and the `topic` tone requires its topicBasis.
   */
  recordWindowEndRoll(subjectId:string,targetId:string,opportunityKey:string,roll:WindowEndRoll,nowMs=Date.now()):WindowEndRoll {
    subjectId=id(subjectId);targetId=id(targetId);opportunityKey=id(opportunityKey);nowMs=time(nowMs);
    const unit=(value:unknown)=>typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=1;
    if(!roll||roll.kind!=='window_end_roll'||!['send','skip'].includes(roll.decision)||!unit(roll.p)||!unit(roll.u)||roll.u===1||
      !(WINDOW_END_TONES as readonly string[]).includes(roll.tone)||!Number.isSafeInteger(roll.quietMs)||roll.quietMs<0||
      typeof roll.driveOpen!=='boolean')throw new Error('invalid_companion_value');
    const value:WindowEndRoll={kind:'window_end_roll',decision:roll.decision,p:roll.p,u:roll.u,tone:roll.tone,quietMs:roll.quietMs,
      driveOpen:roll.driveOpen,decidedAtMs:time(roll.decidedAtMs),
      ...(roll.instanceEndMs===undefined?{}:{instanceEndMs:time(roll.instanceEndMs)}),windowKey:opportunityKey,
      ...windowEndRollExtras(roll)};
    return this.transaction(()=>{
      const occurrence=windowEndRollId(subjectId,targetId,opportunityKey),existing=this.judgmentRow(occurrence);
      if(existing?.last_fingerprint)return JSON.parse(existing.last_fingerprint) as WindowEndRoll;
      this.db.prepare(`INSERT INTO companion_judgments(occurrence_id,subject,target,last_choice,last_fingerprint,pressure_marker,next_check,updated)
        VALUES(?,?,?,?,?,NULL,NULL,?) ON CONFLICT(occurrence_id) DO UPDATE SET last_choice=excluded.last_choice,
        last_fingerprint=excluded.last_fingerprint,updated=excluded.updated`)
        .run(occurrence,subjectId,targetId,value.decision,JSON.stringify(value),nowMs);
      if(value.decision==='skip')this.recordPollDiagnostic(subjectId,targetId,'window_end_roll',
        {occurrenceId:hash([subjectId,targetId,opportunityKey,'window_end']),stage:'window_end_roll',code:'skip',
          p:value.p,u:value.u,tone:value.tone,quietMs:value.quietMs,driveOpen:value.driveOpen,
          ...(value.reason===undefined?{}:{reason:value.reason})},nowMs);
      return value;
    });
  }

  /**
   * The latest recorded window-end rolls of this target, newest first, at most `limit` (the companionStatus view): a skipped
   * window end leaves no opportunity row, so this is where a host or the user can see it was rolled and skipped.
   */
  windowEndRolls(subjectId:string,targetId:string,limit=5):WindowEndRollView[] {
    subjectId=id(subjectId);targetId=id(targetId);
    if(!Number.isSafeInteger(limit)||limit<1||limit>50)throw new Error('invalid_companion_value');
    const rows=this.db.prepare(`SELECT last_fingerprint,updated FROM companion_judgments WHERE subject=? AND target=?
      AND instr(last_fingerprint,'{"kind":"window_end_roll"')=1 ORDER BY updated DESC,rowid DESC LIMIT ?`)
      .all(subjectId,targetId,limit) as {last_fingerprint:string;updated:number}[];
    return rows.map(row=>{
      const roll=JSON.parse(row.last_fingerprint) as WindowEndRoll;
      return {windowKey:roll.windowKey??null,instanceEndMs:roll.instanceEndMs??null,p:roll.p,u:roll.u,decision:roll.decision,
        recordedAtMs:row.updated,...(roll.sendAtMs===undefined?{}:{sendAtMs:roll.sendAtMs}),
        ...(roll.reason===undefined?{}:{reason:roll.reason})};
    });
  }

  /** Deferred rows whose last judgment used other substantive inputs are due now (invalidateOn), not at their fallback. */
  /**
   * Makes deferred rows whose stored judgment fingerprint differs from the current one due now. A pressure occurrence (a
   * row with a pressure record) is compared with `pressureFingerprint` (the flow counts a soft window for it until the
   * grid point after its end), every other row with `fingerprint`.
   */
  reviveDeferred(subjectId:string,targetId:string,fingerprint:string,nowMs=Date.now(),pressureFingerprint=fingerprint):number {
    subjectId=id(subjectId);targetId=id(targetId);fingerprint=text(fingerprint,2000);nowMs=time(nowMs);
    pressureFingerprint=text(pressureFingerprint,2000);
    return this.transaction(()=>Number(this.db.prepare(`UPDATE companion_opportunities SET check_at=?,updated=?
      WHERE subject=? AND target=? AND status='deferred' AND check_at>? AND occurrence_id IN (SELECT occurrence_id FROM companion_judgments
        WHERE subject=? AND target=? AND last_fingerprint IS NOT NULL AND
          last_fingerprint<>(CASE WHEN companion_opportunities.pressure IS NULL THEN ? ELSE ? END))`)
      .run(nowMs,nowMs,subjectId,targetId,nowMs,subjectId,targetId,fingerprint,pressureFingerprint).changes));
  }

  guardSettings(subjectId:string):GuardSettings {
    subjectId=id(subjectId);
    const rows=new Map((this.db.prepare('SELECT * FROM companion_guard_settings WHERE subject=?').all(subjectId) as unknown as GuardSettingRow[])
      .map(row=>[row.key,row] as const));
    const setting=<K extends GuardKey>(key:K):GuardSetting<K>=>{
      const row=rows.get(key);
      return row?{enabled:Boolean(row.enabled),value:JSON.parse(row.value) as GuardValues[K],revision:row.revision,updatedAtMs:row.updated}:
        {enabled:true,value:{...GUARD_DEFAULTS[key]},revision:0,updatedAtMs:0};
    };
    return {G1:setting('G1'),G2:setting('G2'),G3:setting('G3')};
  }

  setGuardSetting<K extends GuardKey>(subjectId:string,key:K,patch:{enabled?:boolean;value?:GuardValues[K]},expectedRevision:number,
    nowMs=Date.now()):GuardSetting<K> {
    subjectId=id(subjectId);assertRevision(expectedRevision);nowMs=time(nowMs);
    if(!GUARD_KEYS.includes(key)||!patch||typeof patch!=='object'||(patch.enabled===undefined&&patch.value===undefined)||
      (patch.enabled!==undefined&&typeof patch.enabled!=='boolean'))throw new Error('invalid_guard_setting');
    const value=patch.value===undefined?undefined:validateGuardValue(key,patch.value);
    return this.transaction(()=>{
      const current=this.guardSettings(subjectId)[key] as GuardSetting<K>;
      if(current.revision!==expectedRevision)throw new Error('context_changed_retry');
      const next:GuardSetting<K>={enabled:patch.enabled??current.enabled,value:value??current.value,revision:current.revision+1,updatedAtMs:nowMs};
      this.db.prepare(`INSERT INTO companion_guard_settings(subject,key,enabled,value,revision,updated) VALUES(?,?,?,?,?,?)
        ON CONFLICT(subject,key) DO UPDATE SET enabled=excluded.enabled,value=excluded.value,revision=excluded.revision,updated=excluded.updated`)
        .run(subjectId,key,next.enabled?1:0,JSON.stringify(next.value),next.revision,nowMs);
      return next;
    });
  }

  /**
   * G1: at least `count` confirmed sends to this target within the window and no user activity since then; it stays
   * tripped until the user is active again. G2: at most `count` confirmed sends within the window without user activity.
   * A trip is recorded once in companion_guard_events. Legacy minimum_interval/max_unanswered are not read.
   */
  contactGuard(subjectId:string,targetId:string,nowMs=Date.now()):GuardBlock|null {
    subjectId=id(subjectId);targetId=id(targetId);nowMs=time(nowMs);
    return this.transaction(()=>{
      const settings=this.guardSettings(subjectId),activity=this.activity(subjectId),since=activity.lastUserActivityAtMs??-1;
      const sends=(windowMs:number)=>this.db.prepare(`SELECT id,updated FROM companion_outbox WHERE subject=? AND target=?
        AND status='host_committed' AND updated>? AND updated<=? ORDER BY updated,id`)
        .all(subjectId,targetId,Math.max(since,nowMs-windowMs),nowMs) as {id:string;updated:number}[];
      if(settings.G1.enabled){
        const latch=`user:${activity.lastUserActivityAtMs??'none'}`;
        if(this.hasGuardEvent(subjectId,targetId,'G1',latch))return {guard:'G1',untilMs:null};
        const recent=sends(settings.G1.value.windowMinutes*60_000);
        if(recent.length>=settings.G1.value.count){
          this.recordGuardEvent(subjectId,targetId,'G1',latch,{count:recent.length,windowMinutes:settings.G1.value.windowMinutes,
            firstSentAtMs:recent[0]!.updated,lastUserActivityAtMs:activity.lastUserActivityAtMs},nowMs);
          return {guard:'G1',untilMs:null};
        }
      }
      if(settings.G2.enabled){
        const windowMs=settings.G2.value.windowMinutes*60_000,limit=settings.G2.value.count,recent=sends(windowMs);
        if(recent.length>=limit){
          const anchor=recent[recent.length-limit]!,untilMs=anchor.updated+windowMs;
          this.recordGuardEvent(subjectId,targetId,'G2',`from:${anchor.id}`,{count:recent.length,
            windowMinutes:settings.G2.value.windowMinutes,untilMs},nowMs);
          return {guard:'G2',untilMs};
        }
      }
      return null;
    });
  }

  /** G3: contact-class provider evaluations per subject and clock hour; `needed` is how many this judgment will use. */
  evaluationBudget(subjectId:string,targetId:string,needed:number,nowMs=Date.now()):{allowed:true}|{allowed:false;untilMs:number} {
    subjectId=id(subjectId);targetId=id(targetId);nowMs=time(nowMs);
    if(!Number.isSafeInteger(needed)||needed<1||needed>10)throw new Error('invalid_companion_value');
    return this.transaction(()=>{
      const setting=this.guardSettings(subjectId).G3;if(!setting.enabled)return {allowed:true} as const;
      const hourStart=Math.floor(nowMs/3_600_000)*3_600_000,untilMs=hourStart+3_600_000;
      const count=(this.db.prepare('SELECT COUNT(*) AS count FROM companion_contact_evaluations WHERE subject=? AND at>=? AND at<?')
        .get(subjectId,hourStart,untilMs) as {count:number}).count;
      if(count+needed<=setting.value.perHour)return {allowed:true} as const;
      this.recordGuardEvent(subjectId,targetId,'G3',`hour:${hourStart}`,{count,perHour:setting.value.perHour,untilMs},nowMs);
      return {allowed:false,untilMs} as const;
    });
  }

  recordEvaluation(subjectId:string,targetId:string,occurrenceId:string,kind:'contact'|'quiet_exception'|'host',nowMs=Date.now()):void {
    subjectId=id(subjectId);targetId=id(targetId);occurrenceId=id(occurrenceId);nowMs=time(nowMs);
    if(!['contact','quiet_exception','host'].includes(kind))throw new Error('invalid_companion_value');
    this.transaction(()=>{
      this.db.prepare('INSERT INTO companion_contact_evaluations(subject,target,occurrence_id,kind,at) VALUES(?,?,?,?,?)')
        .run(subjectId,targetId,occurrenceId,kind,nowMs);
      this.db.prepare('DELETE FROM companion_contact_evaluations WHERE subject=? AND at<?').run(subjectId,nowMs-7*86_400_000);
    });
  }

  guardEvents(subjectId:string,targetId?:string):GuardEvent[] {
    subjectId=id(subjectId);
    const rows=(targetId===undefined?this.db.prepare('SELECT * FROM companion_guard_events WHERE subject=? ORDER BY created,rowid').all(subjectId):
      this.db.prepare('SELECT * FROM companion_guard_events WHERE subject=? AND target=? ORDER BY created,rowid').all(subjectId,id(targetId))) as unknown as
      {subject:string;target:string;guard:GuardKey;event_key:string;detail:string;created:number}[];
    return rows.map(row=>({subjectId:row.subject,targetId:row.target,guard:row.guard,eventKey:row.event_key,
      detail:JSON.parse(row.detail) as Record<string,unknown>,createdAtMs:row.created}));
  }

  /**
   * One diagnostics row per poll stall cause (for `source_processing_failed`: per failed source revision, stage and error
   * code); repeated polls on the same stall write nothing more.
   */
  recordPollDiagnostic(subjectId:string,targetId:string,reason:string,
    detail:{sourceId?:string;occurrenceId?:string;revision?:number;stage:string|null;code:string;[extra:string]:unknown},nowMs=Date.now()):void {
    const eventKey=JSON.stringify([detail.sourceId??detail.occurrenceId??null,detail.revision??null,detail.stage,detail.code]);
    this.db.prepare('INSERT OR IGNORE INTO companion_poll_diagnostics(subject,target,reason,event_key,detail,created) VALUES(?,?,?,?,?,?)')
      .run(id(subjectId),id(targetId),reason,eventKey,JSON.stringify(detail),nowMs);
  }
  /**
   * Drops `source_processing_failed` rows of sources that are no longer stalled (ready again, or gone: not among
   * `unresolvedSourceIds`) and any row older than seven days, like companion_contact_evaluations.
   */
  prunePollDiagnostics(subjectId:string,targetId:string,unresolvedSourceIds:readonly string[],nowMs=Date.now()):void {
    subjectId=id(subjectId);targetId=id(targetId);
    if(!this.db.prepare('SELECT 1 FROM companion_poll_diagnostics WHERE subject=? AND target=? LIMIT 1').get(subjectId,targetId))return;
    this.db.prepare(`DELETE FROM companion_poll_diagnostics WHERE subject=? AND target=? AND
      (created<? OR (reason='source_processing_failed' AND json_extract(event_key,'$[0]') NOT IN (SELECT value FROM json_each(?))))`)
      .run(subjectId,targetId,nowMs-7*86_400_000,JSON.stringify([...new Set(unresolvedSourceIds)]));
  }
  pollDiagnostics(subjectId:string,targetId?:string):{subjectId:string;targetId:string;reason:string;detail:Record<string,unknown>;createdAtMs:number}[] {
    const rows=(targetId===undefined?this.db.prepare('SELECT * FROM companion_poll_diagnostics WHERE subject=? ORDER BY created,rowid').all(id(subjectId)):
      this.db.prepare('SELECT * FROM companion_poll_diagnostics WHERE subject=? AND target=? ORDER BY created,rowid').all(id(subjectId),id(targetId))) as unknown as
      {subject:string;target:string;reason:string;detail:string;created:number}[];
    return rows.map(row=>({subjectId:row.subject,targetId:row.target,reason:row.reason,
      detail:JSON.parse(row.detail) as Record<string,unknown>,createdAtMs:row.created}));
  }

  private finishDelivery(row:DeliveryRow,outcome:{status:'sent';hostMessageId:string}|{status:'failed'|'unknown';code:string},nowMs:number):CompanionDelivery {
    if(outcome.status==='sent') {
      const hostMessageId=id(outcome.hostMessageId);
      this.db.prepare(`UPDATE companion_outbox SET status='host_committed',claim_token=NULL,claim_until=NULL,host_message_id=?,result_code=?,updated=? WHERE id=?`)
        .run(hostMessageId,row.status==='unknown'?'sent_time_unknown':'sent',nowMs,row.id);
      this.consumeQuietExceptions(row.id,nowMs);
      this.db.prepare("UPDATE companion_opportunities SET status='consumed',updated=? WHERE id=?").run(nowMs,row.opportunity_id);
      // Only a confirmed pressure contact (drive, recall, follow-up), or the longing sent when a hard window ends, locks the
      // contact hysteresis; a wait, skip or failed send never does, and a reminder keeps a promise without expressing a seed.
      const opportunity=this.opportunityRow(row.opportunity_id);
      if(opportunity&&['drive','window_end','recall','experience'].includes(opportunity.kind)){
        const waiting=(JSON.parse(opportunity.basis) as CompanionBasis[])
          .find(item=>item.kind==='drive'&&item.id.startsWith('waiting:'))?.id.slice('waiting:'.length);
        this.writeDriveMarker(row.subject,row.target,{fired:true,episode:waiting||this.driveMarker(row.subject,row.target)?.episode||null},nowMs);
      }
      const activity=this.activity(row.subject),revision=activity.revision+1;
      this.writeActivity({...activity,revision,semanticReadyRevision:revision,unansweredCount:activity.unansweredCount+1,lastSentAtMs:nowMs});
      const enabled=readProfileControls(this.db,row.subject).proactiveCompanionEnabled;
      this.writeState(row.subject,row.target,enabled?'awaiting_reply':'disabled',row.opportunity_id,'host_committed',null,nowMs);
    } else {
      const code=id(outcome.code),status=outcome.status==='unknown'?'unknown':'failed';
      this.db.prepare('UPDATE companion_outbox SET status=?,claim_token=NULL,claim_until=NULL,result_code=?,updated=? WHERE id=?')
        .run(status,code,nowMs,row.id);
      if(status==='unknown')this.consumeQuietExceptions(row.id,nowMs);
      else this.releaseQuietExceptions(row.id,nowMs);
      // A failed drive send must not hold its episode: the row is cancelled, its send judgment forgotten and its occurrence
      // closed, and the failure time enters the episode identity (driveReopenTimes, at most two per episode), so the next
      // poll may materialize and judge it once more. A stored wait or skip is kept. Follow-ups, reminders and window-end
      // contacts keep their row and are not retried automatically; a recall or follow-up pressure occurrence is still
      // closed (reason `pressure_delivery_failed`, which never enters the drive episode identity), so its approved row no
      // longer holds the hazard (the flow lets a failed recall open its next generation at most DRIVE_REOPEN_LIMIT times).
      // An `unknown` outcome finishes nothing.
      const opportunity=status==='failed'?this.opportunityRow(row.opportunity_id):undefined;
      const pressureSeed=opportunity!==undefined&&opportunity.pressure!==null&&['recall','experience'].includes(opportunity.kind);
      if(opportunity&&(opportunity.kind==='drive'||pressureSeed))this.db.prepare(`INSERT OR IGNORE INTO companion_drive_reopens(occurrence_id,subject,target,reason,at)
        VALUES(?,?,?,?,?)`).run(opportunity.occurrence_id,row.subject,row.target,pressureSeed?'pressure_delivery_failed':'delivery_failed',nowMs);
      if(opportunity?.kind==='drive'&&['waiting','deferred','evaluating','approved'].includes(opportunity.status)){
        this.db.prepare("UPDATE companion_opportunities SET status='cancelled',claim_token=NULL,claim_until=NULL,updated=? WHERE id=?")
          .run(nowMs,opportunity.id);
        this.db.prepare(`UPDATE companion_judgments SET last_choice=NULL,last_fingerprint=NULL,next_check=NULL,updated=?
          WHERE occurrence_id=? AND last_choice='send'`).run(nowMs,opportunity.occurrence_id);
      }
      this.writeState(row.subject,row.target,status==='unknown'?'suspended':'cooldown',row.opportunity_id,code,null,nowMs);
    }
    return deliveryOf(this.deliveryRow(row.id)!);
  }

  private assertOpportunityCurrent(row:OpportunityRow,currentSourceVersion:number,nowMs:number):void {
    const controls=readProfileControls(this.db,row.subject),contact=this.contactSettings(row.subject),activity=this.activity(row.subject);
    if(!controls.proactiveCompanionEnabled)throw new Error('proactive_companion_disabled');
    if(row.source_version!==currentSourceVersion||row.profile_revision!==this.profileRevision(row.subject)||row.activity_revision!==activity.revision||
      row.controls_revision!==controls.revision||row.contact_revision!==contact.revision)throw new Error('context_changed_retry');
    if(activity.semanticReadyRevision!==activity.revision)throw new Error('companion_semantic_pending');
    if((activity.busyUntilMs??0)>nowMs)throw new Error('companion_busy');
  }
  private assertDeliveryCurrent(row:DeliveryRow,currentSourceVersion:number,nowMs:number):void {
    const opportunity=this.opportunityRow(row.opportunity_id);if(!opportunity)throw new Error('companion_opportunity_not_found');
    this.assertOpportunityCurrent(opportunity,currentSourceVersion,nowMs);
    if(nowMs>opportunity.window_end||nowMs>opportunity.expires_at)throw new Error('companion_delivery_expired');
    if(row.source_version!==opportunity.source_version||row.profile_revision!==opportunity.profile_revision||
      row.activity_revision!==opportunity.activity_revision||row.controls_revision!==opportunity.controls_revision||row.contact_revision!==opportunity.contact_revision)
      throw new Error('context_changed_retry');
  }
  private assertClaim(row:OpportunityRow,claimToken:string,nowMs:number):void {
    if(row.status!=='evaluating'||row.claim_token!==claimToken)throw new Error('companion_claim_mismatch');
    if((row.claim_until??0)<nowMs)throw new Error('companion_claim_expired');
  }
  private dismissExpired(row:OpportunityRow,nowMs:number):void {
    this.db.prepare("UPDATE companion_opportunities SET status='dismissed',decision='dismiss',claim_token=NULL,claim_until=NULL,updated=? WHERE id=?")
      .run(nowMs,row.id);this.writeState(row.subject,row.target,'cooldown',row.id,'window_expired',null,nowMs);
  }
  private cancelUnsent(subjectId:string,reason:string,nowMs:number):void {
    this.db.prepare(`UPDATE companion_opportunities SET status='cancelled',claim_token=NULL,claim_until=NULL,updated=?
      WHERE subject=? AND status IN ('waiting','deferred','evaluating','approved')`).run(nowMs,subjectId);
    this.db.prepare(`UPDATE companion_outbox SET status='cancelled',claim_token=NULL,claim_until=NULL,result_code=?,updated=?
      WHERE subject=? AND status IN ('draft','ready')`).run(reason,nowMs,subjectId);
    this.releaseCancelledQuietExceptions(subjectId,nowMs);
  }
  private consumeQuietExceptions(deliveryId:string,nowMs:number):void {
    this.db.prepare("UPDATE companion_quiet_exceptions SET status='consumed',updated=? WHERE delivery_id=? AND status='reserved'")
      .run(nowMs,deliveryId);
  }
  private releaseQuietExceptions(deliveryId:string,nowMs:number):void {
    this.db.prepare("UPDATE companion_quiet_exceptions SET status='released',updated=? WHERE delivery_id=? AND status IN ('reserved','consumed')")
      .run(nowMs,deliveryId);
  }
  private releaseCancelledQuietExceptions(subjectId:string,nowMs:number):void {
    this.db.prepare(`UPDATE companion_quiet_exceptions SET status='released',updated=? WHERE subject=? AND status='reserved'
      AND delivery_id IN (SELECT id FROM companion_outbox WHERE status='cancelled')`).run(nowMs,subjectId);
  }
  private hasUnknown(subjectId:string):boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM companion_outbox WHERE subject=? AND status IN ('sending','unknown') LIMIT 1").get(subjectId));
  }
  private hasUncertainDelivery(subjectId:string,targetId:string):boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM companion_outbox WHERE subject=? AND target=? AND status IN ('sending','unknown') LIMIT 1").get(subjectId,targetId));
  }
  private profileRevision(subjectId:string):number {
    return (this.db.prepare('SELECT revision FROM user_profile_state WHERE subject=?').get(subjectId) as {revision:number}|undefined)?.revision??0;
  }
  private writeActivity(value:CompanionActivity):void {
    this.db.prepare(`INSERT INTO companion_activity VALUES(?,?,?,?,?,?,?) ON CONFLICT(subject) DO UPDATE SET revision=excluded.revision,
      semantic_ready_revision=excluded.semantic_ready_revision,last_user_activity=excluded.last_user_activity,busy_until=excluded.busy_until,
      unanswered_count=excluded.unanswered_count,last_sent=excluded.last_sent`)
      .run(value.subjectId,value.revision,value.semanticReadyRevision,value.lastUserActivityAtMs,value.busyUntilMs,value.unansweredCount,value.lastSentAtMs);
  }
  private writeState(subjectId:string,targetId:string,state:CompanionState,opportunityId:string|null,reason:string|null,nextCheck:number|null,nowMs:number):void {
    this.db.prepare(`INSERT INTO companion_state(subject,target,state,revision,opportunity_id,reason,next_check,updated) VALUES(?,?,?,1,?,?,?,?)
      ON CONFLICT(subject,target) DO UPDATE SET state=excluded.state,revision=companion_state.revision+1,
      opportunity_id=excluded.opportunity_id,reason=excluded.reason,next_check=excluded.next_check,updated=excluded.updated`)
      .run(subjectId,targetId,state,opportunityId,reason,nextCheck,nowMs);
  }
  private judgmentRow(occurrenceId:string):JudgmentRow|undefined {
    return this.db.prepare('SELECT * FROM companion_judgments WHERE occurrence_id=?').get(occurrenceId) as JudgmentRow|undefined;
  }
  private writeJudgment(row:OpportunityRow,judgment:JudgmentInput,nextCheck:number|null,nowMs:number):void {
    this.db.prepare(`INSERT INTO companion_judgments(occurrence_id,subject,target,last_choice,last_fingerprint,pressure_marker,next_check,updated,
      seed_key,seed_kind,generation,pressure_at_decision)
      VALUES(?,?,?,?,?,NULL,?,?,?,?,?,?) ON CONFLICT(occurrence_id) DO UPDATE SET last_choice=excluded.last_choice,
      last_fingerprint=excluded.last_fingerprint,next_check=excluded.next_check,updated=excluded.updated,seed_key=excluded.seed_key,
      seed_kind=excluded.seed_kind,generation=excluded.generation,pressure_at_decision=excluded.pressure_at_decision`)
      .run(row.occurrence_id,row.subject,row.target,judgment.choice,judgment.fingerprint,nextCheck,nowMs,judgment.seedKey??null,
        judgment.seedKind??null,judgment.generation??null,judgment.pressureAtDecision??null);
  }
  private writeDriveMarker(subjectId:string,targetId:string,marker:DriveMarker,nowMs:number):void {
    this.db.prepare(`INSERT INTO companion_judgments(occurrence_id,subject,target,last_choice,last_fingerprint,pressure_marker,next_check,updated)
      VALUES(?,?,?,NULL,NULL,?,NULL,?) ON CONFLICT(occurrence_id) DO UPDATE SET pressure_marker=excluded.pressure_marker,updated=excluded.updated`)
      .run(driveMarkerId(subjectId,targetId),subjectId,targetId,JSON.stringify(marker),nowMs);
  }
  private hasGuardEvent(subjectId:string,targetId:string,guard:GuardKey,eventKey:string):boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM companion_guard_events WHERE subject=? AND target=? AND guard=? AND event_key=?')
      .get(subjectId,targetId,guard,eventKey));
  }
  private recordGuardEvent(subjectId:string,targetId:string,guard:GuardKey,eventKey:string,detail:Record<string,unknown>,nowMs:number):void {
    this.db.prepare(`INSERT OR IGNORE INTO companion_guard_events(subject,target,guard,event_key,detail,created) VALUES(?,?,?,?,?,?)`)
      .run(subjectId,targetId,guard,eventKey,JSON.stringify(detail),nowMs);
  }
  /**
   * One-time scheduler migration, marked by `scheduler_v3`: every unsent `daily` row, from the removed per-minute
   * `wake:<minute>` keys or the removed constant `daily` greeting key, is cancelled once together with its unclaimed
   * outbox text. Consumed rows and deliveries already handed to a host stay as they are.
   */
  private migrateScheduler():void {
    if(this.db.prepare('SELECT 1 FROM companion_schema_marks WHERE name=?').get(SCHEDULER_MIGRATION))return;
    const nowMs=Date.now();
    this.transaction(()=>{
      const rows=this.db.prepare(`SELECT id,subject,target FROM companion_opportunities p
        WHERE kind='daily' AND status IN ('waiting','deferred','evaluating','approved') AND NOT EXISTS
        (SELECT 1 FROM companion_outbox o WHERE o.opportunity_id=p.id AND o.status IN ('sending','unknown'))`)
        .all() as {id:string;subject:string;target:string}[];
      const cancel=this.db.prepare("UPDATE companion_opportunities SET status='cancelled',claim_token=NULL,claim_until=NULL,updated=? WHERE id=?");
      const cancelText=this.db.prepare(`UPDATE companion_outbox SET status='cancelled',claim_token=NULL,claim_until=NULL,
        result_code='scheduler_migrated',updated=? WHERE opportunity_id=? AND status IN ('draft','ready')`);
      for(const row of rows){cancel.run(nowMs,row.id);cancelText.run(nowMs,row.id);}
      for(const subjectId of new Set(rows.map(row=>row.subject)))this.releaseCancelledQuietExceptions(subjectId,nowMs);
      const cancelled=new Set(rows.map(row=>row.id));
      for(const key of new Set(rows.map(row=>JSON.stringify([row.subject,row.target])))){
        const [subjectId,targetId]=JSON.parse(key) as [string,string],state=this.stateRow(subjectId,targetId);
        if(state?.opportunity_id&&cancelled.has(state.opportunity_id))this.writeState(subjectId,targetId,
          this.hasUncertainDelivery(subjectId,targetId)?'suspended':readProfileControls(this.db,subjectId).proactiveCompanionEnabled?'waiting':'disabled',
          null,'scheduler_migrated',null,nowMs);
      }
      this.db.prepare('INSERT INTO companion_schema_marks(name,applied,detail) VALUES(?,?,?)')
        .run(SCHEDULER_MIGRATION,nowMs,JSON.stringify({cancelled:rows.length,reason:'scheduler_migrated'}));
    });
  }
  private states(subjectId:string):StateRow[]{return this.db.prepare('SELECT * FROM companion_state WHERE subject=?').all(subjectId) as unknown as StateRow[];}
  private stateRow(subjectId:string,targetId:string):StateRow|undefined{return this.db.prepare('SELECT * FROM companion_state WHERE subject=? AND target=?').get(subjectId,targetId) as StateRow|undefined;}
  private opportunityRow(value:string):OpportunityRow|undefined{return this.db.prepare('SELECT * FROM companion_opportunities WHERE id=?').get(value) as OpportunityRow|undefined;}
  private deliveryRow(value:string):DeliveryRow|undefined{return this.db.prepare('SELECT * FROM companion_outbox WHERE id=?').get(value) as DeliveryRow|undefined;}
  private ensureSchema():void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS companion_contact_settings (
      subject TEXT PRIMARY KEY, revision INTEGER NOT NULL, time_zone TEXT NOT NULL, windows TEXT NOT NULL, exceptions TEXT NOT NULL,
      minimum_interval INTEGER NOT NULL, max_unanswered INTEGER NOT NULL, updated INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS companion_activity (
        subject TEXT PRIMARY KEY, revision INTEGER NOT NULL, semantic_ready_revision INTEGER NOT NULL,
        last_user_activity INTEGER, busy_until INTEGER, unanswered_count INTEGER NOT NULL, last_sent INTEGER);
      CREATE TABLE IF NOT EXISTS companion_state (
        subject TEXT NOT NULL,target TEXT NOT NULL,state TEXT NOT NULL,revision INTEGER NOT NULL,opportunity_id TEXT,
        reason TEXT,next_check INTEGER,updated INTEGER NOT NULL,PRIMARY KEY(subject,target));
      CREATE TABLE IF NOT EXISTS companion_opportunities (
        id TEXT PRIMARY KEY,subject TEXT NOT NULL,target TEXT NOT NULL,kind TEXT NOT NULL,purpose TEXT NOT NULL,topic TEXT NOT NULL,basis TEXT NOT NULL,
        occurrence_id TEXT NOT NULL,source_version INTEGER NOT NULL,profile_revision INTEGER NOT NULL,activity_revision INTEGER NOT NULL,
        controls_revision INTEGER NOT NULL,contact_revision INTEGER NOT NULL,check_at INTEGER NOT NULL,window_start INTEGER NOT NULL,
        window_end INTEGER NOT NULL,expires_at INTEGER NOT NULL,status TEXT NOT NULL,defer_count INTEGER NOT NULL,decision TEXT,strategy TEXT,
        claim_token TEXT,claim_until INTEGER,created INTEGER NOT NULL,updated INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS companion_opportunities_due ON companion_opportunities(subject,status,check_at);
      CREATE TABLE IF NOT EXISTS companion_outbox (
        id TEXT PRIMARY KEY,opportunity_id TEXT NOT NULL UNIQUE,subject TEXT NOT NULL,target TEXT NOT NULL,body TEXT NOT NULL,status TEXT NOT NULL,
        source_version INTEGER NOT NULL,profile_revision INTEGER NOT NULL,activity_revision INTEGER NOT NULL,controls_revision INTEGER NOT NULL,
        contact_revision INTEGER NOT NULL,claim_token TEXT,claim_until INTEGER,host TEXT,host_message_id TEXT,result_code TEXT,
        created INTEGER NOT NULL,updated INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS companion_outbox_status ON companion_outbox(subject,target,status);
      CREATE TABLE IF NOT EXISTS companion_quiet_exceptions (
        delivery_id TEXT NOT NULL,subject TEXT NOT NULL,target TEXT NOT NULL,scope_key TEXT NOT NULL,
        commitment_id TEXT NOT NULL,commitment_revision INTEGER NOT NULL,window_key TEXT NOT NULL,
        source_id TEXT NOT NULL,source_revision INTEGER NOT NULL,status TEXT NOT NULL,updated INTEGER NOT NULL,
        PRIMARY KEY(delivery_id,scope_key,commitment_id,commitment_revision,window_key));
      CREATE UNIQUE INDEX IF NOT EXISTS companion_quiet_exception_once ON companion_quiet_exceptions
        (subject,target,scope_key,commitment_id,commitment_revision,window_key) WHERE status IN ('reserved','consumed');
      CREATE TABLE IF NOT EXISTS companion_quiet_declines (
        subject TEXT NOT NULL,target TEXT NOT NULL,scope_key TEXT NOT NULL,commitment_id TEXT NOT NULL,
        commitment_revision INTEGER NOT NULL,window_key TEXT NOT NULL,occurrence_id TEXT NOT NULL,created INTEGER NOT NULL,
        PRIMARY KEY(subject,target,scope_key,commitment_id,commitment_revision,window_key));
      CREATE TABLE IF NOT EXISTS companion_judgments (
        occurrence_id TEXT PRIMARY KEY,subject TEXT NOT NULL,target TEXT NOT NULL,last_choice TEXT,last_fingerprint TEXT,
        pressure_marker TEXT,next_check INTEGER,updated INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS companion_judgments_target ON companion_judgments(subject,target);
      CREATE TABLE IF NOT EXISTS companion_guard_settings (
        subject TEXT NOT NULL,key TEXT NOT NULL,enabled INTEGER NOT NULL,value TEXT NOT NULL,revision INTEGER NOT NULL,
        updated INTEGER NOT NULL,PRIMARY KEY(subject,key));
      CREATE TABLE IF NOT EXISTS companion_guard_events (
        subject TEXT NOT NULL,target TEXT NOT NULL,guard TEXT NOT NULL,event_key TEXT NOT NULL,detail TEXT NOT NULL,
        created INTEGER NOT NULL,PRIMARY KEY(subject,target,guard,event_key));
      CREATE TABLE IF NOT EXISTS companion_contact_evaluations (
        subject TEXT NOT NULL,target TEXT NOT NULL,occurrence_id TEXT NOT NULL,kind TEXT NOT NULL,at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS companion_contact_evaluations_at ON companion_contact_evaluations(subject,at);
      CREATE TABLE IF NOT EXISTS companion_schema_marks (name TEXT PRIMARY KEY,applied INTEGER NOT NULL,detail TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS companion_drive_reopens (
        occurrence_id TEXT PRIMARY KEY,subject TEXT NOT NULL,target TEXT NOT NULL,reason TEXT NOT NULL,at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS companion_drive_reopens_target ON companion_drive_reopens(subject,target,at);
      CREATE TABLE IF NOT EXISTS companion_poll_diagnostics (
        subject TEXT NOT NULL,target TEXT NOT NULL,reason TEXT NOT NULL,event_key TEXT NOT NULL,detail TEXT NOT NULL,
        created INTEGER NOT NULL,PRIMARY KEY(subject,target,reason,event_key));
      CREATE TABLE IF NOT EXISTS companion_tendencies (
        subject TEXT NOT NULL,target TEXT NOT NULL,disposition TEXT NOT NULL,openness REAL NOT NULL DEFAULT 1,
        receptivity INTEGER NOT NULL DEFAULT 1,origin TEXT NOT NULL,revision INTEGER NOT NULL,updated INTEGER NOT NULL,
        PRIMARY KEY(subject,target));
      CREATE TABLE IF NOT EXISTS companion_busy_changes (subject TEXT PRIMARY KEY,updated INTEGER NOT NULL);`);
    // Idempotent M3 columns (pressure_v1): a table created by an older version gains them once; rows written before keep NULL.
    const columns=(table:string)=>new Set((this.db.prepare(`PRAGMA table_info(${table})`).all() as {name:string}[]).map(row=>row.name));
    const added:string[]=[];
    const add=(table:string,column:string,type:string,present:ReadonlySet<string>)=>{
      if(present.has(column))return;
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);added.push(`${table}.${column}`);
    };
    const opportunities=columns('companion_opportunities');
    add('companion_opportunities','seed_kind','TEXT',opportunities);add('companion_opportunities','pressure','TEXT',opportunities);
    const judgments=columns('companion_judgments');
    add('companion_judgments','seed_key','TEXT',judgments);add('companion_judgments','seed_kind','TEXT',judgments);
    add('companion_judgments','generation','INTEGER',judgments);add('companion_judgments','pressure_at_decision','REAL',judgments);
    this.db.exec('CREATE INDEX IF NOT EXISTS companion_judgments_seed ON companion_judgments(subject,target,seed_key)');
    // The mark records when the columns were added; opening a database that already has them writes nothing.
    if(added.length)this.db.prepare('INSERT OR IGNORE INTO companion_schema_marks(name,applied,detail) VALUES(?,?,?)')
      .run(PRESSURE_SCHEMA,Date.now(),JSON.stringify({table:'companion_tendencies',columns:added}));
    // Idempotent M3-5 column (relief_v1): texts queued before it keep NULL and release the table amount.
    if(!columns('companion_outbox').has('relief_connection')){
      this.db.exec('ALTER TABLE companion_outbox ADD COLUMN relief_connection REAL');
      this.db.prepare('INSERT OR IGNORE INTO companion_schema_marks(name,applied,detail) VALUES(?,?,?)')
        .run(RELIEF_SCHEMA,Date.now(),JSON.stringify({columns:['companion_outbox.relief_connection']}));
    }
  }
  private transaction<T>(work:()=>T):T {
    const savepoint=`companion_${this.savepointSequence++}`;this.db.exec(`SAVEPOINT ${savepoint}`);
    try{const result=work();this.db.exec(`RELEASE ${savepoint}`);return result;}
    catch(error){this.db.exec(`ROLLBACK TO ${savepoint}`);this.db.exec(`RELEASE ${savepoint}`);throw error;}
  }
}

function opportunityOf(row:OpportunityRow):CompanionOpportunity {
  return {opportunityId:row.id,subjectId:row.subject,targetId:row.target,kind:row.kind,purpose:row.purpose,topic:row.topic,
    basis:JSON.parse(row.basis) as CompanionBasis[],occurrenceId:row.occurrence_id,sourceVersion:row.source_version,
    profileRevision:row.profile_revision,activityRevision:row.activity_revision,controlsRevision:row.controls_revision,
    contactRevision:row.contact_revision,checkAtMs:row.check_at,windowStartMs:row.window_start,windowEndMs:row.window_end,
    expiresAtMs:row.expires_at,status:row.status,deferCount:row.defer_count,decision:row.decision,
    strategy:row.strategy?JSON.parse(row.strategy) as FrontendStrategy:null,claimToken:row.claim_token,claimUntilMs:row.claim_until,
    createdAtMs:row.created,updatedAtMs:row.updated,seedKind:row.seed_kind??null,
    pressure:row.pressure?JSON.parse(row.pressure) as OccurrencePressure:null};
}
function deliveryOf(row:DeliveryRow):CompanionDelivery {
  return {deliveryId:row.id,opportunityId:row.opportunity_id,subjectId:row.subject,targetId:row.target,body:row.body,status:row.status,
    sourceVersion:row.source_version,profileRevision:row.profile_revision,activityRevision:row.activity_revision,
    controlsRevision:row.controls_revision,contactRevision:row.contact_revision,claimToken:row.claim_token,claimUntilMs:row.claim_until,
    host:row.host,hostMessageId:row.host_message_id,resultCode:row.result_code,createdAtMs:row.created,updatedAtMs:row.updated,
    ...(typeof row.relief_connection==='number'?{reliefConnection:row.relief_connection}:{})};
}
function contactOf(row:ContactRow):ContactSettings {
  return {subjectId:row.subject,revision:row.revision,timeZone:row.time_zone,windows:JSON.parse(row.windows),exceptions:JSON.parse(row.exceptions),
    minimumIntervalMs:row.minimum_interval,maxUnanswered:row.max_unanswered,updatedAtMs:row.updated};
}
function activityOf(row:ActivityRow):CompanionActivity {
  return {subjectId:row.subject,revision:row.revision,semanticReadyRevision:row.semantic_ready_revision,lastUserActivityAtMs:row.last_user_activity,
    busyUntilMs:row.busy_until,unansweredCount:row.unanswered_count,lastSentAtMs:row.last_sent};
}
function validateExceptions(value:unknown):ContactException[] {
  if(!Array.isArray(value)||value.length>100)throw new Error('invalid_contact_exceptions');
  return value.map(item=>{
    if(!item||typeof item!=='object')throw new Error('invalid_contact_exceptions');const row=item as Record<string,unknown>;
    const date=validateDate(row.date);if(row.mode!=='skip'&&row.mode!=='replace')throw new Error('invalid_contact_exceptions');
    const windows=row.mode==='replace'?validateContactWindows((Array.isArray(row.windows)?row.windows:[]).map(window=>({...window as object,days:[0]})))
      .map(({start,end})=>({start,end})):undefined;
    return {date,mode:row.mode,...(windows?{windows}:{})};
  });
}
function validateBasis(value:unknown,kind:string):CompanionBasis[] {
  if(!Array.isArray(value)||value.length>50||(kind!=='daily'&&!value.length))throw new Error('invalid_companion_basis');
  return value.map(item=>{if(!item||typeof item!=='object')throw new Error('invalid_companion_basis');const row=item as Record<string,unknown>;
    if(!['source','profile','schedule','daily','drive','window','memory'].includes(row.kind as string))throw new Error('invalid_companion_basis');
    return {kind:row.kind as CompanionBasis['kind'],id:id(row.id),revision:revision(row.revision)};});
}
function validateQuietBindings(value:readonly QuietExceptionBinding[]):QuietExceptionBinding[] {
  if(!Array.isArray(value)||value.length>50)throw new Error('invalid_quiet_exception_bindings');
  const result=value.map(item=>{
    if(!item||typeof item!=='object')throw new Error('invalid_quiet_exception_bindings');
    return {scopeKey:text(item.scopeKey,500),commitmentId:id(item.commitmentId),revision:revision(item.revision),
      key:text(item.key,500),sourceId:id(item.sourceId),sourceRevision:revision(item.sourceRevision)};
  });
  const keys=result.map(item=>JSON.stringify([item.scopeKey,item.commitmentId,item.revision,item.key]));
  if(new Set(keys).size!==keys.length)throw new Error('invalid_quiet_exception_bindings');
  return result;
}
function sameQuietBindings(a:readonly QuietExceptionBinding[],b:readonly QuietExceptionBinding[]):boolean {
  const key=(item:QuietExceptionBinding)=>JSON.stringify([item.scopeKey,item.commitmentId,item.revision,item.key,item.sourceId,item.sourceRevision]);
  const left=a.map(key).sort(),right=b.map(key).sort();
  return left.length===right.length&&left.every((value,index)=>value===right[index]);
}
function validateStrategy(strategy:FrontendStrategy,row:OpportunityRow):void {
  if(!strategy||typeof strategy!=='object'||strategy.sourceVersions.profileRevision!==row.profile_revision||
    strategy.sourceVersions.controlsRevision!==row.controls_revision)throw new Error('context_changed_retry');
}
function validateJudgment(value:JudgmentInput):JudgmentInput {
  if(!value||typeof value!=='object'||!['send','wait','skip'].includes(value.choice))throw new Error('invalid_companion_judgment');
  const result:JudgmentInput={choice:value.choice,fingerprint:text(value.fingerprint,2000)};
  if(value.seedKey!==undefined){
    result.seedKey=text(value.seedKey,500);
    if(value.seedKind===undefined||!Number.isSafeInteger(value.generation)||value.generation!<0)throw new Error('invalid_companion_judgment');
    result.seedKind=validateSeedKind(value.seedKind);result.generation=value.generation!;
  }
  if(value.pressureAtDecision!==undefined){
    if(value.choice!=='skip'||typeof value.pressureAtDecision!=='number'||!Number.isFinite(value.pressureAtDecision))
      throw new Error('invalid_companion_judgment');
    result.pressureAtDecision=value.pressureAtDecision;
  }
  return result;
}
function validateMarker(value:DriveMarker):DriveMarker {
  if(!value||typeof value!=='object'||typeof value.fired!=='boolean'||(value.episode!==null&&typeof value.episode!=='string')||
    (value.clearedAtMs!==undefined&&(value.fired||!Number.isSafeInteger(value.clearedAtMs)||value.clearedAtMs<0)))
    throw new Error('invalid_companion_marker');
  return {fired:value.fired,episode:value.episode===null?null:id(value.episode),...(value.clearedAtMs===undefined?{}:{clearedAtMs:value.clearedAtMs})};
}
/**
 * The M3-5 fields of a window-end roll (see WindowEndRoll), each validated when present, in a fixed order; an old-shape roll
 * yields none. The `topic` tone and topicBasis come together; a reason belongs to a skip.
 */
function windowEndRollExtras(roll:WindowEndRoll):Partial<WindowEndRoll> {
  const invalid=()=>new Error('invalid_companion_value');
  const unit=(value:unknown)=>{if(typeof value!=='number'||!Number.isFinite(value)||value<0||value>1)throw invalid();return value;};
  const finite=(value:unknown)=>{if(typeof value!=='number'||!Number.isFinite(value))throw invalid();return value;};
  const extras:Partial<WindowEndRoll>={};
  if(roll.availableFromMs!==undefined)extras.availableFromMs=time(roll.availableFromMs);
  if(roll.delayMs!==undefined){
    if(finite(roll.delayMs)<0||roll.delayMs>WINDOW_END_DELAY_LIMIT_MS)throw invalid();
    extras.delayMs=roll.delayMs;
  }
  if(roll.sendAtMs!==undefined)extras.sendAtMs=time(roll.sendAtMs);
  const end=roll.instanceEndMs;
  if(end!==undefined&&((extras.availableFromMs??end)<end||(extras.sendAtMs??end)<end))throw invalid();
  if(extras.availableFromMs!==undefined&&extras.sendAtMs!==undefined&&extras.sendAtMs<extras.availableFromMs)throw invalid();
  if(roll.reason!==undefined){
    if(roll.decision!=='skip'||typeof roll.reason!=='string'||!/^[a-z][a-z0-9_]{0,63}$/.test(roll.reason))throw invalid();
    extras.reason=roll.reason;
  }
  if(roll.pBase!==undefined)extras.pBase=unit(roll.pBase);
  if(roll.g!==undefined)extras.g=unit(roll.g);
  if(roll.drive!==undefined){
    const drive=roll.drive as unknown as Record<string,unknown>;
    if(!drive||typeof drive!=='object'||Array.isArray(drive)||Object.keys(drive).some(key=>!['d','s1','s2','s6','s7'].includes(key)))
      throw invalid();
    extras.drive={d:finite(drive.d),s1:finite(drive.s1),s2:finite(drive.s2),s6:finite(drive.s6),
      ...(drive.s7===undefined?{}:{s7:finite(drive.s7)})};
  }
  if(roll.thetaX!==undefined)extras.thetaX=finite(roll.thetaX);
  if(roll.connection!==undefined)extras.connection=validateReliefConnection(roll.connection);
  if(roll.y!==undefined)extras.y=unit(roll.y);
  const topic=(roll.tone as string)==='topic';
  if(topic!==(roll.topicBasis!==undefined))throw invalid();
  if(roll.topicBasis!==undefined){
    const basis=roll.topicBasis as unknown as Record<string,unknown>;
    if(!basis||typeof basis!=='object'||!['source','memory'].includes(basis.kind as string))throw invalid();
    extras.topicBasis={kind:basis.kind as 'source'|'memory',id:id(basis.id),revision:revision(basis.revision)};
  }
  return extras;
}
function validateReliefConnection(value:unknown):number {
  if(typeof value!=='number'||!Number.isFinite(value)||value<0)throw new Error('invalid_companion_value');
  return value;
}
function validateSeedKind(value:unknown):SeedKind {
  if(!SEED_KINDS.includes(value as SeedKind))throw new Error('invalid_companion_value');
  return value as SeedKind;
}
function validatePressure(value:OccurrencePressure):OccurrencePressure {
  if(!value||typeof value!=='object'||typeof value.seedKey!=='string'||!value.seedKey||!Number.isSafeInteger(value.generation)||
    value.generation<0||typeof value.opportunityKey!=='string'||!value.opportunityKey)throw new Error('invalid_companion_value');
  if(JSON.stringify(value).length>PRESSURE_RECORD_LIMIT)throw new Error('invalid_companion_value');
  return value;
}
function validateGuardValue<K extends GuardKey>(key:K,value:unknown):GuardValues[K] {
  const whole=(item:unknown,min:number,max:number)=>{if(!Number.isSafeInteger(item)||(item as number)<min||(item as number)>max)
    throw new Error('invalid_guard_setting');return item as number;};
  if(!value||typeof value!=='object')throw new Error('invalid_guard_setting');
  const row=value as Record<string,unknown>,keys=Object.keys(row).sort().join(',');
  if(key==='G3'){
    if(keys!=='perHour')throw new Error('invalid_guard_setting');
    return {perHour:whole(row.perHour,1,1000)} as GuardValues[K];
  }
  if(keys!=='count,windowMinutes')throw new Error('invalid_guard_setting');
  return {windowMinutes:whole(row.windowMinutes,1,1440),count:whole(row.count,key==='G1'?2:1,100)} as GuardValues[K];
}
/** Synthetic judgment occurrence that holds the per-target drive hysteresis marker. */
export function driveMarkerId(subjectId:string,targetId:string):string{return hash(['drive-marker',subjectId,targetId]);}
/** Synthetic judgment occurrence that holds the seeded send roll of one window-end occurrence. */
function windowEndRollId(subjectId:string,targetId:string,opportunityKey:string):string{return hash(['window-end-roll',subjectId,targetId,opportunityKey]);}
function hash(value:unknown):string{return createHash('sha256').update(JSON.stringify(value)).digest('hex');}
function flag(value:unknown,fallback:boolean):boolean {if(value===undefined)return fallback;if(typeof value!=='boolean')throw new Error('invalid_companion_controls');return value;}
function id(value:unknown):string{return text(value,200);}
function text(value:unknown,max:number):string {if(typeof value!=='string'||!value.trim()||value.length>max)throw new Error('invalid_companion_value');return value.trim();}
function time(value:unknown):number {if(!Number.isSafeInteger(value)||(value as number)<0)throw new Error('invalid_companion_time');return value as number;}
function revision(value:unknown):number {assertRevision(value);return value;}
function assertRevision(value:unknown):asserts value is number {if(!Number.isSafeInteger(value)||(value as number)<0)throw new Error('invalid_companion_revision');}
function lease(value:unknown):asserts value is number {if(!Number.isSafeInteger(value)||(value as number)<1_000||(value as number)>3_600_000)throw new Error('invalid_companion_lease');}
