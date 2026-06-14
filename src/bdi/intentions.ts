import type { Pos } from '../types/perception.js'
import type { Params } from './params.js'
import type { Route } from './route.js'
import { rate, tileKey } from './utility.js'

export interface ExploreTarget {
  tile: Pos
  /** ticks since this spawner was last observed; tnow if never seen */
  staleness: number
}

export type Intention =
  | { kind: 'route'; route: Route }
  | { kind: 'explore'; target: ExploreTarget }
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
  return false
}

/**
 * §9.9 four-candidate argmax (three this slice) with commitment hysteresis.
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
 */
export function chooseExplore(spawners: Pos[], seenAt: Map<string, number>, self: Pos, tnow: number, dist: (a: Pos, b: Pos) => number, params: Params): Candidate | null {
  let best: { target: ExploreTarget; u: number } | null = null
  for (const s of spawners) {
    const dd = dist(self, s)
    if (!Number.isFinite(dd)) continue
    const lastSeen = seenAt.get(tileKey(s))
    const staleness = lastSeen === undefined ? tnow : tnow - lastSeen
    const value = params.theta_explore * (1 + params.kappa_info * staleness)
    const u = rate(value, dd, params.alpha)
    if (best === null || u > best.u) best = { target: { tile: s, staleness }, u }
  }
  return best === null ? null : { intention: { kind: 'explore', target: best.target }, u: best.u }
}
