import type {DatabaseSync} from 'node:sqlite';
import {profileCategories,profileCategoriesNone} from './types.ts';
import type {ProfileCategory,ProfileControls} from './types.ts';

interface ControlRow {
  subject:string;revision:number;profile_learning:number;personalization:number;proactive:number;scheduled_wake:number;
  learning_categories:string;read_categories:string;strategy_categories:string;proactive_categories:string;
  time_zone:string|null;updated:number;
}

export function ensureUserModelSchema(db:DatabaseSync):void {
  db.exec(`CREATE TABLE IF NOT EXISTS user_subject_bindings (
    host TEXT NOT NULL, binding_id TEXT NOT NULL, subject TEXT NOT NULL, created INTEGER NOT NULL,
    PRIMARY KEY(host,binding_id));
    CREATE INDEX IF NOT EXISTS user_subject_bindings_subject ON user_subject_bindings(subject);
    CREATE TABLE IF NOT EXISTS user_model_controls (
      subject TEXT PRIMARY KEY, revision INTEGER NOT NULL, profile_learning INTEGER NOT NULL,
      personalization INTEGER NOT NULL, proactive INTEGER NOT NULL, scheduled_wake INTEGER NOT NULL,
      learning_categories TEXT NOT NULL, read_categories TEXT NOT NULL,
      strategy_categories TEXT NOT NULL, proactive_categories TEXT NOT NULL, updated INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS user_profile_state (
      subject TEXT PRIMARY KEY, revision INTEGER NOT NULL, updated INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS user_profile_entries (
      id TEXT PRIMARY KEY, subject TEXT NOT NULL, semantic_key TEXT NOT NULL, category TEXT NOT NULL,
      body TEXT NOT NULL, status TEXT NOT NULL, corrected INTEGER NOT NULL, revision INTEGER NOT NULL, updated INTEGER NOT NULL,
      UNIQUE(subject,semantic_key));
    CREATE INDEX IF NOT EXISTS user_profile_entries_subject ON user_profile_entries(subject,status,category);
    CREATE TABLE IF NOT EXISTS user_profile_evidence (
      subject TEXT NOT NULL, entry_id TEXT NOT NULL, source_scope TEXT NOT NULL, source_id TEXT NOT NULL,
      source_revision INTEGER NOT NULL, candidate_key TEXT NOT NULL, polarity TEXT NOT NULL, body TEXT NOT NULL,
      PRIMARY KEY(subject,entry_id,source_scope,source_id,source_revision,candidate_key));
    CREATE INDEX IF NOT EXISTS user_profile_evidence_source ON user_profile_evidence(subject,source_scope,source_id);
    CREATE TABLE IF NOT EXISTS user_profile_overrides (
      entry_id TEXT PRIMARY KEY, subject TEXT NOT NULL, status TEXT NOT NULL, body TEXT, updated INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS user_model_strategies (
      id TEXT PRIMARY KEY, subject TEXT NOT NULL, purpose TEXT NOT NULL, profile_revision INTEGER NOT NULL,
      controls_revision INTEGER NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL, created INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS user_model_strategies_active ON user_model_strategies(subject,purpose,status);`);
  db.exec(`CREATE TABLE IF NOT EXISTS user_model_feedback (
    id TEXT PRIMARY KEY, subject TEXT NOT NULL, storage_key TEXT NOT NULL, strategy_id TEXT NOT NULL,
    change TEXT NOT NULL, detail TEXT NOT NULL, created INTEGER NOT NULL, profile_revision INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS user_model_feedback_scope ON user_model_feedback(subject,storage_key,created);
    CREATE TABLE IF NOT EXISTS user_profile_reflections (
      subject TEXT NOT NULL, source_scope TEXT NOT NULL, fingerprint TEXT NOT NULL,
      controls_revision INTEGER NOT NULL, after_profile_revision INTEGER NOT NULL,
      sources TEXT NOT NULL, actions TEXT NOT NULL, created INTEGER NOT NULL,
      PRIMARY KEY(subject,source_scope,fingerprint));
    CREATE TABLE IF NOT EXISTS user_model_contact_pauses (
      subject TEXT NOT NULL, target TEXT NOT NULL, paused INTEGER NOT NULL, updated INTEGER NOT NULL,
      PRIMARY KEY(subject,target));`);
  // The user's zone for day-based profile rules; NULL (legacy rows included) falls back to the process zone.
  const columns=db.prepare('PRAGMA table_info(user_model_controls)').all() as {name:string}[];
  if(!columns.some(column=>column.name==='time_zone'))db.exec('ALTER TABLE user_model_controls ADD COLUMN time_zone TEXT');
}

/**
 * A subject without a controls row: every switch off, every category list at its default (all seven), no zone. The
 * switches alone decide whether profile learning or reading happens; categories only narrow what an enabled switch uses.
 */
