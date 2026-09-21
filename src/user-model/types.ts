import type {SceneScope} from '../scene/types.ts';

export const profileCategories=['experience','current_context','schedule','habit','observation','preference','hypothesis'] as const;
export type ProfileCategory=(typeof profileCategories)[number];
export const profileAttributions=['real_user','roleplay','quoted_third_party','uncertain'] as const;
export type ProfileAttribution=(typeof profileAttributions)[number];
export const profileBases=['explicit','observed','inferred','planned'] as const;
export type ProfileBasis=(typeof profileBases)[number];
export type EvidencePolarity='support'|'counter';

export interface SubjectBinding {
  host:string;
  bindingId:string;
  subjectId:string;
  createdAtMs:number;
}

export interface ProfileControls {
  subjectId:string;
  revision:number;
  profileLearningEnabled:boolean;
  personalizationEnabled:boolean;
  proactiveCompanionEnabled:boolean;
  scheduledWakeEnabled:boolean;
  learningCategories:ProfileCategory[];
  readCategories:ProfileCategory[];
  strategyCategories:ProfileCategory[];
  proactiveCategories:ProfileCategory[];
  updatedAtMs:number;
}

export interface ProfileCandidate {
  key:string;
  category:ProfileCategory;
  attribution:ProfileAttribution;
  basis:ProfileBasis;
  claim:string;
  evidence:string;
  polarity:EvidencePolarity;
  occurredAtMs:number|null;
  validFromMs:number|null;
  validUntilMs:number|null;
  purposes:string[];
  characterIds:string[];
  sessionIds:string[];
  confidenceBasis:string[];
}

export interface ProfileProjectionSource {
  id:string;
  revision:number;
  status:'accepted'|'deleted'|'needs_review';
  text:string;
  acceptedAtMs:number;
  candidates?:ProfileCandidate[];
}

export interface ProfileEntry {
  id:string;
  subjectId:string;
  key:string;
  category:ProfileCategory;
  attribution:ProfileAttribution;
  basis:ProfileBasis;
  claim:string;
  occurredAtMs:number|null;
  validFromMs:number|null;
  validUntilMs:number|null;
  purposes:string[];
  characterIds:string[];
  sessionIds:string[];
  confidenceBasis:string[];
  supportCount:number;
  counterCount:number;
  corrected:boolean;
  status:'active'|'invalid'|'deleted';
  revision:number;
  updatedAtMs:number;
}

export interface ProfileProjectionResult {
  subjectId:string;
  profileRevision:number;
  changed:boolean;
  activeEntries:number;
  invalidatedStrategies:number;
}

export interface ProfileListOptions {
  purpose:'user'|'read'|'strategy'|'proactive';
  taskPurpose?:string;
  characterId?:string;
  sessionId?:string;
  nowMs?:number;
}

export interface ProfileExtractionTask {
  schema:'xldb-profile-extraction-task-v1';
  subjectId:string;
  scope:SceneScope;
  source:{id:string;revision:number;text:string;acceptedAtMs:number};
  allowedCategories:ProfileCategory[];
  messages:{role:'system'|'user';content:string}[];
}

export interface StrategyFact {entryId:string;text:string}
export interface CommunicationStrategy {
  schema:'xldb-communication-strategy-v1';
  purpose:string;
  supportMode:string;
  allowedTopics:string[];
  knownFacts:StrategyFact[];
  uncertainFacts:StrategyFact[];
  tone:string;
  length:'short'|'medium'|'long';
  questionBudget:number;
  avoidRepeating:string[];
  stopConditions:string[];
  sourceVersions:{profileRevision:number;controlsRevision:number;entryRevisions:Record<string,number>};
}

export interface StrategyTask {
  schema:'xldb-communication-strategy-task-v1';
  subjectId:string;
  /** Semantic profile-use purpose, such as reply or proactive. */
  purpose:string;
  /** Persistence partition; never used to decide which profile entries may be read. */
  storageKey:string;
  profileRevision:number;
  controlsRevision:number;
  allowedEntryIds:string[];
  allowedEntryRevisions:Record<string,number>;
  characterId?:string;
  sessionId?:string;
  messages:{role:'system'|'user';content:string}[];
}

export interface FrontendStrategy {
  strategyId:string;
  purpose:string;
  supportMode:string;
  allowedTopics:string[];
  knownFacts:StrategyFact[];
  uncertainFacts:StrategyFact[];
  tone:string;
  length:'short'|'medium'|'long';
  questionBudget:number;
  avoidRepeating:string[];
  stopConditions:string[];
  sourceVersions:CommunicationStrategy['sourceVersions'];
}
