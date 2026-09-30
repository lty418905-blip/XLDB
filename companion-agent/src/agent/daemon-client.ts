import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawn,type ChildProcess} from 'node:child_process';
import {createFileHost} from './file-host.ts';
import {createRun,finishUnstartedRun,readRunManifest,requestCancel,type AgentRequest,type AgentRun} from './operations-core.ts';
import {acquireAuthorityLease,type AuthorityLease} from '../../../shared/src/scene/backup.ts';
import type {RetrievalConfig} from '../../../shared/src/memory/retrieval.ts';
import {PROTOCOL,REQUEST_DEADLINE_MS,DRAIN_LIMIT_MS,DEFAULT_SESSION_IDLE_MS,DEFAULT_STOP_GRACE_MS,DEFAULT_CONVERSATION_WINDOW_MS,
  HEARTBEAT_STALE_MS,WAIT_TIMEOUT_DEFAULT_MS,daemonPaths,daemonState,inboxFile,readJsonFile,writeJsonAtomic,pidAlive,leaseOwnerPid,
  processInfo,comparable,realDataDirectory,replaceReceipt,heartbeatAgeMs,
  type DaemonPaths,type DaemonReceipt,type Installation,type RequestKind,type RequestOrigin} from './daemon-protocol.ts';

// The thin client: it talks to a live daemon through the file inbox and imports nothing that loads the runtime.
// Only the in-process fallback loads the runtime (and LanceDB), by dynamic import.

export interface ClientOptions {
  root:string;
  /** This installation's cli.mjs, the script a daemon of this installation runs. */
  entryPath:string;
  /** Absolute data directory; it exists. */
  dataDirectory:string;
  print:(line:unknown)=>void;
}
export interface RunCommandOptions extends ClientOptions {
  request:AgentRequest;
  loadRetrieval:(retrievalConfigPath:string|undefined)=>Partial<RetrievalConfig>|undefined;
}

const ACCEPT_POLL_MS=50;
const RUN_POLL_MS=100;
const LIVENESS_MS=2_000;
/** A daemon whose heartbeat went stale is re-identified through CIM at most this often. */
const RECHECK_MS=30_000;
const REROUTE_POLL_MS=200;
const START_TIMEOUT_MS=60_000;
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));

function installation(options:ClientOptions):Installation {
  return {root:options.root,entryPath:options.entryPath,dataDirectory:realDataDirectory(options.dataDirectory)};
}

/** Places a request in the inbox; the daemon claims it by renaming it. */
function submit(paths:DaemonPaths,install:Installation,kind:RequestKind,origin:RequestOrigin,request:AgentRequest={},
  wait?:{timeoutMs:number;cursor:string|null}):string {
  const requestId=randomUUID();const submitted=Date.now();
  fs.mkdirSync(paths.inbox,{recursive:true});
  writeJsonAtomic(inboxFile(paths,requestId,'request'),{protocol:PROTOCOL,requestId,kind,origin,clientPid:process.pid,
    submittedAt:new Date(submitted).toISOString(),deadlineAtMs:submitted+REQUEST_DEADLINE_MS,dataDirectory:install.dataDirectory,request,...(wait?{wait}:{})});
  return requestId;
}

/** True when the request was taken back; false when the daemon had already claimed it. */
function withdraw(paths:DaemonPaths,requestId:string):boolean {
  const withdrawn=inboxFile(paths,requestId,'withdrawn');
  try {fs.renameSync(inboxFile(paths,requestId,'request'),withdrawn);}
  catch(error) {if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error;}
  fs.rmSync(withdrawn,{force:true});return true;
}

type Answer={state:'accepted'|'rejected'|'response';value:Record<string,any>};
/** Collects (and removes) whichever answer the daemon wrote for the request. */
function collect(paths:DaemonPaths,requestId:string):Answer|null {
  for(const state of ['accepted','rejected','response'] as const) {
    const file=inboxFile(paths,requestId,state);
    const value=readJsonFile<Record<string,any>>(file);
    if(value){fs.rmSync(file,{force:true});return {state,value};}
  }
  return null;
}

