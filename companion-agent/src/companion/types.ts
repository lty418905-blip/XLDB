import type {FrontendStrategy} from '../user-model/types.ts';
import type {PressureRecord,SeedKind} from './contact-pressure.ts';

export type CompanionState='disabled'|'waiting'|'evaluating'|'cooldown'|'awaiting_reply'|'suspended';
/**
 * `drive` is an internal-pressure contact keyed per episode (from the latest user activity or confirmed send to its target);
 * `recall` is a pressure contact whose dominant seed was a memory the user's conversation brought back (M3);
 * `window_end` is the longing sent first thing after a hard window the user set, keyed per window instance;
 * `daily` remains only for rows written by older versions, which the scheduler migration cancels.
 */
export type OpportunityKind='schedule'|'experience'|'unfinished_topic'|'daily'|'drive'|'window_end'|'recall';
/**
 * The seed a contact expresses (M3; defined with the pressure model, which checks it against the release table). The
 * pressure seeds (longing, share, recall, check_in, followup) reach an opportunity only through the hazard; a reminder is
 * due by its time and a window end by its roll.
 */
export type {SeedKind};
/**
 * What a pressure occurrence keeps of the hazard that materialized it (companion_opportunities.pressure, at most 2 KB): the
 * pressure record at the trigger, the seed key it spent, its generation (`~g<n>` suffix of the opportunity key, 0 for the
 * M1 key) and the opportunity key itself, so a cancelled row can be rebuilt without evaluating the hazard again.
 */
export type OccurrencePressure=PressureRecord&{seedKey:string;generation:number;opportunityKey:string};
export type OpportunityStatus='waiting'|'evaluating'|'approved'|'deferred'|'dismissed'|'cancelled'|'consumed';
export type DeliveryStatus='draft'|'ready'|'sending'|'host_committed'|'failed'|'unknown'|'cancelled';

export interface LocalContactWindow {
  days:number[];
  start:string;
  end:string;
}
export interface ContactException {
  date:string;
  mode:'skip'|'replace';
  windows?:Omit<LocalContactWindow,'days'>[];
}
export interface ContactSettings {
  subjectId:string;
  revision:number;
  timeZone:string;
  windows:LocalContactWindow[];
  exceptions:ContactException[];
  minimumIntervalMs:number;
  maxUnanswered:number;
  updatedAtMs:number;
}
export interface ContactOccurrence {
  occurrenceId:string;
  localDate:string;
  windowIndex:number;
  startAtMs:number;
  endAtMs:number;
  timeZone:string;
  settingsRevision:number;
}

/**
 * A single currently active soft no-contact window: a soft no-contact promise, or the user's own explicit goodnight
 * (`kind:'sleep'`, keyed `sleep:<sourceId>@<revision>`, `commitmentId` `sleep:<sourceId>`). `kind` is not persisted;
 * a stored sleep binding is recognised by its key.
 */
export interface QuietExceptionBinding {
  scopeKey:string;
  commitmentId:string;
  revision:number;
  key:string;
  sourceId:string;
  sourceRevision:number;
  kind?:'commitment'|'sleep';
}
/** `declined`: the exception was judged negative for this window instance, so no other occurrence applies in it. */
export type QuietExceptionStatus='available'|'reserved'|'consumed'|'declined';

/** `window`: the commitment and revision whose hard window just ended; `memory`: the recalled memory and its source revision. */
export interface CompanionBasis {kind:'source'|'profile'|'schedule'|'daily'|'drive'|'window'|'memory';id:string;revision:number}
export interface CompanionOpportunity {
  opportunityId:string;
  subjectId:string;
  targetId:string;
  kind:OpportunityKind;
  purpose:string;
  topic:string;
  basis:CompanionBasis[];
  occurrenceId:string;
  sourceVersion:number;
  profileRevision:number;
  activityRevision:number;
  controlsRevision:number;
  contactRevision:number;
  checkAtMs:number;
  windowStartMs:number;
  windowEndMs:number;
  expiresAtMs:number;
  status:OpportunityStatus;
  deferCount:number;
  decision:'approve'|'defer'|'dismiss'|null;
  strategy:FrontendStrategy|null;
  claimToken:string|null;
  claimUntilMs:number|null;
  createdAtMs:number;
  updatedAtMs:number;
  /** The seed this contact expresses; null on rows written before M3 (see CompanionFlow's legacy mapping). */
  seedKind:SeedKind|null;
  /** Only on pressure occurrences. */
  pressure:OccurrencePressure|null;
}
export interface ScheduleOpportunityInput {
  subjectId:string;
  targetId:string;
  opportunityKey:string;
  kind:OpportunityKind;
  purpose:string;
  topic:string;
  basis:CompanionBasis[];
  sourceVersion:number;
  nowMs?:number;
  notBeforeMs?:number;
  expiresAtMs?:number;
  /**
   * Substantive judgment inputs other than the scene version. A rebuilt row whose occurrence was last judged `wait`
   * or `skip` with this same fingerprint keeps that judgment instead of being evaluated again.
   */
  fingerprint?:string;
  seedKind?:SeedKind|null;
  pressure?:OccurrencePressure|null;
}
export interface OpportunityClaim {opportunity:CompanionOpportunity;claimToken:string;claimUntilMs:number}

