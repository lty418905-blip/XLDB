import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { connect, Index } from '../../.local/runtime/node_modules/@lancedb/lancedb/dist/index.js';
import { projectMemories } from './access.ts';
import {retentionSnapshot} from './retention.ts';
import type { MemorySnapshot, MemoryView, Scope } from './access.ts';
import type { ModelConfig } from '../core/types.ts';
import { scopeKey } from '../core/types.ts';
import {MemoryTokenizer} from './tokenizer.ts';
import type {ChineseTokenizer} from './tokenizer.ts';

const CANDIDATE_LIMIT = 20;
const DEFAULT_EXTERNAL_TIMEOUT_MS = 15_000;
const SEARCH_LIMIT = 40;
const EMBEDDING_BATCH = 32;

export type RetrievalConfig = { embedding: ModelConfig; reranker: ModelConfig };
type IndexedRow = { id: string; text: string; kind: string; lexical?: string; vector?: number[] };
type RerankResult = { index: number; score: number };
export interface RetrievalOptions {tokenizer?:ChineseTokenizer|'default';minimumRerankScore?:number;externalTimeoutMs?:number}
export interface RetrievalResult {ids:string[];mode:string;tokenizer:ChineseTokenizer;intent:'fact'|'episode'|'balanced';cacheHit:boolean;topScore?:number;
  fallbackReason?:'embedding_request_failed'|'rerank_request_failed'}
type Provider = {url:string;key:string;model:string};
type Projection = {fingerprint:string;table:any;results:Map<string,RetrievalResult>};

/**
 * A disposable LanceDB projection.  It contains only text allowed by the supplied
 * authority snapshot and is never a source of truth: callers recheck returned IDs
 * against the current authority after this async operation.
 */
export class Retrieval {
  private connection: Awaited<ReturnType<typeof connect>> | undefined;
  private readonly tables = new Map<string, Projection>();
  private readonly pending = new Map<string,Promise<void>>();
  private readonly queryVectors = new Map<string,number[]>();
  private readonly directory: string;
  private readonly tokenizer:MemoryTokenizer;
  private readonly minimumRerankScore:number|undefined;
  private readonly externalTimeoutMs:number;

  constructor(directory: string,options:RetrievalOptions={}) {
    this.directory = directory;
    this.tokenizer=new MemoryTokenizer(options.tokenizer==='default'?undefined:options.tokenizer);
    if(options.minimumRerankScore!==undefined&&!Number.isFinite(options.minimumRerankScore))throw new Error('invalid_rerank_threshold');
    if(options.externalTimeoutMs!==undefined&&(!Number.isSafeInteger(options.externalTimeoutMs)||options.externalTimeoutMs<1||options.externalTimeoutMs>30_000))throw new Error('invalid_external_timeout');
    this.minimumRerankScore=options.minimumRerankScore;
    this.externalTimeoutMs=options.externalTimeoutMs??DEFAULT_EXTERNAL_TIMEOUT_MS;
  }

