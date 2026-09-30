import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {AgentRuntime} from './runtime.ts';
import {createFileHost,listPending} from './file-host.ts';
import {executeRun,operationClass,createRun,writeRunManifest,readRunManifest,requestCancel,finishUnstartedRun,cancelReason,runDirectoryOf,
  CONVERSATION_OPERATIONS,type AgentRequest,type AgentRun,type CancelReason,type OperationClass} from './operations.ts';
import {routedDelegate,type RunContext} from './run-context.ts';
import {DaemonEvents} from './daemon-events.ts';
import {acquireAuthorityLease,type AuthorityLease} from '../../../shared/src/scene/backup.ts';
import {closeEmotionRanker} from '../../../shared/src/scene/emotion-scheduler.ts';
import type {RetrievalConfig} from '../../../shared/src/memory/retrieval.ts';
import {PROTOCOL,DRAIN_LIMIT_MS,SELF_IDENTITY_LIMIT_MS,daemonPaths,inboxFile,readJsonFile,writeJsonAtomic,pidAlive,validateRequest,selfCreatedAt,
  realDataDirectory,type DaemonReceipt,type InboxRequest,type RejectReason,type StopReason} from './daemon-protocol.ts';

export interface ServeOptions {
  root:string;
  entryPath:string;
  dataDirectory:string;
  stay:boolean;
  sessionIdleMs:number;
  stopGraceMs:number;
  conversationWindowMs:number;
  /** Upper bound of the shutdown drain; DRAIN_LIMIT_MS unless a test shortens it. */
  drainLimitMs?:number;
  logPaths?:{stdout:string|null;stderr:string|null};
  loadRetrieval:(retrievalConfigPath:string|undefined)=>Partial<RetrievalConfig>|undefined;
}

interface DaemonRun {
  requestId:string;
  run:AgentRun;
  request:AgentRequest;
  operationClass:OperationClass;
  clientPid:number;
  context?:RunContext;
  done?:Promise<void>;
}

const TICK_MS=100;
const PATROL_MS=2_000;
const IDLE_CHECK_MS=1_000;
const HEARTBEAT_MS=5_000;
/** Answer files a client never collected are removed after this long. */
const STALE_ANSWER_MS=5*60_000;
/**
 * Test-only faults, read from the environment of `daemon serve`: `drain_stuck` keeps the shutdown drain busy until its
 * limit; `crash_on_status` throws outside any handler when a status request arrives; `identity_unavailable` acts as
 * if CIM never described the daemon's own process.
 */
const FAULT=process.env.XLDB_DAEMON_TEST_FAULT??'';
const log=(message:string)=>console.log(`${new Date().toISOString()} ${message}`);
const now=()=>new Date().toISOString();
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));

/**
 * Runs the resident daemon for one data directory until it is stopped or idle, and returns the process exit code:
 * 0 after a clean shutdown, 1 after an unclean one, 3 when another process holds the database.
 */
