const dialog=document.getElementById('dialog');
const cards=document.getElementById('cards');
const feedback=document.getElementById('feedback');
const fileInput=document.getElementById('customFile');
const confirmButton=document.getElementById('confirm');
const previewButton=document.getElementById('preview');
const cancelButton=document.getElementById('cancel');
const review=document.getElementById('review');
const allowLocationButton=document.getElementById('allowLocation');
const skipLocationButton=document.getElementById('skipLocation');
const locationStatus=document.getElementById('locationStatus');
let selectionToken=null;
let revision=0;
let location=null;
let locationPending=false;
let locationRequest=0;
let finished=false;

function message(text,kind=''){feedback.textContent=text;feedback.className=`feedback ${kind}`;}
function updateConfirm(){confirmButton.disabled=!selectionToken||!location||locationPending;}
function pending(value){previewButton.disabled=value;cancelButton.disabled=value;confirmButton.disabled=value||!selectionToken||!location||locationPending;
  allowLocationButton.disabled=value;skipLocationButton.disabled=value;
  for(const input of document.querySelectorAll('input[name="source"],input[type="file"]'))input.disabled=value;}
function setLocation(value,text,button){
  location=value;locationPending=false;locationStatus.textContent=text;
  allowLocationButton.classList.toggle('selected',button==='allow');
  skipLocationButton.classList.toggle('selected',button==='skip');
  updateConfirm();
}
function positionLocation(position){
  const {latitude,longitude,accuracy}=position.coords??{};
  const observedAtMs=position.timestamp;
  if(!Number.isFinite(latitude)||latitude < -90||latitude > 90||!Number.isFinite(longitude)||longitude < -180||longitude > 180||
    !Number.isFinite(accuracy)||accuracy < 0||accuracy > 100_000||!Number.isSafeInteger(observedAtMs)||
    observedAtMs < 0||observedAtMs > Date.now()+300_000)throw new Error('invalid_position');
  return {status:'granted',latitude,longitude,accuracyMeters:accuracy,observedAtMs};
}
function chosen(){return document.querySelector('input[name="source"]:checked');}
const labels={work:'工作',home:'生活',social:'交友',status:'相识状态',kinship:'亲属关系',romance:'恋爱关系',sharedHistory:'共同经历',commitments:'既有承诺',debts:'既有债务',
  voice:'说话方式',closenessPace:'关系推进',supportStyle:'陪伴方式',whenUserBusy:'你忙碌时',boundaries:'相处边界',openingExample:'开场示例'};
