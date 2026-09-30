import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawn,spawnSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {writeJsonAtomic,readJson} from './atomic-file.ts';
import type {AgentRequest} from './operations-core.ts';

// File-inbox protocol shared by the resident daemon and its thin clients. Every file is written atomically and the
// daemon ignores names starting with '.', which are temporaries.

export const PROTOCOL=1;
/** A request not claimed within this window is withdrawn by its client and expired by the daemon. */
export const REQUEST_DEADLINE_MS=30_000;
export const DEFAULT_SESSION_IDLE_MS=30*60_000;
export const DEFAULT_STOP_GRACE_MS=60_000;
export const DEFAULT_CONVERSATION_WINDOW_MS=10*60_000;
/** Upper bound for draining background work during shutdown. */
export const DRAIN_LIMIT_MS=240_000;
/** `cli wait --timeout`: default and accepted range. */
export const WAIT_TIMEOUT_DEFAULT_MS=540_000;
export const WAIT_TIMEOUT_MIN_MS=1_000;
export const WAIT_TIMEOUT_MAX_MS=3_600_000;

export type RequestKind='run'|'wait'|'status';
export type RequestOrigin='run'|'onboard'|'wait'|'status'|'ensure';
export type RejectReason='daemon_stopping'|'daemon_data_directory_mismatch'|'invalid_daemon_request'|'request_expired';
export type StopReason='requested'|'session_idle'|'forced'|'crashed';

export interface InboxRequest {
  protocol:1;
  requestId:string;
  kind:RequestKind;
  origin:RequestOrigin;
  clientPid:number;
  submittedAt:string;
  deadlineAtMs:number;
  dataDirectory:string;
  request:AgentRequest;
  wait?:{timeoutMs:number;cursor:string|null};
}

export interface DaemonReceipt {
  schemaVersion:1;
  protocol:1;
  status:'running'|'stopped';
  pid:number;
  processCreatedAt:string|null;
  root:string;
  nodePath:string;
  entryPath:string;
  dataDirectory:string;
  daemonKey:string;
  startedAt:string;
  stay:boolean;
  sessionIdleMs:number;
  stopGraceMs:number;
  conversationWindowMs:number;
  logPaths:{stdout:string|null;stderr:string|null};
  stoppedAt?:string;
  stopReason?:StopReason;
  shutdown?:{step:string;at:string;unclean?:boolean}[];
}

export interface DaemonPaths {
  key:string;
  directory:string;
  inbox:string;
  activeRuns:string;
  receipt:string;
  ownership:string;
  session:string;
  heartbeat:string;
  shutdown:string;
  notices:string;
  logs:string;
}

/** The data directory as the daemon names it: its native real path. */
export function realDataDirectory(dataDirectory:string):string {return fs.realpathSync.native(dataDirectory);}

/** One daemon per data directory: `<root>/.local/agent/daemon/<key>/`. The data directory must exist. */
export function daemonPaths(root:string,dataDirectory:string):DaemonPaths {
  const key=createHash('sha256').update(realDataDirectory(dataDirectory).toLowerCase()).digest('hex').slice(0,16);
  const directory=path.join(root,'.local/agent/daemon',key);
  const inbox=path.join(directory,'inbox');
  return {key,directory,inbox,activeRuns:path.join(directory,'active-runs'),receipt:path.join(directory,'receipt.json'),
    ownership:path.join(directory,'ownership.json'),session:path.join(directory,'session.json'),heartbeat:path.join(directory,'heartbeat.json'),
    shutdown:path.join(inbox,'shutdown.request'),notices:path.join(directory,'notices'),logs:path.join(root,'.local/logs/agent-daemon')};
}

export type InboxState='request'|'claimed'|'withdrawn'|'accepted'|'rejected'|'response';
export function inboxFile(paths:DaemonPaths,requestId:string,state:InboxState):string {
  return path.join(paths.inbox,`${requestId}.${state}.json`);
}

/** Parsed JSON, or null when the file is missing, unreadable (a concurrent rename on Windows) or malformed. */
export function readJsonFile<T>(file:string):T|null {
  try {return readJson<T>(file);} catch {return null;}
}

export {writeJsonAtomic};