/**
 * Tells whether the daemon behind `receipt` is gone. Its pid is probed every 2 s; while its heartbeat is older than
 * HEARTBEAT_STALE_MS the process is also re-identified through CIM (at most every 30 s), which catches a pid reused by
 * another process after the daemon died.
 */
function daemonWatch(paths:DaemonPaths,install:Installation,receipt:DaemonReceipt):()=>boolean {
  let checked=Date.now();let rechecked=0;
  return ()=>{
    if(Date.now()-checked<LIVENESS_MS)return false;
    checked=Date.now();
    if(!pidAlive(receipt.pid))return true;
    if(heartbeatAgeMs(paths,receipt)<=HEARTBEAT_STALE_MS||Date.now()-rechecked<RECHECK_MS)return false;
    rechecked=Date.now();
    const state=daemonState(paths,install,{recheck:true});
    return !state.alive||state.receipt?.pid!==receipt.pid;
  };
}

/**
 * Waits for the daemon's answer. Past the deadline the request is withdrawn; a request the daemon claimed in the
 * meantime is waited for while its process lives. `interrupted` withdraws early.
 */
async function awaitAnswer(paths:DaemonPaths,requestId:string,lost:()=>boolean,interrupted:()=>boolean=()=>false):Promise<Answer|'withdrawn'|'daemon_lost'> {
  const deadline=Date.now()+REQUEST_DEADLINE_MS;let claimed=false;
  for(;;) {
    const answer=collect(paths,requestId);
    if(answer)return answer;
    if(!claimed&&(interrupted()||Date.now()>=deadline)) {
      if(withdraw(paths,requestId))return 'withdrawn';
      claimed=true;
    }
    if(lost()) {
      // A request the vanished daemon never claimed is taken back, so the caller can fall back as for a timeout.
      const late=collect(paths,requestId);
      if(late)return late;
      return !claimed&&withdraw(paths,requestId)?'withdrawn':'daemon_lost';
    }
    await sleep(ACCEPT_POLL_MS);
  }
}

/** A run no executor took: two stdout lines as for any run, executor none, exit code 1. */
function unstartedRun(options:ClientOptions,operation:unknown,status:'failed'|'cancelled',error:string):number {
  const run=createRun(options.root,operation,{executor:'none'});
  options.print({runDirectory:run.directory,operation,status:'running'});
  finishUnstartedRun(run,status,error,status==='cancelled'?{cancelReason:'user'}:{});
  options.print({status,resultPath:run.manifest.resultPath});
  return 1;
}

/** Signal handling shared by both executors: the first SIGINT/SIGTERM cancels, a second one exits at once. */
function interrupts(onFirst:()=>void) {
  let count=0;
  const handler=()=>{count++;if(count>1)process.exit(1);onFirst();};
  process.on('SIGINT',handler);process.on('SIGTERM',handler);
  return {get requested(){return count>0;},dispose(){process.removeListener('SIGINT',handler);process.removeListener('SIGTERM',handler);}};
}

/**
 * Who holds the lease (`pid`, or its current holder): this installation's daemon for this data directory (possibly
 * still starting), another process, or nobody known yet (a holder writes owner.json just after claiming the lease, so
 * it can briefly be missing).
 */
function leaseHolder(install:Installation,pid:number|null=leaseOwnerPid(install.dataDirectory)):'daemon'|'other'|'unknown' {
  if(pid===null||!pidAlive(pid))return 'unknown';
  const command=comparable(processInfo(pid)?.commandLine??'');
  if(!command)return pidAlive(pid)?'other':'unknown';
  return holderOf(install,command);
}
/** A holder's non-empty comparable command line: this installation's daemon for this data directory, or another process. */
function holderOf(install:Installation,command:string):'daemon'|'other' {
  return command.includes(comparable(install.entryPath))&&/\bdaemon"?\s+"?serve\b/.test(command)&&
    command.includes(comparable(install.dataDirectory))?'daemon':'other';
}

type Route={kind:'daemon';receipt:DaemonReceipt}|{kind:'local';lease:AuthorityLease|null}|{kind:'busy';error:string}|{kind:'interrupted'};
/**
 * Where a request goes: a live daemon; else this process, holding a lease probe until its runtime closes (so a daemon
 * cannot take the database in between). A busy database is waited on for up to 30 s, only where a daemon has ever run
 * for this data directory and only while the holder is this installation's daemon (possibly still starting); a holder
 * that is another run or onboard fails at once, as two in-process runs always did.
 */