export function defaultProfileControls(subjectId:string):ProfileControls {
  return {subjectId,revision:0,profileLearningEnabled:false,personalizationEnabled:false,
    proactiveCompanionEnabled:false,scheduledWakeEnabled:false,learningCategories:[...profileCategories],readCategories:[...profileCategories],
    strategyCategories:[...profileCategories],proactiveCategories:[...profileCategories],timeZone:null,updatedAtMs:0};
}

export function readProfileControls(db:DatabaseSync,subjectId:string):ProfileControls {
  const row=db.prepare(`SELECT subject,revision,profile_learning,personalization,proactive,scheduled_wake,
    learning_categories,read_categories,strategy_categories,proactive_categories,time_zone,updated
    FROM user_model_controls WHERE subject=?`).get(subjectId) as ControlRow|undefined;
  if(!row)return defaultProfileControls(subjectId);
  return {subjectId:row.subject,revision:row.revision,profileLearningEnabled:row.profile_learning===1,
    personalizationEnabled:row.personalization===1,proactiveCompanionEnabled:row.proactive===1,
    scheduledWakeEnabled:row.scheduled_wake===1,learningCategories:categories(row.learning_categories),
    readCategories:categories(row.read_categories),strategyCategories:categories(row.strategy_categories),
    proactiveCategories:categories(row.proactive_categories),timeZone:storedTimeZone(row.time_zone),updatedAtMs:row.updated};
}

/**
 * Writes the effective lists (a default is prefilled as all seven), so a stored `[]` only ever comes from a legacy row.
 * A list the caller explicitly patched to `[]` (the explicit "none" choice) is stored as the JSON string `"none"`.
 * A patch that omits a list keeps the current one, whose default is all seven.
 */
export function writeProfileControls(db:DatabaseSync,value:ProfileControls):void {
  const serialize=(list:readonly ProfileCategory[])=>JSON.stringify(list.length?list:profileCategoriesNone);
  db.prepare(`INSERT INTO user_model_controls(subject,revision,profile_learning,personalization,proactive,scheduled_wake,
    learning_categories,read_categories,strategy_categories,proactive_categories,time_zone,updated) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(subject) DO UPDATE SET revision=excluded.revision,profile_learning=excluded.profile_learning,
    personalization=excluded.personalization,proactive=excluded.proactive,scheduled_wake=excluded.scheduled_wake,
    learning_categories=excluded.learning_categories,read_categories=excluded.read_categories,
    strategy_categories=excluded.strategy_categories,proactive_categories=excluded.proactive_categories,
    time_zone=excluded.time_zone,updated=excluded.updated`)
    .run(value.subjectId,value.revision,value.profileLearningEnabled?1:0,value.personalizationEnabled?1:0,
      value.proactiveCompanionEnabled?1:0,value.scheduledWakeEnabled?1:0,serialize(value.learningCategories),
      serialize(value.readCategories),serialize(value.strategyCategories),serialize(value.proactiveCategories),
      value.timeZone===undefined?null:value.timeZone,value.updatedAtMs);
}

export function validateCategories(value:unknown):ProfileCategory[] {
  if(!Array.isArray(value)||value.length>profileCategories.length)throw new Error('invalid_profile_categories');
  const result=[...new Set(value)];
  if(result.some(item=>typeof item!=='string'||!profileCategories.includes(item as ProfileCategory)))throw new Error('invalid_profile_categories');
  return result as ProfileCategory[];
}

/** A zone patch: an IANA zone or fixed UTC offset accepted by Intl, or null to fall back to the process zone. */
export function timeZonePatch(value:unknown):string|null {
  if(value===null)return null;
  if(typeof value!=='string'||!value.trim()||value.length>100||!validTimeZone(value.trim()))throw new Error('invalid_profile_time_zone');
  return value.trim();
}

/** The zone that day-based profile rules use: the subject's own zone, else the process zone (else UTC). */
export function profileTimeZone(controls:Pick<ProfileControls,'timeZone'>):string {
  if(controls.timeZone&&validTimeZone(controls.timeZone))return controls.timeZone;
  return Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC';
}

function validTimeZone(value:string):boolean {
  try{new Intl.DateTimeFormat('en-US',{timeZone:value}).format(0);return true;}catch{return false;}
}
function storedTimeZone(value:string|null):string|null {
  return typeof value==='string'&&value.trim()?value:null;
}
function categories(serialized:string):ProfileCategory[] {
  let value:unknown;
  try{value=JSON.parse(serialized);}catch{throw new Error('invalid_profile_controls');}
  if(value===profileCategoriesNone)return [];
  let result:ProfileCategory[];
  try{result=validateCategories(value);}catch{throw new Error('invalid_profile_controls');}
  // Legacy rows stored the never-chosen default as []; it reads as every category.
  return result.length?result:[...profileCategories];
}