export async function serve(options:ServeOptions):Promise<number> {
  const dataDirectory=realDataDirectory(options.dataDirectory);
  const paths=daemonPaths(options.root,dataDirectory);
  for(const directory of [paths.directory,paths.inbox,paths.activeRuns])fs.mkdirSync(directory,{recursive:true});
  const databasePath=path.join(dataDirectory,'authority.sqlite');
  // CIM takes about a second (far longer on a loaded machine); it runs while the database opens, and is killed if the
  // daemon gives up first.
  const cim=new AbortController();
  const selfInfo=FAULT==='identity_unavailable'?Promise.resolve(null):selfCreatedAt(cim.signal,Date.now()+SELF_IDENTITY_LIMIT_MS);
  // 1. Lease probe. The receipt is written only after the lease is ours, so a losing concurrent start never overwrites it.
  let lease:AuthorityLease;
  try {lease=acquireAuthorityLease(databasePath,'server');}
  catch(error) {
    const code=error instanceof Error?error.message:String(error);
    log(`lease unavailable: ${code}`);cim.abort();
    return code==='backup_database_active'?3:1;
  }
  // 2-3. One runtime for every run; idle learning stays off until the daemon runs it itself (D2).
  let runtime:AgentRuntime;
  try {
    runtime=new AgentRuntime({databasePath,indexPath:path.join(dataDirectory,'indexes'),delegate:routedDelegate,idleLearning:false});
    await runtime.clearPendingIndexes();
  } catch(error) {
    log(`runtime failed to open: ${error instanceof Error?error.message:String(error)}`);lease.release();cim.abort();return 1;
  }

  // 5. The creation time clients compare against CIM (queried while the database opened). Without it no client could
  // ever verify this daemon, which would still hold the lease: it gives up instead of serving unverifiable.
  const processCreatedAt=await selfInfo;
  if(!processCreatedAt) {
    log(`identity unavailable: CIM did not describe this process within ${SELF_IDENTITY_LIMIT_MS} ms`);
    try {runtime.close();} catch(error) {log(`runtime close failed: ${error instanceof Error?error.message:String(error)}`);}
    lease.release();return 1;
  }
  const receipt:DaemonReceipt={schemaVersion:1,protocol:PROTOCOL,status:'running',pid:process.pid,processCreatedAt,
    root:options.root,nodePath:process.execPath,entryPath:options.entryPath,dataDirectory,daemonKey:paths.key,startedAt:now(),stay:options.stay,
    sessionIdleMs:options.sessionIdleMs,stopGraceMs:options.stopGraceMs,conversationWindowMs:options.conversationWindowMs,
    logPaths:options.logPaths??{stdout:null,stderr:null}};
  const queue:DaemonRun[]=[];
  const running=new Map<string,DaemonRun>();
  let writeRunning=false;
  let stopping=false;
  /** Why this daemon is stopping; a request refused as daemon_stopping carries it. */
  let stopReason:StopReason|null=null;
  let lastSeenAt=Date.now();
  let lastHeartbeatAt=0;
  const events=new DaemonEvents({conversationWindowMs:options.conversationWindowMs,sources:{
    running:()=>running.size,
    pendingJobs:()=>[...running.values()].map(entry=>({runDirectory:entry.run.directory,operation:entry.run.manifest.operation,
      jobs:listPending(entry.run.directory).map(job=>({id:job.id,stage:job.stage,kind:job.kind}))})),
    noticesDirectory:paths.notices,
    processingPending:scope=>runtime.processingPending(scope as Parameters<AgentRuntime['processingPending']>[0])}});

  const session=(kind:string|null,clientPid:number|null)=>{
    lastSeenAt=Date.now();
    writeJsonAtomic(paths.session,{lastSeenAt:new Date(lastSeenAt).toISOString(),lastKind:kind,clientPid,
      idleExitAt:options.stay?null:new Date(lastSeenAt+options.sessionIdleMs).toISOString()});
  };

  const reject=(requestId:string,error:RejectReason)=>{
    writeJsonAtomic(inboxFile(paths,requestId,'rejected'),{protocol:PROTOCOL,requestId,error,at:now(),
      ...(error==='daemon_stopping'&&stopReason?{stopReason}:{})});
    fs.rmSync(inboxFile(paths,requestId,'claimed'),{force:true});
  };
  const forget=(entry:DaemonRun)=>{
    fs.rmSync(path.join(paths.activeRuns,`${entry.run.id}.json`),{force:true});
    // The claimed request may carry message text or coordinates; it lives only as long as its run.
    fs.rmSync(inboxFile(paths,entry.requestId,'claimed'),{force:true});
  };
  /** Run-end hook: the run_finished event, then (for runs that may write) whether accepted text still awaits analysis. */
  const finished=(entry:DaemonRun)=>{
    events.runFinished(entry.run.directory,entry.run.manifest.operation,readRunManifest(entry.run.directory)?.status??entry.run.manifest.status);
    const scope=entry.request.scope;
    if(entry.operationClass==='read'||!scope||typeof scope!=='object'||stopping)return;
    try {events.processingPending(scope,runtime.processingPending(scope),entry.run.directory);}
    catch {/* a scope the run could not use has nothing pending */}
  };
  const cancelQueued=(entry:DaemonRun,reason:CancelReason)=>{
    const index=queue.indexOf(entry);if(index>=0)queue.splice(index,1);
    finishUnstartedRun(entry.run,'cancelled','run_not_started',{cancelReason:reason,queued:false});
    forget(entry);
    events.runFinished(entry.run.directory,entry.run.manifest.operation,'cancelled');
  };
  const start=(entry:DaemonRun)=>{
    if(entry.run.manifest.queued){entry.run.manifest.queued=false;entry.run.manifest.dequeuedAt=now();writeRunManifest(entry.run);}
    let context:RunContext;
    try {context={runId:entry.run.id,host:createFileHost(entry.run.directory),jobs:new Set(),closed:false};}
    catch(error) {
      finishUnstartedRun(entry.run,'failed',error instanceof Error?error.message:'operation_failed');forget(entry);
      events.runFinished(entry.run.directory,entry.run.manifest.operation,'failed');
      if(entry.operationClass==='write')writeRunning=false;
      return;
    }
    entry.context=context;running.set(entry.run.id,entry);
    // Each write run first finishes an index cleanup a restore or undo left pending, as every in-process run does.
    entry.done=executeRun({openRuntime:()=>runtime,closeRuntime:false,clearIndexes:entry.operationClass==='write',request:entry.request,run:entry.run,
      context,loadRetrieval:options.loadRetrieval})
      .then(()=>{},error=>log(`run ${entry.run.id} ended abnormally: ${error instanceof Error?error.message:String(error)}`))
      .finally(()=>{
        running.delete(entry.run.id);forget(entry);finished(entry);
        if(entry.operationClass==='write'){writeRunning=false;pump();}
        lastSeenAt=Math.max(lastSeenAt,Date.now());
      });
  };
  /** Writes run one at a time in arrival order. */
  const pump=()=>{
    while(!writeRunning&&!stopping&&queue.length) {
      const entry=queue.shift()!;
      const reason=cancelReason(entry.run.directory);
      if(reason){cancelQueued(entry,reason);continue;}
      writeRunning=true;start(entry);
    }
  };
  const acceptRun=(doc:InboxRequest)=>{
    const operation=doc.request.operation;
    const cls=operationClass(operation);
    const queued=cls==='write'&&(writeRunning||queue.length>0);
    const position=queued?queue.length+(writeRunning?1:0):0;
    // The run is recorded as active before its directory exists, so a crash in between still fails it on restart.
    const id=randomUUID();const runDirectory=runDirectoryOf(options.root,id);
    writeJsonAtomic(path.join(paths.activeRuns,`${id}.json`),{requestId:doc.requestId,runDirectory,operation,class:cls,clientPid:doc.clientPid,acceptedAt:now()});
    const run=createRun(options.root,operation,{executor:'daemon',requestId:doc.requestId,clientPid:doc.clientPid,queued,...(queued?{queuedAt:now()}:{})},id);
    // Accepted before any database write, so a restart can tell which requests may replay.
    writeJsonAtomic(inboxFile(paths,doc.requestId,'accepted'),{protocol:PROTOCOL,requestId:doc.requestId,runDirectory:run.directory,operation,queued,position,acceptedAt:now()});
    if(typeof operation==='string'&&CONVERSATION_OPERATIONS.has(operation))events.userActive(operation,run.directory);
    const entry:DaemonRun={requestId:doc.requestId,run,request:doc.request,operationClass:cls,clientPid:doc.clientPid};
    if(cls==='write'){queue.push(entry);pump();}
    else start(entry);
  };
  const status=()=>{
    const background=runtime.backgroundStatus();
    return {status:'running',pid:process.pid,startedAt:receipt.startedAt,stay:options.stay,session:readJsonFile(paths.session),conversation:events.conversation(),
      runs:{running:running.size,queued:queue.length},waiters:events.waiterCount,agentJev:background.agentJev,learning:background.learning,runtime:background,
      rssBytes:process.memoryUsage().rss,heartbeatAgeMs:lastHeartbeatAt?Date.now()-lastHeartbeatAt:null};
  };
  /** Validates a claimed request and acts on it; `replay` is set for requests found at startup. */
  const handle=(requestId:string,doc:InboxRequest|null,replay:boolean)=>{
    const invalid=validateRequest(doc,requestId,dataDirectory);
    if(invalid)return reject(requestId,invalid);
    if(stopping)return reject(requestId,'daemon_stopping');
    if(Date.now()>doc!.deadlineAtMs||(replay&&!pidAlive(doc!.clientPid)))return reject(requestId,'request_expired');
    session(doc!.kind,doc!.clientPid);
    if(doc!.kind==='run')return acceptRun(doc!);
    if(doc!.kind==='status') {
      if(FAULT==='crash_on_status')setImmediate(()=>{throw new Error('test_fault_crash_on_status');});
      writeJsonAtomic(inboxFile(paths,requestId,'response'),{protocol:PROTOCOL,requestId,kind:'status',...status()});
      return fs.rmSync(inboxFile(paths,requestId,'claimed'),{force:true});
    }
    // wait: no run directory; the answer is written when an event arrives, at the timeout, or at shutdown.
    const clientPid=doc!.clientPid;
    events.wait({requestId,clientPid,cursor:doc!.wait!.cursor,timeoutMs:doc!.wait!.timeoutMs,respond:reply=>{
      writeJsonAtomic(inboxFile(paths,requestId,'response'),{protocol:PROTOCOL,requestId,kind:'wait',...reply});
      fs.rmSync(inboxFile(paths,requestId,'claimed'),{force:true});
      // The session counts from the answer, not the claim: a wait longer than sessionIdleMs must not leave the daemon
      // already idle when the host is about to send its next wait.
      if(!stopping)session('wait',clientPid);
    }});
  };
  const claim=(requestId:string)=>{
    try {fs.renameSync(inboxFile(paths,requestId,'request'),inboxFile(paths,requestId,'claimed'));}
    catch {return;}// withdrawn by its client, or momentarily locked; a locked one is retried on the next tick
    try {handle(requestId,readJsonFile<InboxRequest>(inboxFile(paths,requestId,'claimed')),false);}
    catch(error) {log(`request ${requestId} failed: ${error instanceof Error?error.message:String(error)}`);reject(requestId,'invalid_daemon_request');}
  };
  /** Request ids in arrival order: by submittedAt, then by file name; an unreadable request sorts last. */
  const requestIds=(state:'request'|'claimed')=>{
    const suffix=`.${state}.json`;
    return fs.readdirSync(paths.inbox).filter(name=>!name.startsWith('.')&&name.endsWith(suffix)).map(name=>{
      const submitted=Date.parse(readJsonFile<{submittedAt?:string}>(path.join(paths.inbox,name))?.submittedAt??'');
      return {id:name.slice(0,-suffix.length),name,submitted:Number.isFinite(submitted)?submitted:Infinity};
    }).sort((a,b)=>a.submitted-b.submitted||(a.name<b.name?-1:a.name>b.name?1:0)).map(item=>item.id);
  };

  // 4. Crash replay: runs a previous instance accepted but never finished fail; unclaimed requests replay only while
  // their client is alive and within the deadline.
  for(const name of fs.readdirSync(paths.activeRuns).filter(name=>name.endsWith('.json')&&!name.startsWith('.'))) {
    const file=path.join(paths.activeRuns,name);
    const active=readJsonFile<{requestId?:string;runDirectory?:string;operation?:unknown;clientPid?:unknown}>(file);
    let manifest=active?.runDirectory?readRunManifest(active.runDirectory):null;
    if(active?.runDirectory&&!manifest) {
      // Recorded as active, but the crash came before its run.json: the run is created failed so its client finds it.
      fs.mkdirSync(active.runDirectory,{recursive:true});
      manifest={id:path.basename(active.runDirectory),operation:active.operation,status:'running',startedAt:now(),
        resultPath:path.join(active.runDirectory,'result.json'),executor:'daemon',requestId:active.requestId,clientPid:active.clientPid};
    }
    if(active?.runDirectory&&manifest?.status==='running') {
      if(!fs.existsSync(manifest.resultPath))writeJsonAtomic(manifest.resultPath,{error:'daemon_restarted'});
      Object.assign(manifest,{status:'failed',failureReason:'daemon_restarted',queued:false,finishedAt:now()});
      writeJsonAtomic(path.join(active.runDirectory,'run.json'),manifest);
    }
    if(active?.requestId&&fs.existsSync(inboxFile(paths,active.requestId,'claimed'))) {
      // Its client may still be waiting for the accepted answer that the crash cut off.
      if(active.runDirectory&&!fs.existsSync(inboxFile(paths,active.requestId,'accepted')))
        writeJsonAtomic(inboxFile(paths,active.requestId,'accepted'),{protocol:PROTOCOL,requestId:active.requestId,runDirectory:active.runDirectory,
          operation:manifest?.operation,queued:false,position:0,acceptedAt:now()});
      fs.rmSync(inboxFile(paths,active.requestId,'claimed'),{force:true});
    }
    fs.rmSync(file,{force:true});
  }
  for(const requestId of requestIds('claimed'))handle(requestId,readJsonFile<InboxRequest>(inboxFile(paths,requestId,'claimed')),true);
  for(const requestId of requestIds('request')) {
    try {fs.renameSync(inboxFile(paths,requestId,'request'),inboxFile(paths,requestId,'claimed'));} catch {continue;}
    handle(requestId,readJsonFile<InboxRequest>(inboxFile(paths,requestId,'claimed')),true);
  }
  fs.rmSync(paths.shutdown,{force:true});

  // 6. The receipt goes out only now that the lease is ours and replayed requests are accepted.
  writeJsonAtomic(paths.receipt,receipt);
  session('start',null);
  log(`daemon ${process.pid} serving ${paths.key} (events ${events.instanceId})`);

  process.once('uncaughtException',error=>{
    log(`crashed: ${error instanceof Error?error.stack:String(error)}`);
    try {writeJsonAtomic(paths.receipt,{...receipt,status:'stopped',stoppedAt:now(),stopReason:'crashed',shutdown:shutdownSteps});} catch {}
    process.exit(1);
  });
  let resolveExit!:(code:number)=>void;
  const exit=new Promise<number>(resolve=>{resolveExit=resolve;});
  const shutdownSteps:{step:string;at:string;unclean?:boolean;note?:string}[]=[];
  /** Records a shutdown step once its action is done. */
  const step=(name:string,extra:Record<string,unknown>={})=>{shutdownSteps.push({step:name,at:now(),...extra});log(`shutdown ${name}`);};
  const drainLimitMs=options.drainLimitMs??DRAIN_LIMIT_MS;
  const shutdown=async(reason:StopReason)=>{
    if(stopping)return;
    stopping=true;stopReason=reason;
    events.stop(reason);
    step('stop_accepting');
    for(const entry of [...queue])cancelQueued(entry,'daemon_shutdown');
    step('cancel_queued');
    const graceEnd=Date.now()+options.stopGraceMs;
    while(running.size&&Date.now()<graceEnd)await sleep(50);
    step('grace_wait');
    for(const entry of running.values()){requestCancel(entry.run.directory,'daemon_shutdown');entry.context?.host.close();}
    step('cancel_running');
    const drainEnd=Date.now()+drainLimitMs;
    const busy=()=>{
      if(FAULT==='drain_stuck')return true;
      const b=runtime.backgroundStatus();
      return running.size>0||b.pendingJobs>0||b.reflectionInFlight>0||b.companionInFlight>0||b.presetInitializations>0||b.relationshipInFlight>0;
    };
    while(busy()&&Date.now()<drainEnd)await sleep(50);
    const unclean=busy();
    step('drain',unclean?{unclean:true}:{});
    closeEmotionRanker();
    step('close_emotion_ranker');
    // The idle-learning worker is stopped inside runtime.close before the Authority closes; in D1 the daemon never
    // starts one (idleLearning:false), which the step records.
    const learningDisabled=runtime.backgroundStatus().learning.state==='disabled';
    let closed=false;
    try {runtime.close();closed=true;}
    catch(error) {log(`runtime close failed: ${error instanceof Error?error.message:String(error)}`);}
    step('learning_worker',learningDisabled?{note:'idle_learning_disabled'}:{});
    try {lease.release();} catch(error) {log(`lease release failed: ${error instanceof Error?error.message:String(error)}`);}
    step('runtime_close',closed?{}:{unclean:true});
    clearInterval(timer);
    writeJsonAtomic(paths.receipt,{...receipt,status:'stopped',stoppedAt:now(),stopReason:reason,shutdown:[...shutdownSteps,{step:'receipt_stopped',at:now()}]});
    step('receipt_stopped');
    fs.rmSync(paths.shutdown,{force:true});
    resolveExit(unclean||!closed?1:0);
  };

  // 7. The inbox timer is not unref'd: it is what keeps the daemon alive.
  let ticks=0;let expected=performance.now()+TICK_MS;let loopLagMs=0;
  const timer=setInterval(()=>{
    const at=performance.now();loopLagMs=Math.max(0,Math.round(at-expected));expected=at+TICK_MS;ticks++;
    try {
      if(!stopping&&fs.existsSync(paths.shutdown))void shutdown('requested');
      for(const requestId of requestIds('request'))claim(requestId);
      for(const entry of [...queue]){const reason=cancelReason(entry.run.directory);if(reason)cancelQueued(entry,reason);}
      events.tick();
      if(ticks%(PATROL_MS/TICK_MS)===0)patrol();
      if(ticks%(IDLE_CHECK_MS/TICK_MS)===0&&!stopping&&!options.stay&&!running.size&&!queue.length&&!events.waiterCount&&
        Date.now()-lastSeenAt>options.sessionIdleMs)
        void shutdown('session_idle');
      if(ticks%(HEARTBEAT_MS/TICK_MS)===1) {
        writeJsonAtomic(paths.heartbeat,{pid:process.pid,at:now(),loopLagMs,running:running.size,queued:queue.length,waiters:events.waiterCount});
        lastHeartbeatAt=Date.now();
      }
    } catch(error) {log(`tick failed: ${error instanceof Error?error.message:String(error)}`);}
  },TICK_MS);
  /** Runs and waits whose client died are dropped; answer files nobody collected are removed. */
  const patrol=()=>{
    for(const entry of [...queue])if(!pidAlive(entry.clientPid))cancelQueued(entry,'client_lost');
    for(const entry of running.values())if(!pidAlive(entry.clientPid))requestCancel(entry.run.directory,'client_lost');
    for(const requestId of events.dropWaiters(clientPid=>!pidAlive(clientPid))) {
      fs.rmSync(inboxFile(paths,requestId,'claimed'),{force:true});
      lastSeenAt=Math.max(lastSeenAt,Date.now());// the idle window starts when the last waiter goes
    }
    for(const name of fs.readdirSync(paths.inbox)) {
      if(!/\.(accepted|rejected|response)\.json$/.test(name))continue;
      const file=path.join(paths.inbox,name);
      try {if(Date.now()-fs.statSync(file).mtimeMs>STALE_ANSWER_MS)fs.rmSync(file,{force:true});} catch {}
    }
  };
  return exit;
}