async function route(paths:DaemonPaths,install:Installation,interrupted:()=>boolean,skipDaemon=false):Promise<Route> {
  // A receipt pid that CIM has just described (and found not to be this daemon) is classified from that answer rather
  // than asked about again: under load one CIM query can take ten seconds or more.
  let described:{pid:number;command:string}|null=null;
  if(!skipDaemon) {
    const state=daemonState(paths,install);
    if(state.alive)return {kind:'daemon',receipt:state.receipt!};
    const command=comparable(state.info?.commandLine??'');
    if(state.receipt&&command)described={pid:state.receipt.pid,command};
  }
  try {return {kind:'local',lease:acquireAuthorityLease(path.join(install.dataDirectory,'authority.sqlite'),'server')};}
  catch(error) {
    const code=error instanceof Error?error.message:String(error);
    // Any other lease error recurs when the runtime opens and fails the request exactly as before.
    if(code!=='backup_database_active')return {kind:'local',lease:null};
    if(!fs.existsSync(paths.directory))return {kind:'busy',error:code};
    const holders=new Map<number,'daemon'|'other'|'unknown'>();
    const until=Date.now()+REQUEST_DEADLINE_MS;
    do {
      if(interrupted())return {kind:'interrupted'};
      const pid=leaseOwnerPid(install.dataDirectory);
      if(pid!==null&&pidAlive(pid)) {
        if(!holders.has(pid))holders.set(pid,described?.pid===pid?holderOf(install,described.command):leaseHolder(install,pid));
        if(holders.get(pid)==='other')return {kind:'busy',error:code};
      }
      await sleep(REROUTE_POLL_MS);
      const state=daemonState(paths,install);
      if(state.alive)return {kind:'daemon',receipt:state.receipt!};
    } while(Date.now()<until);
    return {kind:'busy',error:code};
  }
}

/**
 * `cli run`: through the daemon when it is alive, otherwise in this process (see route). A SIGINT before any executor
 * accepted the request still leaves a run directory, cancelled with run_not_started, and prints both lines.
 */
export async function runCommand(options:RunCommandOptions):Promise<number> {
  const {retrievalConfigPath}=options.request;
  if(retrievalConfigPath!==undefined&&typeof retrievalConfigPath!=='string')
    return unstartedRun(options,options.request.operation,'failed','invalid_retrieval_config');
  const request:AgentRequest={...options.request,dataDirectory:options.dataDirectory,
    ...(retrievalConfigPath===undefined?{}:{retrievalConfigPath:path.resolve(retrievalConfigPath)})};
  const paths=daemonPaths(options.root,options.dataDirectory);
  const install=installation(options);
  let onInterrupt=()=>{};
  const signals=interrupts(()=>onInterrupt());
  const interrupted=()=>signals.requested;
  try {
    let skipDaemon=false;
    for(;;) {
      const target=await route(paths,install,interrupted,skipDaemon);
      if(target.kind==='interrupted')return unstartedRun(options,request.operation,'cancelled','run_not_started');
      if(target.kind==='busy')return unstartedRun(options,request.operation,'failed',target.error);
      if(target.kind==='daemon') {
        const outcome=await runThroughDaemon(options,paths,install,target.receipt,request,interrupted);
        if(outcome!=='fallback')return outcome;
        skipDaemon=true;continue;
      }
      if(interrupted()){target.lease?.release();return unstartedRun(options,request.operation,'cancelled','run_not_started');}
      try {return await runInProcess(options,request,interrupted,callback=>{onInterrupt=callback;});}
      finally {target.lease?.release();}
    }
  } finally {signals.dispose();}
}

