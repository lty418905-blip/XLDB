import type { SceneAuthority } from './store.ts';
import type { SceneScope } from './types.ts';
import type { WorldProjection } from './world-state.ts';

/** Player-facing display material, never an admin inspect response. */
export function sceneDashboard(authority:SceneAuthority,scope:SceneScope,now=Date.now()) {
  const state=authority.state(scope);
  const world=authority.world(scope,'player',now,state) as WorldProjection|null;
  const settings=authority.worldSettings(scope);
  const map=authority.geography.project(scope,'player');
  return {
    version:state.version,scope,mode:authority.interactions.modeOf(scope),
    playerName:settings?.playerName||'玩家',clock:authority.interactions.clock(scope,now),
    configured:Boolean(world)||map.configured,
    balances:(world?.balances??[]).filter(row=>row.ownerId==='player'),
    inventory:(world?.inventory??[]).filter(row=>row.ownerId==='player'),
    transactions:(world?.receipts??[]).filter(row=>row.ownerId==='player'&&['purchase','refund','consume'].includes(row.kind)).slice(-30).reverse(),
    physiology:authority.physiology.status(scope,{readerId:'player',nowMs:now}),
    map,
  };
}
