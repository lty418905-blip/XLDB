import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

// Events for `cli wait`: a ring buffer numbered by seq, the waiters blocked on it, and whether a conversation is in
// progress. The daemon feeds it from its accept, run-end, tick and shutdown hooks; nothing here writes the database.

export const NOTICE_SCHEMA='xldb-daemon-notice-v1';
const CAPACITY=256;
const JOB_SCAN_MS=250;
const NOTICE_SCAN_MS=1_000;

export type DaemonEvent={type:string;seq?:number;at:string;[field:string]:unknown};
export interface Conversation {active:boolean;reason:'run_running'|'user_active'|null;lastUserActivityAt:string|null;windowMs:number}
export interface WaitReply {cursor:string;conversation:Conversation;timedOut:boolean;events:DaemonEvent[]}
export interface PendingRunJobs {runDirectory:string;operation:unknown;jobs:{id:string;stage:string;kind:string}[]}

export interface EventSources {
  /** Runs executing now (queued ones excluded). */
  running():number;
  /** Every executing run with its pending host jobs (possibly none). */
  pendingJobs():PendingRunJobs[];
  /** `<daemonDir>/notices`; it may not exist. */
  noticesDirectory:string;
  /** Accepted sources of a scope still awaiting analysis now; lets a snapshot drop a set that has since been processed. */
  processingPending?(scope:unknown):string[];
}

interface Waiter {requestId:string;clientPid:number;after:number;expiresAtMs:number;respond:(reply:WaitReply)=>void}
export interface WaitRequest {requestId:string;clientPid:number;cursor:string|null;timeoutMs:number;respond:(reply:WaitReply)=>void}

interface Notice {noticeId:string;kind:unknown;scope:unknown;characterId:unknown;opportunityId:unknown;expiresAt:string}

const SCOPE_FIELDS=['worldId','sessionId','branchId','characterId'] as const;
/** The scope's four fields only, so key order or extra fields in the request that carried it make no difference. */
function scopeFields(scope:unknown):Record<string,unknown> {
  const value=(scope&&typeof scope==='object'?scope:{}) as Record<string,unknown>;
  return Object.fromEntries(SCOPE_FIELDS.map(field=>[field,value[field]??null]));
}

export class DaemonEvents {
  readonly instanceId=randomUUID().slice(0,8);
  private seq=0;
  private readonly buffer:DaemonEvent[]=[];
  private readonly waiters=new Map<string,Waiter>();
  private lastUserActivityAt:number|null=null;
  /** Job ids already announced, per run directory. */
  private readonly announcedJobs=new Map<string,Set<string>>();
  /** Notice ids already announced; pruned when their file goes. */
  private readonly announcedNotices=new Set<string>();
  /** The unprocessed source ids last reported per scope, so an unchanged set is not announced again; a snapshot lists them. */
  private readonly pendingSources=new Map<string,{signature:string;scope:unknown;sourceIds:string[];runDirectory:string}>();
  private lastJobScan=0;
  private lastNoticeScan=0;
  private flushQueued=false;
  private stopped=false;
  private stopReason='requested';

  private readonly options:{conversationWindowMs:number;sources:EventSources;now?:()=>number};
  constructor(options:{conversationWindowMs:number;sources:EventSources;now?:()=>number}) {this.options=options;}

  private now():number {return (this.options.now??Date.now)();}
  get waiterCount():number {return this.waiters.size;}
  get cursor():string {return `${this.instanceId}:${this.seq}`;}

  /** A conversation is in progress while any run executes or within conversationWindowMs of the last user message. */
  conversation():Conversation {
    const running=this.options.sources.running()>0;
    const recent=this.lastUserActivityAt!==null&&this.now()-this.lastUserActivityAt<this.options.conversationWindowMs;
    return {active:running||recent,reason:running?'run_running':recent?'user_active':null,
      lastUserActivityAt:this.lastUserActivityAt===null?null:new Date(this.lastUserActivityAt).toISOString(),windowMs:this.options.conversationWindowMs};
  }

  private emit(type:string,fields:Record<string,unknown>):void {
    if(this.stopped)return;
    const event={type,seq:++this.seq,at:new Date(this.now()).toISOString(),...fields};
    this.buffer.push(event);
    if(this.buffer.length>CAPACITY)this.buffer.splice(0,this.buffer.length-CAPACITY);
    // Events emitted in one synchronous step (a run's end and its processing check) reach a waiter together.
    if(!this.flushQueued){this.flushQueued=true;setImmediate(()=>{this.flushQueued=false;this.flush();});}
  }

