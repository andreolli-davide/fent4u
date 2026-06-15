import type { Pos } from '../types/perception.js'
import type { ParcelBelief } from '../blackboard/beliefs.js'
import type { Params } from './params.js'
import { rate, vValue, M1, G1, W1, type DecayConsts, type ParcelWeight } from './utility.js'

export interface Route {
  pickups: ParcelBelief[] // ordered parcels to collect
  zone: Pos // chosen delivery tile (z*)
  delivered: ParcelBelief[] // carried ∪ pickups
  L: number // total tick length self -> q1 -> ... -> qn -> zone
}

type Dist = (a: Pos, b: Pos) => number

/** Tick length of self -> pickups in order -> zone. Infinity if any leg is unreachable. */
function routeLength(self: Pos, pickups: ParcelBelief[], zone: Pos, dist: Dist): number {
  let total = 0
  let at = self
  for (const p of pickups) {
    total += dist(at, p.pos)
    at = p.pos
  }
  total += dist(at, zone)
  return total
}

export function uRoute(r: Route, tnow: number, dc: DecayConsts, params: Params, weight: ParcelWeight = W1): number {
  // r.L was computed at build time; accuracy degrades if the agent has moved since.
  // The BDI loop rebuilds routes each tick so drift is bounded to one tick.
  return rate(vValue(r.delivered, r.zone, r.L, tnow, dc, M1, G1, weight), r.L, params.alpha)
}

function score(self: Pos, carried: ParcelBelief[], pickups: ParcelBelief[], zones: Pos[], tnow: number, dc: DecayConsts, params: Params, dist: Dist, weight: ParcelWeight): { route: Route; u: number } | null {
  const delivered = [...carried, ...pickups]
  let bestZ: Pos | null = null
  let bestU = -Infinity
  let bestL = Infinity
  for (const z of zones) {
    const L = routeLength(self, pickups, z, dist)
    if (!Number.isFinite(L)) continue
    const u = rate(vValue(delivered, z, L, tnow, dc, M1, G1, weight), L, params.alpha)
    if (u > bestU) { bestU = u; bestZ = z; bestL = L }
  }
  if (bestZ === null) return null
  return { route: { pickups, zone: bestZ, delivered, L: bestL }, u: bestU }
}

function bestInsert(self: Pos, carried: ParcelBelief[], pickups: ParcelBelief[], p: ParcelBelief, zones: Pos[], tnow: number, dc: DecayConsts, params: Params, dist: Dist, weight: ParcelWeight): { route: Route; u: number } | null {
  let best: { route: Route; u: number } | null = null
  for (let i = 0; i <= pickups.length; i++) {
    const trial = [...pickups.slice(0, i), p, ...pickups.slice(i)]
    const s = score(self, carried, trial, zones, tnow, dc, params, dist, weight)
    if (s !== null && (best === null || s.u > best.u)) best = s
  }
  return best
}

/**
 * §9.2 greedy multi-pickup route. Start from the carried set (length-0 deliver);
 * fold the pool parcel whose best insertion most raises U_route, while it raises it
 * (emergent horizon). `pool` should already be P_avail-filtered by the caller.
 * Returns null only when carrying nothing AND no pool parcel is reachable.
 */
export function buildRoute(carried: ParcelBelief[], pool: ParcelBelief[], self: Pos, zones: Pos[], tnow: number, dc: DecayConsts, params: Params, dist: Dist, weight: ParcelWeight = W1): Route | null {
  let current = carried.length > 0 ? score(self, carried, [], zones, tnow, dc, params, dist, weight) : null
  const remaining = [...pool]

  if (current === null && carried.length === 0) {
    let seed: { route: Route; u: number; idx: number } | null = null
    for (let idx = 0; idx < remaining.length; idx++) {
      const p = remaining[idx]!
      const s = score(self, carried, [p], zones, tnow, dc, params, dist, weight)
      if (s !== null && (seed === null || s.u > seed.u)) seed = { ...s, idx }
    }
    if (seed === null) return null
    current = { route: seed.route, u: seed.u }
    remaining.splice(seed.idx, 1)
  }
  if (current === null) return null

  for (;;) {
    let bestAdd: { route: Route; u: number; idx: number } | null = null
    for (let idx = 0; idx < remaining.length; idx++) {
      const p = remaining[idx]!
      const s = bestInsert(self, carried, current!.route.pickups, p, zones, tnow, dc, params, dist, weight)
      if (s !== null && (bestAdd === null || s.u > bestAdd.u)) bestAdd = { ...s, idx }
    }
    if (bestAdd === null || bestAdd.u <= current.u) break
    current = { route: bestAdd.route, u: bestAdd.u }
    remaining.splice(bestAdd.idx, 1)
  }
  return current.route
}

/**
 * §9.7 route derived from a committed claim set: order ALL of `claimed` by greedy
 * cheapest insertion and include every one (committed parcels are never dropped —
 * the auction already decided to take them). Null only when carrying nothing AND
 * no claim is reachable. Pass `claimed` pre-sorted by id for replica-determinism.
 */
export function routeFromClaims(carried: ParcelBelief[], claimed: ParcelBelief[], self: Pos, zones: Pos[], tnow: number, dc: DecayConsts, params: Params, dist: Dist, weight: ParcelWeight = W1): Route | null {
  if (carried.length === 0 && claimed.length === 0) return null
  let cur = score(self, carried, [], zones, tnow, dc, params, dist, weight)
  if (cur === null) return null // no reachable zone
  for (const p of claimed) {
    const ins = bestInsert(self, carried, cur.route.pickups, p, zones, tnow, dc, params, dist, weight)
    if (ins !== null) cur = ins // unreachable insertion: skip; parcel stays claimed but unrouted this tick
  }
  return cur.route
}
