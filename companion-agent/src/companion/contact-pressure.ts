/**
 * M3 contact pressure: pure, synchronous and model-free. Every input, including the current time, is passed in; nothing
 * here reads a clock, a store, a model or a host. Timing comes only from her state (OpenHer drives with the release of
 * her own sends, recalled memories, the user's unexplained absence, a user follow-up) integrated as a hazard over a
 * UTC-aligned 5-minute grid with one seeded uniform per epoch, so a trigger time depends on state and seed, never on how
 * often anyone polls. The only time-of-day dependence here is multiplicative: the user's own rhythm (floor 0.5) and her own
 * life (S7); boundaries enter as blocked intervals decided by the caller. (E0's initiative and warmth are inputs; OpenHer
 * derives them with its own time-of-day context, which is her state and is kept.)
 */
import {createHash} from 'node:crypto';
import {emotionSettingsOf,projectFrustration,type DriveValues} from '../../../shared/src/emotion/openher.ts';
import {expressionRelief,type ExpressionReliefKind,type ExpressionReliefSend} from '../../../shared/src/emotion/contact-affect.ts';
import {receptivityAt,type UserActivityGaps,type UserActivitySummary} from '../user-model/activity.ts';

export type SeedKind='longing'|'share'|'recall'|'check_in'|'followup'|'reminder'|'window_end';
// SeedKind and the release table's kinds are one union; this fails to type-check if they drift apart.
type Same<A,B>=[A] extends [B]?[B] extends [A]?true:false:false;
const SEED_KINDS_MATCH_RELIEF:Same<SeedKind,ExpressionReliefKind>=true;void SEED_KINDS_MATCH_RELIEF;

const HOUR_MS=3_600_000;
const DAY_MS=24*HOUR_MS;
/** OpenHer's MIN_METABOLISM_HOURS: a shorter projection leaves F0 unchanged (projectFrustration). */
const MIN_METABOLISM_HOURS=0.001;
const FALLBACK_G50=12*HOUR_MS,FALLBACK_G90=36*HOUR_MS;
const clamp01=(value:number)=>Math.min(1,Math.max(0,value));
/** A uniform in [0, 1) from sha256 of `seed`. */
function seededUnit(seed:string):number {
  return Number.parseInt(createHash('sha256').update(seed).digest('hex').slice(0,13),16)/2**52;
}

/**
 * The seed a stored contact expresses: its recorded seed kind, or for a row written before M3 the seed its kind and basis
 * express (a drive row on a waiting episode is a check-in). The one mapping the pressure model and the scene's read-time
 * release both use; null for a legacy row that expresses none.
 */
export function opportunitySeedKind(item:{kind:string;purpose:string;basis?:readonly {kind:string;id:string}[];seedKind?:SeedKind|null}):SeedKind|null {
  if(item.seedKind)return item.seedKind;
  if(item.kind==='drive')return (item.basis??[]).some(basis=>basis.kind==='drive'&&basis.id.startsWith('waiting:'))?'check_in':'longing';
  if(item.kind==='window_end')return 'window_end';
  if(item.kind==='schedule')return 'reminder';
  if(item.kind==='recall')return 'recall';
  return item.kind==='experience'&&item.purpose==='followup'?'followup':null;
}

export interface TendencyBound {value:number;min:number;max:number}
export interface ContactTendency {
  /** m_theta: theta_eff = clamp(3.0 * m_theta, 1.5, 4.5). */
  thetaScale:number;
  /** sigma */
  hazardScale:number;
  /** A_f */
  followupAmplitude:number;
  /** w_recall */
  recallWeight:number;
  /** w_checkIn */
  checkInWeight:number;
  /** mu: hazard factor inside any soft window binding. */
  softWindowFactor:number;
  /** o: the user's own contact ceiling; at most 1, so it can only narrow. */
  openness:number;
  revision:number;
}
export type TendencyKey=Exclude<keyof ContactTendency,'revision'>;

function deepFreeze<T>(value:T):T {
  if(value&&typeof value==='object'){for(const item of Object.values(value))deepFreeze(item);Object.freeze(value);}
  return value;
}

/** Frozen defaults. Only `tendency` entries may be overridden (within their bounds); M3-4 calibrates the numbers. */
export const PRESSURE_DEFAULTS=deepFreeze({
  /** theta_on, as in M1. */
  thetaOn:3.0,
  /** theta_eff clamp: the upper bound below the frustration cap 5 keeps a tendency from learning permanent silence. */
  thetaMin:1.5,
  thetaMax:4.5,
  /** theta_off = theta_eff - 1. */
  thetaOffGap:1.0,
  lambdaMaxPerHour:1.0,
  kappa:0.75,
  delta:0.5,
  gridMs:5*60_000,
  /** The first 10 minutes of an epoch (= DEFAULT_CONVERSATION_WINDOW_MS). */
  refractoryMs:10*60_000,
  drive:{connection:1,expression:0.5,novelty:0.3,initiativeBase:0.8,initiativeGain:0.2},
  recall:{clear:1.2,gist:0.8,halfLifeHours:6,cap:2.0,horizonHours:48},
  checkIn:{amplitude:2.0,explainedWeight:-0.5,waitThresholdMs:12*HOUR_MS},
  followup:{peakHours:3,horizonHours:24},
  share:{halfLifeHours:6},
  life:{off:0,busy:0.2,glance:0.6,free:1},
  tendency:{
    thetaScale:{value:1,min:0.5,max:1.5},
    hazardScale:{value:1,min:0.5,max:2},
    followupAmplitude:{value:2.0,min:0,max:3},
    recallWeight:{value:1,min:0,max:2},
    checkInWeight:{value:1,min:0,max:2},
    softWindowFactor:{value:0.25,min:0.1,max:0.5},
    openness:{value:1,min:0.25,max:1},
  } satisfies Record<TendencyKey,TendencyBound>,
  /** Tie order for the dominant seed. */
  seedOrder:['followup','recall','check_in','longing','share'] as readonly SeedKind[],
  /**
   * M3-5 item 3: the user's own announced absence. r = clamp((end - t)/24h, 0, 1) inside it; the hunger multiplier takes
   * the factor 1 - 0.5r and theta_x the addend +0.5r. An announcement without an end lasts clamp(g90, 24h, 72h).
   */
  explained:{damping:0.5,thetaAddend:0.5,rampMs:24*HOUR_MS,unknownMinMs:24*HOUR_MS,unknownMaxMs:72*HOUR_MS},
  /**
   * M3-5 item 4: c_fb = min(cap, C_inv + min(positiveCap, C_pos) + min(scoreCap, C_score)), C_k = sum w * 2^(-(t - t_i)/h);
   * only events after the latest negative, boundary, score_drop or outward_rejected count, and none within 7 days of it.
   * A userDependency score_rise above dependenceSaturationLevel earns nothing (PLAN 12.1 point 6; slice 5b emits none).
   */
  feedback:{cap:0.6,positiveCap:0.3,scoreCap:0.3,negativeHoldMs:7*24*HOUR_MS,dependenceSaturationLevel:3,
    invitation:{weight:0.30,halfLifeMs:5*24*HOUR_MS},positive:{weight:0.20,halfLifeMs:7*24*HOUR_MS},
    score_rise:{weight:0.15,halfLifeMs:14*24*HOUR_MS}},
  /** theta_x never falls more than this below theta_eff (G4). */
  thetaXFloorGap:0.6,
  /** A one-off invitation seed: peak * (d/20h) * e^(1 - d/20h), zero after 5 days. */
  invite:{peak:0.8,peakHours:20,horizonMs:5*24*HOUR_MS},
  /** The hunger multiplier omega on S1's connection and novelty hunger. */
  omega:{min:0.05,max:3},
  /** A fired marker also clears at epochGridStart(send) + clamp(g50, 3h, 12h); a skipped seed re-arms at epochGridStart(skip) + 24h. */
  rearm:{minMs:3*HOUR_MS,maxMs:12*HOUR_MS,fallbackMs:12*HOUR_MS,skipMs:24*HOUR_MS},
  /** After a soft window or her off/busy/glance ends, mu and alpha return to 1 over R = 15 + 15u minutes (grid lookback 6). */
  ramp:{baseMs:15*60_000,spreadMs:15*60_000,lookbackPoints:6},
  /**
   * M3-5 item 6: weeks of silence. omega_sil = 1 + (w(U) (theta_x0/theta_ref) psi v f_b - 1) clamp((U - m)/12h, 0, 1); a
   * week bucket at its cap holds lambda at 0 and omega_sil at capOmega. Tunable only inside the ranges PLAN-M3-5 item 6 names.
   */
  silence:{
    thetaRef:3.0,
    /** w(U) nodes (U in ms, weight), linear between them and flat outside. */
    weights:[[2*24*HOUR_MS,1.5],[6*24*HOUR_MS,1.05],[8*24*HOUR_MS,0.72],[12*24*HOUR_MS,0.72],[14*24*HOUR_MS,0.21]] as readonly (readonly [number,number])[],
    rampMs:12*HOUR_MS,
    beta:0.5,psiMin:0.95,psiMax:1.1,repeatFactor:0.8,
    /** v = 2^(s (2u - 1)): s before and from moodSwitchMs of unexplained wait. */
    moodSpread:[0.3,0.8] as readonly number[],moodSwitchMs:14*24*HOUR_MS,
    bucketMs:7*24*HOUR_MS,
    /** (L_b, H_b) per week bucket; the last entry holds for every later week. */
    bounds:[[8,12],[4,6],[1,2]] as readonly (readonly [number,number])[],
    floorWindowMs:60*HOUR_MS,floorFactor:4,capOmega:0.05,
    worryRampMs:48*HOUR_MS,worryMin:0.3,
    lostMs:7*24*HOUR_MS,lostLateMs:14*24*HOUR_MS,settledMs:28*24*HOUR_MS,
  },
});