async function runThroughDaemon(options:RunCommandOptions,paths:DaemonPaths,install:Installation,receipt:DaemonReceipt,request:AgentRequest,
  interrupted:()=>boolean):Promise<number|'fallback'> {
  const requestId=submit(paths,install,'run','run',request);
  const lost=daemonWatch(paths,install,receipt);
  const answer=await awaitAnswer(paths,requestId,lost,interrupted);
  if(answer==='withdrawn') {
    if(interrupted())return unstartedRun(options,request.operation,'cancelled','run_not_started');
    // Unanswered for the whole deadline: only a daemon that CIM no longer recognizes lets this run fall back.
    return daemonState(paths,install,{recheck:true}).alive?unstartedRun(options,request.operation,'failed','daemon_unresponsive'):'fallback';
  }
  if(answer==='daemon_lost')return unstartedRun(options,request.operation,'failed','daemon_lost');
  if(answer.state!=='accepted')return unstartedRun(options,request.operation,'failed',answer.value.error??'invalid_daemon_request');
  const runDirectory=answer.value.runDirectory as string;
  options.print({runDirectory,operation:request.operation,status:'running'});
  let cancelWritten=false;
  for(;;) {
    const manifest=readRunManifest(runDirectory);
    if(manifest&&manifest.status!=='running') {
      options.print({status:manifest.status,resultPath:manifest.resultPath});
      return manifest.status==='completed'?0:1;
    }
    if(interrupted()&&!cancelWritten&&manifest){requestCancel(runDirectory,'user');cancelWritten=true;}
    if(lost()) {
      // The daemon died with this run unfinished. result.json appears only when the next daemon start marks the run
      // failed (daemon_restarted).
      options.print({status:'failed',resultPath:path.join(runDirectory,'result.json'),error:'daemon_lost'});
      return 1;
    }
    await sleep(RUN_POLL_MS);
  }
}

async function runInProcess(options:RunCommandOptions,request:AgentRequest,interrupted:()=>boolean,
  setInterrupt:(callback:()=>void)=>void):Promise<number> {
  const [{executeRun},{AgentRuntime},{routedDelegate}]=await Promise.all([import('./operations.ts'),import('./runtime.ts'),import('./run-context.ts')]);
  // Loading the runtime takes a second or two; a SIGINT meanwhile means the run never starts.
  if(interrupted())return unstartedRun(options,request.operation,'cancelled','run_not_started');
  const run:AgentRun=createRun(options.root,request.operation,{executor:'in-process'});
  options.print({runDirectory:run.directory,operation:request.operation,status:'running'});
  const context={runId:run.id,host:createFileHost(run.directory),jobs:new Set<Promise<unknown>>(),closed:false};
  setInterrupt(()=>context.host.close());
  const outcome=await executeRun({closeRuntime:true,request,run,context,cancelled:interrupted,loadRetrieval:options.loadRetrieval,
    openRuntime:retrieval=>new AgentRuntime({databasePath:path.join(options.dataDirectory,'authority.sqlite'),
      indexPath:path.join(options.dataDirectory,'indexes'),delegate:routedDelegate,retrieval})});
  options.print({status:outcome.status,resultPath:outcome.resultPath});
  return outcome.status==='completed'?0:1;
}

/** The runtime methods onboarding calls; the runtime itself satisfies it, and so does the daemon proxy. */
export interface OnboardingOperations {
  companionPreset(scope:unknown):unknown;
  previewCompanionPreset(scope:unknown,document:unknown):unknown;
  importCompanionPreset(scope:unknown,document:unknown,guard:{expectedVersion?:unknown;previewId?:unknown;operationId?:unknown},
    location?:unknown,subjectId?:string):unknown;
}

/**
 * The operations onboarding uses, routed per call: a daemon run (origin onboard) while a daemon is alive, otherwise a
 * runtime opened in this process under the same lease probe and re-route rules as `cli run`. A daemon that stops or
 * dies during the session is left for the in-process runtime at the next call (or at once, for a call it never
 * claimed); one that later starts is not used while this process holds the runtime. A daemon call whose result is an
 * `{error}` throws that code, as the runtime method would.
 */
