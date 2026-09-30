export interface UserActivityEvent {
  id: string;
  revision: number;
  role: string;
  status: string;
  acceptedAtMs: number;
  kind?: 'message' | 'summary';
}

export interface UserActivitySummary {
  schema: 'xldb-user-activity-v1';
  timeZone: string;
  window: {fromMs: number; toMs: number; windowDays: number};
  sampleSize: number;
  weekdays: {sampleSize: number; hourCounts: number[]};
  weekends: {sampleSize: number; hourCounts: number[]};
  localDates: string[];
  sources: {id: string; revision: number}[];
}

export interface UserActivityOptions {
  timeZone: string;
  nowMs?: number;
  windowDays?: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_EVENTS = 100_000;
const MIN_DATE_MS = -8_640_000_000_000_000;
const MAX_DATE_MS = 8_640_000_000_000_000;

type NormalizedEvent = Required<UserActivityEvent>;

/**
 * Summarize accepted real-user message timestamps without interpreting them as
 * a schedule, preference, psychological trait, or permission to contact.
 */
export function summarizeUserActivity(
  events: readonly UserActivityEvent[],
  options: UserActivityOptions,
): UserActivitySummary {
  if (!Array.isArray(events)) throw new TypeError('events must be an array');
  if (events.length > MAX_EVENTS) throw new RangeError(`events must contain at most ${MAX_EVENTS} items`);
  if (!options || typeof options !== 'object') throw new TypeError('options are required');
  if (typeof options.timeZone !== 'string' || options.timeZone.length === 0) {
    throw new TypeError('timeZone must be a non-empty IANA time zone');
  }

  const nowMs = options.nowMs ?? Date.now();
  if (!Number.isSafeInteger(nowMs) || nowMs < MIN_DATE_MS || nowMs > MAX_DATE_MS) {
    throw new RangeError('nowMs must be an integer within the JavaScript date range');
  }
  const windowDays = options.windowDays ?? 30;
  if (!Number.isInteger(windowDays) || windowDays < 1 || windowDays > 366) {
    throw new RangeError('windowDays must be an integer from 1 to 366');
  }
  const fromMs = nowMs - windowDays * DAY_MS;
  if (fromMs < MIN_DATE_MS) throw new RangeError('activity window falls outside the JavaScript date range');

  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat('en-US-u-ca-gregory-nu-latn', {
      timeZone: options.timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      weekday: 'short',
      hour: '2-digit',
      hourCycle: 'h23',
    });
  } catch {
    throw new RangeError(`invalid IANA time zone: ${options.timeZone}`);
  }

  const latestById = new Map<string, NormalizedEvent[]>();
  for (const rawEvent of events) {
    const event = normalizeEvent(rawEvent);
    const revisions = latestById.get(event.id);
    if (!revisions || event.revision > revisions[0].revision) {
      latestById.set(event.id, [event]);
    } else if (event.revision === revisions[0].revision) {
      revisions.push(event);
    }
  }

  const weekdayHours = Array<number>(24).fill(0);
  const weekendHours = Array<number>(24).fill(0);
  const dates = new Set<string>();
  const sources: {id: string; revision: number}[] = [];
  let weekdaySampleSize = 0;
  let weekendSampleSize = 0;

  for (const [id, latest] of latestById) {
    if (!hasOneUnambiguousRevision(latest)) continue;
    const event = latest[0];

    // Resolve revisions before this filter so a deletion or summary revision
    // cannot expose an older accepted message again.
    if (event.role !== 'user' || event.status !== 'accepted' || event.kind !== 'message') continue;
    if (event.acceptedAtMs < fromMs || event.acceptedAtMs > nowMs) continue;

    const parts = formatter.formatToParts(new Date(event.acceptedAtMs));
    const value = (type: Intl.DateTimeFormatPartTypes): string => {
      const part = parts.find(candidate => candidate.type === type);
      if (!part) throw new Error(`time-zone formatter omitted ${type}`);
      return part.value;
    };
    const date = `${value('year')}-${value('month')}-${value('day')}`;
    const weekday = value('weekday');
    const hour = Number(value('hour'));
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) throw new Error('invalid local hour from time-zone formatter');

