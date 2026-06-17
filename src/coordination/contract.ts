// src/coordination/contract.ts
// DESIGN §8 — the generic coordination-contract primitive. One step list of LOCALs and
// barriers, run by BOTH agents, advanced by shared monotonic `posted` bookkeeping (§8.1).
// This slice implements the RENDEZVOUS template only (single barrier, no parcels).
import type { AgentId } from '../types/a2a.js'
import type { Pos } from '../types/perception.js'

export type ContractType = 'RENDEZVOUS' | 'HANDOFF' | 'SYNC_GATE'
export type ContractStatus =
  | 'PROPOSED' | 'COMMITTED' | 'ACTIVE' | 'SATISFIED' | 'FAILED' | 'ABORTED'

// What a LOCAL party must verify alone (§8.1). AT_TILE: an exact tile. IN_ZONE: within
// `radius` of `center` under the SERVER's distance metric — never A* path length (§8.4).
export type LocalGoal =
  | { kind: 'AT_TILE'; tile: Pos }
  | { kind: 'IN_ZONE'; center: Pos; radius: number }

const manhattan = (a: Pos, b: Pos): number => Math.abs(a.x - b.x) + Math.abs(a.y - b.y)

// Manhattan is the project-wide metric (cf. markSeen in bdi/loop.ts). If the server credits
// "within distance r" by a different rule, THIS is the single calibration point (§8.4).
export function goalSatisfied(goal: LocalGoal, self: Pos): boolean {
  if (goal.kind === 'AT_TILE') return self.x === goal.tile.x && self.y === goal.tile.y
  return manhattan(self, goal.center) <= goal.radius
}

// The tile to route TOWARD while the goal is unmet. A* routes into the zone; goalSatisfied
// (server metric) decides arrival — they may disagree at the boundary, by design (§8.4).
export function navTarget(goal: LocalGoal): Pos {
  return goal.kind === 'AT_TILE' ? goal.tile : goal.center
}

// A single step in the contract's plan. Both agents hold the SAME list; each executes only
// its own LOCAL steps and blocks on every BARRIER (§8.1). (ACTION steps land in the handoff plan.)
export type Step =
  | { kind: 'LOCAL'; agent: AgentId; goal: LocalGoal; post: string }
  | { kind: 'BARRIER'; needs: string[] }

export interface Contract {
  id: string
  type: ContractType
  steps: Step[]
  posted: Record<string, boolean> // milestone -> reached; monotonic, replicated (§8.1)
  payoff: number
  deadline: number
  status: ContractStatus
}

// What THIS agent should do for the contract this tick. Pure. Rescans from step 0 every call:
// `posted` is monotonic, so this is idempotent and replica-safe — a late a2a post only ever
// advances the contract, never corrupts it (§8.1). No cursor state to keep convergent.
export type ContractAction =
  | { kind: 'navigate'; to: Pos }
  | { kind: 'post'; milestone: string }
  | { kind: 'block' }
  | { kind: 'done' }

export function advance(c: Contract, me: AgentId, self: Pos): ContractAction {
  for (const s of c.steps) {
    if (s.kind === 'BARRIER') {
      if (s.needs.every((m) => c.posted[m])) continue // released → fall through to later steps
      return { kind: 'block' }
    }
    if (s.agent !== me) continue        // not my LOCAL → skip (the partner runs it)
    if (c.posted[s.post]) continue      // my milestone already reached → advance
    if (goalSatisfied(s.goal, self)) return { kind: 'post', milestone: s.post }
    return { kind: 'navigate', to: navTarget(s.goal) }
  }
  return { kind: 'done' }
}