  async search(
    snapshot: MemorySnapshot,
    query: string,
    config: RetrievalConfig,
    nowMs: number,
  ): Promise<RetrievalResult> {
    if (typeof query !== 'string' || query.length > 20_000) throw new Error('invalid_query');
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error('invalid_time');
    snapshot=retentionSnapshot(snapshot,nowMs,query);

    const key=scopeKey(snapshot.scope);
    return this.serialized(key,async () => {
      const views = projectMemories(snapshot, {
        scope: snapshot.scope,
        asOfMs: nowMs,
        ids: [...snapshot.memories.keys()],
      }).memories;
      const rows:IndexedRow[] = views.map(view => ({ id: view.id, text: allowedText(view),kind:view.kind??'legacy' })).filter(row => row.text.length > 0);
      const embedding = configured(config.embedding, 'embedding');
      const reranker = configured(config.reranker, 'reranker');
      const mode = embedding ? (reranker ? 'hybrid+rerank' : 'hybrid') : (reranker ? 'bm25+rerank' : 'bm25');
      const intent=queryIntent(query);
      const result=(resultMode:string,ids:string[],extra:Partial<RetrievalResult>={}):RetrievalResult=>({ids,mode:resultMode,tokenizer:this.tokenizer.name,intent,cacheHit:false,...extra});
      if (rows.length === 0) {
        await this.clearProjection(key);
        return result(mode,[]);
      }
      // A protected fact remains stored and searchable, not automatically injected
      // into every unrelated query. An empty query is an explicit recent-memory view.
      if(!query.trim())return result(mode,recentMemoryIds(views));
      const identifiers=query.match(/\b[A-Z][A-Z0-9]*(?:[-_][A-Z0-9]+)+\b/g)??[];
      if(identifiers.some(id=>!rows.some(row=>row.text.includes(id))))return result(mode,[]);
      const deadline=Date.now()+this.externalTimeoutMs;
      const run=async(activeEmbedding:Provider|undefined,activeReranker:Provider|undefined,resultMode:string,fallbackReason?:RetrievalResult['fallbackReason'])=>{
        const fingerprint = digest(JSON.stringify({
          format:2,tokenizer:this.tokenizer.fingerprint,embedding:identity(activeEmbedding),rows,
        }));
        const projection=await this.table(key,fingerprint,rows,activeEmbedding,deadline);
        const table=projection.table;
        const cacheKey=digest(JSON.stringify([query,identity(activeReranker),activeReranker?digest(activeReranker.key):'',activeEmbedding?digest(activeEmbedding.key):'',this.minimumRerankScore,fallbackReason]));
        const cached=projection.results.get(cacheKey);
        if(cached)return {...cached,ids:[...cached.ids],cacheHit:true};
        const rowById=new Map(rows.map(row=>[row.id,row]));
        const queries=queryParts(query);
        // Batch the aspect vectors and share the same bounded external deadline.
        if(activeEmbedding)await this.prepareQueryVectors(key,queries,activeEmbedding,deadline);
        const lists=await Promise.all(queries.map(async part=>{
          const lexicalQuery=await this.tokenizer.query(part);
          const [lexical,semantic]=await Promise.all([
            lexicalQuery?table.search(lexicalQuery,'fts','lexical').select(['id','_score']).limit(SEARCH_LIMIT).toArray():[],
            activeEmbedding?this.queryVector(key,part,activeEmbedding,deadline).then(vector=>table.vectorSearch(vector).column('vector').distanceType('cosine').select(['id','_distance']).limit(SEARCH_LIMIT).toArray()):[],
          ]);
          const ranked=new Map<string,number>();addRanks(ranked,lexical);addRanks(ranked,semantic);
          const candidates=[...ranked.entries()].filter(([id])=>rowById.has(id)).map(([id,score])=>({id,score:score*(intent!=='balanced'&&rowById.get(id)!.kind===intent?1.15:1)}))
            .sort((a,b)=>b.score-a.score||a.id.localeCompare(b.id)).slice(0,CANDIDATE_LIMIT).map(item=>item.id);
          if(!activeReranker||!candidates.length)return {ids:candidates,topScore:undefined};
          let reranked:RerankResult[];
          try{reranked=await rerank(activeReranker,part,candidates.map(id=>rowById.get(id)!.text),deadline);}
          catch(error){
            if(providerFailure(error)!=='rerank_request_failed')throw error;
            return {ids:candidates,topScore:undefined,rerankFailed:true};
          }
          // A provider score is an ordering signal, not a calibrated probability.
          const floor=this.minimumRerankScore??-Infinity;
          return {ids:reranked.filter(item=>item.score>=floor).map(item=>candidates[item.index]),topScore:reranked[0]?.score};
        }));
        const ids:string[]=[];
        for(let rank=0;rank<CANDIDATE_LIMIT&&ids.length<CANDIDATE_LIMIT;rank++)for(const list of lists){
          const id=list.ids[rank];if(id&&!ids.includes(id)&&ids.length<CANDIDATE_LIMIT)ids.push(id);
        }
        const rerankFailed=lists.some(list=>'rerankFailed' in list&&list.rerankFailed);
        const output=result(rerankFailed?(activeEmbedding?'hybrid-fallback':'bm25-fallback'):resultMode,ids,
          {topScore:lists[0]?.topScore,...(rerankFailed?{fallbackReason:'rerank_request_failed' as const}:fallbackReason?{fallbackReason}:{})});
        if(!rerankFailed)cache(projection.results,cacheKey,output,64);
        return {...output,ids:[...output.ids]};
      };
      try{return await run(embedding,reranker,mode);}
      catch(error){
        const reason=providerFailure(error);
        if(!reason)throw error;
        // Rebuild a text-only projection from this authority snapshot. Failed or
        // partial vectors never enter the projection, and the next search retries
        // the configured provider because its fingerprint differs from this one.
        return run(undefined,undefined,'bm25-fallback',reason);
      }
    });
  }

