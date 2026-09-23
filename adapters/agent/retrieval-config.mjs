import fs from 'node:fs';
import path from 'node:path';

function provider(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_retrieval_config');
  const {baseUrl, model} = value;
  const key=value.key ?? '';
  if (![baseUrl, key, model].every(item => typeof item === 'string')) throw new Error('invalid_retrieval_config');
  if (!baseUrl.trim() && !key.trim() && !model.trim()) return undefined;
  if (!baseUrl.trim() || !model.trim()) throw new Error('invalid_retrieval_config');
  let url;
  try { url = new URL(baseUrl.trim()); }
  catch { throw new Error('invalid_retrieval_config'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('invalid_retrieval_config');
  }
  return {baseUrl:baseUrl.trim(),key:key.trim(),model:model.trim()};
}

/** The default file is optional; an explicit file must exist. Errors never include its contents. */
export function loadRetrievalConfig(root, explicitPath) {
  const filename=explicitPath === undefined
    ? path.join(root,'.local','agent','retrieval-api.txt')
    : path.resolve(explicitPath);
  if (explicitPath === undefined && !fs.existsSync(filename)) return undefined;
  let document;
  try { document=JSON.parse(fs.readFileSync(filename,'utf8').replace(/^\uFEFF/,'')); }
  catch { throw new Error('invalid_retrieval_config'); }
  if (!document || typeof document !== 'object' || Array.isArray(document)) throw new Error('invalid_retrieval_config');
  const embedding=provider(document.embedding);
  const reranker=provider(document.reranker);
  return {...(embedding?{embedding}:{}),...(reranker?{reranker}:{})};
}
