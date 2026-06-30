// §18.9 reintegration: cost the emitted step-list with the SAME push-aware A* (so L is in the
// same tick unit as every typed mission), and value the delivered set with the §5.4 kernel.

import { planPath, key, type Grid, type PlanCtx } from '../../planning/astar.js'
import { vValue, type DecayConsts } from '../../bdi/utility.js'
import type { ParcelBelief } from '../../blackboard/beliefs.js'
import type { AgentStep } from '../kinds.js'
import type { Pos } from '../../types/perception.js'
import type { WorldSnapshot, SnapParcel } from './snapshot.js'

export interface PlanCost { L: number; vPlan: number; reachable: boolean }

const planCtxFor = (budgetMs: number, maskTiles?: Pos[]): PlanCtx => ({
  obstacles: { crateAt: new Map(), agentAt: new Set((maskTiles ?? []).map((t) => key(t))) }, // enemies not modelled (§17.7.4); masked tiles blocked (§17.7.4 K_block)
  protectedTiles: [],
  budgetMs,
})

const asBelief = (p: SnapParcel, t0: number): ParcelBelief =>
  ({ id: p.id, pos: p.pos, rewardSeen: p.reward, carriedBy: p.carriedBy, lastSeen: t0 })

export function costPlan(
  steps: AgentStep[], grid: Grid, snap: WorldSnapshot, tnow: number, dc: DecayConsts, budgetMs: number,
): PlanCost {
  const ctx = planCtxFor(budgetMs, snap.maskTiles)
  let cur: Pos = snap.selfPos
  let L = 0
  const carried: string[] = []
  const delivered: Array<{ id: string; zone: Pos }> = []

  for (const step of steps) {
    if (step.op === 'goto') {
      const res = planPath(grid, ctx, cur, step.target)
      if (!res.reachable) return { L: Infinity, vPlan: 0, reachable: false }
      L += res.L
      cur = step.target
    } else if (step.op === 'pickup') {
      if (!carried.includes(step.parcelId)) carried.push(step.parcelId)
    } else if (step.op === 'deliver') {
      for (const id of carried) delivered.push({ id, zone: step.zone })
      carried.length = 0
    } else if (step.op === 'wait') {
      L += step.n
    }
  }

  // Value the delivered parcels at the last delivery zone with the shared kernel.
  let vPlan = 0
  if (delivered.length > 0) {
    const zone = delivered[delivered.length - 1]!.zone
    const byId = new Map(snap.parcels.map((p) => [p.id, p]))
    const beliefs = delivered
      .map((d) => byId.get(d.id))
      .filter((p): p is SnapParcel => p !== undefined)
      .map((p) => asBelief(p, snap.t0))
    vPlan = vValue(beliefs, zone, L, tnow, dc)
  }
  return { L, vPlan, reachable: true }
}
