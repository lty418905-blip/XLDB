import {createHash} from 'node:crypto';
import type {LifeAvailability,LifeAvailabilityProvider,LifeShareSeed} from '../contact-pressure.ts';

/**
 * Her default rhythm before L1 (M3-5 item 7): a persona-derived chronotype that only says when she is asleep.
 * Asleep is `off`; every other instant is null (no claim, as NO_LIFE). It never forbids any instant of the user's, it
 * never invents events, and it has no share seeds. L1's ledger provider (traits.chronotype) and the U6 onboarding
 * declaration replace it through the same interface.
 */
export type Chronotype='early'|'standard'|'late';

/** Minutes after local midnight of the evening's date D: sleep at `sleep`, wake at `wake` (D + 1); Fri and Sat shift both. */
export interface ChronotypeWindow {sleep:number;wake:number;weekendLateRise:number;weekendLateSleep:number}

const MINUTE_MS=60_000,DAY_MINUTES=24*60;
export const CHRONOTYPE_JITTER_MINUTES=30,CHRONOTYPE_WEEKDAY_WAKE_JITTER_MINUTES=15; // a weekday wake is an alarm
export const CHRONOTYPE_WINDOWS:Readonly<Record<Chronotype,Readonly<ChronotypeWindow>>>=Object.freeze({
  early:Object.freeze({sleep:22*60+30,wake:DAY_MINUTES+6*60+30,weekendLateRise:0,weekendLateSleep:30}),
  standard:Object.freeze({sleep:23*60+30,wake:DAY_MINUTES+7*60+30,weekendLateRise:60,weekendLateSleep:30}),
  late:Object.freeze({sleep:DAY_MINUTES+60,wake:DAY_MINUTES+9*60,weekendLateRise:60,weekendLateSleep:30}),
});

/** A preset's default rhythm: its chronotype and how much later it wakes on Saturday and Sunday mornings. */
export interface PresetRhythm {chronotype:Chronotype;weekendLateRise:number}

const rhythm=(chronotype:Chronotype,weekendLateRise=CHRONOTYPE_WINDOWS[chronotype].weekendLateRise):Readonly<PresetRhythm>=>
  Object.freeze({chronotype,weekendLateRise});

/**
 * The six built-in presets by presetId, proposed from each preset's own text and revised after the fable-high review (see
 * .local/review/proactive-m3-20260928/m3-5a-chronotypes.md). Xia Mingcheng runs public nature activities, so her weekend
 * mornings are working mornings and she does not sleep in. A custom persona is standard.
 */
export const PRESET_RHYTHMS:Readonly<Record<string,Readonly<PresetRhythm>>>=Object.freeze({
  'reserved-older-brother-gu-chen':rhythm('early'),
  'decisive-executive-cheng-yanzhou':rhythm('standard'),
  'gentle-older-sister-shen-zhiwei':rhythm('standard'),
  'energetic-young-woman-xia-mingcheng':rhythm('standard',0),
  'affectionate-younger-brother-lu-tinglan':rhythm('standard'),
  'tsundere-younger-sister-tang-yinghe':rhythm('standard'),
});

const CUSTOM_RHYTHM=rhythm('standard');

/** The default rhythm of a preset id; custom personas (or none) are standard. */
export function presetRhythm(presetId:string|null|undefined):Readonly<PresetRhythm> {
  return presetId!=null&&Object.hasOwn(PRESET_RHYTHMS,presetId)?PRESET_RHYTHMS[presetId]!:CUSTOM_RHYTHM;
}

/** The chronotype of a preset id; custom personas (or none) are standard. */
export function presetChronotype(presetId:string|null|undefined):Chronotype {
  return presetRhythm(presetId).chronotype;
}

export interface ChronotypeOptions {
  /** A stable key of the scene scope (for example scopeKey(scope)). */
  scope:string;
  characterId:string;
  chronotype:Chronotype;
  /** The interactions clock time zone (IANA). */
  timeZone:string;
  /** Minutes later she wakes on Saturday and Sunday mornings (integer 0-120); defaults to the chronotype's. */
  weekendLateRise?:number;
  /** Minutes later she goes to sleep on Friday and Saturday evenings (integer 0-120); defaults to the chronotype's. */
  weekendLateSleep?:number;
}

