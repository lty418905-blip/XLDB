/**
 * M3-5 opening frames: pure and synchronous. Which way she opens a proactive message follows her state (how far S1 is
 * above theta_x, an announced absence, weeks of silence) and what she really has to share; the draw is seeded by the
 * opportunity key (sha256(key:frame)), so a rebuild keeps the frame it drew. Frame texts only say what she feels and would
 * do; they carry no prohibitions (the shared prohibitions stay in the generation prompts until the M2 text check).
 */
import {createHash} from 'node:crypto';
import {silenceStage,type SeedKind} from './contact-pressure.ts';

const HOUR_MS=3_600_000;
const clamp01=(value:number)=>Math.min(1,Math.max(0,value));

export type FrameKind='longing'|'share'|'care'|'curious'|'light'|'topic'|'worry'|'lost'|'quiet'|'memory'|'outward';

/** A uniform in [0, 1) from sha256 of `seed`. */
export function frameUniform(seed:string):number {
  return Number.parseInt(createHash('sha256').update(seed).digest('hex').slice(0,13),16)/2**52;
}
/** One of `items` chosen by sha256(key:label); null when there are none. */
export function seededPick<T>(key:string,label:string,items:readonly T[]):T|null {
  if(!items.length)return null;
  return items[Math.min(items.length-1,Math.floor(frameUniform(`${key}:${label}`)*items.length))]!;
}

type Weights=Partial<Record<FrameKind,number>>;
/** Normalized weights, zero entries dropped, in a fixed order so a draw is reproducible. */
const FRAME_ORDER:readonly FrameKind[]=['longing','share','care','curious','light','topic','worry','lost','quiet','memory','outward'];
function normalize(weights:Weights):Weights {
  const total=FRAME_ORDER.reduce((sum,kind)=>sum+Math.max(0,weights[kind]??0),0);
  const result:Weights={};
  if(!(total>0))return result;
  for(const kind of FRAME_ORDER){const value=Math.max(0,weights[kind]??0);if(value>0)result[kind]=value/total;}
  return result;
}
/** Remove `kind` and give its weight to `to` in proportion to their own weights (evenly when they are all zero). */
function redistribute(weights:Weights,kind:FrameKind,to:readonly FrameKind[]):Weights {
  const share=weights[kind]??0,result={...weights};delete result[kind];
  if(!(share>0))return result;
  const targets=to.filter(item=>item!==kind),total=targets.reduce((sum,item)=>sum+(result[item]??0),0);
  for(const item of targets)result[item]=(result[item]??0)+(total>0?share*(result[item]??0)/total:share/targets.length);
  return result;
}
/** Draw from normalized weights with uniform u; null when every weight is zero. */
export function drawFrame(weights:Weights,uniform:number):FrameKind|null {
  const normalized=normalize(weights);
  let rest=uniform,last:FrameKind|null=null;
  for(const kind of FRAME_ORDER){
    const value=normalized[kind];if(!value)continue;
    last=kind;
    if(rest<value)return kind;
    rest-=value;
  }
  return last;
}

/** Longing seed x = clamp((s1 - theta_x)/1.5, 0, 1): how far she is above what she would say anything at. */
export function longingIntensity(s1:number,thetaX:number):number {return clamp01((s1-thetaX)/1.5);}

/**
 * The frame weights of an S1 (longing) seed: w_L = 0.10 + 0.35x, the rest share 0.30 : care 0.30 : curious 0.25. Without
 * material share is 0 and its part goes to care and curious. Inside an announced absence (r > 0) her frames are care 0.5,
 * share 0.3, light 0.2, and longing (as anticipation) (1 - r) 0.3 taken from care and light in proportion.
 */
export function longingFrameWeights(input:{x:number;hasShareMaterial:boolean;explainedR?:number}):Weights {
  const r=clamp01(input.explainedR??0);
  let weights:Weights;
  if(r>0){
    const longing=(1-r)*0.3;
    weights={care:0.5-longing*0.5/0.7,share:0.3,light:0.2-longing*0.2/0.7,longing};
    if(!input.hasShareMaterial)weights=redistribute(weights,'share',['care','light']);
  }else{
    const longing=0.10+0.35*clamp01(input.x),rest=1-longing;
    weights={longing,share:rest*0.30/0.85,care:rest*0.30/0.85,curious:rest*0.25/0.85};
    if(!input.hasShareMaterial)weights=redistribute(weights,'share',['care','curious']);
  }
  return normalize(weights);
}

