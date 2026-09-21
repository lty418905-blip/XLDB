import {createHash,randomUUID} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {communicationStrategyPrompt,profileExtractionPrompt} from './codec.ts';
import {defaultProfileControls,ensureUserModelSchema,readProfileControls,validateCategories,writeProfileControls} from './schema.ts';
import type {CommunicationStrategy,FrontendStrategy,ProfileCandidate,ProfileControls,ProfileEntry,ProfileExtractionTask,
  ProfileListOptions,ProfileProjectionResult,ProfileProjectionSource,StrategyTask,SubjectBinding} from './types.ts';
import type {SceneScope} from '../scene/types.ts';

interface EntryRow {id:string;subject:string;semantic_key:string;category:string;body:string;status:string;corrected:number;revision:number;updated:number}
interface EvidenceRow {entry_id:string;source_id:string;source_revision:number}
interface OverrideRow {status:'corrected'|'deleted';body:string|null}
interface StrategyRow {id:string;profile_revision:number;controls_revision:number;body:string}

export interface ProfileControlPatch {
  profileLearningEnabled?:boolean;
  personalizationEnabled?:boolean;
  proactiveCompanionEnabled?:boolean;
  scheduledWakeEnabled?:boolean;
  learningCategories?:unknown;
  readCategories?:unknown;
  strategyCategories?:unknown;
  proactiveCategories?:unknown;
}

export class UserModelStore {
  private db:DatabaseSync;
  private savepointSequence=0;
  constructor(db:DatabaseSync){this.db=db;ensureUserModelSchema(db);}

  bindSubject(host:string,bindingId:string,subjectId:string,nowMs=Date.now()):SubjectBinding {
    host=id(host);bindingId=id(bindingId);subjectId=id(subjectId);nowMs=time(nowMs);
    return this.transaction(()=>{
      const row=this.db.prepare('SELECT subject,created FROM user_subject_bindings WHERE host=? AND binding_id=?')
        .get(host,bindingId) as {subject:string;created:number}|undefined;
      if(row&&row.subject!==subjectId)throw new Error('subject_binding_conflict');
      if(!row)this.db.prepare('INSERT INTO user_subject_bindings VALUES(?,?,?,?)').run(host,bindingId,subjectId,nowMs);
      return {host,bindingId,subjectId,createdAtMs:row?.created??nowMs};
    });
  }

  resolveSubject(host:string,bindingId:string):SubjectBinding|null {
    const row=this.db.prepare('SELECT subject,created FROM user_subject_bindings WHERE host=? AND binding_id=?')
      .get(id(host),id(bindingId)) as {subject:string;created:number}|undefined;
    return row?{host,bindingId,subjectId:row.subject,createdAtMs:row.created}:null;
  }

  controls(subjectId:string):ProfileControls {return readProfileControls(this.db,id(subjectId));}

