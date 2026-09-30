import path from 'node:path';
import {agentTurnResult,agentConfigurations,type AgentRuntime} from './runtime.ts';
import {safeError} from '../../../shared/src/core/service.ts';
import type {RetrievalConfig} from '../../../shared/src/memory/retrieval.ts';
import {runContext,drainRun,type RunContext} from './run-context.ts';
import {writeJsonAtomic} from './atomic-file.ts';
import {cancelReason,type AgentRequest,type AgentRun,type RunManifest} from './operations-core.ts';

export * from './operations-core.ts';

/** Runs one request operation against an open runtime and returns its result document. */
export async function dispatchOperation(runtime:AgentRuntime,request:AgentRequest):Promise<unknown> {
  let result:unknown;
  switch(request.operation) {
    case 'interaction': result=runtime.interaction(request.scope);break;
    case 'roleplayOpen': result=runtime.openRoleplayTask(request.roster,{directorEnabled:request.directorEnabled});break;
    case 'previewCompanionPreset': result=runtime.previewCompanionPreset(request.scope,request.document);break;
    case 'importCompanionPreset': result=runtime.importCompanionPreset(request.scope,request.document,{expectedVersion:request.expectedVersion,previewId:request.previewId,operationId:request.operationId},request.location,request.subjectId);break;
    case 'companionPreset': result=runtime.companionPreset(request.scope);break;
    case 'initializeCompanionPreset': result=await runtime.initializeCompanionPreset(request.scope);break;
    case 'clock': result=runtime.clock(request.scope);break;
    case 'resources': result=runtime.resources(request.scope);break;
    case 'initializationProvenance': result=runtime.initializationProvenance(request.scope);break;
    case 'previewInitializationRefresh': result=runtime.previewInitializationRefresh(request.scope,request.sources);break;
    case 'refreshInitialization': result=runtime.refreshInitialization(request.scope,request.sources,request.guard);break;
    case 'configureResources': result=runtime.configureResources(request.scope,request.settings);break;
    case 'commitments': result=runtime.commitments(request.scope,request.query);break;
    case 'bindSubject': result=runtime.bindSubject(request.scope,request.subjectId);break;
    case 'profile': result=runtime.profile(request.scope,request.characterId);break;
    case 'relationshipAssessment': result=await runtime.relationshipAssessment(request.scope,request.characterId);break;
    case 'relationshipCorrect': result=runtime.correctRelationship(request.scope,request.characterId,request.correction,request.expectedRevision);break;
    case 'profileControls': result=runtime.setProfileControls(request.scope,request.patch,request.expectedRevision);break;
    case 'profileCorrect': result=runtime.correctProfile(request.scope,request.id,request.correction);break;
    case 'profileDelete': result=runtime.deleteProfile(request.scope,request.id);break;
    case 'profileFeedback': result=runtime.feedbackProfile(request.scope,request.characterId,request.purpose,request.feedback);break;
    case 'profileExport': result=runtime.exportProfile(request.scope);break;
    case 'companionStatus': result=runtime.companionStatus(request.scope,request.characterId);break;
    case 'physiologyStatus': result=runtime.physiologyStatus(request.scope,request.readerId);break;
    case 'configurePhysiology': result=runtime.configurePhysiology(request.scope,request.config,request.expectedRevision);break;
    case 'correctPhysiology': result=runtime.correctPhysiology(request.scope,request.correction,request.expectedRevision);break;
    case 'clearPhysiologyCorrection': result=runtime.clearPhysiologyCorrection(request.scope,request.characterId,request.id,request.expectedRevision);break;
    case 'geographyStatus': result=runtime.geographyStatus(request.scope,request.readerId);break;
    case 'setCompanionLocation': result=runtime.setCompanionLocation(request.scope,request.location);break;
    case 'configureGeography': result=runtime.configureGeography(request.scope,request.config,{expectedRevision:request.expectedRevision,operationId:request.operationId});break;
    case 'previewGeographyImport': result=runtime.previewGeographyImport(request.scope,request.document);break;
    case 'previewGeographyBackground': result=await runtime.previewGeographyBackground(request.scope,request.input);break;
    case 'importGeography': result=runtime.importGeography(request.scope,request.document,{expectedVersion:request.expectedVersion,operationId:request.operationId,documentHash:request.documentHash,allowInitialPositionConflicts:request.allowInitialPositionConflicts});break;
    case 'exportGeography': result=runtime.exportGeography(request.scope,request.readerId);break;
    case 'correctGeography': result=runtime.correctGeography(request.scope,request.correction,{expectedVersion:request.expectedVersion,operationId:request.operationId});break;
    case 'clearGeographyCorrection': result=runtime.clearGeographyCorrection(request.scope,request.id,{expectedVersion:request.expectedVersion,operationId:request.operationId});break;
    case 'saveGeographyLayout': result=runtime.saveGeographyLayout(request.scope,request.readerId??'player',request.layout,{expectedRevision:request.expectedRevision,operationId:request.operationId});break;
    case 'contactSettings': result=runtime.setContactSettings(request.scope,request.settings,request.expectedRevision);break;
    case 'companionBusy': result=runtime.setBusyUntil(request.scope,request.busyUntilMs,request.expectedRevision);break;
    case 'guardSettings': result=runtime.guardSettings(request.scope);break;
    case 'guardSetting': result=runtime.setGuardSetting(request.scope,request.key,request.patch,request.expectedRevision);break;
    case 'guardEvents': result=runtime.guardEvents(request.scope,request.characterId);break;
    case 'contactTendency': result=runtime.contactTendency(request.scope,request.characterId);break;
    case 'setContactTendency': result=runtime.setContactTendency(request.scope,request.characterId,request.patch,request.expectedRevision,request.origin);break;
    case 'companionPoll': result=await runtime.pollCompanion(request.scope,request.characterId,request.trigger);break;
    case 'companionClaim': result=runtime.claimCompanion(request.scope,request.characterId,request.deliveryId);break;
    case 'companionReceipt': result=await runtime.companionReceipt(request.scope,request.characterId,request.deliveryId,request.claimToken,request.outcome);break;
    case 'reconcileCompanion': result=await runtime.reconcileCompanion(request.scope,request.characterId,request.deliveryId,request.outcome);break;
    case 'timeZone': result=runtime.setTimeZone(request.scope,request.timeZone,request.expectedRevision);break;
    case 'configure': result=runtime.configure(request.scope,request.roster);break;
    case 'configureWorld': result=runtime.configureWorld(request.scope,request.settings);break;
    case 'checkpoint': result=runtime.checkpoint(request.scope,request.reason);break;
    case 'checkpoints': result=runtime.checkpoints(request.scope);break;
    case 'restore': result=await runtime.restore(request.scope,request.checkpointId,request.expectedVersion);break;
    case 'undo': result=await runtime.undo(request.scope,request.expectedVersion,request.checkpointId);break;
    case 'restorePreview': result=runtime.previewRestore(request.scope,request.checkpointId);break;
    case 'exportTemplate': result=runtime.exportTemplate(request.scope,request.name);break;
    case 'previewTransfer': result=runtime.previewTransfer(request.scope,request.document);break;
    case 'applyTransfer': result=runtime.applyTransfer(request.scope,request.document,{expectedVersion:request.expectedVersion,previewId:request.previewId,operationId:request.operationId});break;
    case 'deleteReference': result=runtime.deleteReference(request.scope,request.id,{expectedVersion:request.expectedVersion,operationId:request.operationId});break;
    case 'workbench': result=runtime.workbench(request.scope,{view:request.view??'admin',characterId:request.characterId,query:request.query,type:request.type});break;
    case 'progress': result=runtime.progress(request.scope);break;
    case 'retryPending': result=await runtime.retryPending(request.scope,request.sourceId,request.revision);break;
    case 'correctSource': result=await runtime.correctSource(request.scope,request.sourceId,request.revision,request.text,{expectedVersion:request.expectedVersion,operationId:request.operationId});break;
    case 'fork': result=runtime.fork(request.scope,request.branchId,request.checkpointId);break;
    case 'syncState': result=runtime.syncState(request.scope);break;
    case 'sync': result=await runtime.sync(request.scope,request.messages,{expectedVersion:request.expectedVersion,operationId:request.operationId});break;
    case 'reconfirm': result=await runtime.reconfirmSource(request.scope,request.sourceId,{expectedVersion:request.expectedVersion,operationId:request.operationId});break;
    case 'retry': result=await runtime.retry(request.scope);break;
    case 'recall': result=await runtime.recall(request.scope,request.characterId,request.query,request.placeQuery);break;
    case 'turn': {
      if(typeof request.accept!=='boolean')throw new Error('invalid_accept');
      const draft=await runtime.prepare(request.scope,request.envelope,request.input,request.userSubmission,request.placeQuery);
      if(draft.status!=='prepared') {result=draft;break;}
      // accepted + processing:'pending' means both messages are stored and only their analysis awaits retry.
      const receipt=request.accept?await runtime.accept(request.scope,draft.draftId):runtime.reject(request.scope,draft.draftId);
      result=agentTurnResult(request.accept,draft,receipt);
      break;
    }
    case 'roleplayTurn': {
      if(typeof request.accept!=='boolean')throw new Error('invalid_accept');
      const draft=await runtime.prepareRoleplay(request.scope,request.input,request.envelope);
      if(draft.status!=='prepared') {result=draft;break;}
      const receipt=request.accept?await runtime.acceptRoleplay(request.scope,draft.draftId):runtime.rejectRoleplay(request.scope,draft.draftId);
      result={status:request.accept?(receipt.status==='committed'||receipt.status==='duplicate'?'accepted':'failed'):'preview',answer:draft.answer,receipt};
      break;
    }
    case 'regenerate': {
      if(typeof request.accept!=='boolean')throw new Error('invalid_accept');
      const draft=await runtime.regenerate(request.scope);
      if(draft.status!=='prepared'){result=draft;break;}
      const receipt=request.accept?await runtime.accept(request.scope,draft.draftId):runtime.reject(request.scope,draft.draftId);
      result=agentTurnResult(request.accept,draft,receipt);
      break;
    }
    case 'access': runtime.setAccess(request.scope,request.characterId,request.memoryId,request.access);result={status:'updated'};break;
    case 'preference': runtime.setPreference(request.scope,request.characterId,request.id,request.enabled,request.text);result={status:'updated'};break;
    case 'edit': result=await runtime.editSource(request.scope,request.messageId,request.text);break;
    case 'delete': result=await runtime.editSource(request.scope,request.messageId,null);break;
    default: throw new Error('invalid_agent_operation');
  }
  return result;
}