/** The one-off invitation seed: with material curious 0.6, share 0.4; without, curious 0.8, care 0.2. */
export function inviteFrameWeights(hasShareMaterial:boolean):Weights {
  return hasShareMaterial?{curious:0.6,share:0.4}:{curious:0.8,care:0.2};
}

export interface SilenceFrameInput {
  U:number;gaps?:{g50:number;g90:number}|null;hasShareMaterial:boolean;hasMemory:boolean;
  /** The frame of the previous confirmed delivery in this episode (null if none). */
  prevFrame?:FrameKind|null;
}
/**
 * Weeks-of-silence weights (M3-5 item 6), from m on. worry stage: care (1 - y') : worry y'; second week: worry (1 - l) 0.8,
 * lost l 0.8, share/memory 0.2; 14-28 days: lost 0.4, quiet 0.3, share/memory 0.3; from 28 days: lost 0.25, quiet 0.3,
 * share/memory 0.45. share and memory split their part; a missing one leaves it to the other, both missing to the rest.
 * From 7 days the previous delivery's frame is left out, so two in a row always differ.
 */
export function silenceFrameWeights(input:SilenceFrameInput):Weights {
  const stage=silenceStage(input.U,input.gaps);
  let weights:Weights;
  if(stage.stage==='care')return {care:1};
  if(stage.stage==='worry')weights={care:1-stage.yPrime,worry:stage.yPrime};
  else if(stage.U<14*24*HOUR_MS)weights={worry:(1-stage.ell)*0.8,lost:stage.ell*0.8,share:0.1,memory:0.1};
  else if(stage.stage==='lost')weights={lost:0.4,quiet:0.3,share:0.15,memory:0.15};
  else weights={lost:0.25,quiet:0.3,share:0.225,memory:0.225};
  if(!input.hasShareMaterial)weights=redistribute(weights,'share',input.hasMemory&&(weights.memory??0)>0?['memory']:
    FRAME_ORDER.filter(kind=>kind!=='memory'&&(weights[kind]??0)>0));
  if(!input.hasMemory)weights=redistribute(weights,'memory',input.hasShareMaterial&&(weights.share??0)>0?['share']:
    FRAME_ORDER.filter(kind=>kind!=='share'&&(weights[kind]??0)>0));
  if(stage.U>=7*24*HOUR_MS&&input.prevFrame){
    const without={...weights};delete without[input.prevFrame];
    weights=Object.values(without).some(value=>(value??0)>0)?without:{quiet:1};
  }
  return normalize(weights);
}

/** check_in topic below g90 ("有一阵"); CHECK_IN_TOPIC (flow, "很久") from g90 on. */
export const CHECK_IN_EARLY_TOPIC='对方有一阵没有回复时的一次简短关心，不催促、不要求回复，也不假定原因。';
export function checkInTopicIsEarly(U:number,gaps?:{g90:number}|null):boolean {return U<(gaps?.g90??36*HOUR_MS);}

/** Share material slot labels (L1 before: the persona's own details); anything else is named as her own thing. */
const SHARE_SLOT_LABEL:Record<string,string>={dailyRitual:'她每天都有的那个小习惯',projectDetail:'她最近正在做的那件事'};
export function shareSlotLabel(slot:string):string {return SHARE_SLOT_LABEL[slot]??'她自己这阵子的一件事';}

/**
 * What each frame says: only her feeling now and what she would do. `careful` replaces care after an earlier long
 * disappearance; `busy` is care just past m ("在忙吗, 有点想你"); `anticipation` is longing inside an announced absence.
 */
export const FRAME_TEXT={
  longing:'有点想他，想让他知道自己在想他，一句就好。',
  anticipation:'心里有点盼着他回来，带着期待轻轻说一句，比如他快回来了吧。',
  share:'想和他说说{slot}，就说人设里本来就有的这件事，像平常分享那样。',
  shareSilence:'说一件她这阵子自己的事或时节，像平常分享那样，只说她自己这边的日子。',
  shareSilenceSlot:'说说{slot}，或者这阵子的时节，像平常分享那样，只说她自己这边的日子。',
  care:'有点挂心，想知道他好不好，一句就好。',
  careWithMaterial:'有点挂心，想知道他好不好；可以先说说{slot}。',
  careful:'有点小心翼翼，怕打扰到他，只轻轻问一句。',
  busy:'想问问他是不是在忙，有点想他，一句就好。',
  curious:'对他最近在做什么有点好奇，想轻轻问一句。',
  light:'想发一句轻松的话，语气轻快。',
  worry:'担心他，好一阵子没有他的消息，想确认他没事，一句就好。',
  lost:'有点失落，有点可怜兮兮的，像在原地等他；还是惦记着他，体谅他也许有自己的事，只想知道他好不好，说一句就好。',
  quiet:'只问一句他好不好，平平静静的，把自己的情绪放在一边。',
  memory:'想起他以前说过的那件事，轻轻提一句。',
  outward:'她一直有点想看他出去玩的样子：想看他在外面走走时拍的照片或小视频；或者想着哪天和他一起去一个她自己会想去的地方'+
    '（和人设一致，他提过的地方优先，只说一个）。这是她自己的向往，轻轻带一句就好。人设里她不能外出时，只说想看他的照片。',
  outwardFollowup:'接着上次说起的那个地方问一句，或者聊聊他出去玩的事。',
  topicWindowEnd:'接着他昨晚说的事问一句。',
} as const;

