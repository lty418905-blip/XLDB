import type { StableRelations } from './openher.ts';

/** A current, accepted directional relationship anchor; transient affect is deliberately absent. */
export interface AddressRelationAnchor {
  sourceId: string;
  revision: number;
  status: 'accepted';
  direction: 'speaker-to-addressee';
  relations: Pick<StableRelations, 'depth' | 'trust' | 'valence'>;
}

export type AddressPreference =
  | { status: 'accepted'; scope: 'all' | 'private' | 'public'; kind: 'use'; address: string }
  | { status: 'accepted'; scope: 'all' | 'private' | 'public'; kind: 'reject-intimate' }
  | { status: 'revoked'; scope: 'all' | 'private' | 'public'; kind: 'use' | 'reject-intimate'; address?: string };

export interface AddressSituation {
  visibility: 'private' | 'public';
  /** Includes the speaker and addressee. Two means a private pair. */
  presentCount: number;
  formality: 'casual' | 'formal';
  /** The current speaker may only use a personal name it is entitled to know. */
  addresseeIdentityKnown: boolean;
}

export interface AddressSuggestion {
  mode: 'explicit' | 'personal-name-allowed' | 'conservative';
  /** Present only when the user explicitly supplied this exact address. */
  address?: string;
  reason: 'explicit_preference' | 'intimacy_rejected' | 'grounded_long_term_relation' | 'public_or_formal' | 'missing_relation_anchor' | 'identity_not_known';
  instruction: string;
}

const MAX_ADDRESS_LENGTH = 120;

/**
 * Produces a narrow presentation hint. It never invents a nickname, changes
 * state, or reads short-term emotion. Callers provide the already-filtered
 * directional anchor and only the preferences visible in this scene.
 */
export function suggestAddress(
  situation: AddressSituation,
  anchor: AddressRelationAnchor | undefined,
  preferences: readonly AddressPreference[] = [],
): AddressSuggestion {
  validateSituation(situation);
  const applicable = preferences.filter(preference => preference.status === 'accepted' &&
    (preference.scope === 'all' || preference.scope === situation.visibility));
  if (applicable.some(preference => preference.kind === 'reject-intimate')) return conservative('intimacy_rejected');
  const explicit = applicable.find((preference): preference is Extract<AddressPreference,{kind:'use';status:'accepted'}> =>
    preference.kind === 'use' && typeof preference.address === 'string' && validAddress(preference.address));
  if (explicit) return {
    mode: 'explicit', address: explicit.address, reason: 'explicit_preference',
    instruction: '只使用用户明确指定的称谓；不扩写、变形或另造昵称。',
  };
  if (!situation.addresseeIdentityKnown) return conservative('identity_not_known');
  if (situation.visibility === 'public' || situation.presentCount > 2 || situation.formality === 'formal') {
    return conservative('public_or_formal');
  }
  if (!anchor || !validAnchor(anchor)) return conservative('missing_relation_anchor');
  if (isGroundedPositiveRelation(anchor.relations)) return {
    mode: 'personal-name-allowed', reason: 'grounded_long_term_relation',
    instruction: '可自然使用对方已知姓名，但不必强行称呼；不得自行创造昵称、亲属称谓或亲密身份。',
  };
  return conservative('missing_relation_anchor');
}

function conservative(reason:AddressSuggestion['reason']):AddressSuggestion {
  return {mode:'conservative',reason,instruction:'使用已知全名、明确身份称谓，或不使用称谓；不得擅自使用亲昵称呼。'};
}

function isGroundedPositiveRelation(relations:Pick<StableRelations,'depth'|'trust'|'valence'>):boolean {
  return relations.depth >= 0.65 && relations.trust >= 0.7 && relations.valence >= 0.35;
}

function validAnchor(anchor:AddressRelationAnchor):boolean {
  return !!anchor.sourceId && anchor.sourceId.length <= 500 && Number.isSafeInteger(anchor.revision) && anchor.revision > 0 &&
    anchor.status === 'accepted' && anchor.direction === 'speaker-to-addressee' &&
    [anchor.relations.depth,anchor.relations.trust].every(value => Number.isFinite(value) && value >= 0 && value <= 1) &&
    Number.isFinite(anchor.relations.valence) && anchor.relations.valence >= -1 && anchor.relations.valence <= 1;
}

function validAddress(value:string):boolean { return !!value.trim() && value.length <= MAX_ADDRESS_LENGTH; }

function validateSituation(value:AddressSituation):void {
  if (!value || !['private','public'].includes(value.visibility) || !['casual','formal'].includes(value.formality) ||
    !Number.isSafeInteger(value.presentCount) || value.presentCount < 2 || typeof value.addresseeIdentityKnown !== 'boolean') {
    throw new Error('invalid_address_situation');
  }
}
