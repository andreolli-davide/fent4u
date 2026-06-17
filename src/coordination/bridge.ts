// src/coordination/bridge.ts
// DESIGN §8 bridge — the single seam between a §4 COORDINATION_CONTRACT mission and a §8 Contract.
// Pure: (mission, grid, live state) → Contract | null. `null` means NOT YET bindable (parcel
// unperceived / no valid tiles) — the Liaison loop holds and retries next tick (§8.2, deferred bind).
import type { AgentId } from '../types/a2a.js'
import type { Pos } from '../types/perception.js'
import type { ParcelBelief } from '../blackboard/beliefs.js'

export interface AgentRef { id: AgentId; pos: Pos }

const manhattan = (a: Pos, b: Pos): number => Math.abs(a.x - b.x) + Math.abs(a.y - b.y)

// Canonical agent ordering: liaison < courier (for deterministic tie-breaking in role binding)
const agentOrder = (id: AgentId): number => {
  if (id === 'liaison') return 0
  if (id === 'courier') return 1
  return 2 // fallback for other agents
}

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
  const aPicks = da < db || (da === db && agentOrder(a.id) < agentOrder(b.id))
  return aPicks ? { picker: a.id, deliverer: b.id } : { picker: b.id, deliverer: a.id }
}