  setControls(subjectId:string,patch:ProfileControlPatch,expectedRevision:number,nowMs=Date.now()):ProfileControls {
    subjectId=id(subjectId);assertRevision(expectedRevision);nowMs=time(nowMs);
    if(!patch||typeof patch!=='object'||!Object.keys(patch).length)throw new Error('invalid_profile_controls');
    return this.transaction(()=>{
      const current=readProfileControls(this.db,subjectId);
      if(current.revision!==expectedRevision)throw new Error('context_changed_retry');
      const profileBefore=currentProfileSnapshot(this.db,subjectId);
      const next:ProfileControls={...current,
        profileLearningEnabled:boolean(patch.profileLearningEnabled,current.profileLearningEnabled),
        personalizationEnabled:boolean(patch.personalizationEnabled,current.personalizationEnabled),
        proactiveCompanionEnabled:boolean(patch.proactiveCompanionEnabled,current.proactiveCompanionEnabled),
        scheduledWakeEnabled:boolean(patch.scheduledWakeEnabled,current.scheduledWakeEnabled),
        learningCategories:patch.learningCategories===undefined?current.learningCategories:validateCategories(patch.learningCategories),
        readCategories:patch.readCategories===undefined?current.readCategories:validateCategories(patch.readCategories),
        strategyCategories:patch.strategyCategories===undefined?current.strategyCategories:validateCategories(patch.strategyCategories),
        proactiveCategories:patch.proactiveCategories===undefined?current.proactiveCategories:validateCategories(patch.proactiveCategories),
        revision:current.revision+1,updatedAtMs:nowMs};
      if(next.scheduledWakeEnabled&&!next.proactiveCompanionEnabled)throw new Error('invalid_scheduled_wake_without_proactive');
      writeProfileControls(this.db,next);
      if(patch.learningCategories!==undefined) {
        const placeholders=next.learningCategories.map(()=>'?').join(',');
        const sql=next.learningCategories.length
          ?`DELETE FROM user_profile_evidence WHERE subject=? AND entry_id IN (SELECT id FROM user_profile_entries WHERE subject=? AND category NOT IN (${placeholders}))`
          :'DELETE FROM user_profile_evidence WHERE subject=? AND entry_id IN (SELECT id FROM user_profile_entries WHERE subject=?)';
        this.db.prepare(sql).run(subjectId,subjectId,...next.learningCategories);
        this.recomputeEntries(subjectId,nowMs);
        this.bumpProfileIfChanged(subjectId,profileBefore,nowMs);
      }
      this.invalidateStrategies(subjectId);
      return next;
    });
  }

  profileRevision(subjectId:string):number {
    return (this.db.prepare('SELECT revision FROM user_profile_state WHERE subject=?').get(id(subjectId)) as {revision:number}|undefined)?.revision??0;
  }

  /** Rebuild from the whole accepted source projection. It is safe inside the scene commit transaction. */
  rebuildProjection(subjectId:string,scope:SceneScope,sources:readonly ProfileProjectionSource[],nowMs=Date.now()):ProfileProjectionResult {
    subjectId=id(subjectId);const sourceScope=JSON.stringify(scope);nowMs=time(nowMs);
    return this.transaction(()=>{
      const before=currentProfileSnapshot(this.db,subjectId),controls=readProfileControls(this.db,subjectId);
      const accepted=sources.filter(source=>source.status==='accepted').map(validateSource)
        .sort((left,right)=>left.acceptedAtMs-right.acceptedAtMs||left.id.localeCompare(right.id)||left.revision-right.revision);
      const current=new Map(accepted.map(source=>[source.id,source.revision]));
      const evidence=this.db.prepare(`SELECT entry_id,source_id,source_revision FROM user_profile_evidence
        WHERE subject=? AND source_scope=?`).all(subjectId,sourceScope) as unknown as EvidenceRow[];
      for(const row of evidence)if(current.get(row.source_id)!==row.source_revision)
        this.db.prepare('DELETE FROM user_profile_evidence WHERE subject=? AND source_scope=? AND source_id=?')
          .run(subjectId,sourceScope,row.source_id);

      if(controls.profileLearningEnabled)for(const source of accepted) {
        this.db.prepare('DELETE FROM user_profile_evidence WHERE subject=? AND source_scope=? AND source_id=? AND source_revision=?')
          .run(subjectId,sourceScope,source.id,source.revision);
        for(const candidate of (source.candidates??[]).map(value=>validateCandidate(value,source.text))) {
          if(!controls.learningCategories.includes(candidate.category))continue;
          const semanticKey=`${candidate.category}:${candidate.key}`;
          const entryId=hash([subjectId,semanticKey]);
          const existing=this.entryRow(entryId);
          if(!existing)this.db.prepare(`INSERT INTO user_profile_entries
            (id,subject,semantic_key,category,body,status,corrected,revision,updated) VALUES(?,?,?,?,?,'invalid',0,1,?)`)
            .run(entryId,subjectId,semanticKey,candidate.category,JSON.stringify(candidate),nowMs);
          else if(!this.override(entryId)&&JSON.stringify(candidate)!==existing.body&&prefer(candidate,JSON.parse(existing.body) as ProfileCandidate))
            this.db.prepare('UPDATE user_profile_entries SET category=?,body=?,revision=revision+1,updated=? WHERE id=?')
              .run(candidate.category,JSON.stringify(candidate),nowMs,entryId);
          this.db.prepare(`INSERT OR REPLACE INTO user_profile_evidence
            (subject,entry_id,source_scope,source_id,source_revision,candidate_key,polarity,body) VALUES(?,?,?,?,?,?,?,?)`)
            .run(subjectId,entryId,sourceScope,source.id,source.revision,candidate.key,candidate.polarity,
              JSON.stringify({candidate,acceptedAtMs:source.acceptedAtMs,evidence:source.text.includes(candidate.evidence)}));
        }
      }
      this.recomputeEntries(subjectId,nowMs);
      const changed=this.bumpProfileIfChanged(subjectId,before,nowMs);
      const invalidatedStrategies=changed?this.invalidateStrategies(subjectId):0;
      return {subjectId,profileRevision:this.profileRevision(subjectId),changed,
        activeEntries:(this.db.prepare("SELECT COUNT(*) AS count FROM user_profile_entries WHERE subject=? AND status='active'").get(subjectId) as {count:number}).count,
        invalidatedStrategies};
    });
  }