  close(): void {
    this.connection?.close();
    this.connection = undefined;
    this.tables.clear();
    this.queryVectors.clear();
  }

  async clear(scope: Scope): Promise<void> {
    const key=scopeKey(scope);
    await this.serialized(key,()=>this.clearProjection(key));
  }

  private async table(
    key: string,
    fingerprint: string,
    rows: IndexedRow[],
    embedding: { url: string; key: string; model: string } | undefined,
    deadline: number,
  ): Promise<Projection> {
    const cached=this.tables.get(key);
    if(cached?.fingerprint===fingerprint)return cached;
    try {
      const name=projectionName(key);
      const metadataPath=path.join(this.directory,`${name}.projection.json`);
      const database=this.connection??=await connect(this.directory);
      let metadata:{fingerprint?:string;embedding?:string;tokenizer?:string}={};
      try{metadata=JSON.parse(fs.readFileSync(metadataPath,'utf8'));}catch{/* Disposable cache, rebuild from authority. */}
      let previous:any;
      try{previous=await database.openTable(name);}catch{/* First projection. */}
      if(previous&&metadata.fingerprint===fingerprint){
        const projection={fingerprint,table:previous,results:new Map<string,RetrievalResult>()};cache(this.tables,key,projection,16);return projection;
      }
      const oldRows=new Map<string,IndexedRow>();
      if(previous&&metadata.tokenizer&&(metadata.embedding===identity(embedding)||!embedding)){
        const stored=await previous.query().select(embedding?['id','text','lexical','vector']:['id','text','lexical']).toArray();
        for(const row of stored)oldRows.set(row.id,{...row,...(row.vector?{vector:Array.from(row.vector) as number[]}: {})});
      }
      const indexed:IndexedRow[]=[];const missing:number[]=[];
      for(const row of rows){
        const old=oldRows.get(row.id);const same=old?.text===row.text;
        const lexical=same&&metadata.tokenizer===this.tokenizer.fingerprint&&old.lexical!==undefined?old.lexical:await this.tokenizer.document(row.text);
        const next={...row,lexical,...(embedding&&same&&old.vector?{vector:old.vector}: {})};
        if(embedding&&!next.vector)missing.push(indexed.length);
        indexed.push(next);
      }
      if(embedding)for(let offset=0;offset<missing.length;offset+=EMBEDDING_BATCH){
        const batch=missing.slice(offset,offset+EMBEDDING_BATCH);
        const vectors=await embed(embedding,batch.map(index=>indexed[index].text),deadline);
        batch.forEach((index,i)=>{indexed[index].vector=vectors[i];});
      }
      const table=await database.createTable(name,indexed,{mode:'overwrite'});
      await table.createIndex('lexical',{config:Index.fts({baseTokenizer:'whitespace',stem:false,removeStopWords:false,asciiFolding:false})});
      fs.mkdirSync(this.directory,{recursive:true});
      const temporary=metadataPath+'.tmp';fs.writeFileSync(temporary,JSON.stringify({fingerprint,embedding:identity(embedding),tokenizer:this.tokenizer.fingerprint}));fs.renameSync(temporary,metadataPath);
      const projection={fingerprint,table,results:new Map<string,RetrievalResult>()};cache(this.tables,key,projection,16);return projection;
    } catch (error) {
      this.tables.delete(key);
      if (error instanceof Error && (error.message === 'invalid_embedding_response' || error.message === 'embedding_request_failed')) throw error;
      throw new Error('index_build_failed');
    }
  }

