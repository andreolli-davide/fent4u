// src/blackboard/blackboard.ts
// Belief-replication hub (DESIGN §2.2 belief half, §2.3.5). Wraps a BeliefBase and
// moves deltas/snapshots between the two agent replicas over the a2a channel. Sole
// caller of the base's computeDelta/applyDelta/computeSnapshot/applySnapshot.
import { BeliefBase, type Delta } from './beliefs.js'
import type { AgentId, A2AMessage } from '../types/a2a.js'

/** Default cadence: ping every silent tick so freshness stays inside GATE_STALE_TTL (~2). */
export const HEARTBEAT_INTERVAL_TICKS = 1
/** Default coarse partner-loss horizon (§11). Looser than the gate's tight threshold. */
export const PARTNER_TTL_TICKS = 5

/** The blackboard sub-protocol carried in A2AMessage.payload on the `type:'blackboard'` channel. */
export type BlackboardMsg =
  | { kind: 'hello'; tick: number }
  | { kind: 'snapshot'; tick: number; base: Delta }
  | { kind: 'delta'; tick: number; delta: Delta }
  | { kind: 'heartbeat'; tick: number }

/** The slice of a pino Logger this module needs. */
export interface LoggerLike {
  debug: (obj: Record<string, unknown> | string, msg?: string) => void
  info: (obj: Record<string, unknown> | string, msg?: string) => void
}

export interface BlackboardOpts {
  self: AgentId
  partner: AgentId
  send: (msg: A2AMessage) => void
  logger: LoggerLike
  heartbeatInterval?: number
  partnerTtl?: number
}

/** True iff a delta carries no observed change (used to decide heartbeat vs broadcast). */
export function isEmptyDelta(d: Delta): boolean {
  return (
    d.parcels.upsert.length === 0 &&
    d.parcels.remove.length === 0 &&
    d.agents.upsert.length === 0 &&
    d.crates.upsert.length === 0 &&
    d.self === null
  )
}

/** Count of entities a delta carries — for the `n` field in debug logs. */
function deltaCount(d: Delta): number {
  return (
    d.parcels.upsert.length +
    d.parcels.remove.length +
    d.agents.upsert.length +
    d.crates.upsert.length +
    (d.self === null ? 0 : 1)
  )
}

/** Minimal structural guard for a Delta. Trust boundary is in-process structured-clone, so light. */
function isDelta(d: unknown): boolean {
  if (typeof d !== 'object' || d === null) return false
  const x = d as Record<string, unknown>
  return typeof x.tick === 'number' && typeof x.parcels === 'object' && x.parcels !== null
}

/** Narrowing guard for an inbound blackboard payload (unknown → BlackboardMsg). */
export function isBlackboardMsg(p: unknown): p is BlackboardMsg {
  if (typeof p !== 'object' || p === null) return false
  const m = p as Record<string, unknown>
  if (typeof m.tick !== 'number') return false
  switch (m.kind) {
    case 'hello':
    case 'heartbeat':
      return true
    case 'snapshot':
      return isDelta(m.base)
    case 'delta':
      return isDelta(m.delta)
    default:
      return false
  }
}

export class Blackboard {
  readonly beliefs: BeliefBase
  partnerLastSeenTick = -Infinity

  private readonly self: AgentId
  private readonly partner: AgentId
  private readonly send: (msg: A2AMessage) => void
  private readonly logger: LoggerLike
  private readonly heartbeatInterval: number
  private readonly partnerTtl: number
  private lastSentTick = -Infinity
  private lastPartnerAlive = false

  constructor(beliefs: BeliefBase, opts: BlackboardOpts) {
    this.beliefs = beliefs
    this.self = opts.self
    this.partner = opts.partner
    this.send = opts.send
    this.logger = opts.logger
    this.heartbeatInterval = opts.heartbeatInterval ?? HEARTBEAT_INTERVAL_TICKS
    this.partnerTtl = opts.partnerTtl ?? PARTNER_TTL_TICKS
  }

  /** Coarse degradation signal (§11). False before first contact (partnerLastSeenTick = -Infinity). */
  partnerAlive(tick: number): boolean {
    return tick - this.partnerLastSeenTick <= this.partnerTtl
  }

  /**
   * Pump after BeliefBase.foldPerception + own-action calls each tick. Sole drainer of
   * computeDelta. Ships a delta on material change, else heartbeats when silence exceeds
   * the interval. A delta doubles as a liveness ping (it resets lastSentTick).
   */
  onTick(tick: number): void {
    const d = this.beliefs.computeDelta()
    if (!isEmptyDelta(d)) {
      this.emit({ kind: 'delta', tick, delta: d })
      this.lastSentTick = tick
      this.logger.debug({ kind: 'delta', n: deltaCount(d), agentId: this.self }, 'bb send')
    } else if (tick - this.lastSentTick >= this.heartbeatInterval) {
      this.emit({ kind: 'heartbeat', tick })
      this.lastSentTick = tick
      this.logger.debug({ kind: 'heartbeat', agentId: this.self }, 'bb send')
    }
    this.checkLivenessEdge(tick)
  }

  /** Feed inbound a2a from the main relay. Ignores non-blackboard / malformed messages. */
  receive(msg: A2AMessage): void {
    if (msg.type !== 'blackboard' || !isBlackboardMsg(msg.payload)) return
    const bb = msg.payload
    this.partnerLastSeenTick = Math.max(this.partnerLastSeenTick, bb.tick)
    switch (bb.kind) {
      case 'hello': {
        const base = this.beliefs.computeSnapshot()
        this.emit({ kind: 'snapshot', tick: base.tick, base })
        this.logger.debug({ kind: 'snapshot', n: deltaCount(base), agentId: this.self }, 'bb send')
        break
      }
      case 'snapshot':
        this.beliefs.applySnapshot(bb.base)
        this.logger.debug({ kind: 'snapshot', n: deltaCount(bb.base), agentId: this.self }, 'bb recv')
        break
      case 'delta':
        this.beliefs.applyDelta(bb.delta)
        this.logger.debug({ kind: 'delta', n: deltaCount(bb.delta), agentId: this.self }, 'bb recv')
        break
      case 'heartbeat':
        this.logger.debug({ kind: 'heartbeat', agentId: this.self }, 'bb recv')
        break
    }
  }

  /** Call once on worker boot to announce (re)connection; the partner replies with a snapshot. */
  hello(tick: number): void {
    this.emit({ kind: 'hello', tick })
    this.logger.debug({ kind: 'hello', agentId: this.self }, 'bb send')
  }

  /** Log the boolean edge of partnerAlive at `info` (a degradation event, §11). */
  private checkLivenessEdge(tick: number): void {
    const alive = this.partnerAlive(tick)
    if (alive !== this.lastPartnerAlive) {
      this.logger.info(
        { event: alive ? 'partner-recovered' : 'partner-loss', partnerLastSeenTick: this.partnerLastSeenTick, tick },
        'bb liveness',
      )
      this.lastPartnerAlive = alive
    }
  }

  private emit(msg: BlackboardMsg): void {
    this.send({ from: this.self, to: this.partner, type: 'blackboard', payload: msg })
  }
}
