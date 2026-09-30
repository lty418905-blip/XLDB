import {AsyncLocalStorage} from 'node:async_hooks';
import type {Configurations} from '../../../shared/src/core/types.ts';
import type {FileHost,HostTask} from './file-host.ts';

/** One run's host, retrieval configurations and the background jobs it started. */
export interface RunContext {
  runId:string;
  host:FileHost;
  configurations?:Configurations;
  jobs:Set<Promise<unknown>>;
  /** Set when the run ends; later host calls from its background work fail without touching its directory. */
  closed:boolean;
}

/** Promises, setImmediate and timers inherit the store, so background work stays with the run that started it. */
export const runContext=new AsyncLocalStorage<RunContext>();

/** The fixed runtime delegate: each call goes to the file host of the run it belongs to. */
export async function routedDelegate(task:HostTask):Promise<string> {
  const context=runContext.getStore();
  if(!context)throw new Error('host_delegate_unavailable');
  if(context.closed)throw new Error('FILE_HOST_CLOSED');
  return context.host.delegate(task);
}

/** Records a background job on the current run; outside a run it is only tracked by the runtime. */
export function trackRunJob(job:Promise<unknown>):void {
  const context=runContext.getStore();
  if(!context)return;
  context.jobs.add(job);
  const remove=()=>{context.jobs.delete(job);};
  job.then(remove,remove);
}

/** Waits for this run's background jobs only, including jobs they start while it waits. */
export async function drainRun(context:RunContext):Promise<void> {
  for(;;) {
    const jobs=[...context.jobs];
    if(!jobs.length)return;
    await Promise.allSettled(jobs);
    for(const job of jobs)context.jobs.delete(job);
  }
}
