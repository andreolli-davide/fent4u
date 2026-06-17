// src/bdi/utility.ts
// Utility functions for parcel value assessment (§5.2/5.3).
// Implements deterministic reward decay, survival probability, and availability assessment
// under decay and race conditions.
import type { Pos } from '../types/perception.js'
import type { GameConsts } from '../types/perception.js'
import { posKey } from '../types/perception.js'
import type { ParcelBelief } from '../blackboard/beliefs.js'

export interface DecayConsts {
  rho: number
  lambda: number
  lambdaAgent: number
  decayIntervalTicks: number
}

/** Derive the §5.2/5.3 decay constants from server config. Infinite decay => rho=lambda=0. */
export function decayConsts(c: GameConsts): DecayConsts {
  const decayIntervalTicks = c.PARCEL_DECAY_TICKS
  const ticksPerMove = c.MOVEMENT_DURATION / c.CLOCK
  const rho = decayIntervalTicks === Infinity ? 0 : ticksPerMove / decayIntervalTicks
  const lambda = decayIntervalTicks === Infinity ? 0 : Math.LN2 / (3 * decayIntervalTicks)
  return { rho, lambda, lambdaAgent: Math.LN2 / 3, decayIntervalTicks }
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

/** §5.2 deterministic reward decay, floored at 0. */
export function rnow(p: ParcelBelief, tnow: number, dc: DecayConsts): number {
  return Math.max(0, p.rewardSeen - dc.rho * (tnow - p.lastSeen))
}

/** §5.3 survival probability: exists despite staleness + the travel still to come. */
export function psurv(p: ParcelBelief, tnow: number, dSelfP: number, dc: DecayConsts): number {
  return Math.exp(-dc.lambda * (tnow - p.lastSeen + dSelfP))
}

/** A single enemy's grab probability (§5.3), weighted by sighting freshness. */
export function grab(enemyAge: number, dSelf: number, dEnemy: number, betaComp: number, lambdaAgent: number): number {
  const fresh = Math.exp(-lambdaAgent * enemyAge)
  const raceFrac = clamp((dSelf - dEnemy) / (dSelf + 1), 0, 1)
  return betaComp * fresh * raceFrac
}

export interface EnemyThreat {
  age: number // tnow - enemy.lastSeen
  dToP: number // d(enemy, parcel)
}

/** §5.3 product over enemies (partner excluded by the caller). */
export function raceDiscount(dSelfP: number, enemies: EnemyThreat[], lambdaAgent: number, betaComp: number): number {
  let prod = 1
  for (const e of enemies) prod *= 1 - grab(e.age, dSelfP, e.dToP, betaComp, lambdaAgent)
  return prod
}

/** §5.3 P_avail = exists AND we win the race; 0 for any carried parcel. */
export function pAvail(p: ParcelBelief, dSelfP: number, enemies: EnemyThreat[], betaComp: number, tnow: number, dc: DecayConsts): number {
  if (p.carriedBy !== null) return 0
  return psurv(p, tnow, dSelfP, dc) * raceDiscount(dSelfP, enemies, dc.lambdaAgent, betaComp)
}

/** Backward compatibility alias for posKey; canonical version lives in src/types/perception.ts. */
export const tileKey = posKey

export type CountShaper = (k: number) => number
export type ZoneShaper = (z: Pos) => number
export const M1: CountShaper = () => 1
export const G1: ZoneShaper = () => 1

/** Rate denominator (§5.5): value / (L+1)^alpha. */
export function rate(value: number, L: number, alpha: number): number {
  return value / Math.pow(L + 1, alpha)
}

/** Per-parcel value weight (§5.5). Default: every parcel certain (in-hand). */
export type ParcelWeight = (p: ParcelBelief) => number
export const W1: ParcelWeight = () => 1

/** §7.2 absolute constraint predicate over (bundle, delivery zone). true = valid. */
export type BundleFilter = (S: ParcelBelief[], z: Pos) => boolean
export const F1: BundleFilter = () => true

/**
 * §5.4 delivery value kernel for a set delivered to zone z after L travel ticks.
 * `weight` discounts each parcel's contribution by its survival/race odds (§5.5):
 * carried parcels weight 1 (in hand), uncollected pickups weight their P_avail.
 * `filter` is a §7.2 absolute constraint predicate; returns 0 if violated.
 */
export function vValue(parcels: ParcelBelief[], z: Pos, L: number, tnow: number, dc: DecayConsts, m: CountShaper = M1, g: ZoneShaper = G1, weight: ParcelWeight = W1, filter: BundleFilter = F1): number {
  if (!filter(parcels, z)) return 0
  let sum = 0
  for (const p of parcels) sum += weight(p) * Math.max(0, rnow(p, tnow, dc) - dc.rho * L)
  return g(z) * m(parcels.length) * sum
}

export interface ZonePick { zone: Pos; L: number; toll: number; rate: number }

/**
 * §6.0 value-aware zone selection: argmax of the travel-decayed kernel rate.
 * @param dist - distance function; must return `Infinity` (not `NaN`) for
 *   unreachable tiles. Infinite-distance zones are skipped; NaN distances are
 *   also skipped (coincidental, not guaranteed).
 */
export function bestZone(parcels: ParcelBelief[], from: Pos, zones: Pos[], tnow: number, dc: DecayConsts, dist: (a: Pos, b: Pos) => { L: number; toll: number }, alpha: number, m: CountShaper = M1, g: ZoneShaper = G1, filter: BundleFilter = F1): ZonePick | null {
  let best: ZonePick | null = null
  for (const z of zones) {
    const { L, toll } = dist(from, z)
    if (!Number.isFinite(L)) continue
    const r = rate(vValue(parcels, z, L, tnow, dc, m, g, undefined, filter) - toll, L, alpha)
    if (best === null || r > best.rate) best = { zone: z, L, toll, rate: r }
  }
  return best
}
