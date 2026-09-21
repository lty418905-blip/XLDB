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
}

export interface FileHostOptions {
  timeoutMs?: number;
  pollMs?: number;
}

export interface FileHost {
  delegate(task: HostTask): Promise<string>;
  close(): void;
}

const UUID_SAFE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_OUTPUT_LENGTH = 50_000;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_POLL_MS = 50;

type Completion = 'consumed' | 'failed' | 'cancelled' | 'timed_out';

interface ActiveJob {
  cancel: () => void;
}

interface WorkerResult {
  id: unknown;
  status: unknown;
  output?: unknown;
  error?: unknown;
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

function removeJobContent(paths: ReturnType<typeof jobPaths>): void {
  fs.rmSync(paths.requestPath,{force:true});
  fs.rmSync(paths.resultPath,{force:true});
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

function resultOutput(result: WorkerResult, id: string): string {
  if (result.id !== id) throw error('FILE_HOST_INVALID_RESULT');
  if (result.status === 'failed') {
    if (typeof result.error !== 'string' || !/^[A-Z0-9_]{1,80}$/.test(result.error)) throw error('FILE_HOST_INVALID_RESULT');
    throw error('FILE_HOST_WORKER_FAILED');
  }
  if (result.status !== 'ok' || typeof result.output !== 'string' || result.output.length === 0 || result.output.length > MAX_OUTPUT_LENGTH) {
    throw error('FILE_HOST_INVALID_RESULT');
  }
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
          const request = JSON.parse(fs.readFileSync(paths.requestPath, 'utf8')) as Partial<HostTask>;
          if (request.id !== id || typeof request.stage !== 'string' || request.stage.length === 0 || (request.kind !== 'background' && request.kind !== 'foreground')) return [];
          return [{ id, stage: request.stage, kind: request.kind, requestPath: paths.requestPath, resultPath: paths.resultPath }];
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
  const timeoutMs = numberOption(options.timeoutMs, DEFAULT_TIMEOUT_MS, 'TIMEOUT');
  const pollMs = numberOption(options.pollMs, DEFAULT_POLL_MS, 'POLL');
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
      writeJsonAtomically(paths.requestPath, task);

      return new Promise<string>((resolve, reject) => {
        const deadline = Date.now() + timeoutMs;
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const settle = (outcome: 'resolve' | 'reject', value: string | Error, completion: Completion) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          active.delete(task.id);
          markDone(paths, completion);
          try { removeJobContent(paths); }
          catch { return reject(error('FILE_HOST_CLEANUP_FAILED')); }
          if (outcome === 'resolve') resolve(value as string);
          else reject(value as Error);
        };
        const poll = () => {
          if (settled) return;
          if (fs.existsSync(path.join(directory,'cancel.json'))) return settle('reject',error('FILE_HOST_CLOSED'),'cancelled');
          const decoded = decodeResult(paths.resultPath);
          if (decoded.kind === 'missing') {
            if (Date.now() >= deadline) return settle('reject', error('FILE_HOST_TIMEOUT'), 'timed_out');
            timer = setTimeout(poll, Math.max(1, pollMs));
            return;
          }
          if (decoded.kind === 'invalid') return settle('reject', error('FILE_HOST_INVALID_RESULT'), 'failed');
          try {
            settle('resolve', resultOutput(decoded.value, task.id), 'consumed');
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
