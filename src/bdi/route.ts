import type { Pos } from '../types/perception.js'
import type { ParcelBelief } from '../blackboard/beliefs.js'
import type { Params } from './params.js'
import { rate, vValue, bestZone, M1, G1, W1, F1, type DecayConsts, type ParcelWeight, type CountShaper, type ZoneShaper, type BundleFilter, type Dist } from './utility.js'

export interface Route {
  pickups: ParcelBelief[] // ordered parcels to collect
  zone: Pos // chosen delivery tile (z*)
  delivered: ParcelBelief[] // carried ∪ pickups
  L: number // total tick length self -> q1 -> ... -> qn -> zone
  toll: number // Σ toll over self→pickups→zone; 0 when no priced constraint (§7.1)
}

/** Tick length + toll-sum of self -> pickups in order -> zone. L is Infinity if any leg is unreachable. */
function routeAccum(self: Pos, pickups: ParcelBelief[], zone: Pos, dist: Dist): { L: number; toll: number } {
  let L = 0, toll = 0, at = self
  for (const p of pickups) { const d = dist(at, p.pos); L += d.L; toll += d.toll; at = p.pos }
  const d = dist(at, zone); L += d.L; toll += d.toll
  return { L, toll }
}

export function uRoute(r: Route, tnow: number, dc: DecayConsts, params: Params, weight: ParcelWeight = W1, m: CountShaper = M1, g: ZoneShaper = G1, filter: BundleFilter = F1): number {
  // r.L was computed at build time; accuracy degrades if the agent has moved since.
  // The BDI loop rebuilds routes each tick so drift is bounded to one tick.
  return rate(vValue(r.delivered, r.zone, r.L, tnow, dc, m, g, weight, filter) - r.toll, r.L, params.alpha) // §7.1: net the path toll from realised value
}

function score(self: Pos, carried: ParcelBelief[], pickups: ParcelBelief[], zones: Pos[], tnow: number, dc: DecayConsts, params: Params, dist: Dist, weight: ParcelWeight, m: CountShaper, g: ZoneShaper, filter: BundleFilter = F1): { route: Route; u: number } | null {
  const delivered = [...carried, ...pickups]
  // §9.2: z_route is chosen by the §6.0 tail-leg rate measured from the LAST pickup qₙ
  // (or self when carrying-only) — not by the whole-route rate from self. Zone choice is
  // invariant to `weight` (same delivered set across zones), so bestZone's W1 default is safe.
  const tail = pickups.length > 0 ? pickups[pickups.length - 1]!.pos : self
  const pre = routeAccum(self, pickups, tail, dist) // self → q1 → … → qₙ (trailing qₙ→qₙ leg = 0)
  if (!Number.isFinite(pre.L)) return null
  const zp = bestZone(delivered, tail, zones, tnow, dc, dist, params.alpha, m, g, filter)
  if (zp === null) return null
  // U_route still uses the honest whole-route length (§9.2 eq. for U_route): prefix + tail leg.
  const L = pre.L + zp.L
  const toll = pre.toll + zp.toll
  const u = rate(vValue(delivered, zp.zone, L, tnow, dc, m, g, weight, filter) - toll, L, params.alpha) // §7.1: net the path toll from realised value
  return { route: { pickups, zone: zp.zone, delivered, L, toll }, u }
}

function bestInsert(self: Pos, carried: ParcelBelief[], pickups: ParcelBelief[], p: ParcelBelief, zones: Pos[], tnow: number, dc: DecayConsts, params: Params, dist: Dist, weight: ParcelWeight, m: CountShaper, g: ZoneShaper, filter: BundleFilter = F1): { route: Route; u: number } | null {
  let best: { route: Route; u: number } | null = null
  for (let i = 0; i <= pickups.length; i++) {
    const trial = [...pickups.slice(0, i), p, ...pickups.slice(i)]
    const s = score(self, carried, trial, zones, tnow, dc, params, dist, weight, m, g, filter)
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
export function buildRoute(carried: ParcelBelief[], pool: ParcelBelief[], self: Pos, zones: Pos[], tnow: number, dc: DecayConsts, params: Params, dist: Dist, weight: ParcelWeight = W1, m: CountShaper = M1, g: ZoneShaper = G1, filter: BundleFilter = F1): Route | null {
  let current = carried.length > 0 ? score(self, carried, [], zones, tnow, dc, params, dist, weight, m, g, filter) : null
  const remaining = [...pool]

  if (current === null && carried.length === 0) {
    let seed: { route: Route; u: number; idx: number } | null = null
    for (let idx = 0; idx < remaining.length; idx++) {
      const p = remaining[idx]!
      const s = score(self, carried, [p], zones, tnow, dc, params, dist, weight, m, g, filter)
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
      const s = bestInsert(self, carried, current!.route.pickups, p, zones, tnow, dc, params, dist, weight, m, g, filter)
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
export function routeFromClaims(carried: ParcelBelief[], claimed: ParcelBelief[], self: Pos, zones: Pos[], tnow: number, dc: DecayConsts, params: Params, dist: Dist, weight: ParcelWeight = W1, m: CountShaper = M1, g: ZoneShaper = G1, filter: BundleFilter = F1): Route | null {
  if (carried.length === 0 && claimed.length === 0) return null
  let cur = score(self, carried, [], zones, tnow, dc, params, dist, weight, m, g, filter)
  if (cur === null) return null // no reachable zone
  for (const p of claimed) {
    const ins = bestInsert(self, carried, cur.route.pickups, p, zones, tnow, dc, params, dist, weight, m, g, filter)
    if (ins !== null) cur = ins // unreachable insertion: skip; parcel stays claimed but unrouted this tick
  }
  return cur.route
}