/**
 * The last contact judgment for one occurrence, kept independently of the opportunity rows that source changes cancel. A
 * pressure occurrence also records its seed key, seed kind and generation, and a skip the pressure at the decision
 * (P_dec): the next generation of that seed opens only above P_dec + delta.
 */
export interface JudgmentInput {choice:'send'|'wait'|'skip';fingerprint:string;seedKey?:string;seedKind?:SeedKind;generation?:number;
  pressureAtDecision?:number}
export interface CompanionJudgment {
  occurrenceId:string;
  subjectId:string;
  targetId:string;
  lastChoice:JudgmentInput['choice']|null;
  lastFingerprint:string|null;
  pressureMarker:DriveMarker|null;
  nextCheckAtMs:number|null;
  updatedAtMs:number;
  seedKey:string|null;
  seedKind:SeedKind|null;
  generation:number|null;
  /** Null for a judgment other than a skip, and for skips recorded before M3 (read as theta_on). */
  pressureAtDecision:number|null;
}
/**
 * Contact hysteresis, written only when a pressure contact (drive, recall, follow-up) or a window-end message to the target
 * is confirmed sent (a wait or skip never locks it): the pressure must then fall below theta_off before the hazard opens
 * again. `episode` is the unanswered waiting episode that last led to a sent contact; `clearedAtMs` is the grid point at
 * which the pressure was first seen below theta_off after that send (absent while fired, and on markers written before M3).
 * While fired, the pressure model reads the seed the latest such send expressed (see CompanionFlow's pressure context).
 */
export interface DriveMarker {fired:boolean;episode:string|null;clearedAtMs?:number}
/**
 * The user's contact tendency for one companion (companion_tendencies; M3): multipliers of the pressure model within fixed
 * bounds (see PRESSURE_DEFAULTS.tendency), the user's openness (at most 1, it only narrows), whether the user's own rhythm
 * modulates the hazard, and who wrote it. Only the SDK/CLI workspace operation and initialization write it, never a
 * conversation; a rollback keeps the newer revision.
 */
export interface ContactTendencyDisposition {
  thetaScale:number;hazardScale:number;followupAmplitude:number;recallWeight:number;checkInWeight:number;softWindowFactor:number;
}
export interface ContactTendencySettings {
  subjectId:string;
  targetId:string;
  disposition:ContactTendencyDisposition;
  openness:number;
  receptivity:boolean;
  origin:'default'|'init'|'workspace';
  revision:number;
  updatedAtMs:number;
}
/** The direction of a window-end message: say she misses the user, care (how did you sleep), share a small thing, or one light line. */
export type WindowEndTone='longing'|'care'|'share'|'light';
/**
 * M3-5 item 10: follow up the topic he left open last night. The store already accepts a roll with this tone (always with its
 * topicBasis); it joins WindowEndTone in the same change that gives it a framing in CompanionFlow (slice 5f).
 */
export type WindowEndTopicTone='topic';
/** The source or recalled memory a `topic` window-end message follows up, appended to its basis. */
export interface WindowEndTopicBasis {kind:'source'|'memory';id:string;revision:number}
/**
 * What the window-end roll read of her drive at t_r (M3-5 item 2): D = s1 + s2 + s6 (+ s7 once her life has share seeds),
 * with the parts. s4 is never part of D.
 */
export interface WindowEndDriveReading {d:number;s1:number;s2:number;s6:number;s7?:number}
/**
 * The one seeded roll of a window-end occurrence (user decision 2026-09-28): whether she writes when the user's hard window
 * ends, with the probability `p` it was rolled against, the seeded uniform `u` (send iff u < p), the tone chosen from the
 * same seed, the quiet length and whether a drive episode was open. Recorded once; a retry or later poll never rolls again.
 * `instanceEndMs` is the end of the rolled window instance; `windowKey` (its `window_end:` opportunity key) is set by the
 * store when it records the roll. Both are absent on rolls recorded before they were kept.
 *
 * M3-5 fields, all optional and absent on rolls recorded before them (a reader treats a roll without `sendAtMs` as sent at
 * the instance end):
 * - item 1: `availableFromMs` (A, the first grid point from the instance end at which she is not off), `delayMs` (the seeded
 *   delay after A), `sendAtMs` (the grid point at or after A + delay the message waits for), `reason` (why a skip was not
 *   rolled against p, for example `her_unavailable`; only on a skip).
 * - item 2: `pBase` (the quiet-length table value), `g` (the drive factor), `drive` (D and its parts), `thetaX` (the
 *   threshold at t_r), `connection` (F_c at t_r: the proportional release of this message reads it).
 * - item 10: `y` (the S1 reading that weights the tones), `topicBasis` (present exactly when the tone is `topic`).
 */