export function pidAlive(pid:unknown):boolean {
  if(!Number.isSafeInteger(pid)||(pid as number)<=0)return false;
  try {process.kill(pid as number,0);return true;}
  catch(error) {return (error as NodeJS.ErrnoException).code!=='ESRCH';}
}

/** The pid recorded by whoever holds the data directory's Authority lease. */
export function leaseOwnerPid(dataDirectory:string):number|null {
  const owner=readJsonFile<{pid?:unknown}>(path.join(dataDirectory,'authority.sqlite.xldb-guard','active','owner.json'));
  return Number.isSafeInteger(owner?.pid)?owner!.pid as number:null;
}

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Checks the envelope only; the run request itself is validated by the operation it names. */
export function validateRequest(value:unknown,requestId:string,dataDirectory:string):RejectReason|null {
  const doc=value as Partial<InboxRequest>|null;
  if(!doc||typeof doc!=='object'||doc.protocol!==PROTOCOL||doc.requestId!==requestId||!UUID.test(requestId))return 'invalid_daemon_request';
  if(doc.kind!=='run'&&doc.kind!=='wait'&&doc.kind!=='status')return 'invalid_daemon_request';
  if(!['run','onboard','wait','status','ensure'].includes(doc.origin as string))return 'invalid_daemon_request';
  if(!Number.isSafeInteger(doc.clientPid)||!Number.isFinite(doc.deadlineAtMs)||typeof doc.dataDirectory!=='string')return 'invalid_daemon_request';
  if(doc.kind==='run'&&(!doc.request||typeof doc.request!=='object'||Array.isArray(doc.request)))return 'invalid_daemon_request';
  if(doc.kind==='wait'&&(!doc.wait||!Number.isSafeInteger(doc.wait.timeoutMs)||doc.wait.timeoutMs<WAIT_TIMEOUT_MIN_MS||
    doc.wait.timeoutMs>WAIT_TIMEOUT_MAX_MS||(doc.wait.cursor!==null&&typeof doc.wait.cursor!=='string')))return 'invalid_daemon_request';
  if(comparable(doc.dataDirectory)!==comparable(dataDirectory))return 'daemon_data_directory_mismatch';
  return null;
}

/** Windows paths compare case-insensitively and with either slash. */
export function comparable(value:string):string {return value.replaceAll('\\','/').toLowerCase();}

export interface ProcessInfo {executablePath:string|null;commandLine:string|null;createdAt:string|null}
const CIM_SCRIPT="$p=Get-CimInstance Win32_Process -Filter (\"ProcessId=\"+$env:XLDB_CIM_PID); "+
  "if($p){[pscustomobject]@{executablePath=$p.ExecutablePath;commandLine=$p.CommandLine;"+
  "createdAt=if($p.CreationDate){$p.CreationDate.ToUniversalTime().ToString('o')}else{$null}}|ConvertTo-Json -Compress}";
/** PowerShell 7 starts in about 0.6 s, Windows PowerShell in about 2.4 s; pwsh is tried first, powershell.exe when it is absent. */
let shell='pwsh';
/** A CIM query that has not answered within this time is killed and counts as unanswered. */
export const CIM_TIMEOUT_MS=15_000;
function cimArgs(pid:number) {
  return {args:['-NoLogo','-NoProfile','-NonInteractive','-Command',CIM_SCRIPT],env:{...process.env,XLDB_CIM_PID:String(pid)}};
}
function parseInfo(stdout:string):ProcessInfo|null {
  const text=stdout.trim();if(!text)return null;
  try {
    const value=JSON.parse(text) as ProcessInfo;
    return {executablePath:value.executablePath??null,commandLine:value.commandLine??null,createdAt:value.createdAt??null};
  } catch {return null;}
}
const missing=(error:unknown)=>(error as NodeJS.ErrnoException|undefined)?.code==='ENOENT';