/** A complete tendency; an unknown key, a non-finite or an out-of-bounds value is rejected, never clamped. */
export function resolveTendency(overrides?:Partial<ContactTendency>|null):ContactTendency {
  const input=overrides??{};
  const bounds=PRESSURE_DEFAULTS.tendency as Record<TendencyKey,TendencyBound>;
  for(const key of Object.keys(input))if(key!=='revision'&&!(key in bounds))throw new RangeError('invalid_contact_tendency');
  const result={} as ContactTendency;
  for(const key of Object.keys(bounds) as TendencyKey[]){
    const value=input[key]??bounds[key].value;
    if(typeof value!=='number'||!Number.isFinite(value)||value<bounds[key].min||value>bounds[key].max)
      throw new RangeError('invalid_contact_tendency');
    result[key]=value;
  }
  const revision=input.revision??0;
  if(!Number.isSafeInteger(revision)||revision<0)throw new RangeError('invalid_contact_tendency');
  result.revision=revision;
  return result;
}

export function thetaEffective(tendency:ContactTendency):number {
  return Math.min(PRESSURE_DEFAULTS.thetaMax,Math.max(PRESSURE_DEFAULTS.thetaMin,PRESSURE_DEFAULTS.thetaOn*tendency.thetaScale));
}

export interface PressureInterval {startMs:number;endMs:number}
/** Reply-origin reactivations of memories still in the current snapshot (the reader already dropped the rest). */
export interface RecallEvent {memoryId:string;revision:number;atMs:number;access:'clear'|'gist'}
/** The current unanswered episode and the user's own explanations (effectiveUntilMs ?? validUntilMs as untilMs). */
export interface AbsenceInput {
  episodeId:string;
  sentAtMs:number;
  explanations:readonly {fromMs:number;untilMs:number|null;certainty:'bounded'|'uncertain'}[];
  /** This episode has already led to one delivery (marker.episode): it contributes nothing more. */
  spent?:boolean;
}
/** An announce interval of absenceExplanationTimeline: validFromMs and effectiveUntilMs ?? validUntilMs (null: no end). */
export interface ExplainedInterval {fromMs:number;untilMs:number|null}
/**
 * One contact feedback event (contactFeedbackEvents, M3-5 item 4), mapped by the caller. Silence never produces one; an
 * event whose source was revised or deleted is simply not passed. `seedKey` names an invitation's one-off seed.
 */
export type PressureFeedbackKind='positive'|'negative'|'invitation'|'boundary'|'score_rise'|'score_drop'|'outward_rejected'|
  'dependence_audit';
export interface PressureFeedbackEvent {
  id:string;kind:PressureFeedbackKind;atMs:number;metric?:string|null;seedKey?:string|null;
  /** A score event's confirmed level (for the dependence saturation). */
  level?:number|null;
}
/**
 * The current unanswered episode seen as weeks of silence (M3-5 item 6; the episode itself is `absence`). `deliveredAtMs`
 * are her confirmed deliveries after the episode's opening send (which is counted from absence.sentAtMs); `repeat` is set
 * when an earlier episode that reached 7 days of unexplained wait ended within 30 days before this one began.
 */
export interface SilenceInput {deliveredAtMs:readonly number[];repeat?:boolean}
/**
 * A skip's P_dec and time: the seed is eligible again once P > P_dec + delta, or from epochGridStart(atMs) + 24 hours. Pass
 * the raw skip time (as for the epoch): the library aligns it, so a 1-minute and a 5-minute tick that judge inside the same
 * grid cell re-arm at the same grid point.
 */
export interface SpentSeed {pDec:number;atMs:number|null}
export type SpentValue=number|SpentSeed;
/** The latest direct user source with a plan; its key stays `source:id:rev`. */
export interface FollowupInput {key:string;atMs:number}
export type LifeAvailabilityKind='off'|'busy'|'glance'|'free';
export interface LifeAvailability {availability:LifeAvailabilityKind;ledgerRef:string}
export interface LifeShareSeed {key:string;atMs:number;weight:number}
/** S7, her own life (L1). Synchronous and pure; M3 ships only the null stub below. */
export interface LifeAvailabilityProvider {
  availabilityAt(atMs:number):LifeAvailability|null;
  shareSeeds(fromMs:number,toMs:number):readonly LifeShareSeed[];
}
export const NO_LIFE:LifeAvailabilityProvider=Object.freeze({availabilityAt:()=>null,shareSeeds:()=>[]});

export interface PressureEmotion {
  /** E0: the latest persisted OpenHer state (scene emotionBase), not a read-time projection. */
  atMs:number;
  frustration:DriveValues;
  /** Behavioral signals of E0, fixed for the epoch. */
  initiative:number;
  warmth:number;
  /** The character's OpenHer settings (decay and hunger rates). */
  settings?:unknown;
}

export interface PressureInputs {
  subjectId:string;
  targetId:string;
  nowMs:number;
  emotion:PressureEmotion;
  /** Her host-confirmed sends with the seed they expressed (scene expressionReliefSends). */
  sends?:readonly ExpressionReliefSend[];
  recall?:readonly RecallEvent[];
  absence?:AbsenceInput|null;
  gaps?:Pick<UserActivityGaps,'g50'|'g90'>|null;
  followup?:FollowupInput|null;
  activity?:UserActivitySummary|null;
  /** The user's switch for S5; off means rho = 1. */
  receptivityEnabled?:boolean;
  life?:LifeAvailabilityProvider;
  tendency?:Partial<ContactTendency>|null;
  /** T0 = max of these; with none, E0's time. */
  epoch:{lastUserActivityMs?:number|null;lastConfirmedSendMs?:number|null;lastSkipMs?:number|null;lastControlChangeMs?:number|null};
  /** lambda = 0 inside: hard windows, pause, busy-until. [startMs, endMs). */
  blocked?:readonly PressureInterval[];
  /** mu applies inside any soft window binding (hers, a good-night state). [startMs, endMs). */
  soft?:readonly PressureInterval[];
  /**
   * The drive hysteresis marker as it stood at T0. It is set only by a confirmed pressure send, which also starts the
   * epoch, so it is fixed for the whole epoch: keep passing the value the epoch started with, not a later clear. It
   * clears at the first grid point where S1 (after the release) is below theta_off.
   */
  hysteresisFired?:boolean;
  /**
   * A clear already recorded for this epoch (an earlier evaluation's hysteresisClearedAtMs). Grid points before it keep
   * the marker held even when hysteresisFired is no longer passed, so a recomputation never moves a trigger before the
   * clear. A value before T0 belongs to an older epoch and is ignored.
   */
  hysteresisClearedAtMs?:number|null;
  /**
   * The seed the send that fired the marker expressed (DriveMarker.seedKind / seedKey). The marker reads that seed's own
   * contribution after its release: S1 for longing, share and window_end (and for a marker written before M3, as the M1
   * marker read connection alone), the seed itself otherwise (a sent follow-up, recall or check-in contributes nothing
   * more, so its marker clears at the first grid point).
   */
  hysteresisSeed?:{seedKind:SeedKind;key:string|null;relabeledFrom?:'longing'|'share'|null}|null;
  /**
   * M3-5 item 5: the marker also clears at the first grid point at or after this time (hysteresisRearmAt of the send that
   * fired it), so a marker can never hold for days.
   */
  hysteresisRearmAtMs?:number|null;
  /** A pressure occurrence for this target is still open: lambda = 0. */
  openOccurrence?:boolean;
  /**
   * Seed key -> the skip decision: P_dec alone (never re-armed by time; Infinity marks a finished seed) or {pDec, atMs},
   * which is also eligible again from epochGridStart(atMs) + 24 hours (atMs the raw skip time).
   */
  spent?:Readonly<Record<string,SpentValue>>;
  keys?:{drive?:string;checkIn?:string};
  /** Test seam (flow.hazardUniform); otherwise sha256(subject:target:hazard:T0). */
  uniform?:number;
  /** M3-5 item 3: the user's own announced absences, whether or not an episode is waiting. */
  explained?:readonly ExplainedInterval[];
  /** M3-5 item 4: contact feedback events (credit c_fb and the one-off invitation seed). */
  feedback?:readonly PressureFeedbackEvent[];
  /** M3-5 item 6: the unanswered episode (`absence`) read as weeks of silence; needs `absence`. */
  silence?:SilenceInput|null;
  /** Test seams: the ramp length uniform (otherwise sha256(subject:target:ramp:e)) and the silence mood uniform. */
  rampUniform?:number;
  moodUniform?:number;
}