export async function onboardingOperations(options:ClientOptions&{openRuntime:()=>Promise<OnboardingOperations&{close():void}>}):
  Promise<{operations:OnboardingOperations;readonly executor:'daemon'|'in-process';close():void}> {
  const paths=daemonPaths(options.root,options.dataDirectory);
  const install=installation(options);
  type Current={kind:'daemon';receipt:DaemonReceipt}|{kind:'local';runtime:OnboardingOperations&{close():void};lease:AuthorityLease|null};
  const open=async(skipDaemon:boolean):Promise<Current>=>{
    const target=await route(paths,install,()=>false,skipDaemon);
    if(target.kind==='busy'||target.kind==='interrupted')throw new Error(target.kind==='busy'?target.error:'onboarding_interrupted');
    if(target.kind==='daemon')return target;
    let runtime:OnboardingOperations&{close():void};
    try {runtime=await options.openRuntime();} catch(error) {target.lease?.release();throw error;}
    return {kind:'local',runtime,lease:target.lease};
  };
  let current=await open(false);
  let rerouting:Promise<void>|null=null;
  /** Leaves the daemon `from` (once, however many calls notice it is gone). */
  const reroute=(from:Current,skipDaemon:boolean):Promise<void>=>{
    if(current!==from)return Promise.resolve();
    rerouting??=open(skipDaemon).then(next=>{current=next;}).finally(()=>{rerouting=null;});
    return rerouting;
  };
  const call=async(request:AgentRequest,local:(runtime:OnboardingOperations)=>unknown):Promise<unknown>=>{
    for(let attempt=0;attempt<3;attempt++) {
      const here=current;
      if(here.kind==='local')return local(here.runtime);
      if(!daemonState(paths,install).alive){await reroute(here,false);continue;}
      const outcome=await daemonCall(options,paths,install,here.receipt,request);
      if(outcome!==FALLBACK)return outcome;
      // Never claimed, and CIM no longer recognizes the daemon: this call runs in process instead.
      await reroute(here,true);
    }
    throw new Error('daemon_lost');
  };
  return {get executor(){return current.kind==='daemon'?'daemon':'in-process';},
    close:()=>{if(current.kind==='local'){const {runtime,lease}=current;try {runtime.close();} finally {lease?.release();}}},
    operations:{
      companionPreset:scope=>call({operation:'companionPreset',scope},runtime=>runtime.companionPreset(scope)),
      previewCompanionPreset:(scope,document)=>call({operation:'previewCompanionPreset',scope,document},
        runtime=>runtime.previewCompanionPreset(scope,document)),
      importCompanionPreset:(scope,document,guard,location,subjectId)=>call({operation:'importCompanionPreset',scope,document,
        expectedVersion:guard.expectedVersion,previewId:guard.previewId,operationId:guard.operationId,
        ...(location===undefined?{}:{location}),...(subjectId===undefined?{}:{subjectId})},
        runtime=>runtime.importCompanionPreset(scope,document,guard,location,subjectId)),
    }};
}

const FALLBACK=Symbol('fallback');
/**
 * One daemon run for a caller that wants its result, not stdout lines. FALLBACK: the daemon never claimed the request
 * and is gone. A daemon that died after accepting throws daemon_lost; one alive but silent throws daemon_unresponsive.
 */
async function daemonCall(options:ClientOptions,paths:DaemonPaths,install:Installation,receipt:DaemonReceipt,
  request:AgentRequest):Promise<unknown> {
  const requestId=submit(paths,install,'run','onboard',{...request,dataDirectory:options.dataDirectory});
  const lost=daemonWatch(paths,install,receipt);
  const answer=await awaitAnswer(paths,requestId,lost);
  if(answer==='withdrawn'){if(daemonState(paths,install,{recheck:true}).alive)throw new Error('daemon_unresponsive');return FALLBACK;}
  if(answer==='daemon_lost')throw new Error('daemon_lost');
  if(answer.state!=='accepted')throw new Error(answer.value.error==='daemon_stopping'?'daemon_lost':answer.value.error??'invalid_daemon_request');
  const runDirectory=answer.value.runDirectory as string;
  for(;;) {
    const manifest=readRunManifest(runDirectory);
    if(manifest&&manifest.status!=='running') {
      const result=readJsonFile<unknown>(manifest.resultPath);
      const error=(result as {error?:unknown}|null)?.error;
      if(manifest.status!=='completed'||typeof error==='string')throw new Error(typeof error==='string'?error:`run_${manifest.status}`);
      return result;
    }
    if(lost())throw new Error('daemon_lost');
    await sleep(RUN_POLL_MS);
  }
}