  /** A conversation operation was accepted. */
  userActive(operation:string,runDirectory:string):void {
    this.lastUserActivityAt=this.now();
    this.emit('user_active',{operation,runDirectory});
  }
  runFinished(runDirectory:string,operation:unknown,status:string):void {
    this.announcedJobs.delete(runDirectory);
    this.emit('run_finished',{runDirectory,operation,status});
  }
  /**
   * Accepted text still awaiting analysis after a write or delivery run. Only a changed set is announced: a retry that
   * fails for the same cause leaves the set as it was and emits nothing, so a host answering with retry cannot loop.
   */
  processingPending(scope:unknown,sourceIds:string[],runDirectory:string):void {
    scope=scopeFields(scope);const key=JSON.stringify(scope);
    if(!sourceIds.length){this.pendingSources.delete(key);return;}
    const signature=JSON.stringify([...sourceIds].sort());
    if(this.pendingSources.get(key)?.signature===signature)return;
    this.pendingSources.set(key,{signature,scope,sourceIds:[...sourceIds],runDirectory});
    this.emit('processing_pending',{scope,sourceIds,runDirectory});
  }

  /**
   * Called on every daemon tick: new host jobs every 250 ms, notices every second, expired waits. An expiring waiter
   * still gets whatever was emitted since its cursor (this tick's scan, or a claim just before it) whose flush has not
   * run yet; it counts as timed out only when there is nothing, so its cursor never skips an unseen event.
   */
  tick():void {
    const at=this.now();
    if(at-this.lastJobScan>=JOB_SCAN_MS){this.lastJobScan=at;this.scanJobs();}
    if(at-this.lastNoticeScan>=NOTICE_SCAN_MS){this.lastNoticeScan=at;this.scanNotices();}
    for(const waiter of [...this.waiters.values()]) {
      if(waiter.expiresAtMs>at)continue;
      const events=this.since(waiter.after);
      this.reply(waiter,events,events.length===0);
    }
  }

  private scanJobs():void {
    const live=new Set<string>();
    for(const {runDirectory,operation,jobs} of this.options.sources.pendingJobs()) {
      live.add(runDirectory);
      const announced=this.announcedJobs.get(runDirectory)??new Set<string>();
      this.announcedJobs.set(runDirectory,announced);
      const fresh=jobs.filter(job=>!announced.has(job.id));
      for(const job of fresh)announced.add(job.id);
      if(fresh.length)this.emit('jobs_pending',{runDirectory,operation,jobs:fresh});
    }
    for(const runDirectory of [...this.announcedJobs.keys()])if(!live.has(runDirectory))this.announcedJobs.delete(runDirectory);
  }

  /** Unexpired notices on disk, oldest first; malformed or foreign files are skipped. */
  private notices():Notice[] {
    const directory=this.options.sources.noticesDirectory;
    let names:string[];
    try {names=fs.readdirSync(directory).filter(name=>name.endsWith('.json')&&!name.startsWith('.')).sort();} catch {return [];}
    const at=this.now();const found:Notice[]=[];
    for(const name of names) {
      let doc:Record<string,unknown>;
      try {doc=JSON.parse(fs.readFileSync(path.join(directory,name),'utf8'));} catch {continue;}
      if(!doc||typeof doc!=='object'||doc.schema!==NOTICE_SCHEMA||typeof doc.noticeId!=='string'||typeof doc.expiresAt!=='string')continue;
      const expires=Date.parse(doc.expiresAt);
      if(!Number.isFinite(expires)||expires<=at)continue;
      found.push({noticeId:doc.noticeId,kind:doc.kind,scope:doc.scope,characterId:doc.characterId,opportunityId:doc.opportunityId,expiresAt:doc.expiresAt});
    }
    return found;
  }

  private scanNotices():void {
    const notices=this.notices();
    const present=new Set(notices.map(notice=>notice.noticeId));
    for(const id of [...this.announcedNotices])if(!present.has(id))this.announcedNotices.delete(id);
    // During a conversation notices wait; they are announced once it ends, unless they expired meanwhile.
    if(this.conversation().active)return;
    for(const notice of notices) {
      if(this.announcedNotices.has(notice.noticeId))continue;
      this.announcedNotices.add(notice.noticeId);
      this.emit('notice',{...notice});
    }
  }