export interface PressureContribution {
  seedKind:SeedKind;key:string;value:number;
  /** S1 read as a check-in inside weeks of silence (U >= m): its value is S1, its key the episode's check-in key. */
  relabeledFrom?:'longing'|'share';
  /** A one-off invitation seed (expressed as longing). */
  origin?:'invite';
}
export interface DriveSample {value:number;seedKind:'longing'|'share';connection:number;expression:number;novelty:number;iota:number}

/**
 * S1: projected E0 minus the release of her own sends; s1 = iota * (F_c + 0.5 F_e + 0.3 F_n). With `hungerHours` (the
 * integral of the hunger multiplier omega from E0 to `atMs`, M3-5 items 3 and 6) the connection and novelty hunger
 * accumulate over it instead of the elapsed hours: F = F0 e^(-kh) + eta * W, clamped to [0, 5] as OpenHer does.
 */
export function driveSource(emotion:PressureEmotion,sends:readonly ExpressionReliefSend[],atMs:number,hungerHours?:number):DriveSample {
  const settings=emotionSettingsOf(emotion.settings);
  const hours=(atMs-emotion.atMs)/HOUR_MS;
  const projected=projectFrustration(emotion.frustration,hours,settings);
  if(hungerHours!==undefined&&hours>=MIN_METABOLISM_HOURS){
    const decay=Math.exp(-settings.frustrationDecayPerHour*hours),clamp5=(value:number)=>Math.min(5,Math.max(0,value));
    projected.connection=clamp5(emotion.frustration.connection*decay+settings.connectionHungerPerHour*hungerHours);
    projected.novelty=clamp5(emotion.frustration.novelty*decay+settings.noveltyHungerPerHour*hungerHours);
  }
  const relief=expressionRelief(sends,atMs,settings);
  const weights=PRESSURE_DEFAULTS.drive;
  const connection=Math.max(0,projected.connection-relief.connection),expression=Math.max(0,projected.expression-relief.expression);
  const novelty=projected.novelty;
  const iota=weights.initiativeBase+weights.initiativeGain*(emotion.initiative+emotion.warmth);
  const other=weights.expression*expression+weights.novelty*novelty;
  return {value:iota*(weights.connection*connection+other),seedKind:weights.connection*connection>=other?'longing':'share',
    connection,expression,novelty,iota};
}

/** S2: w * min(2, sum a_i * 2^(-(t - t_i)/6h)), a = 1.2 clear / 0.8 gist; events older than 48h or after t ignored. */
export function recallSource(events:readonly RecallEvent[],atMs:number,weight=1):{value:number;top:PressureContribution&{memoryId:string;revision:number}|null} {
  const defaults=PRESSURE_DEFAULTS.recall;
  let sum=0,top:{memoryId:string;revision:number;value:number}|null=null;
  const byMemory=new Map<string,{memoryId:string;revision:number;value:number}>();
  for(const event of events){
    const age=atMs-event.atMs;
    if(age<0||age>defaults.horizonHours*HOUR_MS)continue;
    const value=(event.access==='clear'?defaults.clear:defaults.gist)*2**(-age/(defaults.halfLifeHours*HOUR_MS));
    sum+=value;
    const key=`${event.memoryId}\u0000${event.revision}`,current=byMemory.get(key);
    if(current)current.value+=value;else byMemory.set(key,{memoryId:event.memoryId,revision:event.revision,value});
  }
  for(const item of byMemory.values())if(!top||item.value>top.value||item.value===top.value&&item.memoryId<top.memoryId)top=item;
  const value=weight*Math.min(defaults.cap,sum);
  return {value,top:top&&value>0?{seedKind:'recall',key:`memory:${top.memoryId}:${top.revision}`,value,memoryId:top.memoryId,revision:top.revision}:null};
}

export interface AbsenceSample {absence:'explained'|'uncertain'|'unexplained'|null;elapsedMs:number;unexplainedMs:number}

/** The wait at `atMs`, by the same rules as projectContactAffect for one fixed episode. */
export function absenceAt(input:AbsenceInput|null|undefined,atMs:number):AbsenceSample {
  const none={absence:null,elapsedMs:0,unexplainedMs:0};
  if(!input||atMs<=input.sentAtMs)return none;
  const elapsed=atMs-input.sentAtMs;
  if(elapsed<=PRESSURE_DEFAULTS.checkIn.waitThresholdMs)return {...none,elapsedMs:elapsed};
  const intervals=input.explanations.map(item=>({certainty:item.certainty,start:Math.max(input.sentAtMs,item.fromMs),
    end:Math.min(atMs,item.untilMs??atMs)})).filter(item=>item.end>item.start).sort((a,b)=>a.start-b.start||a.end-b.end);
  let covered=0,lastEnd=-Infinity;
  for(const item of intervals){
    if(item.end<=lastEnd)continue;
    covered+=item.end-Math.max(lastEnd,item.start);lastEnd=item.end;
  }
  const unexplainedMs=Math.max(0,elapsed-covered);
  const uncertain=intervals.some(item=>item.certainty==='uncertain'&&item.end===atMs);
  return {absence:uncertain?'uncertain':unexplainedMs>PRESSURE_DEFAULTS.checkIn.waitThresholdMs?'unexplained':'explained',
    elapsedMs:elapsed,unexplainedMs};
}

/**
 * S4: unexplained, w * 2.0 * clamp((U - g50)/(g90 - g50), 0, 1); explained, -0.5 * explained fraction; uncertain, 0;
 * an episode that already led to a delivery, 0. Without gaps the 12h/36h fallback applies.
 */
export function absenceSource(input:AbsenceInput|null|undefined,gaps:Pick<UserActivityGaps,'g50'|'g90'>|null|undefined,
  atMs:number,weight=1):{value:number;sample:AbsenceSample} {
  const sample=absenceAt(input,atMs);
  if(!input||input.spent||sample.absence===null||sample.absence==='uncertain')return {value:0,sample};
  if(sample.absence==='explained')
    return {value:PRESSURE_DEFAULTS.checkIn.explainedWeight*(1-sample.unexplainedMs/sample.elapsedMs),sample};
  const g50=gaps?.g50??12*HOUR_MS,g90=gaps?.g90??36*HOUR_MS;
  const scaled=g90>g50?(sample.unexplainedMs-g50)/(g90-g50):sample.unexplainedMs>=g90?1:0;
  return {value:weight*PRESSURE_DEFAULTS.checkIn.amplitude*Math.min(1,Math.max(0,scaled)),sample};
}

interface Span {start:number;end:number}
/** Sorted, merged spans; `end` may be Infinity. */
function mergeSpans(spans:Span[]):Span[] {
  const sorted=spans.filter(item=>item.end>item.start).sort((a,b)=>a.start-b.start||a.end-b.end),merged:Span[]=[];
  for(const item of sorted){
    const last=merged.at(-1);
    if(last&&item.start<=last.end)last.end=Math.max(last.end,item.end);else merged.push({...item});
  }
  return merged;
}

/** The announced absences as merged spans; one without an end lasts clamp(g90, 24h, 72h) from its start. */
export function explainedSpans(intervals:readonly ExplainedInterval[]|null|undefined,
  gaps:Pick<UserActivityGaps,'g50'|'g90'>|null|undefined):{startMs:number;endMs:number}[] {
  const defaults=PRESSURE_DEFAULTS.explained;
  const unknown=Math.min(defaults.unknownMaxMs,Math.max(defaults.unknownMinMs,gaps?.g90??FALLBACK_G90));
  return mergeSpans((intervals??[]).filter(item=>Number.isFinite(item.fromMs)&&(item.untilMs===null||Number.isFinite(item.untilMs)))
    .map(item=>({start:item.fromMs,end:item.untilMs??item.fromMs+unknown}))).map(item=>({startMs:item.start,endMs:item.end}));
}

export interface ExplainedState {r:number;endMs:number|null}
/**
 * M3-5 item 3: inside an announced absence r = clamp((end - t)/24h, 0, 1) (overlapping announcements merge into one
 * absence); outside, r = 0. `left` reads the limit just before `atMs` (an absence does not hold at its own start).
 */
export function explainedState(spans:readonly {startMs:number;endMs:number}[],atMs:number,left=false):ExplainedState {
  for(const span of spans){
    const inside=left?span.startMs<atMs&&atMs<=span.endMs:span.startMs<=atMs&&atMs<span.endMs;
    if(inside)return {r:clamp01((span.endMs-atMs)/PRESSURE_DEFAULTS.explained.rampMs),endMs:span.endMs};
  }
  return {r:0,endMs:null};
}

