// src/mission/shapers.ts
// Pure builders: transcribed REWARD_SHAPER params -> the CountShaper/ZoneShaper closures the
// §5.4 kernel already accepts (DESIGN §6). Identity when absent/empty, so base play is recovered
// exactly. bestSubset (§6.1 argmax + §6.2 expiry floor) lives here too.
// Imports bdi/utility (NOT bdi/loop): one-way mission -> utility, no cycle, no-hotloop guard stays green.

import { key } from '../planning/astar.js'
import type { Pos } from '../types/perception.js'
import { posKey } from '../types/perception.js'
import type { ParcelBelief } from '../blackboard/beliefs.js'
import type { MissionParams } from './kinds.js'
import { M1, G1, F1, rnow, vValue, type CountShaper, type ZoneShaper, type DecayConsts, type BundleFilter } from '../bdi/utility.js'

/** count->factor over |putDown| (§6). Identity (M1) when absent or after filtering empties. */
export function buildCountShaper(m: MissionParams['m']): CountShaper {
  if (m === undefined) return M1
  const table = new Map<number, number>()
  for (const [k, f] of Object.entries(m)) {
    const ki = Number(k)
    if (Number.isInteger(ki) && ki > 0 && Number.isFinite(f)) table.set(ki, f)
  }
  if (table.size === 0) return M1
  return (k: number) => table.get(k) ?? 1
}

/**
 * location->factor over the delivery tile (§6). TEXT_BOUND tiles bind directly; RUNTIME_BOUND tiles
 * bind through `resolve` (a region resolver, §17.5.3) — the runtime chooses the concrete zone from
 * the map. An unresolvable RUNTIME_BOUND entry is dropped (grounding fail), leaving identity there.
 */
export function buildZoneShaper(g: MissionParams['g'], resolve?: (rule: string) => Pos | null): ZoneShaper {
  if (g === undefined || g.length === 0) return G1
  const table = new Map<string, number>()
  for (const e of g) {
    if (!Number.isFinite(e.factor)) continue
    const tile = e.tile.tag === 'TEXT_BOUND'
      ? { x: e.tile.x, y: e.tile.y }
      : resolve?.(e.tile.rule) ?? null
    if (tile === null) continue // RUNTIME_BOUND unresolved ⇒ drop (grounding fail)
    table.set(posKey(tile), e.factor)
  }
  if (table.size === 0) return G1
  return (z: Pos) => table.get(posKey(z)) ?? 1
}

/**
 * §6.1 reactive subset choice on a delivery tile, with the §6.2 expiry-floor guard.
 * value(S) = g(tile)*m(|S|)*Σ Rnow(i). For a fixed size k the best S is the top-k carried by
 * Rnow, so the argmax is max over prefix sizes — scan every feasible k (carried count is tiny;
 * the sort dominates at O(n log n)). Any carried parcel projected to decay to <=0 within
 * `floorTicks` is FORCED into every candidate (never held to expiry, §6.2 guard 2).
 */
export function bestSubset(
  carried: ParcelBelief[],
  tile: Pos,
  tnow: number,
  dc: DecayConsts,
  m: CountShaper,
  g: ZoneShaper,
  floorTicks: number,
  filter: BundleFilter = F1,
): { set: ParcelBelief[]; value: number } {
  const positive = carried
    .map((p) => ({ p, r: rnow(p, tnow, dc) }))
    .filter((x) => x.r > 0)
    .sort((a, b) => b.r - a.r)
  if (positive.length === 0) return { set: [], value: 0 }

  const forced = positive.filter((x) => x.r - dc.rho * floorTicks <= 0).map((x) => x.p)
  // Pre-drop singleton-invalid optionals: the prefix-only argmax below can't skip a high-Rnow
  // violator, so without this a valid low-reward subset (e.g. [a] when [b] violates) is
  // unreachable (§7.2). FORCED parcels deliberately bypass this — a forced violator must zero
  // the whole bundle via vValue's set-level filter (§7.3 worst-case), not be silently dropped.
  const optional = positive
    .filter((x) => x.r - dc.rho * floorTicks > 0)
    .filter((x) => filter([x.p], tile))
    .map((x) => x.p)

  let best: { set: ParcelBelief[]; value: number } | null = null
  for (let j = 0; j <= optional.length; j++) {
    const set = [...forced, ...optional.slice(0, j)]
    if (set.length === 0) continue
    const value = vValue(set, tile, 0, tnow, dc, m, g, undefined, filter)
    if (best === null || value > best.value) best = { set, value }
  }
  return best ?? { set: [], value: 0 }
}

/** §7.1 priced tiles -> tileKey->toll points. TEXT_BOUND + finite only; empty when absent. */
export function buildTolls(priced: MissionParams['priced']): Map<string, number> {
  const out = new Map<string, number>()
  if (priced === undefined) return out
  for (const e of priced) {
    if (e.tile.tag !== 'TEXT_BOUND') continue
    if (!Number.isFinite(e.toll)) continue
    out.set(key({ x: e.tile.x, y: e.tile.y }), e.toll)
  }
  return out
}

/** §7.2 absolute constraint -> BundleFilter. Identity (F1) when absent. RUNTIME_BOUND ZONE binds via `resolve`. */
export function buildBundleFilter(absolute: MissionParams['absolute'], resolve?: (rule: string) => Pos | null): BundleFilter {
  if (absolute === undefined) return F1
  if (absolute.kind === 'REWARD_THRESHOLD') {
    const max = absolute.max
    return (S) => S.every((p) => p.rewardSeen <= max) // §7.3 worst-case: any over-max voids all
  }
  const tile = absolute.tile.tag === 'TEXT_BOUND'
    ? { x: absolute.tile.x, y: absolute.tile.y }
    : resolve?.(absolute.tile.rule) ?? null
  if (tile === null) return F1 // RUNTIME_BOUND unresolved ⇒ no filter (grounding fail)
  const forbidden = key(tile)
  return (_S, z) => key(z) !== forbidden
}
