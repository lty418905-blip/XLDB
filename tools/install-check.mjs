import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';

const args=process.argv.slice(2);
const rootIndex=args.indexOf('--root');
const root=path.resolve(rootIndex>=0&&args[rootIndex+1]?args[rootIndex+1]:path.resolve(import.meta.dirname,'..'));
const quiet=args.includes('--quiet');
const diagnosticBase=path.resolve(root,'.local','install-check');
const diagnostic=path.join(diagnosticBase,crypto.randomUUID());
let runDirectory;

function packageVersion(base,name){
  return JSON.parse(fs.readFileSync(path.join(base,'node_modules',...name.split('/'),'package.json'),'utf8')).version;
}

try {
  assert.equal(process.platform,'win32','Windows is required');
  assert.equal(process.arch,'x64','Windows x64 Node.js is required');
  const version=process.versions.node.split('.').map(Number);
  assert.equal(version[0],24,'Node.js 24.x is required');
  assert.ok(version[1]>18||(version[1]===18&&version[2]>=1),'Node.js 24.18.1 or newer is required');
  const runtime=path.join(root,'.local','runtime');
  const tooling=path.join(root,'.local','tooling');
  assert.equal(packageVersion(runtime,'@lancedb/lancedb'),'0.39.0');
  assert.equal(packageVersion(runtime,'@lancedb/lancedb-win32-x64-msvc'),'0.39.0');
  assert.equal(packageVersion(tooling,'typescript'),'5.9.3');
  assert.equal(packageVersion(tooling,'@types/node'),'24.13.6');

  const lance=await import(pathToFileURL(path.join(runtime,'node_modules','@lancedb','lancedb','dist','index.js')));
  assert.equal(typeof lance.connect,'function');
  fs.mkdirSync(diagnostic,{recursive:true});
  const connection=await lance.connect(path.join(diagnostic,'lance'));
  if(typeof connection.close==='function') connection.close();

  const dataDirectory=path.join(diagnostic,'agent-data');
  const requestPath=path.join(diagnostic,'request.json');
  fs.writeFileSync(requestPath,JSON.stringify({
    operation:'interaction',
    scope:{worldId:'install-check',sessionId:'install-check',branchId:'main',characterId:'diagnostic'},
    dataDirectory
  }));
  const cli=path.join(root,'adapters','agent','cli.mjs');
  const child=spawnSync(process.execPath,[cli,'run',requestPath],{cwd:root,encoding:'utf8',windowsHide:true});
  assert.equal(child.status,0,child.stderr||child.stdout);
  const events=child.stdout.trim().split(/\r?\n/u).filter(Boolean).map(line=>JSON.parse(line));
  runDirectory=events[0]?.runDirectory;
  assert.ok(runDirectory&&events.at(-1)?.status==='completed','Agent CLI did not complete');
  const result=JSON.parse(fs.readFileSync(events.at(-1).resultPath,'utf8'));
  assert.equal(result.mode,'companion');

  const report={
    status:'ready',
    root,
    node:{version:process.versions.node,architecture:process.arch},
    checks:{typescript:'5.9.3',lancedb:'0.39.0',lancedbNative:'0.39.0',agentCli:'companion_non_model'}
  };
  const bundlePath=path.join(root,'.local/agentjev/bundle.json');
  if(fs.existsSync(bundlePath)){
    const bundle=JSON.parse(fs.readFileSync(bundlePath,'utf8'));
    const model=path.join(root,'.local/agentjev/model/model.safetensors');
    assert.equal(fs.statSync(model).size,2393718620,'AgentJev weight file is incomplete');
    const cache=path.join(root,'.local/agentjev/cache');
    fs.mkdirSync(cache,{recursive:true});
    const python=spawnSync(path.join(root,'.local/agentjev/runtime/python.exe'),['-X','utf8','-c',
      'import json,torch,transformers,safetensors; print(json.dumps(dict(torch=torch.__version__,transformers=transformers.__version__,safetensors=safetensors.__version__)))'],
      {cwd:root,encoding:'utf8',windowsHide:true,timeout:60000,env:{...process.env,PYTHONUTF8:'1',PYTHONDONTWRITEBYTECODE:'1',
        HF_HUB_OFFLINE:'1',TRANSFORMERS_OFFLINE:'1',HF_HOME:cache,TEMP:cache,TMP:cache}});
    assert.equal(python.status,0,'AgentJev portable runtime import failed');
    const versions=JSON.parse(python.stdout.trim());
    for(const name of ['torch','transformers','safetensors'])assert.equal(versions[name],bundle.runtime.packages[name]);
    report.checks.agentjev={status:'runtime_imports_only',versions,modelRevision:bundle.modelRevision};
  }
  if(!quiet) process.stdout.write(`${JSON.stringify(report)}\n`);
} finally {
  if(runDirectory&&path.resolve(runDirectory).startsWith(path.join(root,'.local','agent','runs')+path.sep)) fs.rmSync(runDirectory,{recursive:true,force:true});
  const resolvedDiagnostic=path.resolve(diagnostic);
  if(!resolvedDiagnostic.startsWith(`${diagnosticBase}${path.sep}`)) throw new Error('invalid install-check cleanup path');
  fs.rmSync(resolvedDiagnostic,{recursive:true,force:true});
}