export interface FeedbackCredit {
  /** c_fb, the total lowering of theta_x. */
  cFb:number;
  invitation:number;positive:number;score:number;
  /** C_score per metric (uncapped parts). */
  scoreByMetric:Record<string,number>;
  /** The latest negative, boundary, score_drop or outward_rejected at or before t. */
  lastNegativeAtMs:number|null;
}
const NEGATIVE_FEEDBACK:ReadonlySet<PressureFeedbackKind>=new Set(['negative','boundary','score_drop','outward_rejected']);
function lastNegativeAt(events:readonly PressureFeedbackEvent[],atMs:number):number|null {
  let last:number|null=null;
  for(const event of events)if(NEGATIVE_FEEDBACK.has(event.kind)&&event.atMs<=atMs&&(last===null||event.atMs>last))last=event.atMs;
  return last;
}

/**
 * M3-5 item 4: c_fb(t) = min(0.6, C_inv + min(0.3, C_pos) + min(0.3, C_score)); invitation 0.30 halving in 5 days,
 * positive 0.20 in 7, each score_rise 0.15 in 14. Only events after the latest negative-class event count, and within 7
 * days of it the credit is 0. A dependence audit earns nothing, nor does a dependence rise above level 3 (saturation).
 */
export function feedbackCredit(events:readonly PressureFeedbackEvent[]|null|undefined,atMs:number):FeedbackCredit {
  const defaults=PRESSURE_DEFAULTS.feedback,list=events??[];
  const lastNegativeAtMs=lastNegativeAt(list,atMs);
  const empty={cFb:0,invitation:0,positive:0,score:0,scoreByMetric:{},lastNegativeAtMs};
  if(lastNegativeAtMs!==null&&atMs-lastNegativeAtMs<defaults.negativeHoldMs)return empty;
  let invitation=0,positive=0,score=0;const scoreByMetric:Record<string,number>={};
  for(const event of list){
    if(event.atMs>atMs||lastNegativeAtMs!==null&&event.atMs<=lastNegativeAtMs)continue;
    const kind=event.kind==='invitation'||event.kind==='positive'||event.kind==='score_rise'?event.kind:null;
    if(!kind||kind==='score_rise'&&event.metric==='userDependency'&&typeof event.level==='number'&&
      event.level>defaults.dependenceSaturationLevel)continue;
    const value=defaults[kind].weight*2**(-(atMs-event.atMs)/defaults[kind].halfLifeMs);
    if(kind==='invitation')invitation+=value;
    else if(kind==='positive')positive+=value;
    else {score+=value;const metric=event.metric??'unknown';scoreByMetric[metric]=(scoreByMetric[metric]??0)+value;}
  }
  const cFb=Math.min(defaults.cap,invitation+Math.min(defaults.positiveCap,positive)+Math.min(defaults.scoreCap,score));
  return {cFb,invitation,positive,score,scoreByMetric,lastNegativeAtMs};
}

export interface ThetaReading {thetaEff:number;thetaX:number;bExpl:number;cFb:number;r:number;credit:FeedbackCredit}
/** theta_x(t) = clamp(theta_eff + b_expl - c_fb, 1.5, 4.5) and never below theta_eff - 0.6 (G4). */
export function thetaReading(thetaEff:number,spans:readonly {startMs:number;endMs:number}[],
  events:readonly PressureFeedbackEvent[]|null|undefined,atMs:number):ThetaReading {
  const r=explainedState(spans,atMs).r,bExpl=PRESSURE_DEFAULTS.explained.thetaAddend*r,credit=feedbackCredit(events,atMs);
  const clamped=Math.min(PRESSURE_DEFAULTS.thetaMax,Math.max(PRESSURE_DEFAULTS.thetaMin,thetaEff+bExpl-credit.cFb));
  return {thetaEff,thetaX:Math.max(thetaEff-PRESSURE_DEFAULTS.thetaXFloorGap,clamped),bExpl,cFb:credit.cFb,r,credit};
}

/**
 * The one-off invitation seed (M3-5 item 4): the latest invitation not followed by a negative-class event, 0.8 (d/20h)
 * e^(1 - d/20h), zero after 5 days. It only adds to P: boundaries, soft windows and openness are untouched. Expressed as
 * longing; its key is the event's seedKey (`invite:<assessmentRevision>`).
 */
export function inviteSource(events:readonly PressureFeedbackEvent[]|null|undefined,atMs:number):PressureContribution|null {
  const list=events??[],defaults=PRESSURE_DEFAULTS.invite;
  let latest:PressureFeedbackEvent|null=null;
  for(const event of list)if(event.kind==='invitation'&&event.atMs<=atMs&&(!latest||event.atMs>latest.atMs))latest=event;
  if(!latest)return null;
  const negative=lastNegativeAt(list,atMs);
  if(negative!==null&&negative>=latest.atMs)return null;
  const elapsed=atMs-latest.atMs;
  if(elapsed<=0||elapsed>defaults.horizonMs)return null;
  const ratio=elapsed/(defaults.peakHours*HOUR_MS);
  return {seedKind:'longing',key:latest.seedKey??`invite:${latest.id}`,value:defaults.peak*ratio*Math.exp(1-ratio),origin:'invite'};
}

/** The marker's time re-arm (M3-5 item 5): epochGridStart(send) + clamp(g50, 3h, 12h). */
export function hysteresisRearmAt(sendAtMs:number,gaps:Pick<UserActivityGaps,'g50'|'g90'>|null|undefined):number {
  const defaults=PRESSURE_DEFAULTS.rearm;
  return epochGridStart(sendAtMs)+Math.min(defaults.maxMs,Math.max(defaults.minMs,gaps?.g50??defaults.fallbackMs));
}

/** R = 15 + 15u minutes, u = sha256(subject:target:ramp:e). */
export function rampUniform(subjectId:string,targetId:string,endMs:number):number {return seededUnit(`${subjectId}:${targetId}:ramp:${endMs}`);}
/** A factor returning linearly from f_in at e to `to` over R: f_in + (to - f_in) clamp((t - e)/R, 0, 1). */
export function rampFactor(fIn:number,to:number,endMs:number,atMs:number,uniform:number):number {
  const length=PRESSURE_DEFAULTS.ramp.baseMs+PRESSURE_DEFAULTS.ramp.spreadMs*uniform;
  return fIn+(to-fIn)*clamp01((atMs-endMs)/length);
}

export type SilenceStageName='care'|'worry'|'lost'|'settled';
export interface SilenceStage {
  stage:SilenceStageName;
  /** Unexplained wait and m = (g50 + g90)/2. */
  U:number;m:number;
  /** y = clamp((U - m)/48h, 0, 1); y' = y when y >= 0.3, else 0; l = clamp((U - 7d)/7d, 0, 1). */
  y:number;yPrime:number;ell:number;
}
/** m = (g50 + g90)/2 (default 24h). */
export function silenceMidpoint(gaps:Pick<UserActivityGaps,'g50'|'g90'>|null|undefined):number {
  return ((gaps?.g50??FALLBACK_G50)+(gaps?.g90??FALLBACK_G90))/2;
}
/** care (U < m), worry (m <= U < 7d), lost (7d <= U < 28d, the second week fading in from worry), settled (U >= 28d). */
export function silenceStage(U:number,gaps:Pick<UserActivityGaps,'g50'|'g90'>|null|undefined):SilenceStage {
  const defaults=PRESSURE_DEFAULTS.silence,m=silenceMidpoint(gaps);
  const y=clamp01((U-m)/defaults.worryRampMs),yPrime=y>=defaults.worryMin?y:0,ell=clamp01((U-defaults.lostMs)/defaults.lostMs);
  const stage:SilenceStageName=U<m?'care':U<defaults.lostMs?'worry':U<defaults.settledMs?'lost':'settled';
  return {stage,U,m,y,yPrime,ell};
}
/**
 * w(U), front-loaded: PRESSURE_DEFAULTS.silence.weights (planned 1.35 up to 2d, 0.9 at 6d, 0.72 from 8d to 12d, 0.21 from
 * 14d; calibrated 1.5 and 1.05 for the first two nodes, inside the plan's +-0.15), linear between the nodes.
 */
export function silenceWeight(U:number):number {
  const nodes=PRESSURE_DEFAULTS.silence.weights;
  if(U<=nodes[0]![0])return nodes[0]![1];
  for(let index=1;index<nodes.length;index++){
    const [x1,y1]=nodes[index]!,[x0,y0]=nodes[index-1]!;
    if(U===x1)return y1;
    if(U<=x1)return y0+(y1-y0)*(U-x0)/(x1-x0);
  }
  return nodes.at(-1)![1];
}
/** psi = clamp((theta_ref/theta_x0)^(1 - beta) * rho_rep, psiMin 0.95, psiMax 1.1), rho_rep = 0.8 for a repeated disappearance. */
export function silencePosition(thetaX0:number,repeat:boolean):number {
  const defaults=PRESSURE_DEFAULTS.silence;
  const raw=(defaults.thetaRef/thetaX0)**(1-defaults.beta)*(repeat?defaults.repeatFactor:1);
  return Math.min(defaults.psiMax,Math.max(defaults.psiMin,raw));
}
/**
 * u_v = sha256(subject:target:silence:T_s), one per silence epoch (silenceEpochStart). The plan keyed it to T0; a skip or a
 * control change starts a new T0 without rewriting E0, so keying it (and theta_x0) to T0 re-weighted the whole hunger
 * integral since E0 and made S1 jump at the skip. T_s changes only with the integral's basis: a confirmed delivery.
 */