export interface WaitOptions extends ClientOptions {timeoutMs:number;cursor:string|null}
/** The one line `cli wait` prints: the same four keys in every case. */
export interface WaitOutput {cursor:string|null;conversation:Record<string,unknown>|null;timedOut:boolean;events:Record<string,unknown>[]}

/**
 * `cli wait`: blocks until the daemon reports an event or the timeout passes. Without a live daemon it answers
 * daemon_stopped/not_running at once; a daemon that dies meanwhile gives daemon_stopped with the reason its receipt
 * records (crashed when it has none). A wait the live daemon refuses for another cause gives one wait_failed event
 * carrying the code (the command then exits 1).
 */
export async function waitCommand(options:WaitOptions):Promise<WaitOutput> {
  const paths=daemonPaths(options.root,options.dataDirectory);
  const install=installation(options);
  const stopped=(reason:string,cursor:string|null=options.cursor):WaitOutput=>
    ({cursor,conversation:null,timedOut:false,events:[{type:'daemon_stopped',at:new Date().toISOString(),reason}]});
  const state=daemonState(paths,install);
  if(!state.alive)return stopped('not_running',null);
  const receipt=state.receipt!;
  const requestId=submit(paths,install,'wait','wait',{},{timeoutMs:options.timeoutMs,cursor:options.cursor});
  const answer=await awaitAnswer(paths,requestId,daemonWatch(paths,install,receipt));
  const stopReason=()=>{
    const current=readJsonFile<DaemonReceipt>(paths.receipt);
    return current?.pid===receipt.pid&&current.status==='stopped'&&current.stopReason?current.stopReason:'crashed';
  };
  if(answer==='daemon_lost')return stopped(stopReason());
  // Not claimed within 30 s by a daemon that still lives: nothing to report, the caller waits again.
  if(answer==='withdrawn')return daemonState(paths,install,{recheck:true}).alive?{cursor:options.cursor,conversation:null,timedOut:true,events:[]}:stopped('crashed');
  if(answer.state==='rejected') {
    const error=typeof answer.value.error==='string'?answer.value.error:'invalid_daemon_request';
    if(error==='daemon_stopping')return stopped(typeof answer.value.stopReason==='string'?answer.value.stopReason:'requested');
    // Claimed only after the request deadline (a stalled daemon): as for an unclaimed request, the caller waits again.
    if(error==='request_expired')return {cursor:options.cursor,conversation:null,timedOut:true,events:[]};
    // The daemon is alive but refused this wait (another data directory, a malformed request): nothing to wait on.
    return {cursor:options.cursor,conversation:null,timedOut:false,events:[{type:'wait_failed',at:new Date().toISOString(),error}]};
  }
  const {cursor,conversation,timedOut,events}=answer.value;
  return {cursor,conversation,timedOut,events};
}

export const WAIT_DEFAULT_MS=WAIT_TIMEOUT_DEFAULT_MS;

export interface EnsureOptions extends ClientOptions {
  start:boolean;
  stay:boolean;
  sessionIdleMs:number;
  stopGraceMs:number;
  conversationWindowMs:number;
}
export interface CommandOutcome {output:Record<string,unknown>;code:number}

function running(paths:DaemonPaths,receipt:DaemonReceipt,started:boolean):CommandOutcome {
  return {output:{status:'running',started,pid:receipt.pid,dataDirectory:receipt.dataDirectory,daemonDirectory:paths.directory,
    stay:receipt.stay,startedAt:receipt.startedAt},code:0};
}

/** Sends a status request (which also refreshes the daemon's session) and returns its response payload. */
async function ask(paths:DaemonPaths,install:Installation,receipt:DaemonReceipt,origin:RequestOrigin):Promise<Record<string,any>|string> {
  const requestId=submit(paths,install,'status',origin);
  const answer=await awaitAnswer(paths,requestId,daemonWatch(paths,install,receipt));
  if(typeof answer==='string')return answer==='withdrawn'?'daemon_unresponsive':answer;
  if(answer.state!=='response')return answer.value.error??'invalid_daemon_request';
  const {protocol:_protocol,requestId:_id,kind:_kind,...payload}=answer.value;
  return payload;
}