    dates.add(date);
    if (weekday === 'Sat' || weekday === 'Sun') {
      weekendHours[hour]++;
      weekendSampleSize++;
    } else {
      weekdayHours[hour]++;
      weekdaySampleSize++;
    }
    sources.push({id, revision: event.revision});
  }

  sources.sort((a, b) => a.id.localeCompare(b.id) || a.revision - b.revision);
  return {
    schema: 'xldb-user-activity-v1',
    timeZone: options.timeZone,
    window: {fromMs, toMs: nowMs, windowDays},
    sampleSize: weekdaySampleSize + weekendSampleSize,
    weekdays: {sampleSize: weekdaySampleSize, hourCounts: weekdayHours},
    weekends: {sampleSize: weekendSampleSize, hourCounts: weekendHours},
    localDates: [...dates].sort(),
    sources,
  };
}

function normalizeEvent(event: UserActivityEvent): NormalizedEvent {
  if (!event || typeof event !== 'object') throw new TypeError('each event must be an object');
  if (typeof event.id !== 'string' || event.id.length === 0 || event.id.length > 512) {
    throw new TypeError('event id must be a non-empty string of at most 512 characters');
  }
  if (!Number.isSafeInteger(event.revision) || event.revision < 0) {
    throw new TypeError('event revision must be a non-negative safe integer');
  }
  if (typeof event.role !== 'string' || typeof event.status !== 'string') {
    throw new TypeError('event role and status must be strings');
  }
  if (!Number.isSafeInteger(event.acceptedAtMs) || event.acceptedAtMs < MIN_DATE_MS || event.acceptedAtMs > MAX_DATE_MS) {
    throw new TypeError('event acceptedAtMs must be an integer within the JavaScript date range');
  }
  const kind = event.kind ?? 'message';
  if (kind !== 'message' && kind !== 'summary') throw new TypeError('event kind must be message or summary');
  return {
    id: event.id,
    revision: event.revision,
    role: event.role,
    status: event.status,
    acceptedAtMs: event.acceptedAtMs,
    kind,
  };
}

function hasOneUnambiguousRevision(revisions: NormalizedEvent[]): boolean {
  const first = revisions[0];
  return revisions.every(event => event.role === first.role
    && event.status === first.status
    && event.acceptedAtMs === first.acceptedAtMs
    && event.kind === first.kind);
}

export interface UserReceptivity {
  /** Multiplicative only, within [0.5, 1.5]; 1 without a summary or when disabled. */
  factor: number;
  samples: number;
}

const RECEPTIVITY_MIN_CLASS_SAMPLES = 10;
/** Weight k of the generic day curve, in pseudo-samples per hour: it fades as the user's own samples grow. */
export const RECEPTIVITY_PRIOR_WEIGHT = 2;
const RECEPTIVITY_PRIOR_RAW: readonly number[] = [
  0.4, 0.4, 0.4, 0.4, 0.4, 0.4, 0.6, 0.9, 0.9, 1.0, 1.0, 1.0,
  1.15, 1.15, 1.0, 1.0, 1.0, 1.0, 1.3, 1.3, 1.3, 1.3, 1.15, 0.8,
];
const RECEPTIVITY_PRIOR_MEAN = RECEPTIVITY_PRIOR_RAW.reduce((sum, value) => sum + value, 0) / 24;
/** The generic day curve p_h by local hour, normalised to mean 1 (until the U6 onboarding declaration replaces it). */
export const RECEPTIVITY_PRIOR: readonly number[] = Object.freeze(RECEPTIVITY_PRIOR_RAW.map(value => value / RECEPTIVITY_PRIOR_MEAN));
const receptivityFormatters = new Map<string, Intl.DateTimeFormat>();

/**
 * The user's own rhythm as a multiplicative factor at `atMs`, never a ban: the same class of day (weekday or weekend;
 * both merged when that class has fewer than 10 samples), hour counts smoothed 1:2:1 over +-1 hour,
 * r = (s_h + 0.5 + k*p_h) / (N/24 + 0.5 + k) with the generic day curve p and k = 2 (so a new user starts from the
 * generic curve, and the user's own counts take over as they grow), rho = clamp(0.5 + 0.5r, 0.5, 1.5).
 */