export function silenceMoodUniform(subjectId:string,targetId:string,silenceEpochMs:number):number {
  return seededUnit(`${subjectId}:${targetId}:silence:${silenceEpochMs}`);
}
/**
 * T_s: epochGridStart of her latest confirmed delivery of the episode at or before T0, else of its opening send. It fixes
 * u_v and theta_x0; a skip, a control change or any other new epoch without a delivery leaves it (and so S1) unchanged.
 */
export function silenceEpochStart(absence:Pick<AbsenceInput,'sentAtMs'>,silence:Pick<SilenceInput,'deliveredAtMs'>,
  epochStartMs:number):number {
  let latest=absence.sentAtMs;
  for(const atMs of silence.deliveredAtMs)if(Number.isFinite(atMs)&&atMs>latest&&atMs<=epochStartMs)latest=atMs;
  return epochGridStart(latest);
}
/** v = 2^(s (2u - 1)), s = moodSpread[0] (0.3) below 14 days of unexplained wait and moodSpread[1] (0.8) from there. */
export function silenceMood(uniform:number,U:number,left=false):number {
  const defaults=PRESSURE_DEFAULTS.silence;
  const early=left?U<=defaults.moodSwitchMs:U<defaults.moodSwitchMs;
  return 2**(defaults.moodSpread[early?0:1]!*(2*uniform-1));
}
/** (L_b, H_b) of week bucket b. */
export function silenceBounds(bucket:number):readonly [number,number] {
  const bounds=PRESSURE_DEFAULTS.silence.bounds;
  return bounds[Math.min(bucket,bounds.length-1)]!;
}
/** cap_b = min(H_b, max(L_b, n_{b-1})); the first week's cap is H_0 = 12. */
export function silenceCap(bucket:number,previousCount:number):number {
  const [low,high]=silenceBounds(bucket);
  return bucket===0?high:Math.min(high,Math.max(low,previousCount));
}
export interface SilenceHungerInput {U:number;m:number;thetaX0:number;psi:number;v:number;floor:number;capped:boolean}
/**
 * omega_sil = 1 + (w(U) (theta_x0/theta_ref) psi v f_b - 1) clamp((U - m)/12h, 0, 1): 1 below m, reaching the full
 * factor 12 hours later; capOmega while the week bucket is at its cap.
 */
export function silenceHunger(input:SilenceHungerInput):number {
  const defaults=PRESSURE_DEFAULTS.silence;
  if(input.capped)return defaults.capOmega;
  const ramp=clamp01((input.U-input.m)/defaults.rampMs);
  if(ramp===0)return 1;
  return 1+(silenceWeight(input.U)*(input.thetaX0/defaults.thetaRef)*input.psi*input.v*input.floor-1)*ramp;
}

export interface SilenceReading {
  U:number;stage:SilenceStage;bucket:number;bucketStartMs:number;bucketEndMs:number;
  /** n_b (her confirmed deliveries in this bucket so far, the opening send included), n_{b-1}, cap_b. */
  count:number;previousCount:number;cap:number;capped:boolean;
  /** f_b: 4 from the third week while the bucket has no delivery and is in its last 60 hours, otherwise 1. */
  floor:number;w:number;psi:number;v:number;thetaX0:number;repeat:boolean;omega:number;
}

/** Weeks of silence of one unanswered episode, fixed for one evaluation (its silence epoch T_s fixes theta_x0 and v). */
class SilenceProfile {
  readonly start:number;readonly m:number;readonly psi:number;readonly thetaX0:number;readonly repeat:boolean;
  private readonly covered:Span[];private readonly events:number[];
  private readonly gaps:Pick<UserActivityGaps,'g50'|'g90'>|null|undefined;private readonly moodUniform:number;
  private readonly explained:readonly {startMs:number;endMs:number}[];
  constructor(absence:AbsenceInput,silence:SilenceInput,gaps:Pick<UserActivityGaps,'g50'|'g90'>|null|undefined,thetaX0:number,
    moodUniform:number,explained:readonly {startMs:number;endMs:number}[]) {
    this.gaps=gaps;this.thetaX0=thetaX0;this.moodUniform=moodUniform;this.explained=explained;this.repeat=silence.repeat===true;
    this.start=absence.sentAtMs;this.m=silenceMidpoint(gaps);this.psi=silencePosition(thetaX0,silence.repeat===true);
    this.covered=mergeSpans(absence.explanations.map(item=>({start:Math.max(this.start,item.fromMs),end:item.untilMs??Infinity})));
    this.events=[this.start,...silence.deliveredAtMs.filter(atMs=>Number.isFinite(atMs)&&atMs>this.start)].sort((a,b)=>a-b);
  }
  /** Unexplained wait since the opening send (the user's explanations do not count). */
  U(atMs:number):number {
    if(atMs<=this.start)return 0;
    let covered=0;
    for(const span of this.covered){if(span.start>=atMs)break;covered+=Math.min(atMs,span.end)-span.start;}
    return atMs-this.start-covered;
  }
  /** The first time the unexplained wait reaches `value` (Infinity if it never does). */
  timeAtU(value:number):number {
    let cursor=this.start,wait=0;
    for(const span of this.covered){
      if(span.start>cursor){
        const length=span.start-cursor;
        if(wait+length>=value)return cursor+(value-wait);
        wait+=length;
      }
      cursor=Math.max(cursor,span.end);
      if(cursor===Infinity)return Infinity;
    }
    return cursor+(value-wait);
  }
  bucket(atMs:number,left:boolean):number {
    const offset=(atMs-this.start)/PRESSURE_DEFAULTS.silence.bucketMs;
    return Math.max(0,left?Math.ceil(offset)-1:Math.floor(offset));
  }
  count(bucket:number,atMs:number,left:boolean):number {
    const size=PRESSURE_DEFAULTS.silence.bucketMs,from=this.start+bucket*size,to=from+size;
    let count=0;
    for(const event of this.events)if(event>=from&&event<to&&(left?event<atMs:event<=atMs))count++;
    return count;
  }
  private explainedIn(bucket:number):boolean {
    const size=PRESSURE_DEFAULTS.silence.bucketMs,from=this.start+bucket*size,to=from+size;
    return this.covered.some(span=>span.start<to&&span.end>from)||this.explained.some(span=>span.startMs<to&&span.endMs>from);
  }
  reading(atMs:number,left=false):SilenceReading {
    const defaults=PRESSURE_DEFAULTS.silence,U=this.U(atMs),stage=silenceStage(U,this.gaps);
    const bucket=this.bucket(atMs,left),bucketStartMs=this.start+bucket*defaults.bucketMs,bucketEndMs=bucketStartMs+defaults.bucketMs;
    const count=this.count(bucket,atMs,left),previousCount=bucket>0?this.count(bucket-1,Infinity,false):0;
    const cap=silenceCap(bucket,previousCount),capped=count>=cap;
    const remaining=bucketEndMs-atMs;
    const floor=bucket>=2&&count===0&&(left?remaining<defaults.floorWindowMs:remaining<=defaults.floorWindowMs)&&
      !this.explainedIn(bucket)?defaults.floorFactor:1;
    const v=silenceMood(this.moodUniform,U,left),w=silenceWeight(U);
    const omega=atMs<=this.start?1:silenceHunger({U,m:this.m,thetaX0:this.thetaX0,psi:this.psi,v,floor,capped});
    return {U,stage,bucket,bucketStartMs,bucketEndMs,count,previousCount,cap,capped,floor,w,psi:this.psi,v,
      thetaX0:this.thetaX0,repeat:this.repeat,omega};
  }
  /** Every time in (from, to) where omega_sil may change its form. */
  breakpoints(from:number,to:number):number[] {
    const defaults=PRESSURE_DEFAULTS.silence,points=[this.start];
    for(const span of this.covered)points.push(span.start,span.end);
    for(const value of [this.m,this.m+defaults.rampMs,defaults.moodSwitchMs,...defaults.weights.map(node=>node[0])])
      points.push(this.timeAtU(value));
    points.push(...this.events);
    const first=Math.max(0,Math.floor((from-this.start)/defaults.bucketMs));
    for(let bucket=first;this.start+bucket*defaults.bucketMs<=to+defaults.bucketMs;bucket++){
      const edge=this.start+bucket*defaults.bucketMs;
      points.push(edge,edge+defaults.bucketMs-defaults.floorWindowMs);
    }
    return points.filter(point=>point>from&&point<to);
  }
}

/** The coefficients c_0..c_3 of the cubic through (xs, ys) (Newton's divided differences, expanded). */
function cubicThrough(xs:readonly number[],ys:readonly number[]):number[] {
  const count=xs.length,d=[...ys];
  for(let order=1;order<count;order++)for(let index=count-1;index>=order;index--)
    d[index]=(d[index]!-d[index-1]!)/(xs[index]!-xs[index-order]!);
  let coefficients=[d[count-1]!];
  for(let index=count-2;index>=0;index--){
    const next=new Array<number>(coefficients.length+1).fill(0);
    coefficients.forEach((value,power)=>{next[power+1]!+=value;next[power]!-=xs[index]!*value;});
    next[0]!+=d[index]!;coefficients=next;
  }
  return coefficients;
}
const polynomialAt=(coefficients:readonly number[],s:number)=>coefficients.reduceRight((sum,value)=>sum*s+value,0);
const polynomialIntegral=(coefficients:readonly number[],from:number,to:number)=>
  coefficients.reduce((sum,value,power)=>sum+value*(to**(power+1)-from**(power+1))/(power+1),0);