  listEntries(subjectId:string,options:ProfileListOptions={purpose:'user'}):ProfileEntry[] {
    subjectId=id(subjectId);const now=options.nowMs===undefined?Date.now():time(options.nowMs),controls=readProfileControls(this.db,subjectId);
    if(options.purpose==='read'&&!controls.readCategories.length)return [];
    if(options.purpose==='strategy'&&!controls.personalizationEnabled)return [];
    if(options.purpose==='proactive'&&(!controls.personalizationEnabled||!controls.proactiveCompanionEnabled))return [];
    const allowed=options.purpose==='user'?null:options.purpose==='read'?controls.readCategories:
      options.purpose==='strategy'?controls.strategyCategories:controls.proactiveCategories;
    const rows=this.db.prepare("SELECT id,subject,semantic_key,category,body,status,corrected,revision,updated FROM user_profile_entries WHERE subject=? AND status='active' ORDER BY updated DESC,id")
      .all(subjectId) as unknown as EntryRow[];
    return rows.map(row=>this.entry(row)).filter(entry=>(!allowed||allowed.includes(entry.category))&&
      (options.purpose==='user'||entry.attribution==='real_user'||entry.attribution==='uncertain')&&
      (entry.validFromMs===null||entry.validFromMs<=now)&&(entry.validUntilMs===null||entry.validUntilMs>=now)&&
      (!options.taskPurpose||!entry.purposes.length||entry.purposes.includes(options.taskPurpose))&&
      (!options.characterId||!entry.characterIds.length||entry.characterIds.includes(options.characterId))&&
      (!options.sessionId||!entry.sessionIds.length||entry.sessionIds.includes(options.sessionId)));
  }

