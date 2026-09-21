import type {Retention} from './retention.ts';
import {retainedAccess} from './retention.ts';

export interface Scope {
  worldId: string;
  sessionId: string;
  branchId: string;
  characterId: string;
}

export type Access = 'clear' | 'gist' | 'feeling' | 'anchor' | 'hidden';

export type MemoryKind = 'fact' | 'episode';

export interface EpisodeMemory {
  scene: string;
  participants: string[];
  sensoryCues: string[];
  appraisal: string;
  feelingBasis: 'explicit' | 'inferred';
  feelingQuote: string;
  /** Optional only on typed records created before multi-observation episodes. */
  evidenceQuotes?: string[];
}

export interface Memory {
  id: string;
  scope: Scope;
  source: { messageId: string; revision: number; occurredAtMs: number | null; knownAtMs: number;
    author?: {role:'user'|'assistant';actorId:string};
    reference?: {fileHash:string;table:string;row:string};
    knowledge?: {kind:string;actorId?:string;observationId:string;start:number;end:number} };
  status: 'accepted' | 'candidate' | 'deleted' | 'superseded';
  access: Access;
  /** User-set granularity takes precedence over automatic retention. */
  accessOverride?:boolean;
  retention?:Retention;
  retentionAtMs?:number;
  reactivated?:boolean;
  detail: string;
  gist: string;
  feeling: string;
  anchor: string;
  protectedFacts: readonly string[];
  /** Missing only on records persisted before dual-memory extraction. */
  kind?: MemoryKind;
  episode?: EpisodeMemory;
}

/** Validated current records from one consistent authority read, never model/index data. */
export interface MemorySnapshot {
  /** Current story clock when applicable; otherwise the caller's real time. */
  memoryTimeMs?:number;
  scope: Scope;
  version: number;
  messages: ReadonlyMap<string, { revision: number; status: 'accepted' | 'deleted' }>;
  memories: ReadonlyMap<string, Memory>;
  /** Trusted one-hop host reply bindings; never copied into MemoryView output. */
  replyParents?: ReadonlyMap<string, {
    assistantRevision: number;
    parentMessageId: string;
    parentRevision: number;
  }>;
}

export interface MemoryView {
  reactivated?:boolean;
  id: string;
  source: Memory['source'];
  access: Access;
  kind: MemoryKind | 'legacy';
  protectedFacts: string[];
  /** Preserves whether a visible episode feeling was stated or inferred. */
  feelingBasis?: EpisodeMemory['feelingBasis'];
  episode?: EpisodeMemory;
  detail?: string;
  gist?: string;
  feeling?: string;
  anchor?: string;
  forgotten?: string;
}

const DIRECT_COPY_RUN = 6;
const DIRECT_CODE_RUN = 4;
const conservativeCoarse = {
  gist: '记得曾发生过一件事，但具体内容已经模糊。',
  feeling: '这段经历仍留下感觉，但具体感受已经模糊。',
  anchor: '仍记得这是一件重要的经历。',
} as const;

/**
 * Deterministic guard for copied precision. It deliberately makes no claim
 * about paraphrases or semantic equivalence; those remain model-quality work.
 */
export function directlyCopiesPreciseText(detail: string, coarse: string, protectedFacts: readonly string[] = []): boolean {
  if (!coarse) return false;
  const projected = compactCopyText(coarse);
  if (!projected) return false;
  for (const preciseText of [detail,...protectedFacts]) {
    const precise = compactCopyText(preciseText);
    if (!precise) continue;
    if (precise === projected) return true;
    if (precise.length >= DIRECT_COPY_RUN && projected.includes(precise)) return true;
    if (projected.length >= DIRECT_COPY_RUN && precise.includes(projected)) return true;
    if (sharesExactRun(precise,projected,DIRECT_COPY_RUN)) return true;
    const codes = precise.match(/[a-z0-9]{4,}/g) ?? [];
    if (codes.some(code => code.length >= DIRECT_CODE_RUN && projected.includes(code))) return true;
  }
  return false;
}

export function withoutDirectCopy(
  detail: string,
  coarse: string,
  layer: keyof typeof conservativeCoarse,
  protectedFacts: readonly string[] = [],
): string {
  return directlyCopiesPreciseText(detail,coarse,protectedFacts) ? conservativeCoarse[layer] : coarse;
}

/**
 * Search supplies IDs only. Text and access decisions come from current authority.
 * Gist/feeling/anchor must already be approved for their respective access levels.
 * This projects stored decisions; it neither decides when to forget nor rewrites text.
 */