  /**
   * What a waiter without a usable cursor needs to know now: pending host jobs, the scopes whose accepted text still
   * awaits analysis (re-checked, so a set processed since is dropped) and, outside a conversation, notices. The caller
   * scans first, so every job and notice listed here is already announced before the returned cursor and does not come
   * again as an event after it. Earlier run_finished events are not replayed: a host reads each run's result.json.
   */
  private snapshot():DaemonEvent[] {
    const at=new Date(this.now()).toISOString();
    const events:DaemonEvent[]=[];
    for(const {runDirectory,operation,jobs} of this.options.sources.pendingJobs())
      if(jobs.length)events.push({type:'jobs_pending',at,snapshot:true,runDirectory,operation,jobs});
    for(const [key,entry] of [...this.pendingSources]) {
      let sourceIds=entry.sourceIds;
      const check=this.options.sources.processingPending;
      if(check) {
        try {sourceIds=check(entry.scope);} catch {sourceIds=[];}
        const signature=JSON.stringify([...sourceIds].sort());
        if(!sourceIds.length){this.pendingSources.delete(key);continue;}
        if(signature!==entry.signature)this.pendingSources.set(key,{...entry,signature,sourceIds:[...sourceIds]});
      }
      events.push({type:'processing_pending',at,snapshot:true,scope:entry.scope,sourceIds,runDirectory:entry.runDirectory});
    }
    if(!this.conversation().active)for(const notice of this.notices())events.push({type:'notice',at,snapshot:true,...notice});
    return events;
  }

  /** The seq after which a cursor has seen everything, or null when it belongs elsewhere or fell out of the buffer. */
  private position(cursor:string|null):number|null {
    const match=typeof cursor==='string'?/^([0-9a-f]{8}):(\d+)$/.exec(cursor):null;
    if(!match||match[1]!==this.instanceId)return null;
    const after=Number(match[2]);
    if(after>this.seq)return null;
    const oldest=this.buffer[0]?.seq??this.seq+1;
    return after+1<oldest&&after<this.seq?null:after;
  }

  /** Answers at once when there is something to report, otherwise holds the waiter until an event or its timeout. */
  wait(request:WaitRequest):void {
    const waiter:Waiter={requestId:request.requestId,clientPid:request.clientPid,after:this.seq,
      expiresAtMs:this.now()+request.timeoutMs,respond:request.respond};
    if(this.stopped)return this.reply(waiter,[this.stoppedEvent(this.stopReason)],false);
    const after=this.position(request.cursor);
    if(after===null) {
      // Jobs and notices not yet announced become events now (reaching other waiters), before the snapshot's cursor.
      const at=this.now();this.lastJobScan=at;this.lastNoticeScan=at;
      this.scanJobs();this.scanNotices();
      waiter.after=this.seq;
      const events=this.snapshot();
      if(events.length)return this.reply(waiter,events,false);
    } else {
      waiter.after=after;
      const events=this.since(after);
      if(events.length)return this.reply(waiter,events,false);
    }
    this.waiters.set(waiter.requestId,waiter);
  }

  private since(after:number):DaemonEvent[] {return this.buffer.filter(event=>(event.seq??0)>after);}

  private reply(waiter:Waiter,events:DaemonEvent[],timedOut:boolean):void {
    this.waiters.delete(waiter.requestId);
    waiter.respond({cursor:this.cursor,conversation:this.conversation(),timedOut,events});
  }

  private flush():void {
    for(const waiter of [...this.waiters.values()]) {
      const events=this.since(waiter.after);
      if(events.length)this.reply(waiter,events,false);
    }
  }

  /** Drops waiters whose client process is gone and returns their request ids. */
  dropWaiters(gone:(clientPid:number)=>boolean):string[] {
    const dropped=[...this.waiters.values()].filter(waiter=>gone(waiter.clientPid)).map(waiter=>waiter.requestId);
    for(const id of dropped)this.waiters.delete(id);
    return dropped;
  }

  private stoppedEvent(reason:string):DaemonEvent {return {type:'daemon_stopped',at:new Date(this.now()).toISOString(),reason};}

  /** Shutdown: every waiter gets its unseen events and daemon_stopped; later waits get daemon_stopped at once. */
  stop(reason:string):void {
    if(this.stopped)return;
    this.stopped=true;this.stopReason=reason;
    for(const waiter of [...this.waiters.values()])this.reply(waiter,[...this.since(waiter.after),this.stoppedEvent(reason)],false);
  }
}