/** Executable, command line and creation time of a process, from CIM on Windows; null when it does not exist. */
export function processInfo(pid:number):ProcessInfo|null {
  if(process.platform!=='win32')return posixProcessInfo(pid);
  const {args,env}=cimArgs(pid);
  let result=spawnSync(shell,args,{encoding:'utf8',windowsHide:true,env,timeout:CIM_TIMEOUT_MS});
  if(missing(result.error)&&shell==='pwsh'){shell='powershell.exe';result=spawnSync(shell,args,{encoding:'utf8',windowsHide:true,env,timeout:CIM_TIMEOUT_MS});}
  return result.status===0?parseInfo(result.stdout):null;
}

/**
 * The same query without blocking the event loop (the daemon asks about itself while it opens the database). It is
 * killed after `timeoutMs` (CIM_TIMEOUT_MS by default) or when `signal` aborts, and then answers null.
 */
export function processInfoAsync(pid:number,signal?:AbortSignal,timeoutMs=CIM_TIMEOUT_MS):Promise<ProcessInfo|null> {
  if(process.platform!=='win32')return Promise.resolve(posixProcessInfo(pid));
  const {args,env}=cimArgs(pid);
  const attempt=(executable:string)=>new Promise<ProcessInfo|null|'missing'>(resolve=>{
    let stdout='';
    const child=spawn(executable,args,{windowsHide:true,env,stdio:['ignore','pipe','ignore'],timeout:timeoutMs,...(signal?{signal}:{})});
    child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>{stdout+=chunk;});
    child.once('error',error=>resolve(missing(error)?'missing':null));
    child.once('close',code=>resolve(code===0?parseInfo(stdout):null));
  });
  return attempt(shell).then(answer=>{
    if(answer!=='missing')return answer;
    if(shell==='pwsh')shell='powershell.exe';else return null;
    return attempt(shell).then(value=>value==='missing'?null:value);
  });
}

/**
 * How long a starting daemon keeps asking CIM for its own creation time. On a loaded machine one query can outlast
 * CIM_TIMEOUT_MS; the limit stays below the 60 s an ensure waits for the receipt.
 */
export const SELF_IDENTITY_LIMIT_MS=40_000;
/** Pause before asking again after a query that ended without a creation time. */
const SELF_IDENTITY_RETRY_MS=250;
/**
 * This process's creation time from CIM. A query may run until `until`; one that ends sooner without an answer is
 * asked again after a short pause. Null when none came by `until` or `signal` aborted (which also kills a query in
 * flight). `query` is replaced only by tests.
 */
export async function selfCreatedAt(signal:AbortSignal,until:number,
  query:(signal:AbortSignal,timeoutMs:number)=>Promise<ProcessInfo|null>=(abort,timeoutMs)=>processInfoAsync(process.pid,abort,timeoutMs)):Promise<string|null> {
  for(;;) {
    const remaining=until-Date.now();
    if(remaining<=0||signal.aborted)return null;
    const info=await query(signal,remaining).catch(()=>null);
    if(info?.createdAt)return info.createdAt;
    await delay(Math.min(SELF_IDENTITY_RETRY_MS,Math.max(0,until-Date.now())),undefined,{signal}).catch(()=>{});
  }
}

function posixProcessInfo(pid:number):ProcessInfo|null {
  const result=spawnSync('ps',['-o','lstart=','-o','args=','-p',String(pid)],{encoding:'utf8'});
  const line=result.status===0?result.stdout.trim():'';
  if(!line)return null;
  const createdAt=new Date(line.slice(0,24)).toISOString();
  let executablePath:string|null=null;
  try {executablePath=fs.readlinkSync(`/proc/${pid}/exe`);} catch {executablePath=process.execPath;}
  return {executablePath,commandLine:line.slice(24).trim(),createdAt};
}

/** What a client expects of the daemon it may talk to: this installation, this entry script, this data directory. */
export interface Installation {root:string;entryPath:string;dataDirectory:string}

/** True when the process is this installation's `daemon serve` for this data directory, started when the receipt says. */
export function ownsProcess(receipt:DaemonReceipt,info:ProcessInfo|null):boolean {
  if(!info?.executablePath||!info.commandLine||!info.createdAt)return false;
  const command=comparable(info.commandLine);
  return comparable(info.executablePath)===comparable(receipt.nodePath)&&command.includes(comparable(receipt.entryPath))&&
    /\bdaemon"?\s+"?serve\b/.test(command)&&command.includes('--data-directory')&&command.includes(comparable(receipt.dataDirectory))&&
    info.createdAt===receipt.processCreatedAt;
}

