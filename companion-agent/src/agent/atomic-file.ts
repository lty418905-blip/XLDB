import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

const RETRY_CODES=new Set(['EPERM','EACCES','EBUSY']);
const RETRIES=10;
/** Each retry waits a jittered 25-100 ms so two writers blocked by the same reader do not retry in lockstep. */
const retryDelayMs=()=>25+Math.floor(Math.random()*76);
const pause=new Int32Array(new SharedArrayBuffer(4));

/**
 * Writes pretty-printed JSON through a same-directory temporary file and a rename, so readers see the old or the new
 * document, never a partial one. A rename blocked by a Windows reader is retried a few times before failing.
 */
export function writeJsonAtomic(file:string,value:unknown):void {
  const target=path.resolve(file);
  const directory=path.dirname(target);
  const temporary=path.join(directory,`.${path.basename(target)}.${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary,JSON.stringify(value,null,2),{encoding:'utf8',flag:'wx'});
    for(let attempt=0;;attempt++) {
      try {fs.renameSync(temporary,target);return;}
      catch(error) {
        const code=(error as NodeJS.ErrnoException).code;
        if(attempt>=RETRIES||!code||!RETRY_CODES.has(code))throw error;
        Atomics.wait(pause,0,0,retryDelayMs());
      }
    }
  } finally {
    fs.rmSync(temporary,{force:true});
  }
}

export function readJson<T=unknown>(file:string):T {
  return JSON.parse(fs.readFileSync(file,'utf8')) as T;
}
