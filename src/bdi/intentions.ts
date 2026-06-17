import type { Pos } from '../types/perception.js'
import type { Params } from './params.js'
import type { Route } from './route.js'
import type { Mission } from '../mission/kinds.js'
import { rate, tileKey } from './utility.js'
import { awayFromPartner } from '../coordination/dispersion.js'

export interface ExploreTarget {
  tile: Pos
  /** ticks since this spawner was last observed; tnow if never seen */
  staleness: number
}

export type Intention =
  | { kind: 'route'; route: Route }
  | { kind: 'explore'; target: ExploreTarget }
  | { kind: 'mission'; mission: Mission }
  | { kind: 'idle' }

export interface Candidate {
  intention: Intention
  u: number
}

/** Commitment identity (§5.6): same route head pickup (or zone for length-0), same explore tile, idle≡idle. */
export function matches(committed: Intention | null, cand: Intention): boolean {
  if (committed === null || committed.kind !== cand.kind) return false
  if (committed.kind === 'idle') return true
  if (committed.kind === 'route' && cand.kind === 'route') {
    const a = committed.route
    const b = cand.route
    const ah = a.pickups[0]?.id ?? `zone:${tileKey(a.zone)}`
    const bh = b.pickups[0]?.id ?? `zone:${tileKey(b.zone)}`
    return ah === bh
  }
  if (committed.kind === 'explore' && cand.kind === 'explore') {
    return tileKey(committed.target.tile) === tileKey(cand.target.tile)
  }
  if (committed.kind === 'mission' && cand.kind === 'mission') {
    return committed.mission.id === cand.mission.id
  }
  return false
}

/**
 * §9.9 four-candidate argmax with commitment hysteresis.
 *
 * CALLER CONTRACT: always include `{ intention: idle, u: params.eps_idle }` in
 * `cands`. `select` hard-codes a fallback `idle` intention for safety, but relies
 * on the caller to provide the `eps_idle` floor so utility comparisons are fair.
 */
export function select(cands: Candidate[], committed: Intention | null, hCommit: number): Candidate {
  let best: Candidate = { intention: { kind: 'idle' }, u: 0 }
  let bestScore = -Infinity
  for (const c of cands) {
    if (c.u <= 0) continue
    const score = c.u * (matches(committed, c.intention) ? 1 + hCommit : 1)
    if (score > bestScore) {
      bestScore = score
      best = c
    }
  }
  return best
}

/**
 * Stalest-frontier exploration target (§5.5 approximation). spawnValue is a uniform
 * a-priori weight of 1 per spawner tile this slice; staleness = tnow - lastSeen
 * (tnow if never seen). Returns the argmax of theta_explore*[spawnValue + kappa*staleness]/(d+1)^alpha.
 * §9.5: with dispersion enabled, adds θ_disp * awayFromPartner term to break ties toward farther spawners.
 */
export function chooseExplore(
  spawners: Pos[],
  seenAt: Map<string, number>,
  self: Pos,
  tnow: number,
  dist: (a: Pos, b: Pos) => number,
  params: Params,
  partnerTarget: Pos | null = null,
  dRef: number = 1
): Candidate | null {
  let best: { target: ExploreTarget; u: number } | null = null
  for (const s of spawners) {
    const dd = dist(self, s)
    if (!Number.isFinite(dd)) continue
    const lastSeen = seenAt.get(tileKey(s))
    // §5.5: staleness is CAPPED. Uncapped, a long-unexplored region's info bonus grows
    // without bound and makes explore out-rank a real collectible route (observed on hard
    // maps where delivery cycles are long and route rate is low — agents wander and never
    // collect: 26c1_7 scored 0 with explore U≈0.7 vs route U≈0.19). The cap keeps the
    // staleness term a bounded DIRECTION signal ("go where info is old"), below real
    // opportunities as §5.5 intends. Beyond the cap all old regions look equally stale, so
    // the distance term picks the nearest (efficient nearest-frontier patrol).
    const staleness = Math.min(params.explore_stale_cap, lastSeen === undefined ? tnow : tnow - lastSeen)
    // Skip spawners currently in sensor view (markSeen reset them THIS tick ⇒
    // staleness 0). There is no frontier to gain by "exploring" a tile we can already
    // see, and the at-distance-0 spawner otherwise wins the argmax and freezes the
    // agent camping on it (it re-arrives every tick, never patrols — observed on
    // long-hallway maps: one agent visited 4 tiles in 45s and scored 0). Parcels that
    // appear on a visible spawner are still collected via the ROUTE candidate, not
    // explore; explore now seeks genuinely UNSEEN regions so the agent patrols. A
    // never-seen spawner has staleness = tnow (large), so it is always kept.
    if (staleness <= 0) continue
    const value = params.theta_explore * (1 + params.kappa_info * staleness)
    const u = rate(value, dd, params.alpha) + params.theta_disp * awayFromPartner(s, partnerTarget, dRef, dist)
    if (best === null || u > best.u) best = { target: { tile: s, staleness }, u }
  }
  return best === null ? null : { intention: { kind: 'explore', target: best.target }, u: best.u }
}
