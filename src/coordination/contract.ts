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

// The contract sub-protocol carried in A2AMessage.payload on the `type:'contract'` channel.
// propose/accept = the §8.2 handshake; post = replicate a milestone; teardown = §8.2 terminal.
export type ContractMsg =
  | { kind: 'propose'; contract: Contract }
  | { kind: 'accept'; id: string }
  | { kind: 'post'; id: string; milestone: string }
  | { kind: 'teardown'; id: string; status: ContractStatus }

// Narrowing guard for an inbound contract payload (unknown → ContractMsg). Trust boundary is
// in-process structured-clone (relay), so the structural checks are light (cf. isClaimMsg).
export function isContractMsg(p: unknown): p is ContractMsg {
  if (typeof p !== 'object' || p === null) return false
  const m = p as Record<string, unknown>
  switch (m.kind) {
    case 'propose':
      return typeof m.contract === 'object' && m.contract !== null &&
        typeof (m.contract as Contract).id === 'string'
    case 'accept':
      return typeof m.id === 'string'
    case 'post':
      return typeof m.id === 'string' && typeof m.milestone === 'string'
    case 'teardown':
      return typeof m.id === 'string' && typeof m.status === 'string'
    default:
      return false
  }
}

// Owns the single active contract for ONE agent (mirrors MissionSlot's single-slot rule, §4.3)
// and applies the `'contract'` a2a sub-protocol. Both replicas converge because the full
// contract ships in `propose` and every milestone is replicated via `post` (§8.1). This slice
// has no adoption gate (§8.6) and no deadline/FAILED logic — see the follow-on plans.
export class ContractRuntime {
  private c: Contract | null = null

  current(): Contract | null { return this.c }
  active(): Contract | null { return this.c?.status === 'ACTIVE' ? this.c : null }

  // Liaison side: install PROPOSED and return the msg to broadcast. Goes ACTIVE on the accept.
  propose(contract: Contract): ContractMsg {
    this.c = { ...contract, status: 'PROPOSED' }
    return { kind: 'propose', contract: this.c }
  }

  // Either agent: flip its OWN milestone and return the post msg to broadcast (§8.1).
  post(milestone: string): ContractMsg | null {
    if (this.c === null) return null
    this.c.posted[milestone] = true
    return { kind: 'post', id: this.c.id, milestone }
  }

  // The agent that observed `advance(...) === 'done'` marks SATISFIED, clears, broadcasts.
  complete(): ContractMsg | null {
    if (this.c === null) return null
    const id = this.c.id
    this.c.status = 'SATISFIED'
    this.c = null
    return { kind: 'teardown', id, status: 'SATISFIED' }
  }

  // Apply an inbound a2a msg; returns an optional reply for the caller to broadcast.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  applyMsg(msg: ContractMsg, _self: AgentId): ContractMsg | null {
    switch (msg.kind) {
      case 'propose':
        // Receiver (Courier) accepts immediately → ACTIVE. Adoption gating is the proposer's
        // responsibility (§8.6), deferred this slice, so acceptance is unconditional.
        this.c = { ...msg.contract, status: 'ACTIVE' }
        return { kind: 'accept', id: msg.contract.id }
      case 'accept':
        if (this.c !== null && this.c.id === msg.id) this.c.status = 'ACTIVE'
        return null
      case 'post':
        if (this.c !== null && this.c.id === msg.id) this.c.posted[msg.milestone] = true
        return null
      case 'teardown':
        if (this.c !== null && this.c.id === msg.id) this.c = null
        return null
    }
  }
}

// §8.4 RENDEZVOUS: both parties reach within `radius` of `target` (different tiles — agents can
// never share a tile), each posts its readiness, the single barrier releases when both have.
// Roles are symmetric here, so no runtime bid is needed (cf. §8.3 handoff, follow-on plan).
export function rendezvousContract(
  id: string,
  target: Pos,
  radius: number,
  payoff: number,
  deadline: number,
): Contract {
  const goal = { kind: 'IN_ZONE' as const, center: target, radius }
  return {
    id,
    type: 'RENDEZVOUS',
    steps: [
      { kind: 'LOCAL', agent: 'liaison', goal, post: 'liaison_ready' },
      { kind: 'LOCAL', agent: 'courier', goal, post: 'courier_ready' },
      { kind: 'BARRIER', needs: ['liaison_ready', 'courier_ready'] },
    ],
    posted: {},
    payoff,
    deadline,
    status: 'PROPOSED',
  }
}
