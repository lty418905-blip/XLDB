import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export interface HostMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface HostTask {
  id: string;
  stage: string;
  kind: 'background' | 'foreground';
  messages: HostMessage[];
  responseFormat: 'json' | 'text';
  isolation: 'fresh-context';
}

export interface PendingJob {
  id: string;
  stage: string;
  kind: 'background' | 'foreground';
  requestPath: string;
  resultPath: string;
  /** Host-owned deadline length for this job, counted from job creation; informational for workers. */
  timeoutMs: number;
}

export interface FileHostOptions {
  /** Base timeout for one job part; merged companionObservation jobs scale it by part count (see hostTimeoutMs). */
  timeoutMs?: number;
  pollMs?: number;
  /** Clock used for job deadlines; injectable for tests. */
  now?: () => number;
  /** Removes one job file after settlement (default: fs.rmSync with force); injectable for tests. */
  removeFile?: (filename: string) => void;
  /** Receives a code when job cleanup after consumption is deferred to the cleanDoneJobs sweep. */
  onDiagnostic?: (diagnostic: { id: string; code: 'FILE_HOST_CLEANUP_DEFERRED'; completion: Completion }) => void;
}

export interface FileHost {
  delegate(task: HostTask): Promise<string>;
  close(): void;
}

const UUID_SAFE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_OUTPUT_LENGTH = 50_000;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_POLL_MS = 50;
/** Merged observation jobs get at most this many base timeouts (40 minutes with the default base). */
const MAX_TIMEOUT_PARTS = 4;

export type Completion = 'consumed' | 'failed' | 'cancelled' | 'timed_out';

interface ActiveJob {
  cancel: () => void;
}

interface WorkerResult {
  id: unknown;
  status: unknown;
  output?: unknown;
  error?: unknown;
}

/** Part count of a merged companionObservation job; every other job, or an unparsable one, counts as 1. */
function observationParts(task: Pick<HostTask, 'stage' | 'messages'>): number {
  if (task.stage !== 'companionObservation') return 1;
  try {
    const tasks = (JSON.parse(task.messages.at(-1)?.content ?? '') as { tasks?: unknown }).tasks;
    return Array.isArray(tasks) && tasks.length ? tasks.length : 1;
  } catch { return 1; }
}

/** A merged companionObservation job may return up to one ordinary output per part. */
export function hostOutputLimit(task: Pick<HostTask, 'stage' | 'messages'>): number {
  return MAX_OUTPUT_LENGTH * observationParts(task);
}

/** A merged companionObservation job gets one base timeout per part, capped at MAX_TIMEOUT_PARTS (40 minutes by default). */
export function hostTimeoutMs(task: Pick<HostTask, 'stage' | 'messages'>, baseMs: number = DEFAULT_TIMEOUT_MS): number {
  return baseMs * Math.min(observationParts(task), MAX_TIMEOUT_PARTS);
}

function error(code: string): Error {
  return new Error(code);
}

function numberOption(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 0 || !Number.isInteger(value)) throw error(`FILE_HOST_INVALID_${name}`);
  return value;
}

function inside(directory: string, filename: string): string {
  const resolved = path.resolve(filename);
  if (resolved !== directory && !resolved.startsWith(`${directory}${path.sep}`)) throw error('FILE_HOST_INVALID_PATH');
  return resolved;
}

function jobPaths(runDirectory: string, id: string) {
  if (!UUID_SAFE.test(id)) throw error('FILE_HOST_INVALID_ID');
  const jobsDirectory = inside(runDirectory, path.join(runDirectory, 'jobs'));
  return {
    jobsDirectory,
    requestPath: inside(jobsDirectory, path.join(jobsDirectory, `${id}.request.json`)),
    resultPath: inside(jobsDirectory, path.join(jobsDirectory, `${id}.result.json`)),
    donePath: inside(jobsDirectory, path.join(jobsDirectory, `${id}.done`)),
  };
}

function assertTask(task: HostTask): void {
  if (!task || typeof task !== 'object') throw error('FILE_HOST_INVALID_TASK');
  if (!UUID_SAFE.test(task.id) || typeof task.stage !== 'string' || task.stage.length === 0) throw error('FILE_HOST_INVALID_TASK');
  if (task.kind !== 'background' && task.kind !== 'foreground') throw error('FILE_HOST_INVALID_TASK');
  if (task.responseFormat !== 'json' && task.responseFormat !== 'text') throw error('FILE_HOST_INVALID_TASK');
  if (task.isolation !== 'fresh-context' || !Array.isArray(task.messages)) throw error('FILE_HOST_INVALID_TASK');
  for (const message of task.messages) {
    if (!message || typeof message !== 'object' || !['system', 'user', 'assistant'].includes(message.role) || typeof message.content !== 'string') {
      throw error('FILE_HOST_INVALID_TASK');
    }
  }
}

