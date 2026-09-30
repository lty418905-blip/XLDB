import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {writeJsonAtomic,readJson} from './atomic-file.ts';

// Runtime-free parts of the file-CLI operations: the thin daemon client imports only this module, never the runtime.

/** A file-CLI request document; fields are validated by the runtime method each operation calls. */
export type AgentRequest={operation?:unknown;dataDirectory?:string;retrievalConfigPath?:string;[field:string]:any};

/** Every operation dispatchOperation accepts. */
export const AGENT_OPERATIONS:readonly string[]=Object.freeze(['interaction','roleplayOpen','previewCompanionPreset','importCompanionPreset',
  'companionPreset','initializeCompanionPreset','clock','resources','initializationProvenance','previewInitializationRefresh','refreshInitialization',
  'configureResources','commitments','bindSubject','profile','relationshipAssessment','relationshipCorrect','profileControls','profileCorrect',
  'profileDelete','profileFeedback','profileExport','companionStatus','physiologyStatus','configurePhysiology','correctPhysiology',
  'clearPhysiologyCorrection','geographyStatus','setCompanionLocation','configureGeography','previewGeographyImport','previewGeographyBackground',
  'importGeography','exportGeography','correctGeography','clearGeographyCorrection','saveGeographyLayout','contactSettings','companionBusy',
  'guardSettings','guardSetting','guardEvents','contactTendency','setContactTendency','companionPoll','companionClaim','companionReceipt','reconcileCompanion','timeZone','configure',
  'configureWorld','checkpoint','checkpoints','restore','undo','restorePreview','exportTemplate','previewTransfer','applyTransfer','deleteReference',
  'workbench','progress','retryPending','correctSource','fork','syncState','sync','reconfirm','retry','recall','turn','roleplayTurn','regenerate',
  'access','preference','edit','delete']);
/** Synchronous runtime reads that never delegate; they write nothing beyond the idempotent companion interaction binding. */
const READ_OPERATIONS=new Set(['syncState','progress','workbench','interaction','clock','checkpoints','restorePreview',
  'profile','profileExport','commitments','resources','initializationProvenance','previewInitializationRefresh',
  'companionStatus','companionPreset','previewCompanionPreset',
  'physiologyStatus','geographyStatus','exportGeography','previewGeographyImport','previewTransfer','exportTemplate',
  'guardSettings','guardEvents','contactTendency']);
/** Delivery steps must not wait behind a long write (a claim lease is short). They may write and start host jobs. */
const DELIVERY_OPERATIONS=new Set(['companionClaim','companionReceipt','reconcileCompanion']);
/** Operations that mean the user is talking to the companion right now. */
export const CONVERSATION_OPERATIONS:ReadonlySet<string>=new Set(['turn','roleplayTurn','regenerate','recall']);
const KNOWN_OPERATIONS=new Set(AGENT_OPERATIONS);

export type OperationClass='read'|'delivery'|'write';
/** Reads and delivery steps run at once; writes run one at a time. An unknown operation is a read that fails at once. */
export function operationClass(operation:unknown):OperationClass {
  if(typeof operation!=='string'||!KNOWN_OPERATIONS.has(operation)||READ_OPERATIONS.has(operation))return 'read';
  return DELIVERY_OPERATIONS.has(operation)?'delivery':'write';
}

export type CancelReason='user'|'client_lost'|'daemon_shutdown';
export interface RunManifest {
  id:string;
  operation:unknown;
  status:'running'|'completed'|'failed'|'cancelled';
  startedAt:string;
  resultPath:string;
  finishedAt?:string;
  /** 'none' for a run that no executor took (the client recorded why it never ran). */
  executor?:'daemon'|'in-process'|'none';
  cancelReason?:CancelReason;
  [field:string]:unknown;
}
export interface AgentRun {id:string;directory:string;manifest:RunManifest}

/** The directory a run with this id lives in. */
export function runDirectoryOf(root:string,id:string):string {return path.join(root,'.local/agent/runs',id);}

/** Creates `<root>/.local/agent/runs/<id>/` with a running run.json; the id may be chosen (and recorded) beforehand. */
export function createRun(root:string,operation:unknown,fields:Record<string,unknown>={},id:string=randomUUID()):AgentRun {
  const directory=runDirectoryOf(root,id);
  fs.mkdirSync(directory,{recursive:true});
  const manifest:RunManifest={id,operation,status:'running',startedAt:new Date().toISOString(),resultPath:path.join(directory,'result.json'),...fields};
  writeJsonAtomic(path.join(directory,'run.json'),manifest);
  return {id,directory,manifest};
}

export function writeRunManifest(run:AgentRun):void {writeJsonAtomic(path.join(run.directory,'run.json'),run.manifest);}

/** The run's manifest, or null while it cannot be read. */
export function readRunManifest(directory:string):RunManifest|null {
  try {return readJson<RunManifest>(path.join(directory,'run.json'));} catch {return null;}
}

/** The reason recorded in the run's cancel.json; a cancel.json without one (`cli cancel`) is the user's. */
export function cancelReason(directory:string):CancelReason|null {
  const file=path.join(directory,'cancel.json');
  if(!fs.existsSync(file))return null;
  try {
    const reason=readJson<{reason?:unknown}>(file).reason;
    return reason==='client_lost'||reason==='daemon_shutdown'?reason:'user';
  } catch {return 'user';}
}

/**
 * Writes cancel.json unless one exists; the first reason wins. The document is complete before it appears: a temporary
 * file is hard-linked into place, which fails rather than replaces when cancel.json already exists.
 */
export function requestCancel(directory:string,reason:CancelReason):void {
  const target=path.join(directory,'cancel.json');
  const temporary=path.join(directory,`.cancel.json.${randomUUID()}.tmp`);
  fs.writeFileSync(temporary,JSON.stringify({requestedAt:new Date().toISOString(),reason}),{flag:'wx'});
  try {fs.linkSync(temporary,target);}
  catch(error) {if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
  finally {fs.rmSync(temporary,{force:true});}
}

/** Ends a run that never executed: result.json first, then the final run.json. */
export function finishUnstartedRun(run:AgentRun,status:'failed'|'cancelled',error:string,fields:Record<string,unknown>={}):void {
  writeJsonAtomic(run.manifest.resultPath,{error});
  Object.assign(run.manifest,fields,{status,finishedAt:new Date().toISOString()});
  writeRunManifest(run);
}