/** The roots in (0, 1) of p(s) = level: bisection on each monotone stretch (split at the roots of p'). */
function levelCrossings(coefficients:readonly number[],level:number):number[] {
  const [, c1=0,c2=0,c3=0]=coefficients,critical:number[]=[];
  if(Math.abs(c3)>1e-15){
    const disc=4*c2*c2-12*c3*c1;
    if(disc>=0)critical.push((-2*c2-Math.sqrt(disc))/(6*c3),(-2*c2+Math.sqrt(disc))/(6*c3));
  }else if(Math.abs(c2)>1e-15)critical.push(-c1/(2*c2));
  const edges=[0,...critical.filter(s=>s>0&&s<1).sort((a,b)=>a-b),1],roots:number[]=[];
  const q=(s:number)=>polynomialAt(coefficients,s)-level;
  for(let index=1;index<edges.length;index++){
    let low=edges[index-1]!,high=edges[index]!,qLow=q(low);
    if(!(qLow*q(high)<0))continue;
    for(let step=0;step<64&&high-low>0;step++){
      const middle=(low+high)/2,qMiddle=q(middle);
      if(qMiddle===0){low=high=middle;break;}
      if(qMiddle*qLow<0)high=middle;else {low=middle;qLow=qMiddle;}
    }
    roots.push((low+high)/2);
  }
  return roots;
}

/**
 * The integral of the hunger multiplier omega = clamp((1 - 0.5 r) omega_sil, 0.05, 3) from `originMs` (E0), in hours. On
 * each piece between breakpoints the unclamped omega is a polynomial of degree at most 3 in t: it is fitted through four
 * readings, split where it crosses the clamp bounds (which may happen mid-piece) and integrated exactly. The cumulative
 * value at a breakpoint depends only on the breakpoints before it, never on how far an evaluation looks, so W(t) is one
 * function of t whatever the tick.
 */
class HungerIntegral {
  private points:number[]=[];private cumulative:number[]=[];private horizon=-Infinity;
  private readonly originMs:number;private readonly rawAt:(atMs:number,left:boolean)=>number;
  private readonly breakpointsIn:(from:number,to:number)=>number[];
  /** `rawAt` is the unclamped omega; `left` reads the limit just before the time. */
  constructor(originMs:number,rawAt:(atMs:number,left:boolean)=>number,breakpointsIn:(from:number,to:number)=>number[]) {
    this.originMs=originMs;this.rawAt=rawAt;this.breakpointsIn=breakpointsIn;
  }
  private piece(from:number,to:number):number {
    if(!(to>from))return 0;
    const length=to-from,{min,max}=PRESSURE_DEFAULTS.omega;
    const coefficients=cubicThrough([0,0.25,0.5,1],[this.rawAt(from,false),this.rawAt(from+length/4,false),
      this.rawAt(from+length/2,false),this.rawAt(to,true)]);
    const cuts=[0,...levelCrossings(coefficients,min),...levelCrossings(coefficients,max),1].sort((a,b)=>a-b);
    let sum=0;
    for(let index=1;index<cuts.length;index++){
      const a=cuts[index-1]!,b=cuts[index]!;
      if(!(b>a))continue;
      const middle=polynomialAt(coefficients,(a+b)/2);
      sum+=middle>=max?max*(b-a):middle<=min?min*(b-a):polynomialIntegral(coefficients,a,b);
    }
    return sum*length/HOUR_MS;
  }
  private extend(atMs:number):void {
    this.horizon=atMs+7*DAY_MS;
    this.points=[this.originMs,...[...new Set(this.breakpointsIn(this.originMs,this.horizon))].sort((a,b)=>a-b)];
    this.cumulative=[0];
    for(let index=1;index<this.points.length;index++)
      this.cumulative.push(this.cumulative[index-1]!+this.piece(this.points[index-1]!,this.points[index]!));
  }
  hours(atMs:number):number {
    if(atMs<=this.originMs)return 0;
    if(atMs>=this.horizon)this.extend(atMs);
    let low=0,high=this.points.length-1;
    while(low<high){const middle=(low+high+1)>>1;if(this.points[middle]!<=atMs)low=middle;else high=middle-1;}
    return this.cumulative[low]!+this.piece(this.points[low]!,atMs);
  }
}

/** What one evaluation fixes: theta_eff, the announced absences, theta_x0, the silence profile and the hunger integral. */
interface PressureContext {
  T0:number;thetaEff:number;spans:{startMs:number;endMs:number}[];thetaX0:number;
  silence:SilenceProfile|null;hunger:HungerIntegral|null;
}
function pressureContext(inputs:PressureInputs,tendency:ContactTendency):PressureContext {
  const T0=epochStart(inputs),thetaEff=thetaEffective(tendency);
  const spans=explainedSpans(inputs.explained,inputs.gaps);
  // theta_x0 and u_v are read at the silence epoch T_s (not T0): see silenceMoodUniform.
  const silenceEpoch=inputs.silence&&inputs.absence?silenceEpochStart(inputs.absence,inputs.silence,T0):null;
  const thetaX0=thetaReading(thetaEff,spans,inputs.feedback,silenceEpoch??T0).thetaX;
  const silence=inputs.silence&&inputs.absence?new SilenceProfile(inputs.absence,inputs.silence,inputs.gaps,thetaX0,
    inputs.moodUniform??silenceMoodUniform(inputs.subjectId,inputs.targetId,silenceEpoch!),spans):null;
  if(!silence&&!spans.length)return {T0,thetaEff,spans,thetaX0,silence,hunger:null};
  const rawOmegaAt=(atMs:number,left:boolean)=>
    (1-PRESSURE_DEFAULTS.explained.damping*explainedState(spans,atMs,left).r)*(silence?silence.reading(atMs,left).omega:1);
  const breakpointsIn=(from:number,to:number)=>{
    const points:number[]=[];
    for(const span of spans)points.push(span.startMs,span.endMs-PRESSURE_DEFAULTS.explained.rampMs,span.endMs);
    if(silence)points.push(...silence.breakpoints(from,to));
    return points.filter(point=>point>from&&point<to&&Number.isFinite(point));
  };
  return {T0,thetaEff,spans,thetaX0,silence,hunger:new HungerIntegral(inputs.emotion.atMs,rawOmegaAt,breakpointsIn)};
}

/**
 * omega at `atMs` and its integral from E0 (hours), as the pressure model reads them: exposed so a caller or a test can
 * check the closed form against a fine numerical sum. `withHours: false` skips the integral (hours is then NaN).
 */
export function hungerReading(inputs:PressureInputs,atMs:number,withHours=true):{omega:number;hours:number} {
  const context=pressureContext(inputs,resolveTendency(inputs.tendency));
  if(!context.hunger)return {omega:1,hours:Math.max(0,(atMs-inputs.emotion.atMs)/HOUR_MS)};
  return {omega:omegaOf(context,atMs,context.silence&&atMs>context.silence.start?context.silence.reading(atMs):undefined),
    hours:withHours?context.hunger.hours(atMs):Number.NaN};
}
function omegaOf(context:PressureContext,atMs:number,silence:SilenceReading|undefined):number {
  return Math.min(PRESSURE_DEFAULTS.omega.max,Math.max(PRESSURE_DEFAULTS.omega.min,
    (1-PRESSURE_DEFAULTS.explained.damping*explainedState(context.spans,atMs).r)*(silence?.omega??1)));
}

/** S6: A_f * (d/3h) * e^(1 - d/3h), peak A_f at 3h; zero before the source and after 24h. */
export function followupSource(input:FollowupInput|null|undefined,atMs:number,amplitude:number=PRESSURE_DEFAULTS.tendency.followupAmplitude.value):number {
  if(!input)return 0;
  const hours=(atMs-input.atMs)/HOUR_MS,peak=PRESSURE_DEFAULTS.followup.peakHours;
  if(hours<=0||hours>PRESSURE_DEFAULTS.followup.horizonHours)return 0;
  return amplitude*(hours/peak)*Math.exp(1-hours/peak);
}

/** S7 share seeds (L1): weight * 2^(-(t - t_i)/6h) each. The M3 stub provides none. */
export function shareSource(seeds:readonly LifeShareSeed[],atMs:number):PressureContribution[] {
  return seeds.flatMap(seed=>{
    const age=atMs-seed.atMs;
    if(age<0||!(seed.weight>0))return [];
    return [{seedKind:'share' as const,key:seed.key,value:seed.weight*2**(-age/(PRESSURE_DEFAULTS.share.halfLifeHours*HOUR_MS))}];
  });
}

