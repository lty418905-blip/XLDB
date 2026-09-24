import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {AgentRuntime} from '../../src/agent/runtime.ts';
import {createFileHost,listPending} from '../../src/agent/file-host.ts';
import {safeError} from '../../src/core/service.ts';
import {loadRetrievalConfig} from './retrieval-config.mjs';
import {startCompanionOnboarding} from './onboarding.mjs';

const root=fileURLToPath(new URL('../../',import.meta.url));
const [command,argument,...rest]=process.argv.slice(2);
if(command==='onboard') {
  if(!argument||rest.some(value=>value!=='--no-open'))throw new Error('Usage: node adapters/agent/cli.mjs onboard REQUEST_JSON [--no-open]');
  const request=JSON.parse(fs.readFileSync(path.resolve(argument),'utf8'));
  const dataDirectory=path.resolve(request.dataDirectory??path.join(root,'.local/agent/data'));
  const allowedRoot=path.join(root,'.local');
  if(!dataDirectory.startsWith(allowedRoot+path.sep))throw new Error('Agent dataDirectory must be inside workspace .local');
  fs.mkdirSync(dataDirectory,{recursive:true});
  const runtime=new AgentRuntime({databasePath:path.join(dataDirectory,'authority.sqlite'),indexPath:path.join(dataDirectory,'indexes'),delegate:async()=>{throw Error('host_delegate_unavailable');}});
  let session;
  const openBrowser=async url=>{
    if(rest.includes('--no-open'))return;
    const executable=process.platform==='win32'?'rundll32.exe':process.platform==='darwin'?'open':'xdg-open';
    const args=process.platform==='win32'?['url.dll,FileProtocolHandler',url]:[url];
    await new Promise((resolve,reject)=>{
      const child=spawn(executable,args,{windowsHide:true,stdio:'ignore'});
      child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(Error('browser_open_failed')));
    });
  };
  try{
    session=await startCompanionOnboarding({runtime,scope:request.scope,openBrowser});
    if(session.url)console.log(JSON.stringify({status:'waiting_for_selection',url:session.url,scope:request.scope,
      ...(session.browserOpenFailed?{browserOpenFailed:true}: {})}));
    const stop=()=>session.close();process.once('SIGINT',stop);process.once('SIGTERM',stop);
    const result=await session.result;
    process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);
    console.log(JSON.stringify(result));
    if(result.status==='failed')process.exitCode=1;
  }finally{session?.close();runtime.close();}
} else if(command==='cancel') {
  if(!argument||rest.length)throw new Error('Usage: node adapters/agent/cli.mjs cancel RUN_DIRECTORY');
  const directory=path.resolve(argument);const run=JSON.parse(fs.readFileSync(path.join(directory,'run.json'),'utf8'));
  if(run.status==='running')fs.writeFileSync(path.join(directory,'cancel.json'),JSON.stringify({requestedAt:new Date().toISOString()}));
  console.log(JSON.stringify({status:run.status==='running'?'cancel_requested':run.status}));
} else if(command==='jobs') {
  if(!argument||rest.length)throw new Error('Usage: node adapters/agent/cli.mjs jobs RUN_DIRECTORY');
  console.log(JSON.stringify(await listPending(path.resolve(argument))));
} else if(command==='run') {
  if(!argument||rest.length)throw new Error('Usage: node adapters/agent/cli.mjs run REQUEST_JSON');
  const request=JSON.parse(fs.readFileSync(path.resolve(argument),'utf8'));
  const directory=path.join(root,'.local/agent/runs',randomUUID());
  fs.mkdirSync(directory,{recursive:true});
  const dataDirectory=path.resolve(request.dataDirectory??path.join(root,'.local/agent/data'));
  const allowedRoot=path.join(root,'.local');
  if(!dataDirectory.startsWith(allowedRoot+path.sep))throw new Error('Agent dataDirectory must be inside workspace .local');
  fs.mkdirSync(dataDirectory,{recursive:true});
  const manifest={id:path.basename(directory),operation:request.operation,status:'running',startedAt:new Date().toISOString(),resultPath:path.join(directory,'result.json')};
  const save=()=>fs.writeFileSync(path.join(directory,'run.json'),JSON.stringify(manifest,null,2));
  save();console.log(JSON.stringify({runDirectory:directory,operation:request.operation,status:'running'}));
  let host;let runtime;let cancelled=false;
  const cancel=()=>{cancelled=true;host?.close();};
  process.once('SIGINT',cancel);process.once('SIGTERM',cancel);
  try {
    const retrieval=loadRetrievalConfig(root,request.retrievalConfigPath);
    host=createFileHost(directory);runtime=new AgentRuntime({databasePath:path.join(dataDirectory,'authority.sqlite'),indexPath:path.join(dataDirectory,'indexes'),delegate:host.delegate,retrieval});
    await runtime.clearPendingIndexes();
    let result;
    switch(request.operation) {
      case 'interaction': result=runtime.interaction(request.scope);break;
      case 'roleplayOpen': result=runtime.openRoleplayTask(request.roster,{directorEnabled:request.directorEnabled});break;
      case 'previewCompanionPreset': result=runtime.previewCompanionPreset(request.scope,request.document);break;
      case 'importCompanionPreset': result=runtime.importCompanionPreset(request.scope,request.document,{expectedVersion:request.expectedVersion,previewId:request.previewId,operationId:request.operationId});break;
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
        const receipt=request.accept?await runtime.accept(request.scope,draft.draftId):runtime.reject(request.scope,draft.draftId);
        result={status:request.accept?(receipt.status==='committed'||receipt.status==='duplicate'?'accepted':'failed'):'preview',answer:draft.answer,userMessageId:draft.userMessageId,receipt};
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
        result={status:request.accept?(receipt.status==='committed'||receipt.status==='duplicate'?'accepted':'failed'):'preview',answer:draft.answer,receipt};
        break;
      }
      case 'access': runtime.setAccess(request.scope,request.characterId,request.memoryId,request.access);result={status:'updated'};break;
      case 'preference': runtime.setPreference(request.scope,request.characterId,request.id,request.enabled,request.text);result={status:'updated'};break;
      case 'edit': result=await runtime.editSource(request.scope,request.messageId,request.text);break;
      case 'delete': result=await runtime.editSource(request.scope,request.messageId,null);break;
      default: throw new Error('invalid_agent_operation');
    }
    fs.writeFileSync(manifest.resultPath,JSON.stringify(result,null,2));manifest.status=result?.status==='failed'||(result?.status==='pending'&&result?.error)?'failed':'completed';
    if(manifest.status==='failed')process.exitCode=1;
  } catch(error) {
    manifest.status='failed';fs.writeFileSync(manifest.resultPath,JSON.stringify({error:safeError(error)},null,2));process.exitCode=1;
  } finally {
    host?.close();runtime?.close();if(cancelled||fs.existsSync(path.join(directory,'cancel.json'))){manifest.status='cancelled';process.exitCode=1;}
    process.removeListener('SIGINT',cancel);process.removeListener('SIGTERM',cancel);
    manifest.finishedAt=new Date().toISOString();save();
    console.log(JSON.stringify({status:manifest.status,resultPath:manifest.resultPath}));
  }
} else throw new Error('Usage: node adapters/agent/cli.mjs onboard REQUEST_JSON | run REQUEST_JSON | jobs RUN_DIRECTORY | cancel RUN_DIRECTORY');
