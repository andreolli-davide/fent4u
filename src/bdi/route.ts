import type { Pos } from '../types/perception.js'
import type { ParcelBelief } from '../blackboard/beliefs.js'
import type { Params } from './params.js'
import { rate, vValue, bestZone, M1, G1, W1, type DecayConsts, type ParcelWeight } from './utility.js'

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
  // §9.2: z_route is chosen by the §6.0 tail-leg rate measured from the LAST pickup qₙ
  // (or self when carrying-only) — not by the whole-route rate from self. Zone choice is
  // invariant to `weight` (same delivered set across zones), so bestZone's W1 default is safe.
  const tail = pickups.length > 0 ? pickups[pickups.length - 1]!.pos : self
  const lPre = routeLength(self, pickups, tail, dist) // self → q1 → … → qₙ (trailing qₙ→qₙ leg = 0)
  if (!Number.isFinite(lPre)) return null
  const zp = bestZone(delivered, tail, zones, tnow, dc, dist, params.alpha)
  if (zp === null) return null
  // U_route still uses the honest whole-route length (§9.2 eq. for U_route): prefix + tail leg.
  const L = lPre + zp.L
  const u = rate(vValue(delivered, zp.zone, L, tnow, dc, M1, G1, weight), L, params.alpha)
  return { route: { pickups, zone: zp.zone, delivered, L }, u }
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
 * §9.2/§9.7 route derived from a committed claim set. Like `buildRoute`, it folds in
 * the claim whose cheapest insertion most raises `U_route`, *while it raises it*
 * (the emergent horizon). A claim that would LOWER the rate — e.g. a far, low-value
 * parcel against an already-valuable carried load — is NOT routed this cycle: it
 * stays OWNED (still claimed) and is serviced after the current load is delivered.
 *
 * This cutoff is what makes the agent cycle collect→deliver instead of hoarding.
 * Without it (the previous "include every claim" rule) the route always kept a
 * pickup ahead of the single delivery, the auction backfilled claims as the agent
 * made progress, and the agent never reached the deliver phase — collecting forever
 * and scoring nothing. Deferring a claim is NOT dropping it (the claim is unchanged
 * in the store, §9.7); CLAIM_TTL still recycles a claim that sees no progress.
 *
 * Deterministic (best-improvement each round; strict `>` ⇒ id-order tie-break on the
 * caller-sorted `claimed`), so both replicas derive the identical route. Null only
 * when carrying nothing AND no claim is reachable.
 */
export function routeFromClaims(carried: ParcelBelief[], claimed: ParcelBelief[], self: Pos, zones: Pos[], tnow: number, dc: DecayConsts, params: Params, dist: Dist, weight: ParcelWeight = W1): Route | null {
  if (carried.length === 0 && claimed.length === 0) return null
  let cur = score(self, carried, [], zones, tnow, dc, params, dist, weight)
  if (cur === null) return null // no reachable zone
  const remaining = [...claimed]
  for (;;) {
    let bestAdd: { route: Route; u: number; idx: number } | null = null
    for (let idx = 0; idx < remaining.length; idx++) {
      const s = bestInsert(self, carried, cur.route.pickups, remaining[idx]!, zones, tnow, dc, params, dist, weight)
      if (s !== null && (bestAdd === null || s.u > bestAdd.u)) bestAdd = { ...s, idx }
    }
    if (bestAdd === null || bestAdd.u <= cur.u) break // emergent horizon: delivering the load beats collecting more
    cur = { route: bestAdd.route, u: bestAdd.u }
    remaining.splice(bestAdd.idx, 1)
  }
  return cur.route
}