  correctEntry(subjectId:string,entryId:string,correction:{claim:string;category?:unknown;validFromMs?:number|null;validUntilMs?:number|null;
    purposes?:unknown;characterIds?:unknown;sessionIds?:unknown},nowMs=Date.now()):ProfileEntry {
    subjectId=id(subjectId);entryId=id(entryId);nowMs=time(nowMs);
    return this.transaction(()=>{
      const before=currentProfileSnapshot(this.db,subjectId),row=this.entryRow(entryId);
      if(!row||row.subject!==subjectId)throw new Error('profile_entry_not_found');
      const old=JSON.parse(row.body) as ProfileCandidate;
      const candidate:ProfileCandidate={...old,claim:text(correction.claim,1000),category:correction.category===undefined?old.category:singleCategory(correction.category),
        attribution:'real_user',basis:'explicit',polarity:'support',evidence:'用户直接纠正',
        validFromMs:correction.validFromMs===undefined?old.validFromMs:nullableTime(correction.validFromMs),
        validUntilMs:correction.validUntilMs===undefined?old.validUntilMs:nullableTime(correction.validUntilMs),
        purposes:correction.purposes===undefined?old.purposes:stringArray(correction.purposes,20,100),
        characterIds:correction.characterIds===undefined?old.characterIds:stringArray(correction.characterIds,50,200),
        sessionIds:correction.sessionIds===undefined?old.sessionIds:stringArray(correction.sessionIds,50,200),confidenceBasis:['用户直接纠正']};
      this.db.prepare(`INSERT INTO user_profile_overrides(entry_id,subject,status,body,updated) VALUES(?,?,'corrected',?,?)
        ON CONFLICT(entry_id) DO UPDATE SET status='corrected',body=excluded.body,updated=excluded.updated`)
        .run(entryId,subjectId,JSON.stringify(candidate),nowMs);
      this.recomputeEntries(subjectId,nowMs);this.bumpProfileIfChanged(subjectId,before,nowMs);this.invalidateStrategies(subjectId);
      return this.entry(this.entryRow(entryId)!);
    });
  }

  deleteEntry(subjectId:string,entryId:string,nowMs=Date.now()):void {
    subjectId=id(subjectId);entryId=id(entryId);nowMs=time(nowMs);
    this.transaction(()=>{
      const before=currentProfileSnapshot(this.db,subjectId),row=this.entryRow(entryId);
      if(!row||row.subject!==subjectId)throw new Error('profile_entry_not_found');
      this.db.prepare(`INSERT INTO user_profile_overrides(entry_id,subject,status,body,updated) VALUES(?,?,'deleted',NULL,?)
        ON CONFLICT(entry_id) DO UPDATE SET status='deleted',body=NULL,updated=excluded.updated`).run(entryId,subjectId,nowMs);
      this.recomputeEntries(subjectId,nowMs);this.bumpProfileIfChanged(subjectId,before,nowMs);this.invalidateStrategies(subjectId);
    });
  }

  profileTask(subjectId:string,scope:SceneScope,source:{id:string;revision:number;text:string;acceptedAtMs:number}):ProfileExtractionTask|null {
    const controls=readProfileControls(this.db,id(subjectId));
    return controls.profileLearningEnabled&&controls.learningCategories.length
      ?profileExtractionPrompt({subjectId,scope,source,allowedCategories:controls.learningCategories}):null;
  }

  strategyTask(subjectId:string,input:{purpose:string;storageKey?:string;currentContext?:string;characterId?:string;sessionId?:string;nowMs?:number}):StrategyTask|null {
    subjectId=id(subjectId);const purpose=text(input.purpose,200),storageKey=input.storageKey===undefined?purpose:text(input.storageKey,500);
    const controls=readProfileControls(this.db,subjectId);
    if(!controls.personalizationEnabled)return null;
    const entries=this.listEntries(subjectId,{purpose:'strategy',taskPurpose:purpose,characterId:input.characterId,
      sessionId:input.sessionId,nowMs:input.nowMs});
    if(!entries.length)return null;
    return {...communicationStrategyPrompt({subjectId,purpose,storageKey,profileRevision:this.profileRevision(subjectId),controlsRevision:controls.revision,
      currentContext:input.currentContext,entries:entries.map(entry=>({id:entry.id,revision:entry.revision,category:entry.category,
        attribution:entry.attribution,basis:entry.basis,claim:entry.claim,confidenceBasis:entry.confidenceBasis}))}),
      ...(input.characterId===undefined?{}:{characterId:id(input.characterId)}),...(input.sessionId===undefined?{}:{sessionId:id(input.sessionId)})};
  }