/** lambda = lambda_max * factor * (1 - e^(-(P - theta)/kappa)) for P > theta, else 0; factor = sigma*o*rho*alpha*mu. */
export function hazardRate(pressure:number,theta:number,factor:number):number {
  if(!(pressure>theta)||!(factor>0))return 0;
  return PRESSURE_DEFAULTS.lambdaMaxPerHour*factor*(1-Math.exp(-(pressure-theta)/PRESSURE_DEFAULTS.kappa));
}

/** One seeded uniform per epoch in (0, 1]: sha256(subject:target:hazard:T0). */
export function hazardUniform(subjectId:string,targetId:string,epochStartMs:number):number {
  const hex=createHash('sha256').update(`${subjectId}:${targetId}:hazard:${epochStartMs}`).digest('hex').slice(0,13);
  return (Number.parseInt(hex,16)+1)/2**52;
}

export function epochStart(inputs:Pick<PressureInputs,'epoch'|'emotion'>):number {
  const candidates=[inputs.epoch.lastUserActivityMs,inputs.epoch.lastConfirmedSendMs,inputs.epoch.lastSkipMs,
    inputs.epoch.lastControlChangeMs].filter((value):value is number=>typeof value==='number'&&Number.isFinite(value));
  return candidates.length?Math.max(...candidates):inputs.emotion.atMs;
}

/**
 * The grid point strictly after `atMs`: an epoch event is aligned to it before it becomes T0 (and the seed of u), so a
 * send or skip confirmed anywhere inside one 5-minute cell (by a 1-minute tick, or a 5-minute one, aligned or not) starts
 * the same epoch. Monotone, so aligning each epoch event aligns their maximum.
 */
export function epochGridStart(atMs:number):number {
  const step=PRESSURE_DEFAULTS.gridMs;
  return (Math.floor(atMs/step)+1)*step;
}

/**
 * The start of the UTC 5-minute grid cell holding `atMs`. The flow schedules a pressure occurrence at the start of the
 * cell of its check, measures its re-checks from there and reads P_dec there; her confirmed sends are not moved here (the
 * release and E0 keep her raw confirmation time).
 */
export function gridCellStart(atMs:number):number {
  const step=PRESSURE_DEFAULTS.gridMs;
  return Math.floor(atMs/step)*step;
}

/** UTC-aligned 5-minute grid points strictly after `fromMs`, up to and including `toMs`. */
export function gridPoints(fromMs:number,toMs:number):number[] {
  const step=PRESSURE_DEFAULTS.gridMs,points:number[]=[];
  for(let point=(Math.floor(fromMs/step)+1)*step;point<=toMs;point+=step)points.push(point);
  return points;
}

const LIFE_FACTOR:Record<LifeAvailabilityKind,number>=PRESSURE_DEFAULTS.life;
const inside=(intervals:readonly PressureInterval[]|undefined,atMs:number)=>
  (intervals??[]).some(interval=>interval.startMs<=atMs&&atMs<interval.endMs);

export interface PressureSample {
  atMs:number;
  /** The P the hazard reads: the sum of the eligible contributions (a spent seed below P_dec + delta is left out). */
  pressure:number;
  /** The sum of every contribution; eligibility and P_dec compare against it. */
  total:number;
  contributions:PressureContribution[];
  dominant:PressureContribution|null;
  drive:DriveSample;
  absence:AbsenceSample;
  /** Present with M3-5 inputs: the hunger multiplier at t and its integral from E0 (hours). */
  hunger?:{omega:number;hours:number};
  /** Present inside weeks of silence (inputs.silence with an episode). */
  silence?:SilenceReading;
}

/**
 * P(t) = s1 + s2 + s4 + s6 (+ s7) (+ the invitation seed) over the eligible seeds (the hazard's P), the total over all of
 * them, the contributions and the dominant eligible seed. Inside weeks of silence, from U >= m, S1 is read as the
 * episode's check-in (relabeledFrom; same value, the check-in key).
 */
export function pressureAt(inputs:PressureInputs,atMs:number,tendency=resolveTendency(inputs.tendency),
  shareSeeds:readonly LifeShareSeed[]=[],context:PressureContext=pressureContext(inputs,tendency)):PressureSample {
  const hungerHours=context.hunger?context.hunger.hours(atMs):undefined;
  const drive=driveSource(inputs.emotion,inputs.sends??[],atMs,hungerHours);
  const recall=recallSource(inputs.recall??[],atMs,tendency.recallWeight);
  const absence=absenceSource(inputs.absence,inputs.gaps,atMs,tendency.checkInWeight);
  const followup=followupSource(inputs.followup,atMs,tendency.followupAmplitude);
  const silence=context.silence&&atMs>context.silence.start?context.silence.reading(atMs):undefined;
  const checkInKey=inputs.absence?inputs.keys?.checkIn??`check_in:${inputs.absence.episodeId}`:null;
  const contributions:PressureContribution[]=[];
  if(inputs.followup)contributions.push({seedKind:'followup',key:inputs.followup.key,value:followup});
  if(recall.top)contributions.push({seedKind:'recall',key:recall.top.key,value:recall.value});
  if(checkInKey!==null)contributions.push({seedKind:'check_in',key:checkInKey,value:absence.value});
  if(silence&&checkInKey!==null&&silence.U>=silence.stage.m)
    contributions.push({seedKind:'check_in',key:checkInKey,value:drive.value,relabeledFrom:drive.seedKind});
  else contributions.push({seedKind:drive.seedKind,key:inputs.keys?.drive??`drive:${inputs.targetId}`,value:drive.value});
  const invite=inviteSource(inputs.feedback,atMs);
  if(invite)contributions.push(invite);
  contributions.push(...shareSource(shareSeeds,atMs));
  const total=contributions.reduce((sum,item)=>sum+item.value,0),spent=inputs.spent??{};
  const sample:PressureSample={atMs,pressure:eligiblePressure(contributions,total,spent,atMs),total,contributions,
    dominant:dominantSeed(contributions,total,spent,atMs),drive,absence:absence.sample};
  if(context.hunger)sample.hunger={omega:omegaOf(context,atMs,silence),hours:hungerHours!};
  if(silence)sample.silence=silence;
  return sample;
}

/**
 * A seed is eligible unless it is spent (P_dec) and the total P is not above P_dec + delta; a skip recorded with its time
 * is also eligible again from epochGridStart(skip) + 24 hours (when `atMs` is known). A finished seed (Infinity) never is.
 */
function eligible(item:PressureContribution,total:number,spent:Readonly<Record<string,SpentValue>>,atMs?:number):boolean {
  const decided=Object.hasOwn(spent,item.key)?spent[item.key]!:undefined;
  if(decided===undefined)return true;
  if(typeof decided==='number')return total>decided+PRESSURE_DEFAULTS.delta;
  if(total>decided.pDec+PRESSURE_DEFAULTS.delta)return true;
  return decided.pDec!==Number.POSITIVE_INFINITY&&atMs!==undefined&&decided.atMs!==null&&
    atMs>=epochGridStart(decided.atMs)+PRESSURE_DEFAULTS.rearm.skipMs;
}

/**
 * The P the hazard reads: the sum of the eligible contributions, so a small seed can never ride a spent one over theta; a
 * spent seed counts again only once the total P is above its P_dec + delta (or, with its skip time, 24 hours later).
 */
export function eligiblePressure(contributions:readonly PressureContribution[],total:number,
  spent:Readonly<Record<string,SpentValue>>={},atMs?:number):number {
  return contributions.reduce((sum,item)=>eligible(item,total,spent,atMs)?sum+item.value:sum,0);
}

/**
 * The largest positive contribution among eligible seeds: not spent, or the total P (`pressure`) > P_dec + delta (or 24
 * hours after a timed skip). Ties go followup > recall > check_in > longing > share.
 */
export function dominantSeed(contributions:readonly PressureContribution[],pressure:number,
  spent:Readonly<Record<string,SpentValue>>={},atMs?:number):PressureContribution|null {
  const order=PRESSURE_DEFAULTS.seedOrder;
  let best:PressureContribution|null=null;
  for(const item of contributions){
    if(!(item.value>0)||!eligible(item,pressure,spent,atMs))continue;
    if(!best||item.value>best.value||item.value===best.value&&order.indexOf(item.seedKind)<order.indexOf(best.seedKind))best=item;
  }
  return best;
}

/**
 * What the hysteresis marker reads at one point: the contribution, after its release, of the seed whose send fired it. S1
 * (`drive`, the value passed) for longing, share and window_end and for a marker without a seed; otherwise that seed's own
 * contribution (by key when known), which is 0 once the seed was sent.
 */
export function markerValue(seed:PressureInputs['hysteresisSeed'],drive:number,contributions:readonly PressureContribution[]):number {
  if(!seed||seed.seedKind==='longing'||seed.seedKind==='share'||seed.seedKind==='window_end'||seed.relabeledFrom)return drive;
  return contributions.reduce((sum,item)=>item.seedKind===seed.seedKind&&!item.relabeledFrom&&(seed.key===null||item.key===seed.key)?
    sum+Math.max(0,item.value):sum,0);
}

