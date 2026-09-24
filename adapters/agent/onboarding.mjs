import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../../',import.meta.url));
const uiFile=fileURLToPath(new URL('./onboarding.html',import.meta.url));
const maxBody=512_000;

function presets(){
  return fs.readdirSync(path.join(root,'presets/companion')).filter(name=>name.endsWith('.json')).sort()
    .map(file=>({file,document:JSON.parse(fs.readFileSync(path.join(root,'presets/companion',file),'utf8'))}));
}

function errorText(error){return error instanceof Error?error.message:'onboarding_failed';}
function userError(error){
  const code=errorText(error);
  if(error instanceof SyntaxError)return '文件内容不是有效的 JSON，请让创作工具检查后重新导出。';
  if(code==='invalid_companion_preset_birthday')return '生日无效：请填写公历数字月份和日期，例如 4 月 16 日；未知出生年份可以省略。';
  if(code==='invalid_companion_preset_timeline')return '人生时间线不一致：请检查年龄、事件顺序和距初次相遇的年数。';
  if(code==='invalid_companion_preset_length')return '角色文件内容过长：请让创作工具按指南压缩导入资料，把完整经历保留在 Markdown 档案中。';
  if(code==='companion_preset_scope_occupied')return '这个会话已有角色或经历，请回到 Agent 创建新的伴侣会话。';
  if(code==='onboarding_finished')return '本次选择已经结束，请回到 Agent 重新打开角色选择。';
  if(code==='selection_needs_preview'||code==='invalid_companion_preset_preview')return '选择或会话状态已变化，请重新预览后确认。';
  if(code.startsWith('invalid_companion_preset'))return '角色文件与模板格式不符，请把文件和创作指南交给创作工具检查字段后重新导出。';
  return '未能处理这份角色资料，请回到 Agent 查看原因，或按模板重新生成文件。';
}
function reviewOf(document){
  const history=document.lifeBeforeMeeting?.timeline??document.background?.timeline;
  const timeline=Array.isArray(history)?history:[];
  return {name:document.identity?.name,birthday:document.identity?.birthday??null,ageAtFirstMeeting:document.identity?.ageAtFirstMeeting??null,
    nature:document.identity?.nature??null,personality:document.personality?.core??null,
    firstLifeEvent:timeline[0]?.event??timeline[0]?.claim??null,lastLifeEvent:timeline.at(-1)?.event??timeline.at(-1)?.claim??null,
    currentLife:document.lifeBeforeMeeting?.currentLife??null,relationship:document.initialUserRelation??null,
    interaction:document.interaction??null,aspirations:document.aspirations??[],completionSlots:document.completion.slots,document};
}
function locationOf(value){
  if(value===undefined)return {status:'unavailable'};
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('invalid_onboarding_location');
  if(value.status==='denied'||value.status==='unavailable')return {status:value.status};
  if(value.status!=='granted')throw new Error('invalid_onboarding_location');
  const {latitude,longitude,accuracyMeters,observedAtMs}=value;
  const now=Date.now();
  if(!Number.isFinite(latitude)||latitude < -90||latitude > 90||!Number.isFinite(longitude)||longitude < -180||longitude > 180||
    !Number.isFinite(accuracyMeters)||accuracyMeters < 0||accuracyMeters > 100_000||!Number.isSafeInteger(observedAtMs)||
    observedAtMs < 0||observedAtMs > now+300_000)throw new Error('invalid_onboarding_location');
  return {status:'granted',latitude,longitude,accuracyMeters,observedAtMs};
}
function response(res,status,value){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(value));}
async function bodyOf(request){
  if(request.headers['content-type']?.split(';')[0]!=='application/json')throw new Error('invalid_content_type');
  let size=0;const chunks=[];
  for await(const chunk of request){size+=chunk.length;if(size>maxBody)throw new Error('request_too_large');chunks.push(chunk);}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/** The browser presents a selection; the existing preset authority remains the only writer. */
export async function startCompanionOnboarding({runtime,scope,subjectId,openBrowser=()=>{},timeoutMs=30*60_000}){
  if(!scope||typeof scope!=='object')throw new Error('invalid_scope');
  const existing=runtime.companionPreset(scope);
  if(existing)return {url:null,result:Promise.resolve({status:'existing',scope,selection:{kind:'existing',presetId:existing.presetId,
    displayName:existing.preset.displayName,characterId:existing.characterId},import:{status:existing.status,duplicate:true}}),close:()=>{}};
  const choices=presets();
  const token=randomUUID();let origin,previewed=null,finished=false,timer;
  let settle;const result=new Promise(resolve=>{settle=resolve;});
  const server=http.createServer(async(request,res)=>{
    if(request.headers.host!==new URL(origin).host||!request.url?.startsWith(`/${token}/`)){
      response(res,404,{error:'not_found'});return;
    }
    if(request.method==='POST'&&request.headers.origin!==origin){response(res,403,{error:'forbidden_origin'});return;}
    const route=request.url.slice(token.length+2);
    if(request.method==='GET'&&route===''){
      res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer',
        'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'none'; frame-ancestors 'none'"});
      res.end(fs.readFileSync(uiFile));return;
    }
    if(request.method==='GET'&&route==='onboarding.js'){
      res.writeHead(200,{'Content-Type':'text/javascript; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
      res.end(fs.readFileSync(fileURLToPath(new URL('./onboarding.js',import.meta.url))));return;
    }
    if(request.method==='GET'&&route==='onboarding.css'){
      res.writeHead(200,{'Content-Type':'text/css; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
      res.end(fs.readFileSync(fileURLToPath(new URL('./onboarding.css',import.meta.url))));return;
    }
    const documents={guide:['docs/CHARACTER_CREATION_GUIDE.md','text/plain; charset=utf-8'],
      'markdown-template':['docs/CHARACTER_TEMPLATE.md','text/plain; charset=utf-8'],
      'json-template':['presets/custom-character.template.json','application/json; charset=utf-8']};
    if(request.method==='GET'&&route.startsWith('documents/')&&Object.hasOwn(documents,route.slice(10))){
      const [file,contentType]=documents[route.slice(10)];
      res.writeHead(200,{'Content-Type':contentType,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
      res.end(fs.readFileSync(path.join(root,file)));return;
    }
    if(request.method==='GET'&&route==='options'){
      response(res,200,{scope,choices:choices.map(({file,document})=>({file,presetId:document.presetId,displayName:document.displayName,
        name:document.identity?.name,personality:document.personality?.core})),guide:path.join(root,'docs/CHARACTER_CREATION_GUIDE.md'),
        markdownTemplate:path.join(root,'docs/CHARACTER_TEMPLATE.md'),jsonTemplate:path.join(root,'presets/custom-character.template.json')});return;
    }
    if(finished){response(res,410,{error:'onboarding_finished'});return;}
    try{
      if(request.method==='POST'&&route==='preview'){
        const selection=await bodyOf(request);
        if(finished)throw new Error('onboarding_finished');
        const source=selection?.kind==='builtin'?choices.find(item=>item.file===selection.file):null;
        const document=selection?.kind==='custom'?selection.document:source?.document;
        if(!document||!['builtin','custom'].includes(selection?.kind))throw new Error('invalid_selection');
        const preview=runtime.previewCompanionPreset(scope,document);
        previewed=preview.valid?{document,kind:selection.kind,file:source?.file??null,preview,token:randomUUID()}:null;
        response(res,200,{...preview,selectionToken:previewed?.token??null,review:reviewOf(document)});return;
      }
      if(request.method==='POST'&&route==='confirm'){
        const input=await bodyOf(request);
        if(finished)throw new Error('onboarding_finished');
        if(!previewed||input?.selectionToken!==previewed.token)throw new Error('selection_needs_preview');
        const selected=previewed;const location=locationOf(input.location);previewed=null;
        const imported=runtime.importCompanionPreset(scope,selected.document,{expectedVersion:selected.preview.expectedVersion,
          previewId:selected.preview.previewId,operationId:randomUUID()},location,subjectId);
        const output={status:'selected',scope,selection:{kind:selected.kind,presetId:imported.presetId,
          displayName:selected.preview.displayName,characterId:imported.characterId,...(selected.file?{file:selected.file}:{})},
          import:{status:imported.status,duplicate:imported.duplicate,requiresCompletion:selected.preview.requiresCompletion}};
        response(res,200,output);finish(output);return;
      }
      if(request.method==='POST'&&route==='cancel'){
        await bodyOf(request);
        if(finished)throw new Error('onboarding_finished');
        const output={status:'cancelled',scope,selection:null,import:null};response(res,200,output);finish(output);return;
      }
      response(res,404,{error:'not_found'});
    }catch(error){response(res,400,{error:errorText(error),message:userError(error)});}
  });
  function finish(output){if(finished)return;finished=true;clearTimeout(timer);settle(output);server.close();}
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  origin=`http://127.0.0.1:${server.address().port}`;
  const url=`${origin}/${token}/`;
  timer=setTimeout(()=>finish({status:'cancelled',scope,selection:null,import:null,reason:'timeout'}),timeoutMs);
  let browserOpenFailed=false;
  try{await openBrowser(url);}catch{browserOpenFailed=true;}
  return {url,result,browserOpenFailed,close:()=>finish({status:'cancelled',scope,selection:null,import:null,reason:'host_closed'})};
}