  saveStrategy(subjectId:string,task:StrategyTask,strategy:CommunicationStrategy,nowMs=Date.now()):FrontendStrategy {
    subjectId=id(subjectId);const storageKey=text(task.storageKey,500);nowMs=time(nowMs);
    return this.transaction(()=>{
      if(task.subjectId!==subjectId||strategy.purpose!==task.purpose)throw new Error('invalid_profile_strategy');
      const controls=readProfileControls(this.db,subjectId),profileRevision=this.profileRevision(subjectId);
      if(!controls.personalizationEnabled||controls.revision!==task.controlsRevision||profileRevision!==task.profileRevision)
        throw new Error('context_changed_retry');
      if(strategy.sourceVersions.controlsRevision!==controls.revision||strategy.sourceVersions.profileRevision!==profileRevision)
        throw new Error('context_changed_retry');
      const allowed=new Map(this.listEntries(subjectId,{purpose:'strategy',taskPurpose:task.purpose,characterId:task.characterId,sessionId:task.sessionId,nowMs})
        .map(entry=>[entry.id,entry.revision]));
      const cited=new Set([...strategy.knownFacts,...strategy.uncertainFacts].map(fact=>fact.entryId));
      for(const entryId of cited)if(!task.allowedEntryIds.includes(entryId)||strategy.sourceVersions.entryRevisions[entryId]!==task.allowedEntryRevisions[entryId])
        throw new Error('invalid_profile_strategy_reference');
      for(const [entryId,revision] of Object.entries(strategy.sourceVersions.entryRevisions))
        if(allowed.get(entryId)!==revision)throw new Error('context_changed_retry');
      const strategyId=randomUUID();
      this.db.prepare("UPDATE user_model_strategies SET status='invalid' WHERE subject=? AND purpose=? AND status='active'")
        .run(subjectId,storageKey);
      this.db.prepare('INSERT INTO user_model_strategies VALUES(?,?,?,?,?,?,?,?)')
        .run(strategyId,subjectId,storageKey,profileRevision,controls.revision,JSON.stringify({...strategy,contextScope:{characterId:task.characterId??null,sessionId:task.sessionId??null}}),'active',nowMs);
      return frontend(strategyId,strategy);
    });
  }

  strategyForFrontend(subjectId:string,purpose:string,context:{storageKey?:string;characterId?:string;sessionId?:string}={}):FrontendStrategy|null {
    subjectId=id(subjectId);purpose=text(purpose,200);const storageKey=context.storageKey===undefined?purpose:text(context.storageKey,500);const controls=readProfileControls(this.db,subjectId);
    if(!controls.personalizationEnabled)return null;
    const row=this.db.prepare(`SELECT id,profile_revision,controls_revision,body FROM user_model_strategies
      WHERE subject=? AND purpose=? AND status='active' ORDER BY rowid DESC LIMIT 1`).get(subjectId,storageKey) as StrategyRow|undefined;
    if(!row||row.profile_revision!==this.profileRevision(subjectId)||row.controls_revision!==controls.revision)return null;
    const strategy=JSON.parse(row.body) as CommunicationStrategy&{contextScope?:{characterId:string|null;sessionId:string|null}};
    if(strategy.purpose!==purpose)return null;
    const stored=strategy.contextScope??{characterId:null,sessionId:null};
    if(stored.characterId!==(context.characterId??null)||stored.sessionId!==(context.sessionId??null))return null;
    const allowed=new Map(this.listEntries(subjectId,{purpose:'strategy',taskPurpose:purpose,characterId:context.characterId,sessionId:context.sessionId}).map(entry=>[entry.id,entry.revision]));
    const cited=new Set([...strategy.knownFacts,...strategy.uncertainFacts].map(fact=>fact.entryId));
    if([...cited].some(entryId=>strategy.sourceVersions.entryRevisions[entryId]===undefined))return null;
    if(Object.entries(strategy.sourceVersions.entryRevisions).some(([entryId,revision])=>allowed.get(entryId)!==revision))return null;
    return frontend(row.id,strategy);
  }