/** `cli daemon ensure|start`. A start that loses to a concurrent one adopts the winner; one whose rival vanished retries. */
export async function ensureCommand(options:EnsureOptions):Promise<CommandOutcome> {
  const paths=daemonPaths(options.root,options.dataDirectory);
  const install=installation(options);
  const deadline=Date.now()+START_TIMEOUT_MS;
  let outcome:CommandOutcome|'retry'='retry';
  for(let attempt=0;attempt<3&&outcome==='retry';attempt++) {
    const current=daemonState(paths,install);
    if(current.alive) {
      if(options.start&&attempt===0)return {output:{status:'failed',error:'daemon_already_running',pid:current.receipt!.pid},code:1};
      outcome=await adopt(paths,install,current.receipt!,deadline);
      continue;
    }
    outcome=await startDaemon(options,paths,install,deadline);
  }
  return outcome==='retry'?{output:{status:'failed',error:'daemon_start_failed',logPath:null},code:1}:outcome;
}

/**
 * Reports a daemon this command did not start, after a status request that refreshes its session. A daemon that is
 * stopping or does not answer is waited out (until the ensure deadline) and then replaced: the caller retries.
 */
async function adopt(paths:DaemonPaths,install:Installation,receipt:DaemonReceipt,deadline:number):Promise<CommandOutcome|'retry'> {
  const answer=await ask(paths,install,receipt,'ensure');
  if(typeof answer!=='string')return running(paths,receipt,false);
  // A process CIM no longer recognizes as this daemon (it died; its pid may even be reused) is not waited for.
  if(!daemonState(paths,install,{recheck:true}).alive)return 'retry';
  while(pidAlive(receipt.pid)&&Date.now()<deadline)await sleep(100);
  if(pidAlive(receipt.pid))return {output:{status:'failed',error:answer==='daemon_stopping'?'daemon_stopping':'daemon_unresponsive',pid:receipt.pid},code:1};
  return 'retry';
}

async function startDaemon(options:EnsureOptions,paths:DaemonPaths,install:Installation,deadline:number):Promise<CommandOutcome|'retry'> {
  fs.mkdirSync(paths.logs,{recursive:true});fs.mkdirSync(paths.directory,{recursive:true});
  const stamp=new Date().toISOString().replaceAll(':','-');
  const unique=randomUUID().slice(0,8);
  const logPaths={stdout:path.join(paths.logs,`${paths.key}-${stamp}-${unique}.stdout.log`),stderr:path.join(paths.logs,`${paths.key}-${stamp}-${unique}.stderr.log`)};
  const out=fs.openSync(logPaths.stdout,'a');const err=fs.openSync(logPaths.stderr,'a');
  const args=[options.entryPath,'daemon','serve','--data-directory',install.dataDirectory,'--session-idle-ms',String(options.sessionIdleMs),
    '--stop-grace-ms',String(options.stopGraceMs),'--conversation-window-ms',String(options.conversationWindowMs),
    '--stdout-log',logPaths.stdout,'--stderr-log',logPaths.stderr,...(options.stay?['--stay']:[])];
  let child:ChildProcess;
  try {child=spawn(process.execPath,args,{detached:true,windowsHide:true,stdio:['ignore',out,err],cwd:options.root});}
  finally {fs.closeSync(out);fs.closeSync(err);}
  let exitCode:number|null=null;let spawnFailed=false;
  child.once('exit',code=>{exitCode=code??1;});child.once('error',()=>{spawnFailed=true;});
  child.unref();
  const failed=(error:string):CommandOutcome=>({output:{status:'failed',error,logPath:logPaths.stderr},code:1});
  let rival:number|null=null;let unknownSince=0;
  while(Date.now()<deadline) {
    await sleep(100);
    if(spawnFailed)return failed('daemon_start_failed');
    const state=daemonState(paths,install,exitCode===null&&child.pid?{spawnedPid:child.pid}:{});
    if(state.alive)return state.receipt!.pid===child.pid?running(paths,state.receipt!,true):adopt(paths,install,state.receipt!,deadline);
    if(exitCode===null)continue;
    if(exitCode!==3)return failed('daemon_start_failed');
    // Lost the lease. A concurrent start's daemon may still be opening (wait to adopt it); anything else holding the
    // database means busy; a holder that disappears (or never shows) lets this command try again.
    if(rival!==null){if(leaseOwnerPid(install.dataDirectory)!==rival||!pidAlive(rival))return 'retry';continue;}
    const holder=leaseHolder(install);
    if(holder==='other')return failed('database_busy');
    if(holder==='daemon'){rival=leaseOwnerPid(install.dataDirectory);continue;}
    unknownSince||=Date.now();
    if(Date.now()-unknownSince>2_000)return 'retry';
  }
  if(exitCode===null)child.kill();
  return failed('daemon_start_timeout');
}