export function projectMemories(
  snapshot: MemorySnapshot,
  request: { scope: Scope; asOfMs: number; ids: readonly string[] },
): { scope: Scope; version: number; memories: MemoryView[] } {
  if (!sameScope(snapshot.scope, request.scope)) throw new Error('scope_mismatch');
  if (!Number.isSafeInteger(request.asOfMs) || request.asOfMs < 0) throw new Error('invalid_time');

  const memories: MemoryView[] = [];
  for (const id of new Set(request.ids)) {
    let memory = snapshot.memories.get(id);
    if (!memory || memory.id !== id || memory.status !== 'accepted') continue;
    if (!sameScope(memory.scope, request.scope)) continue;
    const message = snapshot.messages.get(memory.source.messageId);
    if (!message || message.status !== 'accepted' || message.revision !== memory.source.revision) continue;
    if (memory.source.knownAtMs > request.asOfMs || (memory.source.occurredAtMs !== null && memory.source.occurredAtMs > request.asOfMs)) continue;
    memory={...memory,access:retainedAccess(memory,snapshot.memoryTimeMs??request.asOfMs).access};

    // Construct an allow-listed result: spreading the record would copy hidden text.
    const view: MemoryView = {
      id,
      source: {
        messageId: memory.source.messageId,
        revision: memory.source.revision,
        occurredAtMs: memory.source.occurredAtMs,
        knownAtMs: memory.source.knownAtMs,
        ...(memory.source.author ? {author:{role:memory.source.author.role,actorId:memory.source.author.actorId}} : {}),
        ...(memory.source.reference ? {reference:{fileHash:memory.source.reference.fileHash,table:memory.source.reference.table,row:memory.source.reference.row}} : {}),
        ...(memory.source.knowledge ? {knowledge:{
          kind:memory.source.knowledge.kind,...(memory.source.knowledge.actorId?{actorId:memory.source.knowledge.actorId}:{}),
          observationId:memory.source.knowledge.observationId,start:memory.source.knowledge.start,end:memory.source.knowledge.end,
        }} : {}),
      },
      access: memory.access,
      ...(memory.reactivated?{reactivated:true}:{}),
      kind: memory.kind ?? 'legacy',
      protectedFacts: [...memory.protectedFacts],
    };
    if (memory.access !== 'hidden' && memory.kind === 'episode' && memory.episode) {
      view.feelingBasis = memory.episode.feelingBasis;
    }
    switch (memory.access) {
      case 'clear':
        view.detail = memory.detail;
        view.gist = memory.gist;
        view.feeling = memory.feeling;
        view.anchor = memory.anchor;
        if (memory.kind === 'episode' && memory.episode) {
          view.episode = {
            scene: memory.episode.scene,
            participants: [...memory.episode.participants],
            sensoryCues: [...memory.episode.sensoryCues],
            appraisal: memory.episode.appraisal,
            feelingBasis: memory.episode.feelingBasis,
            feelingQuote: memory.episode.feelingQuote,
            evidenceQuotes: [...(memory.episode.evidenceQuotes ?? [memory.detail])],
          };
        }
        break;
      case 'gist':
        view.gist = coarseLayer(memory,'gist');
        view.feeling = coarseLayer(memory,'feeling');
        view.anchor = coarseLayer(memory,'anchor');
        view.forgotten = '具体细节已遗忘，只记得大意、感觉和事件锚点。';
        break;
      case 'feeling':
        view.feeling = coarseLayer(memory,'feeling');
        view.anchor = coarseLayer(memory,'anchor');
        view.forgotten = '细节与大意已遗忘，只保留感觉和事件锚点。';
        break;
      case 'anchor':
        view.anchor = coarseLayer(memory,'anchor');
        view.forgotten = '细节与情景已遗忘，只保留事件锚点。';
        break;
      case 'hidden':
        if (view.protectedFacts.length === 0) continue;
        view.forgotten = '此记忆的其它内容当前不可访问。';
        break;
      default:
        throw new Error('invalid_access');
    }
    memories.push(view);
  }
  return {
    scope: {
      worldId: snapshot.scope.worldId,
      sessionId: snapshot.scope.sessionId,
      branchId: snapshot.scope.branchId,
      characterId: snapshot.scope.characterId,
    },
    version: snapshot.version,
    memories,
  };
}

function coarseLayer(memory: Memory, layer: keyof typeof conservativeCoarse): string {
  return withoutDirectCopy(memory.detail,memory[layer],layer,memory.protectedFacts);
}

function compactCopyText(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/[\p{P}\p{S}\s]/gu,'');
}

function sharesExactRun(left: string, right: string, length: number): boolean {
  if (left.length < length || right.length < length) return false;
  const shorter = left.length <= right.length ? left : right;
  const longer = left.length <= right.length ? right : left;
  for (let index=0; index<=shorter.length-length; index++) {
    if (longer.includes(shorter.slice(index,index+length))) return true;
  }
  return false;
}

function sameScope(a: Scope, b: Scope): boolean {
  return a.worldId === b.worldId && a.sessionId === b.sessionId
    && a.branchId === b.branchId && a.characterId === b.characterId;
}