  private recomputeEntries(subjectId:string,nowMs:number):void {
    const rows=this.db.prepare('SELECT id,subject,semantic_key,category,body,status,corrected,revision,updated FROM user_profile_entries WHERE subject=?')
      .all(subjectId) as unknown as EntryRow[];
    for(const row of rows) {
      const override=this.override(row.id);
      const counts=this.db.prepare(`SELECT SUM(CASE WHEN polarity='support' THEN 1 ELSE 0 END) AS supports,
        SUM(CASE WHEN polarity='counter' THEN 1 ELSE 0 END) AS counters FROM
        (SELECT polarity FROM user_profile_evidence WHERE subject=? AND entry_id=? GROUP BY source_id,source_revision,candidate_key,polarity)`)
        .get(subjectId,row.id) as {supports:number|null;counters:number|null};
      const status=override?.status==='deleted'?'deleted':override?.status==='corrected'||(counts.supports??0)>0?'active':'invalid';
      const corrected=override?.status==='corrected'?1:0;
      const body=override?.status==='corrected'&&override.body?override.body:row.body;
      const category=(JSON.parse(body) as ProfileCandidate).category;
      if(status!==row.status||corrected!==row.corrected||body!==row.body||category!==row.category)
        this.db.prepare('UPDATE user_profile_entries SET category=?,body=?,status=?,corrected=?,revision=revision+1,updated=? WHERE id=?')
          .run(category,body,status,corrected,nowMs,row.id);
    }
  }

  private entry(row:EntryRow):ProfileEntry {
    const value=JSON.parse(row.body) as ProfileCandidate;
    const counts=this.db.prepare(`SELECT SUM(CASE WHEN polarity='support' THEN 1 ELSE 0 END) AS supports,
      SUM(CASE WHEN polarity='counter' THEN 1 ELSE 0 END) AS counters FROM
      (SELECT polarity FROM user_profile_evidence WHERE subject=? AND entry_id=? GROUP BY source_id,source_revision,candidate_key,polarity)`)
      .get(row.subject,row.id) as {supports:number|null;counters:number|null};
    return {id:row.id,subjectId:row.subject,key:value.key,category:value.category,attribution:value.attribution,basis:value.basis,
      claim:value.claim,occurredAtMs:value.occurredAtMs,validFromMs:value.validFromMs,validUntilMs:value.validUntilMs,
      purposes:value.purposes,characterIds:value.characterIds,sessionIds:value.sessionIds,confidenceBasis:value.confidenceBasis,
      supportCount:counts.supports??0,counterCount:counts.counters??0,corrected:row.corrected===1,status:row.status as ProfileEntry['status'],
      revision:row.revision,updatedAtMs:row.updated};
  }
  private entryRow(entryId:string):EntryRow|undefined {
    return this.db.prepare('SELECT id,subject,semantic_key,category,body,status,corrected,revision,updated FROM user_profile_entries WHERE id=?')
      .get(entryId) as EntryRow|undefined;
  }
  private override(entryId:string):OverrideRow|undefined {
    return this.db.prepare('SELECT status,body FROM user_profile_overrides WHERE entry_id=?').get(entryId) as OverrideRow|undefined;
  }
  private bumpProfileIfChanged(subjectId:string,before:string,nowMs:number):boolean {
    if(before===currentProfileSnapshot(this.db,subjectId))return false;
    this.db.prepare(`INSERT INTO user_profile_state(subject,revision,updated) VALUES(?,1,?)
      ON CONFLICT(subject) DO UPDATE SET revision=revision+1,updated=excluded.updated`).run(subjectId,nowMs);
    return true;
  }
  private invalidateStrategies(subjectId:string):number {
    return Number(this.db.prepare("UPDATE user_model_strategies SET status='invalid' WHERE subject=? AND status='active'").run(subjectId).changes);
  }
  private transaction<T>(work:()=>T):T {
    const savepoint=`user_model_${this.savepointSequence++}`;this.db.exec(`SAVEPOINT ${savepoint}`);
    try{const result=work();this.db.exec(`RELEASE ${savepoint}`);return result;}
    catch(error){this.db.exec(`ROLLBACK TO ${savepoint}`);this.db.exec(`RELEASE ${savepoint}`);throw error;}
  }
}