/** `cli daemon stop [--force]`. The receipt is only rewritten while it still names the daemon this command stopped. */
export async function stopCommand(options:ClientOptions&{force:boolean}):Promise<CommandOutcome> {
  const paths=daemonPaths(options.root,options.dataDirectory);
  const install=installation(options);
  const state=daemonState(paths,install,{recheck:options.force});
  if(!state.alive)return {output:{status:'not_running'},code:0};
  const receipt=state.receipt!;
  if(options.force) {
    // Ownership was just re-verified through CIM; the lease left behind is reclaimed by the next open.
    try {process.kill(receipt.pid);} catch {}
    const until=Date.now()+10_000;
    while(pidAlive(receipt.pid)&&Date.now()<until)await sleep(50);
    const stopped={...receipt,status:'stopped' as const,stoppedAt:new Date().toISOString(),stopReason:'forced' as const};
    replaceReceipt(paths,receipt.pid,stopped);
    return {output:{status:'stopped',pid:receipt.pid,stopReason:'forced',shutdown:stopped.shutdown??[]},code:0};
  }
  writeJsonAtomic(paths.shutdown,{requestedAt:new Date().toISOString(),clientPid:process.pid});
  const until=Date.now()+receipt.stopGraceMs+DRAIN_LIMIT_MS;
  // The daemon keeps its heartbeat during shutdown; one that went stale is re-identified (its pid may be reused).
  const lost=daemonWatch(paths,install,receipt);
  while(Date.now()<until) {
    const current=readJsonFile<DaemonReceipt>(paths.receipt);
    const stopped=current?.pid===receipt.pid&&current.status==='stopped';
    if(stopped||!pidAlive(receipt.pid)||lost()) {
      // The receipt is final just before process.exit; wait for the exit itself so callers see no process left
      // (not for a pid the daemon no longer owns).
      const exitBy=Date.now()+(stopped?10_000:0);
      while(pidAlive(receipt.pid)&&Date.now()<exitBy)await sleep(50);
      const final=stopped?current!:{...receipt,status:'stopped' as const,stoppedAt:new Date().toISOString(),stopReason:'crashed' as const};
      if(!stopped)replaceReceipt(paths,receipt.pid,final);
      return {output:{status:'stopped',pid:receipt.pid,stopReason:final.stopReason,shutdown:final.shutdown??[]},code:0};
    }
    await sleep(100);
  }
  return {output:{status:'failed',error:'daemon_stop_timeout',pid:receipt.pid},code:1};
}

/** `cli daemon status`. */
export async function statusCommand(options:ClientOptions):Promise<CommandOutcome> {
  const paths=daemonPaths(options.root,options.dataDirectory);
  const install=installation(options);
  const state=daemonState(paths,install);
  if(!state.alive)return {output:{status:'not_running',reason:state.reason,receipt:state.receipt},code:0};
  const payload=await ask(paths,install,state.receipt!,'status');
  if(typeof payload==='string')return {output:{status:'failed',error:payload},code:1};
  return {output:payload,code:0};
}

export const DAEMON_DEFAULTS={sessionIdleMs:DEFAULT_SESSION_IDLE_MS,stopGraceMs:DEFAULT_STOP_GRACE_MS,conversationWindowMs:DEFAULT_CONVERSATION_WINDOW_MS};