  private async queryVector(key:string,query:string,embedding:Provider,deadline:number):Promise<number[]>{
    const id=digest(JSON.stringify([key,query,identity(embedding),digest(embedding.key)]));
    const existing=this.queryVectors.get(id);if(existing)return existing;
    const vector=(await embed(embedding,[query],deadline))[0];cache(this.queryVectors,id,vector,64);return vector;
  }

  private async prepareQueryVectors(key:string,queries:string[],embedding:Provider,deadline:number){
    const missing=queries.map(query=>({query,id:digest(JSON.stringify([key,query,identity(embedding),digest(embedding.key)]))}))
      .filter(item=>!this.queryVectors.has(item.id));
    if(!missing.length)return;
    const vectors=await embed(embedding,missing.map(item=>item.query),deadline);
    missing.forEach((item,index)=>cache(this.queryVectors,item.id,vectors[index],64));
  }

  private async clearProjection(key:string):Promise<void>{
    this.tables.delete(key);
    this.queryVectors.clear();
    if(!fs.existsSync(this.directory))return;
    const name=projectionName(key);
    const metadataPath=path.join(this.directory,`${name}.projection.json`);
    try {
      const database=this.connection??=await connect(this.directory);
      if((await database.tableNames()).includes(name))await database.dropTable(name);
      fs.rmSync(metadataPath,{force:true});
    } catch {
      throw new Error('retrieval_cleanup_failed');
    }
  }

  private async serialized<T>(key:string,operation: () => Promise<T>): Promise<T> {
    const previous = this.pending.get(key);
    let release!: () => void;
    const current=new Promise<void>(resolve => { release = resolve; });this.pending.set(key,current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if(this.pending.get(key)===current)this.pending.delete(key);
    }
  }
}

function allowedText(view: MemoryView): string {
  const texts=[view.detail, view.gist, view.feeling, view.anchor, ...view.protectedFacts,view.episode?.scene,
    ...(view.episode?.participants??[]),...(view.episode?.sensoryCues??[]),view.episode?.appraisal]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
  return unique(texts).filter(value=>!texts.some(other=>other.length>value.length&&other.includes(value))).join('\n');
}

function recentMemoryIds(views: readonly MemoryView[]): string[] {
  return [...views]
    .sort((a, b) => (b.source.occurredAtMs??b.source.knownAtMs) - (a.source.occurredAtMs??a.source.knownAtMs) || b.source.knownAtMs - a.source.knownAtMs)
    .map(view => view.id)
    .slice(0, CANDIDATE_LIMIT);
}

function addRanks(ranked: Map<string, number>, results: readonly unknown[]): void {
  for (let index = 0; index < results.length; index++) {
    const id = record(results[index]).id;
    if (typeof id !== 'string') continue;
    ranked.set(id, (ranked.get(id) ?? 0) + 1 / (60 + index + 1));
  }
}

function queryIntent(query:string):RetrievalResult['intent']{
  if(/感受|感觉|想起|回忆|为何|为什么|怎么想|安心|紧张|害怕|失望|高兴|敬佩|看法|安全感|和解|理解|怎样|如何/.test(query))return 'episode';
  if(/多少|几点|编号|号码|金额|口令|约定|承诺|身份|日期|库存|由谁|是谁|哪位|哪页|颜色/.test(query))return 'fact';
  return 'balanced';
}

/** Split explicit lists, not inferred topics; an ordinary sentence stays intact. */
export function queryParts(query:string):string[]{
  if(!/[、；;]|\n\s*\d+[.)、]/.test(query))return [query];
  const parts=query.split(/[、；;]|\n\s*\d+[.)、]/).flatMap(part=>part.split(/\s+and\s+|和|以及|及其/u))
    .map(part=>part.trim()).filter(part=>part.length>=2);
  return parts.length>=2&&parts.length<=6?[query,...parts]:[query];
}
function identity(provider:Provider|undefined):string{return provider?JSON.stringify([provider.url,provider.model]):'none';}
function cache<K,V>(map:Map<K,V>,key:K,value:V,limit:number){map.delete(key);map.set(key,value);if(map.size>limit)map.delete(map.keys().next().value!);}
function providerFailure(error:unknown):RetrievalResult['fallbackReason']|undefined{
  if(!(error instanceof Error))return undefined;
  if(error.message==='embedding_request_failed'||error.message==='rerank_request_failed')return error.message;
  return undefined;
}