type Retrieval=Partial<RetrievalConfig>|undefined;
export interface ExecuteRunOptions {
  /** Returns the runtime for this run; with closeRuntime it is a fresh runtime that this run owns. */
  openRuntime:(retrieval:Retrieval)=>AgentRuntime|Promise<AgentRuntime>;
  /**
   * True for a runtime opened for this run alone (the file CLI): the run clears pending indexes first, waits for all
   * of the runtime's background work and closes it, so a close refused with agent_background_pending fails the run.
   */
  closeRuntime:boolean;
  /** Finish an interrupted index cleanup (restore/undo) before the operation; always done with closeRuntime. */
  clearIndexes?:boolean;
  request:AgentRequest;
  run:AgentRun;
  context:RunContext;
  /** Reads the retrieval configuration named by the request, or the default file, for this run. */
  loadRetrieval:(retrievalConfigPath:string|undefined)=>Retrieval;
  /** Reports a cancellation requested outside the run directory, such as a signal. */
  cancelled?:()=>boolean;
}

function runStatus(result:unknown):'completed'|'failed' {
  const value=result as {status?:unknown;error?:unknown}|null|undefined;
  return value?.status==='failed'||(value?.status==='pending'&&value?.error)?'failed':'completed';
}

/**
 * Runs one request inside its RunContext and finishes its run directory: result.json is written before the final
 * run.json, both atomically. A run that did not complete stops its host first so queued background jobs settle.
 */
