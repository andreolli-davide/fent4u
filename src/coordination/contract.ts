// src/coordination/contract.ts
// DESIGN §8 — the generic coordination-contract primitive. One step list of LOCALs and
// barriers, run by BOTH agents, advanced by shared monotonic `posted` bookkeeping (§8.1).
// Implements all three templates: RENDEZVOUS (positional barrier), HANDOFF (cross-agent
// parcel delivery via ACTION steps + MISSION lock), and SYNC_GATE (freshness-checked gate overlay).
import type { AgentId } from '../types/a2a.js'
import type { Pos } from '../types/perception.js'
import type { Grid } from '../planning/astar.js'

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

// A single step in the contract's plan. Both agents hold the SAME list; each executes only its
// own LOCAL/ACTION steps and blocks on every BARRIER (§8.1). An ACTION is an atomic game primitive
// fired at tile `at` with EXPLICIT ids (§8.3 rule 1 — never dump base-play parcels on the corridor);
// `onDelivery` marks the deliverer's scoring putDown (selects the belief update in the loop).
export type Step =
  | { kind: 'LOCAL'; agent: AgentId; goal: LocalGoal; post: string }
  | { kind: 'BARRIER'; needs: string[] }
  | { kind: 'ACTION'; agent: AgentId; primitive: 'pickUp' | 'putDown'; ids: string[]; at: Pos; post: string; onDelivery?: boolean }

export interface Contract {
  id: string
  type: ContractType
  steps: Step[]
  posted: Record<string, boolean> // milestone -> reached; monotonic, replicated (§8.1)
  payoff: number
  deadline: number
  status: ContractStatus
  lockOwner?: AgentId      // §9.10 — the single party that installs MISSION locks (handoff picker)
  lockParcels?: string[]   // §9.10 — parcels the contract MISSION-locks for its life
}

// What THIS agent should do for the contract this tick. Pure. Rescans from step 0 every call:
// `posted` is monotonic, so this is idempotent and replica-safe — a late a2a post only ever
// advances the contract, never corrupts it (§8.1). No cursor state to keep convergent.
export type ContractAction =
  | { kind: 'navigate'; to: Pos }
  | { kind: 'post'; milestone: string }
  | { kind: 'block' }
  | { kind: 'done' }
  | { kind: 'gated' } // §8.5 SYNC_GATE: staging complete — hand control back to gated base play
  | { kind: 'pickup'; ids: string[]; post: string }
  | { kind: 'putdown'; ids: string[]; post: string; onDelivery: boolean }