export function receptivityAt(
  summary: UserActivitySummary | null,
  atMs: number,
  options: {enabled?: boolean} = {},
): UserReceptivity {
  const samples = summary?.sampleSize ?? 0;
  if (!summary || options.enabled === false) return {factor: 1, samples};
  if (!Number.isFinite(atMs)) throw new RangeError('atMs must be finite');
  let formatter = receptivityFormatters.get(summary.timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US-u-ca-gregory-nu-latn', {
      timeZone: summary.timeZone, weekday: 'short', hour: '2-digit', hourCycle: 'h23',
    });
    receptivityFormatters.set(summary.timeZone, formatter);
  }
  const parts = formatter.formatToParts(new Date(atMs));
  const weekday = parts.find(part => part.type === 'weekday')?.value;
  const hour = Number(parts.find(part => part.type === 'hour')?.value);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) throw new Error('invalid local hour from time-zone formatter');
  const weekend = weekday === 'Sat' || weekday === 'Sun';
  const own = weekend ? summary.weekends : summary.weekdays;
  const counts = own.sampleSize >= RECEPTIVITY_MIN_CLASS_SAMPLES ? own.hourCounts
    : summary.weekdays.hourCounts.map((count, index) => count + summary.weekends.hourCounts[index]!);
  const total = counts.reduce((sum, count) => sum + count, 0);
  const smoothed = (counts[(hour + 23) % 24]! + 2 * counts[hour]! + counts[(hour + 1) % 24]!) / 4;
  const ratio = (smoothed + 0.5 + RECEPTIVITY_PRIOR_WEIGHT * RECEPTIVITY_PRIOR[hour]!)
    / (total / 24 + 0.5 + RECEPTIVITY_PRIOR_WEIGHT);
  return {factor: Math.min(1.5, Math.max(0.5, 0.5 + 0.5 * ratio)), samples};
}

export interface UserActivityGaps {
  /** Quantiles of the user's own gaps between conversations, in ms. */
  g50: number;
  g75: number;
  g90: number;
  /** Gaps measured; below 20 the fixed fallback applies. */
  samples: number;
  fallback: boolean;
}

/** Messages closer than this belong to one conversation (= DEFAULT_CONVERSATION_WINDOW_MS). */
const CONVERSATION_GAP_MS = 10 * 60 * 1000;
const GAP_MIN_SAMPLES = 20;
const HOUR_MS = 60 * 60 * 1000;

/**
 * The user's own adjacent-activity gaps (between conversations, over the same accepted real-user messages and window as
 * summarizeUserActivity), as linear-interpolated quantiles g50/g75/g90. Fewer than 20 gaps: 12h / 24h / 36h.
 */
export function activityGaps(events: readonly UserActivityEvent[], options: UserActivityOptions): UserActivityGaps {
  const times = acceptedUserMessageTimes(events, options);
  const gaps: number[] = [];
  for (let index = 1; index < times.length; index++) {
    const gap = times[index]! - times[index - 1]!;
    if (gap > CONVERSATION_GAP_MS) gaps.push(gap);
  }
  if (gaps.length < GAP_MIN_SAMPLES) return {g50: 12 * HOUR_MS, g75: 24 * HOUR_MS, g90: 36 * HOUR_MS, samples: gaps.length, fallback: true};
  gaps.sort((a, b) => a - b);
  const quantile = (q: number) => {
    const position = (gaps.length - 1) * q, low = Math.floor(position), high = Math.ceil(position);
    return gaps[low]! + (gaps[high]! - gaps[low]!) * (position - low);
  };
  return {g50: quantile(0.5), g75: quantile(0.75), g90: quantile(0.9), samples: gaps.length, fallback: false};
}

/** Current accepted real-user message times inside the window, ascending; revisions resolve as in the summary. */
function acceptedUserMessageTimes(events: readonly UserActivityEvent[], options: UserActivityOptions): number[] {
  const summary = summarizeUserActivity(events, options);
  const included = new Set(summary.sources.map(source => `${source.revision}:${source.id}`));
  const times = new Set<string>();
  const result: number[] = [];
  for (const event of events) {
    const key = `${event.revision}:${event.id}`;
    if (!included.has(key) || times.has(key)) continue;
    times.add(key);
    result.push(event.acceptedAtMs);
  }
  return result.sort((a, b) => a - b);
}