function currentProfileSnapshot(db:DatabaseSync,subjectId:string):string {
  const entries=db.prepare('SELECT id,category,body,status,corrected,revision FROM user_profile_entries WHERE subject=? ORDER BY id').all(subjectId);
  // Branches may carry the same accepted source. Keep every scope as provenance,
  // but do not turn the duplicated projection into new behavioral evidence.
  const evidence=db.prepare(`SELECT DISTINCT entry_id,source_id,source_revision,candidate_key,polarity,body
    FROM user_profile_evidence WHERE subject=? ORDER BY entry_id,source_id,source_revision,candidate_key,polarity,body`).all(subjectId);
  return JSON.stringify({entries,evidence});
}
function frontend(strategyId:string,strategy:CommunicationStrategy):FrontendStrategy {
  return {strategyId,purpose:strategy.purpose,supportMode:strategy.supportMode,allowedTopics:strategy.allowedTopics,
    knownFacts:strategy.knownFacts,uncertainFacts:strategy.uncertainFacts,tone:strategy.tone,length:strategy.length,
    questionBudget:strategy.questionBudget,avoidRepeating:strategy.avoidRepeating,stopConditions:strategy.stopConditions,
    sourceVersions:strategy.sourceVersions};
}
function validateSource(value:ProfileProjectionSource):ProfileProjectionSource {
  id(value.id);assertRevision(value.revision);text(value.text,20000);time(value.acceptedAtMs);return value;
}
function validateCandidate(value:ProfileCandidate,sourceText:string):ProfileCandidate {
  if(!value||typeof value!=='object'||!sourceText.includes(text(value.evidence,500)))throw new Error('profile_evidence_not_in_source');
  singleCategory(value.category);id(value.key);text(value.claim,1000);
  if(!['real_user','roleplay','quoted_third_party','uncertain'].includes(value.attribution)||!['explicit','observed','inferred','planned'].includes(value.basis)||
    !['support','counter'].includes(value.polarity))throw new Error('invalid_profile_candidate');
  nullableTime(value.occurredAtMs);nullableTime(value.validFromMs);nullableTime(value.validUntilMs);
  stringArray(value.purposes,20,100);stringArray(value.characterIds,50,200);stringArray(value.sessionIds,50,200);stringArray(value.confidenceBasis,20,300);
  return structuredClone(value);
}
function prefer(next:ProfileCandidate,current:ProfileCandidate):boolean {
  const rank={planned:0,inferred:1,observed:2,explicit:3};return rank[next.basis]>=rank[current.basis];
}
function singleCategory(value:unknown):ProfileCandidate['category'] {const result=validateCategories([value]);return result[0]!;}
function hash(value:unknown):string{return createHash('sha256').update(JSON.stringify(value)).digest('hex');}
function boolean(value:unknown,fallback:boolean):boolean {if(value===undefined)return fallback;if(typeof value!=='boolean')throw new Error('invalid_profile_controls');return value;}
function id(value:unknown):string{return text(value,200);}
function text(value:unknown,max:number):string {if(typeof value!=='string'||!value.trim()||value.length>max)throw new Error('invalid_profile_value');return value.trim();}
function stringArray(value:unknown,max:number,itemMax:number):string[]{if(!Array.isArray(value)||value.length>max)throw new Error('invalid_profile_value');return [...new Set(value.map(item=>text(item,itemMax)))];}
function time(value:unknown):number {if(!Number.isSafeInteger(value)||(value as number)<0)throw new Error('invalid_profile_time');return value as number;}
function nullableTime(value:unknown):number|null{return value===null||value===undefined?null:time(value);}
function assertRevision(value:unknown):asserts value is number {if(!Number.isSafeInteger(value)||(value as number)<0)throw new Error('invalid_profile_revision');}