const values={adult_fictional_character:'成年虚构角色',user_authored_fictional_character:'用户创作的虚构角色',not_met:'尚未相遇',none:'无',not_established:'尚未建立',known_before_import:'导入前已经相识'};
function describe(value){
  if(value===null||value===undefined)return '未提供';
  if(typeof value==='object')return Array.isArray(value)?value.length?value.map(describe).join('；'):'无':
    Object.entries(value).map(([key,item])=>`${labels[key]??key}：${describe(item)}`).join('；');
  return values[value]??String(value);
}
function showReview(preview){
  const item=preview.review;
  const birthday=item.birthday?item.birthday.year?`${item.birthday.year}年${item.birthday.month}月${item.birthday.day}日`:
    `${item.birthday.month}月${item.birthday.day}日（出生年份未填写）`:'未提供';
  const lines=[`姓名：${describe(item.name)}`,`生日：${birthday}`,
    `初次相遇年龄：${describe(item.ageAtFirstMeeting)}`,`身份设定：${describe(item.nature)}`,`性格：${describe(item.personality)}`,
    `早年经历：${describe(item.firstLifeEvent)}`,`相遇前近况：${describe(item.lastLifeEvent)}`];
  if(item.currentLife)lines.push(`目前生活：${describe(item.currentLife)}`);
  if(item.relationship)lines.push(`预设关系：${describe(item.relationship)}`);
  if(item.interaction)lines.push(`相处方式：\n${describe(item.interaction)}`);
  if(item.aspirations.length)lines.push(`个人目标：${describe(item.aspirations)}`);
  const slots=Object.values(item.completionSlots);
  lines.push(slots.length?`确认后允许补全的内容：\n${slots.map((text,index)=>`${index+1}. ${text}`).join('\n')}`:'资料将原样保留，不自动补写。');
  review.textContent=`确认前请核对角色资料\n${lines.join('\n')}`;review.hidden=false;
  const details=document.createElement('details'),summary=document.createElement('summary'),full=document.createElement('pre');
  summary.textContent='查看完整导入资料';full.textContent=JSON.stringify(item.document,null,2);
  details.append(summary,full);review.append(details);
  review.scrollIntoView({behavior:'smooth',block:'start'});
}
async function api(route,body){
  const response=await fetch(route,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const result=await response.json();if(!response.ok)throw new Error(result.message||'角色选择服务暂不可用，请回到 Agent 重新打开。');return result;
}
function finish(text){finished=true;locationRequest++;location=null;document.getElementById('chooser').hidden=true;document.getElementById('done').style.display='block';document.getElementById('doneText').textContent=text;document.getElementById('actions').hidden=true;}
function changed(){revision++;selectionToken=null;updateConfirm();review.hidden=true;message('选择已改变，请重新预览。');}

dialog.addEventListener('cancel',event=>{event.preventDefault();cancelButton.click();});
allowLocationButton.addEventListener('click',()=>{
  const request=++locationRequest;
  location=null;locationPending=true;updateConfirm();
  allowLocationButton.classList.add('selected');skipLocationButton.classList.remove('selected');
  locationStatus.textContent='正在等待浏览器获取位置…';
  if(!navigator.geolocation?.getCurrentPosition){
    setLocation({status:'unavailable'},'当前浏览器不支持定位。角色仍可启用，伴侣地图将关闭。','allow');return;
  }
  try{navigator.geolocation.getCurrentPosition(position=>{
    if(finished||request!==locationRequest)return;
    try{setLocation(positionLocation(position),'已取得本次位置。确认启用角色后，伴侣地图才会使用它。','allow');}
    catch{setLocation({status:'unavailable'},'未能取得可用位置。角色仍可启用，伴侣地图将关闭。','allow');}
  },error=>{
    if(finished||request!==locationRequest)return;
    setLocation({status:error?.code===1?'denied':'unavailable'},
      error?.code===1?'你没有授予浏览器定位权限。角色仍可启用，伴侣地图将关闭。':'定位未完成。角色仍可启用，伴侣地图将关闭。','allow');
  },{enableHighAccuracy:false,maximumAge:0,timeout:10_000});}
  catch{if(!finished&&request===locationRequest)setLocation({status:'unavailable'},'浏览器无法启动定位。角色仍可启用，伴侣地图将关闭。','allow');}
});
skipLocationButton.addEventListener('click',()=>{
  locationRequest++;
  setLocation({status:'denied'},'已选择不用定位。角色仍可启用，伴侣地图将关闭。','skip');
});
fileInput.addEventListener('change',()=>{document.querySelector('input[value="custom"]').checked=true;changed();});
previewButton.addEventListener('click',async()=>{
  const choice=chosen();if(!choice){message('请先选择一个角色。','error');return;}
  const startedAtRevision=revision;pending(true);selectionToken=null;review.hidden=true;
  try{
    let selection={kind:'builtin',file:choice.value};
    if(choice.value==='custom'){
      const file=fileInput.files?.[0];if(!file)throw new Error('请先选择 JSON 文件。');
      if(file.size>512000)throw new Error('JSON 文件过大。');
      let document;try{document=JSON.parse(await file.text());}catch{throw new Error('文件不是有效的 JSON。');}
      selection={kind:'custom',document};
    }
    const result=await api('preview',selection);
    if(startedAtRevision!==revision)return;
    if(!result.valid){message('当前会话已有其他角色或经历，不能覆盖。请回到 Agent 创建新的伴侣会话。','error');return;}
    selectionToken=result.selectionToken;
    showReview(result);
    message(`${result.displayName}\n${result.requiresCompletion?'确认后将保存初始资料；Agent 随后会补全允许调整的细节。':'确认后将保存初始资料。'}${result.duplicate?' 已有相同预设，将沿用原状态。':''}`,'good');
  }catch(error){message(error.message||'预览失败。','error');}
  finally{pending(false);}
});
confirmButton.addEventListener('click',async()=>{
  if(!selectionToken||!location||locationPending)return;pending(true);
  try{
    const result=await api('confirm',{selectionToken,location});selectionToken=null;location=null;
    finish(`已选择 ${result.selection.displayName}。${result.import.status==='ready'?'角色已经可以继续使用。':
      result.import.requiresCompletion?'初始资料已导入；Agent 将完成已授权的细节补全后开始交流。':'初始资料已导入；Agent 将载入这份资料后开始交流。'}`);
  }catch(error){selectionToken=null;message(`未启用角色：${error.message||'导入失败'}。请重新预览。`,'error');pending(false);}
});
cancelButton.addEventListener('click',async()=>{
  pending(true);try{await api('cancel',{});finish('已取消，当前会话没有因本次选择而启用角色。');}
  catch(error){message(`取消失败：${error.message}`,'error');pending(false);}
});

try{
  const options=await api('options');
  for(const choice of options.choices){
    const label=document.createElement('label');label.className='card';
    const radio=document.createElement('input');radio.type='radio';radio.name='source';radio.value=choice.file;radio.addEventListener('change',changed);
    const title=document.createElement('strong');title.textContent=choice.displayName;
    const summary=document.createElement('span');summary.textContent=choice.personality||choice.name||'';
    label.append(radio,title,summary);cards.append(label);
  }
  document.querySelector('input[value="custom"]').addEventListener('change',changed);
  for(const id of ['guide','markdownTemplate','jsonTemplate'])document.getElementById(id).textContent=options[id];
  dialog.showModal();
}catch(error){dialog.showModal();message(`无法加载角色列表：${error.message}`,'error');previewButton.disabled=true;}