export interface PressureRecord {
  firedAtMs:number|null;
  epochStartMs:number;
  atMs:number;
  u:number;
  H:number;
  /** The P the hazard read (eligible seeds only). */
  P:number;
  /** P over every seed, spent ones included (what a skip records as P_dec). */
  total:number;
  thetaEff:number;
  lambda:number;
  dominant:PressureContribution|null;
  contributions:PressureContribution[];
  receptivity:{factor:number;samples:number};
  life:{availability:LifeAvailabilityKind|null;factor:number;ledgerRef:string|null};
  /** Present when her own life lowered the hazard at this point. */
  lifeSuppression?:{ledgerRef:string};
  softFactor:number;
  tendencyRevision:number;
  /** Present with feedback or announced absences: theta_x and its parts (M3-5 items 3, 4). */
  thetaX?:number;
  theta?:{bExpl:number;cFb:number;inv:number;pos:number;score:number};
  /** Present with a hunger multiplier (announced absence or weeks of silence): omega at this point. */
  omega?:number;
  /** Present inside weeks of silence (M3-5 item 6). */
  silence?:{U:number;stage:SilenceStageName;y:number;ell:number;bucket:number;count:number;cap:number;floor:number;w:number;
    psi:number;v:number;thetaX0:number;repeat:boolean};
  /**
   * Set by the caller (slice 5e) from contact-framing when it materializes this record: the opening frame and what chose it.
   * The library never writes it.
   */
  frame?:Record<string,unknown>;
}

export interface PressureEvaluation {
  epochStartMs:number;
  u:number;
  /** -ln u: the integrated hazard at which this epoch fires. */
  threshold:number;
  /** Integrated hazard over grid points up to the trigger, or up to now without one. */
  H:number;
  fired:PressureRecord|null;
  /** The state at `nowMs` (P here is what a skip records as P_dec). */
  current:PressureRecord;
  /**
   * First grid point at which a fired marker was seen below theta_off (or reached its time re-arm), if that happened in
   * this epoch. A caller that clears its stored marker passes this back as inputs.hysteresisClearedAtMs for the rest of the
   * epoch.
   */
  hysteresisClearedAtMs:number|null;
}

/**
 * Integrate the hazard from T0 over grid points up to `nowMs` and report the first grid point with lambda > 0 and
 * H >= -ln u. Stateless: the same inputs give the same trigger at any call time on or after it.
 */
export function evaluatePressure(inputs:PressureInputs):PressureEvaluation {
  if(!Number.isFinite(inputs.nowMs))throw new RangeError('invalid_pressure_time');
  const tendency=resolveTendency(inputs.tendency),theta=thetaEffective(tendency),thetaOff=theta-PRESSURE_DEFAULTS.thetaOffGap;
  const life=inputs.life??NO_LIFE,T0=epochStart(inputs);
  const u=inputs.uniform??hazardUniform(inputs.subjectId,inputs.targetId,T0);
  if(!(u>0&&u<=1))throw new RangeError('invalid_hazard_uniform');
  const threshold=-Math.log(u),stepHours=PRESSURE_DEFAULTS.gridMs/HOUR_MS,step=PRESSURE_DEFAULTS.gridMs;
  const shareSeeds=life.shareSeeds(T0,inputs.nowMs);
  const context=pressureContext(inputs,tendency);
  const recordedClear=typeof inputs.hysteresisClearedAtMs==='number'&&Number.isFinite(inputs.hysteresisClearedAtMs)&&
    inputs.hysteresisClearedAtMs>=T0?inputs.hysteresisClearedAtMs:null;
  const rearmAt=typeof inputs.hysteresisRearmAtMs==='number'&&Number.isFinite(inputs.hysteresisRearmAtMs)?inputs.hysteresisRearmAtMs:null;
  const reportTheta=(inputs.feedback?.length??0)>0||context.spans.length>0;
  let cleared=!inputs.hysteresisFired&&recordedClear===null,clearedAt:number|null=null,H=0;
  const availabilities=new Map<number,LifeAvailability|null>();
  const availabilityAt=(atMs:number)=>{
    if(!availabilities.has(atMs))availabilities.set(atMs,life.availabilityAt(atMs));
    return availabilities.get(atMs)!;
  };
  const rampU=(endMs:number)=>inputs.rampUniform??rampUniform(inputs.subjectId,inputs.targetId,endMs);
  const rampLength=PRESSURE_DEFAULTS.ramp.baseMs+PRESSURE_DEFAULTS.ramp.spreadMs;
  // M3-5 item 8: after a soft window ends mu returns to 1 over R; after her off/busy/glance ends alpha does, its end read
  // from the grid points before (at most six). Both are read on grid points; the off-grid reading uses the same rule.
  const softAt=(atMs:number)=>{
    if(inside(inputs.soft,atMs))return tendency.softWindowFactor;
    let factor=1;
    for(const interval of inputs.soft??[])if(interval.endMs<=atMs&&atMs-interval.endMs<rampLength)
      factor=Math.min(factor,rampFactor(tendency.softWindowFactor,1,interval.endMs,atMs,rampU(interval.endMs)));
    return factor;
  };
  const alphaAt=(atMs:number,availability:LifeAvailability|null)=>{
    const now=availability?LIFE_FACTOR[availability.availability]:1;
    if(!(now>0))return now;
    let factor=now;
    const last=(Math.ceil(atMs/step)-1)*step;
    for(let index=0;index<PRESSURE_DEFAULTS.ramp.lookbackPoints;index++){
      const point=last-index*step,before=availabilityAt(point),previous=before?LIFE_FACTOR[before.availability]:1;
      if(previous<now)factor=Math.min(factor,rampFactor(previous,now,point+step,atMs,rampU(point+step)));
    }
    return factor;
  };
  // Hysteresis is observed on grid points only; the off-grid reading at nowMs reports without changing it. It reads the
  // expressed seed alone (markerValue; as the M1 marker read connection alone): S1 after its release for a longing,
  // share, window-end or relabelled check-in send, the seed itself otherwise, so bounded seeds that were not sent (a
  // follow-up, a recall) never keep a fired marker from clearing. It also clears at its time re-arm (M3-5 item 5).
  const pointAt=(atMs:number,onGrid:boolean)=>{
    const sample=pressureAt(inputs,atMs,tendency,shareSeeds,context);
    const held=markerValue(inputs.hysteresisSeed,sample.drive.value,sample.contributions);
    if(onGrid&&!cleared&&(held<thetaOff||recordedClear!==null&&atMs>=recordedClear||rearmAt!==null&&atMs>=rearmAt)){
      cleared=true;clearedAt=atMs;
    }
    const reading=thetaReading(theta,context.spans,inputs.feedback,atMs);
    const receptivity=receptivityAt(inputs.activity??null,atMs,{enabled:inputs.receptivityEnabled!==false});
    const availability=availabilityAt(atMs);
    const alpha=alphaAt(atMs,availability);
    const soft=softAt(atMs);
    const open=!inputs.openOccurrence&&cleared&&atMs-T0>=PRESSURE_DEFAULTS.refractoryMs&&!inside(inputs.blocked,atMs)&&
      sample.dominant!==null&&!sample.silence?.capped;
    const lambda=open?hazardRate(sample.pressure,reading.thetaX,tendency.hazardScale*tendency.openness*receptivity.factor*alpha*soft):0;
    const silence=sample.silence;
    return {sample,lambda,record:(firedAtMs:number|null):PressureRecord=>({firedAtMs,epochStartMs:T0,atMs,u,H,P:sample.pressure,
      total:sample.total,thetaEff:theta,lambda,dominant:sample.dominant,contributions:sample.contributions,receptivity,
      life:{availability:availability?.availability??null,factor:alpha,ledgerRef:availability?.ledgerRef??null},
      ...(availability&&alpha<1?{lifeSuppression:{ledgerRef:availability.ledgerRef}}:{}),
      softFactor:soft,tendencyRevision:tendency.revision,
      ...(reportTheta?{thetaX:reading.thetaX,theta:{bExpl:reading.bExpl,cFb:reading.cFb,inv:reading.credit.invitation,
        pos:reading.credit.positive,score:reading.credit.score}}:{}),
      ...(sample.hunger?{omega:sample.hunger.omega}:{}),
      ...(silence?{silence:{U:silence.U,stage:silence.stage.stage,y:silence.stage.y,ell:silence.stage.ell,bucket:silence.bucket,
        count:silence.count,cap:silence.cap,floor:silence.floor,w:silence.w,psi:silence.psi,v:silence.v,thetaX0:silence.thetaX0,
        repeat:silence.repeat}}:{})})};
  };
  let fired:PressureRecord|null=null;
  for(const atMs of gridPoints(T0,inputs.nowMs)){
    const point=pointAt(atMs,true);
    H+=point.lambda*stepHours;
    if(point.lambda>0&&H>=threshold){fired=point.record(atMs);break;}
  }
  const current=pointAt(inputs.nowMs,false).record(fired?.firedAtMs??null);
  return {epochStartMs:T0,u,threshold,H,fired,current:{...current,H},hysteresisClearedAtMs:clearedAt};
}
