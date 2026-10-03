import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {listPending} from '../src/agent/file-host.ts';
import {runCommand,ensureCommand,stopCommand,statusCommand,waitCommand,onboardingOperations,DAEMON_DEFAULTS,WAIT_DEFAULT_MS} from '../src/agent/daemon-client.ts';
import {loadRetrievalConfig} from './retrieval-config.mjs';
import {startCompanionOnboarding} from './onboarding.mjs';

// The runtime (and LanceDB) is imported only where this process opens the database itself: the in-process fallback of
// `run` and `onboard`, and `daemon serve`. A `run` or `onboard` served by a live daemon stays a thin client.
const root=fileURLToPath(new URL('../../',import.meta.url));
const entryPath=fileURLToPath(import.meta.url);
const [command,argument,...rest]=process.argv.slice(2);
/** The data directory, resolved against the caller's cwd, must be inside the workspace .local; it is created. */
function dataDirectoryOf(value){
  const dataDirectory=path.resolve(value??path.join(root,'.local/agent/data'));
  const allowedRoot=path.join(root,'.local');
  if(!dataDirectory.startsWith(allowedRoot+path.sep))throw new Error('Agent dataDirectory must be inside workspace .local');
  fs.mkdirSync(dataDirectory,{recursive:true});
  return dataDirectory;
}
const print=line=>console.log(JSON.stringify(line));
const DAEMON_USAGE='Usage: node companion-agent/adapters/cli.mjs daemon ensure|start [--stay] [--session-idle-ms N] [--stop-grace-ms N] [--conversation-window-ms N] | stop [--force] | status  [--data-directory DIR]';
/** Parses `--flag` and `--name value` options; every value option is a non-negative integer except paths. */
function daemonOptions(args,allowed,usage=DAEMON_USAGE){
  const options={};
  for(let index=0;index<args.length;index++){
    const name=args[index];
    if(!allowed.includes(name))throw new Error(usage);
    if(name==='--stay'||name==='--force'){options[name.slice(2)]=true;continue;}
    const value=args[++index];if(value===undefined)throw new Error(usage);
    const key=name.slice(2).replace(/-([a-z])/g,(_,c)=>c.toUpperCase());
    if(name.endsWith('-ms')||name==='--timeout'){if(!/^\d+$/.test(value))throw new Error(usage);options[key]=Number(value);}
    else options[key]=value;
  }
  return options;
}
if(command==='onboard') {
  if(!argument||rest.some(value=>value!=='--no-open'))throw new Error('Usage: node companion-agent/adapters/cli.mjs onboard REQUEST_JSON [--no-open]');
  const request=JSON.parse(fs.readFileSync(path.resolve(argument),'utf8'));
  const dataDirectory=dataDirectoryOf(request.dataDirectory);
  // Through the daemon while it is alive (each call a daemon run with origin onboard), otherwise a runtime in this
  // process, under the same lease probe and re-route rules as `run`.
  const route=await onboardingOperations({root,entryPath,dataDirectory,print,openRuntime:async()=>{
    const {AgentRuntime}=await import('../src/agent/runtime.ts');
    return new AgentRuntime({databasePath:path.join(dataDirectory,'authority.sqlite'),indexPath:path.join(dataDirectory,'indexes'),delegate:async()=>{throw Error('host_delegate_unavailable');}});
  }});
  let session;
  const openBrowser=async url=>{
    if(rest.includes('--no-open'))return;
    const executable=process.platform==='win32'?'rundll32.exe':process.platform==='darwin'?'open':'xdg-open';
    const args=process.platform==='win32'?['url.dll,FileProtocolHandler',url]:[url];
    await new Promise((resolve,reject)=>{
      const child=spawn(executable,args,{windowsHide:true,stdio:'ignore'});
      child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(Error('browser_open_failed')));
    });
  };
  try{
    session=await startCompanionOnboarding({runtime:route.operations,scope:request.scope,openBrowser});
    if(session.url)console.log(JSON.stringify({status:'waiting_for_selection',url:session.url,scope:request.scope,
      ...(session.browserOpenFailed?{browserOpenFailed:true}: {})}));
    const stop=()=>session.close();process.once('SIGINT',stop);process.once('SIGTERM',stop);
    const result=await session.result;
    process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);
    console.log(JSON.stringify(result));
    if(result.status==='failed')process.exitCode=1;
  }finally{session?.close();route.close();}
} else if(command==='cancel') {
  if(!argument||rest.length)throw new Error('Usage: node companion-agent/adapters/cli.mjs cancel RUN_DIRECTORY');
  const directory=path.resolve(argument);const run=JSON.parse(fs.readFileSync(path.join(directory,'run.json'),'utf8'));
  if(run.status==='running')fs.writeFileSync(path.join(directory,'cancel.json'),JSON.stringify({requestedAt:new Date().toISOString()}));
  console.log(JSON.stringify({status:run.status==='running'?'cancel_requested':run.status}));
} else if(command==='jobs') {
  if(!argument||rest.length)throw new Error('Usage: node companion-agent/adapters/cli.mjs jobs RUN_DIRECTORY');
  console.log(JSON.stringify(await listPending(path.resolve(argument))));
} else if(command==='run') {
  if(!argument||rest.length)throw new Error('Usage: node companion-agent/adapters/cli.mjs run REQUEST_JSON');
  const request=JSON.parse(fs.readFileSync(path.resolve(argument),'utf8'));
  const dataDirectory=dataDirectoryOf(request.dataDirectory);
  process.exitCode=await runCommand({root,entryPath,dataDirectory,request,print,
    loadRetrieval:retrievalConfigPath=>loadRetrievalConfig(root,retrievalConfigPath)});
} else if(command==='wait') {
  const usage='Usage: node companion-agent/adapters/cli.mjs wait [--timeout MS] [--cursor CURSOR] [--data-directory DIR]';
  const options=daemonOptions([argument,...rest].filter(value=>value!==undefined),['--timeout','--cursor','--data-directory'],usage);
  const timeoutMs=options.timeout??WAIT_DEFAULT_MS;
  if(timeoutMs<1000||timeoutMs>3_600_000)throw new Error(usage);
  const output=await waitCommand({root,entryPath,dataDirectory:dataDirectoryOf(options.dataDirectory),print,timeoutMs,cursor:options.cursor??null});
  print(output);if(output.events.some(event=>event.type==='wait_failed'))process.exitCode=1;
} else if(command==='daemon') {
  const args=rest;const sub=argument;
  const common=['--data-directory'];
  if(sub==='serve') {
    // --drain-limit-ms is internal (tests shorten the shutdown drain with it); ensure never passes it.
    const options=daemonOptions(args,[...common,'--stay','--session-idle-ms','--stop-grace-ms','--conversation-window-ms','--drain-limit-ms','--stdout-log','--stderr-log']);
    const {serve}=await import('../src/agent/daemon.ts');
    const code=await serve({root,entryPath,dataDirectory:dataDirectoryOf(options.dataDirectory),stay:!!options.stay,
      sessionIdleMs:options.sessionIdleMs??DAEMON_DEFAULTS.sessionIdleMs,stopGraceMs:options.stopGraceMs??DAEMON_DEFAULTS.stopGraceMs,
      conversationWindowMs:options.conversationWindowMs??DAEMON_DEFAULTS.conversationWindowMs,drainLimitMs:options.drainLimitMs,
      logPaths:{stdout:options.stdoutLog??null,stderr:options.stderrLog??null},
      loadRetrieval:retrievalConfigPath=>loadRetrievalConfig(root,retrievalConfigPath)});
    process.exit(code);
  }
  let outcome;
  if(sub==='ensure'||sub==='start') {
    const options=daemonOptions(args,[...common,'--stay','--session-idle-ms','--stop-grace-ms','--conversation-window-ms']);
    outcome=await ensureCommand({root,entryPath,dataDirectory:dataDirectoryOf(options.dataDirectory),print,start:sub==='start',stay:!!options.stay,
      sessionIdleMs:options.sessionIdleMs??DAEMON_DEFAULTS.sessionIdleMs,stopGraceMs:options.stopGraceMs??DAEMON_DEFAULTS.stopGraceMs,
      conversationWindowMs:options.conversationWindowMs??DAEMON_DEFAULTS.conversationWindowMs});
  } else if(sub==='stop') {
    const options=daemonOptions(args,[...common,'--force']);
    outcome=await stopCommand({root,entryPath,dataDirectory:dataDirectoryOf(options.dataDirectory),print,force:!!options.force});
  } else if(sub==='status') {
    const options=daemonOptions(args,common);
    outcome=await statusCommand({root,entryPath,dataDirectory:dataDirectoryOf(options.dataDirectory),print});
  } else throw new Error(DAEMON_USAGE);
  print(outcome.output);process.exitCode=outcome.code;
} else throw new Error('Usage: node companion-agent/adapters/cli.mjs onboard REQUEST_JSON | run REQUEST_JSON | jobs RUN_DIRECTORY | cancel RUN_DIRECTORY | wait [--timeout MS] [--cursor CURSOR] | daemon ensure|start|stop|status');
