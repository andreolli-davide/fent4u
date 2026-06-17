// src/coordination/bridge.ts
// DESIGN §8 bridge — the single seam between a §4 COORDINATION_CONTRACT mission and a §8 Contract.
// Pure: (mission, grid, live state) → Contract | null. `null` means NOT YET bindable (parcel
// unperceived / no valid tiles) — the Liaison loop holds and retries next tick (§8.2, deferred bind).
import type { AgentId } from '../types/a2a.js'
import type { Pos } from '../types/perception.js'
import type { ParcelBelief } from '../blackboard/beliefs.js'
import type { Grid } from '../planning/astar.js'
import type { Mission } from '../mission/kinds.js'
import { bindHandoff, handoffContract, rendezvousContract, type Contract } from './contract.js'

export interface AgentRef { id: AgentId; pos: Pos }

const manhattan = (a: Pos, b: Pos): number => Math.abs(a.x - b.x) + Math.abs(a.y - b.y)

// Highest-reward free (uncarried, unclaimed, reward>0) parcel; deterministic id tie-break so both
// replicas would select identically (§9.3). null ⇒ nothing to hand off this tick.
export function selectHandoffParcel(
  parcels: ParcelBelief[],
  isClaimed: (id: string) => boolean,
): ParcelBelief | null {
  let best: ParcelBelief | null = null
  for (const p of parcels) {
    if (p.carriedBy !== null || p.rewardSeen <= 0 || isClaimed(p.id)) continue
    if (best === null || p.rewardSeen > best.rewardSeen || (p.rewardSeen === best.rewardSeen && p.id < best.id)) {
      best = p
    }
  }
  return best
}

// §8.3 / §9.10: picker = the agent closer (Manhattan) to the parcel; deliverer = the other. Bound
// ONCE by the Liaison, frozen into the proposed contract. Tie → lower agent id is picker.
export function bindRoles(parcel: Pos, a: AgentRef, b: AgentRef): { picker: AgentId; deliverer: AgentId } {
  const da = manhattan(a.pos, parcel)
  const db = manhattan(b.pos, parcel)
  const aPicks = da < db || (da === db && a.id < b.id)
  return aPicks ? { picker: a.id, deliverer: b.id } : { picker: b.id, deliverer: a.id }
}

// §8.4 default in-zone radius when the LLM transcribed none (the worked example uses 3).
export const RENDEZVOUS_RADIUS = 3
// Fallback contract lifetime when the mission carries no deadline (absolute-tick deadline added in loop).
export const DEFAULT_CONTRACT_TTL = 500

// Coordinate-free meet-point resolution (§8.4): an explicit TEXT_BOUND tile wins; otherwise the
// delivery zone nearest the map centre — a real landmark both agents know. null ⇒ DECLINE.
export function rendezvousTarget(mission: Mission, grid: Grid): Pos | null {
  const t = mission.params.targetTile
  if (t !== undefined && t.tag === 'TEXT_BOUND') return { x: t.x, y: t.y }
  if (grid.deliveryZones.length === 0) return null
  const centre: Pos = { x: Math.floor(grid.w / 2), y: Math.floor(grid.h / 2) }
  let best = grid.deliveryZones[0]
  let bestD = manhattan(best, centre)
  for (const z of grid.deliveryZones) {
    const d = manhattan(z, centre)
    if (d < bestD || (d === bestD && (z.x < best.x || (z.x === best.x && z.y < best.y)))) { best = z; bestD = d }
  }
  return { x: best.x, y: best.y }
}

// Live state the dispatcher binds against. `partner` is null until the partner is perceived (handoff
// needs both positions to bid roles). `isClaimed` keeps the auction's soft claims off the handoff pool.
export interface BuildCtx {
  parcels: ParcelBelief[]
  self: AgentRef
  partner: AgentRef | null
  isClaimed: (id: string) => boolean
  tnow: number
}

// Classify a COORDINATION_CONTRACT mission into a bound, PROPOSED Contract — or null (hold/decline).
// Liaison-only (the proposer, §2.1); the bound contract ships whole in `propose`, so the Courier
// never re-binds. Adoption gating (§8.6) is OUT — this proposes unconditionally once bindable.
export function buildContract(mission: Mission, grid: Grid, ctx: BuildCtx): Contract | null {
  const deadline = mission.deadline ?? ctx.tnow + DEFAULT_CONTRACT_TTL
  switch (mission.params.contractType) {
    case 'HANDOFF': {
      if (ctx.partner === null) return null
      const parcel = selectHandoffParcel(ctx.parcels, ctx.isClaimed)
      if (parcel === null) return null
      const tiles = bindHandoff(grid, parcel.pos)
      if (tiles === null) return null
      const { picker, deliverer } = bindRoles(parcel.pos, ctx.self, ctx.partner)
      return handoffContract(`${mission.id}:HANDOFF`, parcel.id, picker, deliverer, tiles, mission.payoff, deadline)
    }
    case 'RENDEZVOUS': {
      const target = rendezvousTarget(mission, grid)
      if (target === null) return null
      return rendezvousContract(`${mission.id}:RENDEZVOUS`, target, RENDEZVOUS_RADIUS, mission.payoff, deadline)
    }
    default:
      return null
  }
}