export interface OutwardOffer {
  nudgeKey:string;shape:'first'|'followup';
  /** outwardNudgeState says proactive_ready (from decidedAtMs + 7d and t_ready, not used, not void). */
  proactiveReady:boolean;
  /** Her local weekend or Friday after 17:00, or his outing topic within 72 hours (computed by the caller); null: none. */
  hook:string|null;
}

export interface FrameInput {
  /** The opportunity key: the draw is sha256(key:frame). */
  opportunityKey:string;
  seedKind:SeedKind;
  /** The dominant contribution's relabel or origin (contact-pressure). */
  relabeledFrom?:'longing'|'share'|null;
  origin?:'invite'|null;
  s1:number;thetaX:number;
  /** r of an announced absence at the occurrence (explainedState). */
  explainedR?:number;
  /** Share material: L1 share seed keys, or (before L1) the persona detail slots that exist (dailyRitual, projectDetail). */
  shareMaterial?:readonly string[];
  hasMemory?:boolean;
  /** Inside an unanswered episode: its unexplained wait, the user's gaps, the previous delivery's frame, a repeat. */
  silence?:{U:number;gaps?:{g50:number;g90:number}|null;prevFrame?:FrameKind|null;repeat?:boolean}|null;
  outward?:OutwardOffer|null;
}

export interface ContactFrame {
  kind:FrameKind;
  /** The text appended to the topic; null keeps the seed's own topic (followup and recall). */
  text:string|null;
  weights:Weights;
  x?:number;stage?:string;y?:number;ell?:number;prevFrame?:FrameKind|null;repeat?:boolean;
  slot?:string;nudgeKey?:string;hook?:string;shape?:'first'|'followup';
  /** The frame drawn before an outward replaced it. */
  replaced?:FrameKind;
}

const OUTWARD_ELIGIBLE:ReadonlySet<FrameKind>=new Set(['longing','share','care','curious']);

/**
 * The opening frame of one pressure occurrence. followup and recall are always `topic`. An S1 or invitation seed draws
 * from its state-driven weights; inside weeks of silence (a check-in, native or relabelled, from m on) the silence mixture
 * applies. A proactive outward, when ready and hooked, replaces an eligible longing/share/care/curious frame of an S1 or
 * invitation seed outside the silence from m on; never a check-in, silence, topic or window-end frame.
 */