function configured(config: ModelConfig, stage: 'embedding' | 'reranker'):
  | { url: string; key: string; model: string }
  | undefined {
  const baseUrl = typeof config?.baseUrl === 'string' ? config.baseUrl.trim() : '';
  const key = typeof config?.key === 'string' ? config.key.trim() : '';
  const model = typeof config?.model === 'string' ? config.model.trim() : '';
  if (!baseUrl && !key && !model) return undefined;
  if (!baseUrl || !model || (key && !baseUrl)) throw new Error(`invalid_${stage}_config`);
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error(`invalid_${stage}_config`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(`invalid_${stage}_config`);
  }
  return { url: endpoint(parsed, stage), key, model };
}

function endpoint(base: URL, stage: 'embedding' | 'reranker'): string {
  const expected = `/${stage === 'embedding' ? 'embeddings' : 'rerank'}`;
  const path = base.pathname.replace(/\/+$/, '');
  base.pathname = path.endsWith(expected) ? path : `${path}${expected}`;
  return base.toString();
}

async function embed(config: { url: string; key: string; model: string }, input: string[],deadline:number): Promise<number[][]> {
  const body = await request(config, { model: config.model, input, encoding_format: 'float' }, 'embedding',deadline);
  try {
    const data = record(body).data;
    if (!Array.isArray(data) || data.length !== input.length) throw new Error('invalid_embedding_response');
    const result: number[][] = new Array(input.length);
    for (const item of data) {
      const entry = record(item);
      const index = entry.index;
      const vector = entry.embedding;
      if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0 || index >= input.length || result[index] || !Array.isArray(vector) || vector.length === 0 || vector.some(value => typeof value !== 'number' || !Number.isFinite(value))) {
        throw new Error('invalid_embedding_response');
      }
      result[index] = vector as number[];
    }
    if (result.some(vector => !vector) || new Set(result.map(vector => vector.length)).size !== 1) throw new Error('invalid_embedding_response');
    return result;
  } catch {
    throw new Error('invalid_embedding_response');
  }
}

async function rerank(config: { url: string; key: string; model: string }, query: string, documents: string[],deadline:number): Promise<RerankResult[]> {
  const body = await request(config, {
    model: config.model,
    query,
    documents,
    top_n: documents.length,
    return_documents: false,
  }, 'rerank',deadline);
  try {
    const results = record(body).results;
    if (!Array.isArray(results) || results.length === 0 || results.length > documents.length) throw new Error('invalid_rerank_response');
    const seen = new Set<number>();
    return results.map(item => {
      const entry = record(item);
      const index = entry.index;
      const score = entry.relevance_score;
      if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0 || index >= documents.length || seen.has(index) || typeof score !== 'number' || !Number.isFinite(score)) {
        throw new Error('invalid_rerank_response');
      }
      seen.add(index);
      return { index, score };
    }).sort((a, b) => b.score - a.score);
  } catch {
    throw new Error('invalid_rerank_response');
  }
}

async function request(config: { url: string; key: string; model: string }, payload: object, kind: 'embedding' | 'rerank',deadline:number): Promise<unknown> {
  const remaining=deadline-Date.now();
  if(remaining<=0)throw new Error(`${kind}_request_failed`);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(),remaining);
  try {
    const response = await fetch(config.url, {
      method: 'POST',
      headers: config.key ? { Authorization: `Bearer ${config.key}`, 'Content-Type': 'application/json' } : { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
      redirect: 'error',
    });
    if (!response.ok) throw new Error(`${kind}_request_failed`);
    try {
      return await response.json();
    } catch {
      if(controller.signal.aborted)throw new Error(`${kind}_request_failed`);
      throw new Error(`invalid_${kind}_response`);
    }
  } catch (error) {
    if (error instanceof Error && (error.message === `${kind}_request_failed` || error.message === `invalid_${kind}_response`)) throw error;
    throw new Error(`${kind}_request_failed`);
  } finally {
    clearTimeout(timeout);
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_provider_response');
  return value as Record<string, unknown>;
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function projectionName(key:string):string {
  return `memory_${digest(key).slice(0,40)}`;
}