export interface WindowEndRoll {
  kind:'window_end_roll';decision:'send'|'skip';p:number;u:number;tone:WindowEndTone;quietMs:number;driveOpen:boolean;decidedAtMs:number;
  instanceEndMs?:number;windowKey?:string;
  availableFromMs?:number;delayMs?:number;sendAtMs?:number;reason?:string;
  pBase?:number;g?:number;drive?:WindowEndDriveReading;thetaX?:number;connection?:number;
  y?:number;topicBasis?:WindowEndTopicBasis;
}
/**
 * One recorded window-end roll as companionStatus shows it, so a skipped window end is visible to a host or the user.
 * `sendAtMs` and `reason` appear only on rolls that recorded them.
 */
export interface WindowEndRollView {
  windowKey:string|null;instanceEndMs:number|null;p:number;u:number;decision:'send'|'skip';recordedAtMs:number;
  sendAtMs?:number;reason?:string;
}

export type GuardKey='G1'|'G2'|'G3';
export interface GuardValues {G1:{windowMinutes:number;count:number};G2:{windowMinutes:number;count:number};G3:{perHour:number}}
export interface GuardSetting<K extends GuardKey=GuardKey> {enabled:boolean;value:GuardValues[K];revision:number;updatedAtMs:number}
export type GuardSettings={[K in GuardKey]:GuardSetting<K>};
export interface GuardEvent {subjectId:string;targetId:string;guard:GuardKey;eventKey:string;detail:Record<string,unknown>;createdAtMs:number}
export interface GuardBlock {guard:'G1'|'G2';untilMs:number|null}
export type CompanionDecision=
  |{decision:'approve';strategy:FrontendStrategy}
  |{decision:'defer';nextCheckAtMs:number;reason:string}
  |{decision:'dismiss';reason:string};

export interface CompanionDelivery {
  deliveryId:string;
  opportunityId:string;
  subjectId:string;
  targetId:string;
  body:string;
  status:DeliveryStatus;
  sourceVersion:number;
  profileRevision:number;
  activityRevision:number;
  controlsRevision:number;
  contactRevision:number;
  claimToken:string|null;
  claimUntilMs:number|null;
  host:string|null;
  hostMessageId:string|null;
  resultCode:string|null;
  createdAtMs:number;
  updatedAtMs:number;
  /**
   * Her connection frustration F_c at the grid point the text was queued from (outbox relief_connection, M3-5 item 9), which
   * the proportional release of a longing, window-end or relabelled check-in reads. Absent when none was recorded.
   */
  reliefConnection?:number;
}
export interface DeliveryClaim {delivery:CompanionDelivery;claimToken:string;claimUntilMs:number}
export interface ConfirmedContactDelivery {
  deliveryId:string;
  subjectId:string;
  targetId:string;
  body:string;
  hostMessageId:string;
  confirmedSentAtMs:number;
  /** False when confirmation happened after an unknown delivery outcome. */
  replyTimingKnown:boolean;
  quietException:boolean;
}
export interface CompanionActivity {
  subjectId:string;
  revision:number;
  semanticReadyRevision:number;
  lastUserActivityAtMs:number|null;
  busyUntilMs:number|null;
  unansweredCount:number;
  lastSentAtMs:number|null;
}
export interface CompanionStatus {
  subjectId:string;
  targetId:string;
  state:CompanionState;
  revision:number;
  opportunityId:string|null;
  reason:string|null;
  nextCheckAtMs:number|null;
  activity:CompanionActivity;
  deliveries:{deliveryId:string;status:DeliveryStatus;hostMessageId:string|null;resultCode:string|null;updatedAtMs:number}[];
}

export interface CompanionDecisionTask {
  schema:'xldb-companion-decision-task-v1';
  opportunityId:string;
  allowedDecisions:['approve','defer','dismiss'];
  messages:{role:'system'|'user';content:string}[];
}
export interface CompanionDecisionOutput {
  schema:'xldb-companion-decision-v1';
  decision:'approve'|'defer'|'dismiss';
  reason:string;
  nextCheckAtMs:number|null;
}