export function contactFrame(input:FrameInput):ContactFrame {
  if(input.seedKind==='followup'||input.seedKind==='recall')return {kind:'topic',text:null,weights:{topic:1}};
  const uniform=frameUniform(`${input.opportunityKey}:frame`),material=input.shareMaterial??[];
  const hasShareMaterial=material.length>0,silence=input.silence??null;
  const stage=silence?silenceStage(silence.U,silence.gaps):null;
  const repeat=silence?.repeat===true;
  const x=longingIntensity(input.s1,input.thetaX);
  let weights:Weights,context:Partial<ContactFrame>={};
  if(input.seedKind==='check_in'||input.relabeledFrom){
    weights=silence?silenceFrameWeights({U:silence.U,gaps:silence.gaps,hasShareMaterial,hasMemory:input.hasMemory===true,
      prevFrame:silence.prevFrame??null}):{care:1};
    if(stage)context={stage:stage.stage,y:stage.y,ell:stage.ell,prevFrame:silence!.prevFrame??null,repeat};
  }else if(input.origin==='invite')weights=inviteFrameWeights(hasShareMaterial);
  else if(input.seedKind==='longing'||input.seedKind==='share'){
    // A share seed (her expression drive) opens with share when she has something real to share.
    weights=input.seedKind==='share'&&hasShareMaterial&&!(input.explainedR??0)?{share:1}:
      longingFrameWeights({x,hasShareMaterial,explainedR:input.explainedR??0});
    context={x,...(stage?{stage:stage.stage,repeat}:{})};
  }else weights={care:1};
  let kind=drawFrame(weights,uniform)??'care';
  const inSilence=stage!==null&&stage.stage!=='care';
  const frame:ContactFrame={kind,text:null,weights:normalize(weights),...context};
  const outward=input.outward;
  if(outward&&outward.proactiveReady&&outward.hook&&!inSilence&&input.seedKind!=='check_in'&&!input.relabeledFrom&&
    (input.origin==='invite'||input.seedKind==='longing'||input.seedKind==='share')&&OUTWARD_ELIGIBLE.has(kind)){
    frame.replaced=kind;kind='outward';
    Object.assign(frame,{kind,nudgeKey:outward.nudgeKey,hook:outward.hook,shape:outward.shape});
  }
  const busy=stage?.stage==='worry'&&stage.yPrime===0;
  // Care inside the silence may open with her own material, but only a slot she already has (never a new event).
  if(kind==='share'||kind==='care'&&inSilence&&hasShareMaterial&&!repeat&&!busy){
    const slot=seededPick(input.opportunityKey,'share',material);
    if(slot)frame.slot=slot;
  }
  frame.text=frameText(frame,{hasShareMaterial,anticipation:(input.explainedR??0)>0,busy,careful:repeat,inSilence});
  return frame;
}

function frameText(frame:ContactFrame,flags:{hasShareMaterial:boolean;anticipation:boolean;busy:boolean;careful:boolean;
  inSilence:boolean}):string|null {
  switch(frame.kind){
    case 'topic':return null;
    case 'longing':return flags.anticipation?FRAME_TEXT.anticipation:FRAME_TEXT.longing;
    case 'share':return !frame.slot?FRAME_TEXT.shareSilence:
      (flags.inSilence?FRAME_TEXT.shareSilenceSlot:FRAME_TEXT.share).replace('{slot}',shareSlotLabel(frame.slot));
    case 'care':return flags.careful?FRAME_TEXT.careful:flags.busy?FRAME_TEXT.busy:
      frame.slot?FRAME_TEXT.careWithMaterial.replace('{slot}',shareSlotLabel(frame.slot)):FRAME_TEXT.care;
    case 'outward':return frame.shape==='followup'?FRAME_TEXT.outwardFollowup:FRAME_TEXT.outward;
    default:return FRAME_TEXT[frame.kind];
  }
}

export type WindowEndFrameTone='longing'|'care'|'light'|'share'|'topic';
/**
 * Window-end tone weights (M3-5 item 10, read by slice 5f): y = clamp(S1 - theta_x + 1, 0, 1) (S1 alone), w_L = 0.10 +
 * 0.25y times (1 - r) inside an announced absence; the rest care 4 : light 3 : share 2 after 6 hours of quiet or more,
 * light 4 : care 3 : share 2 after less; without material share goes to care and light; with a topic open, topic 0.45 and
 * the rest times 0.55.
 */
export function windowEndFrameWeights(input:{s1:number;thetaX:number;quietMs:number;hasShareMaterial:boolean;hasTopic:boolean;
  explainedR?:number}):{weights:Weights;y:number} {
  const y=clamp01(input.s1-input.thetaX+1),longing=(0.10+0.25*y)*(1-clamp01(input.explainedR??0)),rest=1-longing;
  const parts:Record<'care'|'light'|'share',number>=input.quietMs>=6*HOUR_MS?{care:4,light:3,share:2}:{care:3,light:4,share:2};
  let weights:Weights={longing,care:rest*parts.care/9,light:rest*parts.light/9,share:rest*parts.share/9};
  if(!input.hasShareMaterial)weights=redistribute(weights,'share',['care','light']);
  if(input.hasTopic){
    const scaled:Weights={topic:0.45};
    for(const kind of FRAME_ORDER)if(kind!=='topic'&&(weights[kind]??0)>0)scaled[kind]=weights[kind]!*0.55;
    weights=scaled;
  }
  return {weights:normalize(weights),y};
}
/** The window-end tone drawn with the roll's own uniform (5f passes it). */
export function windowEndFrame(input:Parameters<typeof windowEndFrameWeights>[0]&{uniform:number}):
  {tone:WindowEndFrameTone;weights:Weights;y:number} {
  const {weights,y}=windowEndFrameWeights(input);
  return {tone:(drawFrame(weights,input.uniform)??'care') as WindowEndFrameTone,weights,y};
}