/** One night: [startMs, endMs) is off; `localDate` is the evening's date D (YYYY-MM-DD) and names the draw. */
export interface ChronotypeNight {localDate:string;startMs:number;endMs:number;jitterStart:number;jitterEnd:number;weekend:boolean}

export interface ChronotypeLifeProvider extends LifeAvailabilityProvider {
  /** Everything that determines this provider's answers; equal identities answer identically. */
  readonly identity:string;
  readonly chronotype:Chronotype;
  readonly weekendLateRise:number;
  readonly weekendLateSleep:number;
  /** The night that starts on the evening of `localDate` (YYYY-MM-DD, local). */
  night(localDate:string):ChronotypeNight;
}

const NO_SHARE:readonly LifeShareSeed[]=Object.freeze([]);
const dateFormatters=new Map<string,Intl.DateTimeFormat>();
const offsetFormatters=new Map<string,Intl.DateTimeFormat>();

function formatter(cache:Map<string,Intl.DateTimeFormat>,timeZone:string,options:Intl.DateTimeFormatOptions):Intl.DateTimeFormat {
  let value=cache.get(timeZone);
  if(!value){
    value=new Intl.DateTimeFormat('en-US-u-ca-gregory-nu-latn',{timeZone,...options});
    cache.set(timeZone,value);
  }
  return value;
}

function localParts(timeZone:string,atMs:number):{year:number;month:number;day:number;minutes:number} {
  const parts=formatter(offsetFormatters,timeZone,{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',
    hourCycle:'h23'}).formatToParts(new Date(atMs));
  const read=(type:string)=>Number(parts.find(part=>part.type===type)?.value);
  const result={year:read('year'),month:read('month'),day:read('day'),minutes:read('hour')*60+read('minute')};
  if(!Object.values(result).every(Number.isInteger))throw new Error('invalid local date from time-zone formatter');
  return result;
}