export function advance(c: Contract, me: AgentId, self: Pos): ContractAction {
  for (const s of c.steps) {
    if (s.kind === 'BARRIER') {
      if (s.needs.every((m) => c.posted[m])) continue // released → fall through to later steps
      return { kind: 'block' }
    }
    if (s.agent !== me) continue   // not my step → skip (the partner runs it)
    if (c.posted[s.post]) continue // my milestone already reached → advance
    if (s.kind === 'LOCAL') {
      if (goalSatisfied(s.goal, self)) return { kind: 'post', milestone: s.post }
      return { kind: 'navigate', to: navTarget(s.goal) }
    }
    // s.kind === 'ACTION' — self-navigate to the action tile, then fire the primitive.
    if (self.x !== s.at.x || self.y !== s.at.y) return { kind: 'navigate', to: s.at }
    return s.primitive === 'pickUp'
      ? { kind: 'pickup', ids: s.ids, post: s.post }
      : { kind: 'putdown', ids: s.ids, post: s.post, onDelivery: s.onDelivery ?? false }
  }
  // Fell through: every barrier released and every step of MINE posted. The contract is SATISFIED
  // only when EVERY non-barrier milestone is posted (mine AND the partner's) — otherwise hold while
  // the partner finishes (the handoff picker waits after vacating until the deliverer scores). In
  // rendezvous both LOCALs posted ⇒ all-posted ⇒ done for both, so this is backward-compatible.
  const allPosted = c.steps.every((s) => s.kind === 'BARRIER' || c.posted[s.post])
  // §8.5: a SYNC_GATE never terminates on its own — past staging it perpetually yields control to
  // gated base play. Every other type completes when all its milestones are posted (§8.1).
  if (allPosted) return c.type === 'SYNC_GATE' ? { kind: 'gated' } : { kind: 'done' }
  return { kind: 'block' }
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

// §8.5 close-latency guard: an OPEN gate older than this many ticks reads CLOSED (fail-safe to STOP
// under uncertainty — a late "red" must never license a move). Carried on the dedicated 'gate' channel.
export const GATE_STALE_TTL = 5

// The gate sub-protocol on the `type:'gate'` a2a channel (separate from 'contract'). `tick` is the
// heartbeat stamp the freshness check reads. Externally originated (server red/green); this slice
// routes + applies it, the live source is a follow-on seam.
export type GateMsg = { id: string; state: 'OPEN' | 'CLOSED'; tick: number }

export function isGateMsg(p: unknown): p is GateMsg {
  if (typeof p !== 'object' || p === null) return false
  const m = p as Record<string, unknown>
  return typeof m.id === 'string' && (m.state === 'OPEN' || m.state === 'CLOSED') && typeof m.tick === 'number'
}

// Owns the single active contract for ONE agent (mirrors MissionSlot's single-slot rule, §4.3)
// and applies the `'contract'` a2a sub-protocol. Both replicas converge because the full
// contract ships in `propose` and every milestone is replicated via `post` (§8.1). This slice
// has no adoption gate (§8.6) and no deadline/FAILED logic — see the follow-on plans.
export class ContractRuntime {
  private c: Contract | null = null

  // §8.5 gate flag — lifetime = the active SYNC_GATE contract. Default OPEN so it is inert outside a
  // SYNC_GATE (gate scoping: callers only consult gateOpen() while a SYNC_GATE contract is ACTIVE).
  private gate: { state: 'OPEN' | 'CLOSED'; heartbeat: number } = { state: 'OPEN', heartbeat: 0 }

  // heartbeat: 0 is the "never-stamped" sentinel — gateOpen() treats it as perpetually fresh so the
  // gate is inert (always OPEN) until the first explicit setGate/applyGate stamp arrives.
  private resetGate(): void { this.gate = { state: 'OPEN', heartbeat: 0 } }

  current(): Contract | null { return this.c }
  active(): Contract | null { return this.c?.status === 'ACTIVE' ? this.c : null }

  // Liaison side: install PROPOSED and return the msg to broadcast. Goes ACTIVE on the accept.
  propose(contract: Contract): ContractMsg {
    this.c = { ...contract, status: 'PROPOSED' }
    this.resetGate()
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
    this.resetGate()
    return { kind: 'teardown', id, status: 'SATISFIED' }
  }

  // OPEN and fresh (§8.5): a stale heartbeat reads CLOSED. heartbeat===0 is the "never-stamped"
  // sentinel (set by resetGate) — treated as perpetually fresh so the gate is inert until armed.
  // Callers arm this only under a live SYNC_GATE.
  gateOpen(now: number): boolean {
    if (this.gate.state !== 'OPEN') return false
    if (this.gate.heartbeat === 0) return true  // sentinel: not yet stamped → always fresh
    return now - this.gate.heartbeat <= GATE_STALE_TTL
  }

  // Origination (Liaison): set the gate locally and return the msg to broadcast on the 'gate' channel.
  setGate(state: 'OPEN' | 'CLOSED', tick: number): GateMsg | null {
    if (this.c === null) return null
    this.gate = { state, heartbeat: tick }
    return { id: this.c.id, state, tick }
  }

  // Replication: apply an inbound gate msg for THIS contract, monotonic in tick (a late stamp is dropped).
  applyGate(msg: GateMsg): void {
    if (this.c !== null && this.c.id === msg.id && msg.tick >= this.gate.heartbeat) {
      this.gate = { state: msg.state, heartbeat: msg.tick }
    }
  }

  // §8.5 partner-loss / barrier-deadline failure: mark FAILED, clear the slot, disarm the gate.
  fail(): ContractMsg | null {
    if (this.c === null) return null
    const id = this.c.id
    this.c.status = 'FAILED'
    this.c = null
    this.resetGate()
    return { kind: 'teardown', id, status: 'FAILED' }
  }

  // Apply an inbound a2a msg; returns an optional reply for the caller to broadcast.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  applyMsg(msg: ContractMsg, _self: AgentId): ContractMsg | null {
    switch (msg.kind) {
      case 'propose':
        // Receiver (Courier) accepts immediately → ACTIVE. Adoption gating is the proposer's
        // responsibility (§8.6), deferred this slice, so acceptance is unconditional.
        this.c = { ...msg.contract, status: 'ACTIVE' }
        this.resetGate()
        return { kind: 'accept', id: msg.contract.id }
      case 'accept':
        if (this.c !== null && this.c.id === msg.id) this.c.status = 'ACTIVE'
        return null
      case 'post':
        if (this.c !== null && this.c.id === msg.id) this.c.posted[msg.milestone] = true
        return null
      case 'teardown':
        if (this.c !== null && this.c.id === msg.id) { this.c = null; this.resetGate() }
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

// §8.5 SYNC_GATE: both stage into the meet zone (reusing the rendezvous staging shape), then the
// barrier releases into a perpetual GATED phase governed by the gate flag — NOT another step list.
// No parcels, no roles, no MISSION lock; "odd-row" parity staging (§8.5 example) is a follow-on.
export function syncGateContract(
  id: string,
  target: Pos,
  radius: number,
  payoff: number,
  deadline: number,
): Contract {
  const goal = { kind: 'IN_ZONE' as const, center: target, radius }
  return {
    id,
    type: 'SYNC_GATE',
    steps: [
      { kind: 'LOCAL', agent: 'liaison', goal, post: 'l_staged' },
      { kind: 'LOCAL', agent: 'courier', goal, post: 'c_staged' },
      { kind: 'BARRIER', needs: ['l_staged', 'c_staged'] },
    ],
    posted: {},
    payoff,
    deadline,
    status: 'PROPOSED',
  }
}

// §8.3 HANDOFF — the picker (A) picks the parcel, carries it to a NON-delivery drop tile next to a
// delivery zone, drops it (ground, not scoring) and vacates; the deliverer (B) waits at an approach
// tile until the barrier (picker dropped AND vacated, B staged) releases, then steps onto the now-
// free drop tile, picks the parcel and delivers it — a CROSS-agent delivery scoring `payoff`.
// Roles are bound by the caller from shared beliefs (picker = closer to the parcel, §9.10), then
// frozen here. Tiles come from bindHandoff() (RUNTIME_BOUND, §8.2).
export interface HandoffTiles { parcel: Pos; drop: Pos; vacate: Pos; approach: Pos; delivery: Pos }

export function handoffContract(
  id: string,
  parcelId: string,
  picker: AgentId,
  deliverer: AgentId,
  tiles: HandoffTiles,
  payoff: number,
  deadline: number,
): Contract {
  const at = (p: Pos): LocalGoal => ({ kind: 'AT_TILE', tile: p })
  return {
    id,
    type: 'HANDOFF',
    steps: [
      { kind: 'ACTION', agent: picker, primitive: 'pickUp', ids: [parcelId], at: tiles.parcel, post: 'picked' },
      { kind: 'ACTION', agent: picker, primitive: 'putDown', ids: [parcelId], at: tiles.drop, post: 'dropped', onDelivery: false },
      { kind: 'LOCAL', agent: picker, goal: at(tiles.vacate), post: 'H_clear' },
      { kind: 'LOCAL', agent: deliverer, goal: at(tiles.approach), post: 'b_ready' },
      { kind: 'BARRIER', needs: ['H_clear', 'b_ready'] },
      { kind: 'ACTION', agent: deliverer, primitive: 'pickUp', ids: [parcelId], at: tiles.drop, post: 'b_picked' },
      { kind: 'ACTION', agent: deliverer, primitive: 'putDown', ids: [parcelId], at: tiles.delivery, post: 'delivered', onDelivery: true },
    ],
    posted: {},
    payoff,
    deadline,
    status: 'PROPOSED',
    lockOwner: picker,
    lockParcels: [parcelId],
  }
}

// §8.3 runtime tile binding (the 3 binding rules). Pure over the grid + parcel position. Returns a
// HandoffTiles or null ⇒ DECLINE the bid (do not propose). A `drop` tile must be walkable, NON-
// delivery (a delivery-tile drop would score for the picker solo, voiding the cross-agent condition)
// and adjacent to a delivery tile; it must have ≥2 distinct walkable non-delivery neighbours for the
// picker's `vacate` step-off and the deliverer's `approach` staging (agents never share a tile).
// Deterministic: delivery zones in array order, neighbours in a fixed order, free neighbours sorted.
// Walkability here is grid-only (non-wall); full push-aware reachability is left to stepToward,
// which blocks gracefully if a bound tile turns out unreachable at run time.
export function bindHandoff(grid: Grid, parcel: Pos): HandoffTiles | null {
  const walkableNonDelivery = (p: Pos): boolean => {
    const t = grid.tiles.get(`${p.x},${p.y}`)
    return t !== undefined && t.type !== 'wall' && t.type !== 'delivery'
  }
  const neigh = (p: Pos): Pos[] => [
    { x: p.x, y: p.y + 1 }, { x: p.x, y: p.y - 1 },
    { x: p.x - 1, y: p.y }, { x: p.x + 1, y: p.y },
  ]
  const eq = (a: Pos, b: Pos): boolean => a.x === b.x && a.y === b.y
  for (const delivery of grid.deliveryZones) {
    for (const drop of neigh(delivery)) {
      if (!walkableNonDelivery(drop)) continue
      const free = neigh(drop)
        .filter((n) => walkableNonDelivery(n) && !eq(n, delivery))
        .sort((a, b) => a.x - b.x || a.y - b.y)
      if (free.length >= 2) {
        return { parcel, drop, vacate: free[0], approach: free[1], delivery }
      }
    }
  }
  return null
}