function writeJsonAtomically(filename: string, value: unknown): void {
  const directory = path.dirname(filename);
  fs.mkdirSync(directory, { recursive: true });
  const temporary = path.join(directory, `.${path.basename(filename)}.${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, filename);
  } finally {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
  }
}

function markDone(paths: ReturnType<typeof jobPaths>, status: Completion): void {
  if (fs.existsSync(paths.donePath)) return;
  try {
    writeJsonAtomically(paths.donePath, { id: path.basename(paths.donePath, '.done'), status });
  } catch {
    // A result remains evidence even if this best-effort completion marker cannot be persisted.
  }
}

const removeFileDefault = (filename: string): void => fs.rmSync(filename, { force: true });

function removeJobContent(paths: ReturnType<typeof jobPaths>, remove: (filename: string) => void = removeFileDefault): void {
  // Order is the dispatch fence: the result file (or the done marker) is what keeps a request out of listPending,
  // so the result is removed only after the request is gone. A locked request therefore leaves the result in place.
  remove(paths.requestPath);
  remove(paths.resultPath);
}

/**
 * Delays between post-settlement removal attempts (about 0.4 s in total). On Windows an antivirus scanner or
 * indexer may hold a job file open without FILE_SHARE_DELETE for a moment; removal then fails with EBUSY/EPERM.
 */
const CLEANUP_RETRY_DELAYS_MS = [25, 50, 100, 200] as const;

async function removeJobContentWithRetry(paths: ReturnType<typeof jobPaths>, remove: (filename: string) => void): Promise<boolean> {
  for (let attempt = 0; ; attempt++) {
    try {
      removeJobContent(paths, remove);
      return true;
    } catch {
      if (attempt >= CLEANUP_RETRY_DELAYS_MS.length) return false;
      await new Promise(resolve => setTimeout(resolve, CLEANUP_RETRY_DELAYS_MS[attempt]));
    }
  }
}

/** Records on the done marker that content removal was deferred to the sweep; best effort. */
function recordDeferredCleanup(paths: ReturnType<typeof jobPaths>, completion: Completion): void {
  try {
    writeJsonAtomically(paths.donePath, { id: path.basename(paths.donePath, '.done'), status: completion, cleanup: 'deferred' });
  } catch {
    // The existing marker still keeps the job out of the dispatchable set and inside the cleanDoneJobs sweep.
  }
}

function cleanDoneJobs(runDirectory:string):void {
  const jobsDirectory=inside(runDirectory,path.join(runDirectory,'jobs'));
  if(!fs.existsSync(jobsDirectory))return;
  for(const name of fs.readdirSync(jobsDirectory)) {
    if(!name.endsWith('.done'))continue;
    const id=name.slice(0,-'.done'.length);
    if(UUID_SAFE.test(id))removeJobContent(jobPaths(runDirectory,id));
  }
}

function decodeResult(resultPath: string): { kind: 'missing' } | { kind: 'value'; value: WorkerResult } | { kind: 'invalid' } {
  if (!fs.existsSync(resultPath)) return { kind: 'missing' };
  try {
    const value: unknown = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
    if (!value || typeof value !== 'object') return { kind: 'invalid' };
    return { kind: 'value', value: value as WorkerResult };
  } catch {
    // Workers publish final result files by atomic rename. A malformed final file is therefore invalid, not partial.
    return { kind: 'invalid' };
  }
}

function resultOutput(result: WorkerResult, id: string, limit: number): string {
  if (result.id !== id) throw error('FILE_HOST_INVALID_RESULT');
  if (result.status === 'failed') {
    if (typeof result.error !== 'string' || !/^[A-Z0-9_]{1,80}$/.test(result.error)) throw error('FILE_HOST_INVALID_RESULT');
    throw error('FILE_HOST_WORKER_FAILED');
  }
  if (result.status !== 'ok' || typeof result.output !== 'string' || result.output.length === 0) throw error('FILE_HOST_INVALID_RESULT');
  if (result.output.length > limit) throw error(limit > MAX_OUTPUT_LENGTH ? 'FILE_HOST_OUTPUT_TOO_LARGE' : 'FILE_HOST_INVALID_RESULT');
  return result.output;
}

function running(directory: string): boolean {
  try {
    if (fs.existsSync(path.join(directory,'cancel.json'))) return false;
    const run = JSON.parse(fs.readFileSync(inside(directory, path.join(directory, 'run.json')), 'utf8')) as { status?: unknown };
    return run.status === 'running';
  } catch {
    return false;
  }
}

/** Returns dispatch metadata only; task messages remain in the request file. */
export function listPending(runDirectory: string): PendingJob[] {
  const directory = path.resolve(runDirectory);
  try { cleanDoneJobs(directory); }
  catch {/* A failed cleanup must not hide other pending work. */}
  if (!running(directory)) return [];
  const jobsDirectory = inside(directory, path.join(directory, 'jobs'));
  try {
    return fs.readdirSync(jobsDirectory)
      .filter(name => name.endsWith('.request.json'))
      .sort()
      .flatMap(name => {
        const id = name.slice(0, -'.request.json'.length);
        if (!UUID_SAFE.test(id)) return [];
        const paths = jobPaths(directory, id);
        if (fs.existsSync(paths.resultPath) || fs.existsSync(paths.donePath)) return [];
        try {
          const request = JSON.parse(fs.readFileSync(paths.requestPath, 'utf8')) as Partial<HostTask> & { timeoutMs?: unknown };
          if (request.id !== id || typeof request.stage !== 'string' || request.stage.length === 0 || (request.kind !== 'background' && request.kind !== 'foreground')) return [];
          const timeoutMs = Number.isInteger(request.timeoutMs) && (request.timeoutMs as number) >= 0
            ? request.timeoutMs as number
            : hostTimeoutMs({ stage: request.stage, messages: Array.isArray(request.messages) ? request.messages : [] });
          return [{ id, stage: request.stage, kind: request.kind, requestPath: paths.requestPath, resultPath: paths.resultPath, timeoutMs }];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

export function createFileHost(runDirectory: string, options: FileHostOptions = {}): FileHost {
  const directory = path.resolve(runDirectory);
  try { cleanDoneJobs(directory); }
  catch { throw error('FILE_HOST_CLEANUP_FAILED'); }
  const baseTimeoutMs = numberOption(options.timeoutMs, DEFAULT_TIMEOUT_MS, 'TIMEOUT');
  const pollMs = numberOption(options.pollMs, DEFAULT_POLL_MS, 'POLL');
  if (options.now !== undefined && typeof options.now !== 'function') throw error('FILE_HOST_INVALID_NOW');
  const now = options.now ?? Date.now;
  if (options.removeFile !== undefined && typeof options.removeFile !== 'function') throw error('FILE_HOST_INVALID_REMOVE_FILE');
  if (options.onDiagnostic !== undefined && typeof options.onDiagnostic !== 'function') throw error('FILE_HOST_INVALID_ON_DIAGNOSTIC');
  const removeFile = options.removeFile ?? removeFileDefault;
  const onDiagnostic = options.onDiagnostic;
  const active = new Map<string, ActiveJob>();
  let closed = false;

  return {
    async delegate(task: HostTask): Promise<string> {
      if (closed || fs.existsSync(path.join(directory,'cancel.json'))) throw error('FILE_HOST_CLOSED');
      assertTask(task);
      const paths = jobPaths(directory, task.id);
      fs.mkdirSync(paths.jobsDirectory, { recursive: true });
      if (fs.existsSync(paths.requestPath) || fs.existsSync(paths.resultPath) || fs.existsSync(paths.donePath) || active.has(task.id)) {
        throw error('FILE_HOST_DUPLICATE_ID');
      }
      // The deadline is fixed here from host state; the request copy of timeoutMs is informational and never read back.
      const timeoutMs = hostTimeoutMs(task, baseTimeoutMs);
      const deadline = now() + timeoutMs;
      writeJsonAtomically(paths.requestPath, { ...task, timeoutMs });

      return new Promise<string>((resolve, reject) => {
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const settle = (outcome: 'resolve' | 'reject', value: string | Error, completion: Completion) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          active.delete(task.id);
          markDone(paths, completion);
          const deliver = () => outcome === 'resolve' ? resolve(value as string) : reject(value as Error);
          try { removeJobContent(paths, removeFile); return deliver(); }
          catch { /* Retried below; a scanner or indexer may hold a job file briefly on Windows. */ }
          void removeJobContentWithRetry(paths, removeFile).then(removed => {
            if (removed) return deliver();
            // Once the worker result was read, the outcome is final: a leftover file must not turn it into a failed turn.
            // The done marker keeps the job out of listPending and inside the cleanDoneJobs sweep, which removes it later.
            markDone(paths, completion);
            if ((completion === 'consumed' || completion === 'failed') && fs.existsSync(paths.donePath)) {
              recordDeferredCleanup(paths, completion);
              try { onDiagnostic?.({ id: task.id, code: 'FILE_HOST_CLEANUP_DEFERRED', completion }); } catch { /* diagnostic only */ }
              return deliver();
            }
            reject(error('FILE_HOST_CLEANUP_FAILED'));
          });
        };
        const poll = () => {
          if (settled) return;
          if (fs.existsSync(path.join(directory,'cancel.json'))) return settle('reject',error('FILE_HOST_CLOSED'),'cancelled');
          const decoded = decodeResult(paths.resultPath);
          if (decoded.kind === 'missing') {
            if (now() >= deadline) return settle('reject', error('FILE_HOST_TIMEOUT'), 'timed_out');
            timer = setTimeout(poll, Math.max(1, pollMs));
            return;
          }
          if (decoded.kind === 'invalid') return settle('reject', error('FILE_HOST_INVALID_RESULT'), 'failed');
          try {
            settle('resolve', resultOutput(decoded.value, task.id, hostOutputLimit(task)), 'consumed');
          } catch (cause) {
            settle('reject', cause instanceof Error ? cause : error('FILE_HOST_INVALID_RESULT'), 'failed');
          }
        };
        active.set(task.id, { cancel: () => settle('reject', error('FILE_HOST_CLOSED'), 'cancelled') });
        poll();
      });
    },
    close(): void {
      if (closed) return;
      closed = true;
      for (const job of [...active.values()]) job.cancel();
    },
  };
}