/** The local calendar date of `atMs` in `timeZone`, as YYYY-MM-DD. */
export function localDateOf(timeZone:string,atMs:number):string {
  if(!Number.isFinite(atMs))throw new RangeError('atMs must be finite');
  const parts=formatter(dateFormatters,timeZone,{year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(atMs));
  const read=(type:string)=>parts.find(part=>part.type===type)?.value;
  return `${read('year')}-${read('month')}-${read('day')}`;
}

function parseDate(localDate:string):{year:number;month:number;day:number} {
  const match=/^(\d{4})-(\d{2})-(\d{2})$/.exec(localDate);
  if(!match)throw new RangeError('localDate must be YYYY-MM-DD');
  const year=Number(match[1]),month=Number(match[2]),day=Number(match[3]),check=new Date(Date.UTC(year,month-1,day));
  if(check.getUTCFullYear()!==year||check.getUTCMonth()!==month-1||check.getUTCDate()!==day)throw new RangeError('invalid localDate');
  return {year,month,day};
}

function addDays(localDate:string,days:number):string {
  const {year,month,day}=parseDate(localDate);
  return new Date(Date.UTC(year,month-1,day+days)).toISOString().slice(0,10);
}

/**
 * The UTC instant of local wall time `minutes` after midnight of `localDate` (minutes may exceed a day). Two offset
 * passes; a wall time inside a DST gap resolves to the instant after the gap.
 */
function localInstant(timeZone:string,localDate:string,minutes:number):number {
  const {year,month,day}=parseDate(localDate),wall=Date.UTC(year,month-1,day)+minutes*MINUTE_MS;
  const offsetAt=(atMs:number)=>{
    const local=localParts(timeZone,atMs);
    return Date.UTC(local.year,local.month-1,local.day)+local.minutes*MINUTE_MS-Math.floor(atMs/MINUTE_MS)*MINUTE_MS;
  };
  let guess=wall-offsetAt(wall);
  guess=wall-offsetAt(guess);
  return guess;
}

/** Whether the night of the evening `localDate` ends on a Saturday or Sunday morning (its evening is a Friday or Saturday). */
function weekendNight(localDate:string):boolean {
  const {year,month,day}=parseDate(addDays(localDate,1)),wakeWeekday=new Date(Date.UTC(year,month-1,day)).getUTCDay();
  return wakeWeekday===0||wakeWeekday===6;
}

/**
 * Two independent integer jitters from sha256(scope:character:chronotype:localDate): bedtime in [-30, 30] minutes; wake in
 * [-15, 15] on a weekday morning (an alarm) and [-30, 30] on a Saturday or Sunday morning.
 */
export function chronotypeJitter(scope:string,characterId:string,chronotype:Chronotype,localDate:string):[number,number] {
  const hex=createHash('sha256').update(`${scope}:${characterId}:${chronotype}:${localDate}`).digest('hex');
  const draw=(slice:string,band:number)=>Math.floor(parseInt(slice,16)/2**48*(2*band+1))-band;
  const wakeBand=weekendNight(localDate)?CHRONOTYPE_JITTER_MINUTES:CHRONOTYPE_WEEKDAY_WAKE_JITTER_MINUTES;
  return [draw(hex.slice(0,12),CHRONOTYPE_JITTER_MINUTES),draw(hex.slice(12,24),wakeBand)];
}

/**
 * Her default rhythm as a life provider: asleep (off) from the evening's sleep time to the next morning's wake time, each
 * with its own seeded jitter per night (bedtime +-30 minutes, a weekday wake +-15, a weekend wake +-30). On Friday and
 * Saturday evenings she goes to sleep `weekendLateSleep` minutes later (by default 30) and on Saturday and Sunday mornings
 * she wakes `weekendLateRise` minutes later (by default 60 for standard and late, 0 for early). Synchronous and pure: the
 * same scope, character, chronotype, weekend shifts, time zone and night always give the same window.
 */
export function chronotypeLife(options:ChronotypeOptions):ChronotypeLifeProvider {
  const {scope,characterId,chronotype,timeZone}=options;
  if(typeof scope!=='string'||scope.length===0)throw new TypeError('scope must be a non-empty string');
  if(typeof characterId!=='string'||characterId.length===0)throw new TypeError('characterId must be a non-empty string');
  if(!Object.hasOwn(CHRONOTYPE_WINDOWS,chronotype))throw new TypeError('unknown chronotype');
  if(typeof timeZone!=='string'||timeZone.length===0)throw new TypeError('timeZone must be a non-empty IANA time zone');
  try {localDateOf(timeZone,0);} catch {throw new RangeError(`invalid IANA time zone: ${timeZone}`);}
  const window=CHRONOTYPE_WINDOWS[chronotype],weekendLateRise=options.weekendLateRise??window.weekendLateRise;
  const weekendLateSleep=options.weekendLateSleep??window.weekendLateSleep;
  for(const [name,value] of [['weekendLateRise',weekendLateRise],['weekendLateSleep',weekendLateSleep]] as const){
    if(!Number.isInteger(value)||value<0||value>120)throw new RangeError(`${name} must be an integer from 0 to 120 minutes`);
  }
  // v2: weekend late sleep and the narrower weekday wake jitter; a night of v1 and of v2 can differ for the same inputs.
  const identity=`chronotype-v2:${JSON.stringify([chronotype,weekendLateRise,weekendLateSleep,timeZone,scope,characterId])}`;
  const nights=new Map<string,ChronotypeNight>();
  const night=(localDate:string):ChronotypeNight=>{
    const cached=nights.get(localDate);
    if(cached)return cached;
    const [jitterStart,jitterEnd]=chronotypeJitter(scope,characterId,chronotype,localDate);
    const weekend=weekendNight(localDate);
    const result=Object.freeze({localDate,weekend,jitterStart,jitterEnd,
      startMs:localInstant(timeZone,localDate,window.sleep+(weekend?weekendLateSleep:0)+jitterStart),
      endMs:localInstant(timeZone,localDate,window.wake+(weekend?weekendLateRise:0)+jitterEnd)});
    nights.set(localDate,result);
    if(nights.size>64)nights.delete(nights.keys().next().value!);
    return result;
  };
  const availabilityAt=(atMs:number):LifeAvailability|null=>{
    const today=localDateOf(timeZone,atMs);
    // A night starts no earlier than 22:00 of D (and by 03:30 of D + 1) and ends before noon of D + 1: only yesterday's and
    // today's can hold atMs.
    for(const localDate of [addDays(today,-1),today]){
      const current=night(localDate);
      if(atMs>=current.startMs&&atMs<current.endMs)return {availability:'off',ledgerRef:`chronotype:${chronotype}:${localDate}`};
    }
    return null;
  };
  return Object.freeze({identity,chronotype,weekendLateRise,weekendLateSleep,night,availabilityAt,shareSeeds:()=>NO_SHARE});
}