/**
 * Replaces the receipt only while it still names `pid`, so a stop that finishes late never overwrites the receipt of a
 * daemon started after it. Returns whether it wrote.
 */
export function replaceReceipt(paths:DaemonPaths,pid:number,value:DaemonReceipt):boolean {
  if(readJsonFile<DaemonReceipt>(paths.receipt)?.pid!==pid)return false;
  writeJsonAtomic(paths.receipt,value);return true;
}

/** A daemon writes heartbeat.json every 5 s; one this old is rechecked through CIM in case its pid was reused. */
export const HEARTBEAT_STALE_MS=120_000;
/** Milliseconds since the daemon's last heartbeat (since its start before the first one). */
export function heartbeatAgeMs(paths:DaemonPaths,receipt:DaemonReceipt):number {
  const beat=readJsonFile<{pid?:unknown;at?:unknown}>(paths.heartbeat);
  const at=beat?.pid===receipt.pid&&typeof beat.at==='string'?Date.parse(beat.at):Date.parse(receipt.startedAt);
  return Number.isFinite(at)?Date.now()-at:Infinity;
}

export interface DaemonState {
  alive:boolean;
  receipt:DaemonReceipt|null;
  reason:string;
  /** What CIM answered about the receipt pid when this call asked it (absent when it did not ask or got no answer). */
  info?:ProcessInfo;
}
const verified=new Map<string,boolean>();

/**
 * The daemon is alive only when all four hold: the receipt says running for this installation; the Authority lease is
 * held by the receipt pid; that pid exists; and the process is this installation's daemon. The last check reads
 * ownership.json written by an earlier verification, else asks CIM (slow) and caches a success in ownership.json.
 */
export function daemonState(paths:DaemonPaths,installation:Installation,options:{recheck?:boolean;spawnedPid?:number}={}):DaemonState {
  const receipt=readJsonFile<DaemonReceipt>(paths.receipt);
  if(!receipt)return {alive:false,receipt,reason:'no_receipt'};
  if(receipt.status!=='running')return {alive:false,receipt,reason:'stopped'};
  if(receipt.protocol!==PROTOCOL||comparable(receipt.root)!==comparable(installation.root)||
    comparable(receipt.entryPath)!==comparable(installation.entryPath)||comparable(receipt.dataDirectory)!==comparable(installation.dataDirectory))
    return {alive:false,receipt,reason:'foreign_installation'};
  if(leaseOwnerPid(installation.dataDirectory)!==receipt.pid)return {alive:false,receipt,reason:'lease_mismatch'};
  if(!pidAlive(receipt.pid))return {alive:false,receipt,reason:'process_gone'};
  const ownership=readJsonFile<{pid?:unknown;startedAt?:unknown;processCreatedAt?:unknown}>(paths.ownership);
  if(!options.recheck&&ownership?.pid===receipt.pid&&ownership.startedAt===receipt.startedAt&&ownership.processCreatedAt===receipt.processCreatedAt)
    return {alive:true,receipt,reason:'ownership_cached'};
  // A client that spawned this pid and still holds its handle knows the pid cannot have been reused.
  const key=`${receipt.pid}|${receipt.startedAt}|${receipt.processCreatedAt}`;
  let owned=options.spawnedPid===receipt.pid&&!!receipt.processCreatedAt;
  let info:ProcessInfo|null=null;
  if(!owned&&!options.recheck&&verified.has(key))owned=verified.get(key)!;
  else if(!owned) {
    // Only an answer about an existing process is remembered; a failed query is asked again next time.
    info=processInfo(receipt.pid);
    owned=ownsProcess(receipt,info);
    if(info)verified.set(key,owned);
  }
  if(!owned){fs.rmSync(paths.ownership,{force:true});return {alive:false,receipt,reason:'ownership_mismatch',...(info?{info}:{})};}
  writeJsonAtomic(paths.ownership,{pid:receipt.pid,startedAt:receipt.startedAt,processCreatedAt:receipt.processCreatedAt,verifiedAt:new Date().toISOString()});
  return {alive:true,receipt,reason:'ownership_verified'};
}