export function executeRun(options:ExecuteRunOptions):Promise<{status:RunManifest['status'];resultPath:string}> {
  return runContext.run(options.context,()=>executeInContext(options));
}

async function executeInContext({openRuntime,closeRuntime,clearIndexes,request,run,context,loadRetrieval,cancelled}:ExecuteRunOptions) {
  const {manifest,directory}=run;
  let runtime:AgentRuntime|undefined;
  const drain=async()=>{await drainRun(context);if(closeRuntime)await runtime?.drainBackground();};
  try {
    const retrieval=loadRetrieval(request.retrievalConfigPath);
    context.configurations=agentConfigurations(retrieval);
    runtime=await openRuntime(retrieval);
    if(closeRuntime||clearIndexes)await runtime.clearPendingIndexes();
    const result=await dispatchOperation(runtime,request);
    // accept/sync/retry/edit queue profile reflection after returning; its host job belongs to this run.
    await drain();
    writeJsonAtomic(manifest.resultPath,result);manifest.status=runStatus(result);
  } catch(error) {
    manifest.status='failed';writeJsonAtomic(manifest.resultPath,{error:safeError(error)});
  } finally {
    try {
      // A failed or cancelled run stops host workers first so queued background jobs settle before closing.
      if(manifest.status!=='completed')context.host.close();
      await drain();if(closeRuntime)runtime?.close();
    } catch(error) {
      if(manifest.status==='completed'){manifest.status='failed';writeJsonAtomic(manifest.resultPath,{error:safeError(error)});}
    }
    context.host.close();context.closed=true;
    const reason=cancelReason(directory)??(cancelled?.()?'user':null);
    if(reason){manifest.status='cancelled';manifest.cancelReason=reason;}
    manifest.finishedAt=new Date().toISOString();writeJsonAtomic(path.join(directory,'run.json'),manifest);
  }
  return {status:manifest.status,resultPath:manifest.resultPath};
}
