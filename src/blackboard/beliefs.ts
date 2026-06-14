// src/blackboard/beliefs.ts
// The stored common belief base (DESIGN §2.3). Stores facts-as-observed
// (rewardSeen, lastSeen); all decayed/derived quantities are computed on read
// by §5 and are deliberately NOT here.
import type { Pos, Tile, SelfObs, AgentObs, GameConsts, PerceptionSnapshot } from '../types/perception.js'

export type Rel = 'self' | 'partner' | 'enemy'
export type CrateState = 'known' | 'unknown'

export interface ParcelBelief {
  id: string
  pos: Pos
  rewardSeen: number
  carriedBy: string | null
  lastSeen: number
}

export interface AgentBelief {
  id: string
  pos: Pos
  rel: Rel
  lastSeen: number
  carrying?: string[]
}

export interface CrateBelief {
  id: string
  state: CrateState
  pos?: Pos
  candidates?: Pos[]
  locked: boolean
  lastSeen: number
}

export interface SelfBelief {
  id: string
  name: string
  teamId: string
  pos: Pos
  score: number
  carrying: string[]
}

export interface Delta {
  tick: number
  parcels: { upsert: ParcelBelief[]; remove: string[] }
  agents: { upsert: AgentBelief[] }
  crates: { upsert: CrateBelief[] }
  self: SelfBelief | null
}

/** Parcel eviction horizon, in decay intervals (§2.3.3). Three halvings of P_surv. */
export const STALE_TTL_INTERVALS = 9

const keyOf = (p: Pos): string => `${p.x},${p.y}`

/** Manhattan distance ≤ obs — the server's entity-visibility metric (Xy.js:62, Sensor.js:64/71). */
export function inRange(a: Pos, b: Pos, obs: number): boolean {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y) <= obs
}

/** Same teamId ⇒ partner, else enemy. Self never appears in sensing, so 'self' is not produced here. */
export function classifyRel(self: SelfBelief, a: AgentObs): Rel {
  return a.teamId === self.teamId ? 'partner' : 'enemy'
}

/** Higher lastSeen wins; equal prefers incoming (identical game state); undefined existing takes incoming. */
export function mergeByLastSeen<T extends { lastSeen: number }>(existing: T | undefined, incoming: T): T {
  if (existing === undefined) return incoming
  return incoming.lastSeen >= existing.lastSeen ? incoming : existing
}

/** 4-neighbour tiles of a crate's former position that are push targets (type-5: slide / crateSpawner). */
export function crateCandidates(tileIndex: Map<string, Tile>, from: Pos): Pos[] {
  const neighbours: Pos[] = [
    { x: from.x + 1, y: from.y },
    { x: from.x - 1, y: from.y },
    { x: from.x, y: from.y + 1 },
    { x: from.x, y: from.y - 1 },
  ]
  return neighbours.filter((n) => {
    const t = tileIndex.get(keyOf(n))
    return t !== undefined && (t.type === 'slide' || t.type === 'crateSpawner')
  })
}

export class BeliefBase {
  readonly parcels = new Map<string, ParcelBelief>()
  readonly agents = new Map<string, AgentBelief>()
  readonly crates = new Map<string, CrateBelief>()
  self: SelfBelief

  private readonly tileIndex: Map<string, Tile>
  private readonly consts: GameConsts
  private lastTick = 0
  private dirtyParcels = new Set<string>()
  private removedParcels = new Set<string>()
  private dirtyAgents = new Set<string>()
  private dirtyCrates = new Set<string>()
  private dirtySelf = false

  constructor(self0: SelfObs, consts: GameConsts, map: Tile[]) {
    this.consts = consts
    this.tileIndex = new Map(map.map((t) => [keyOf(t.pos), t]))
    this.self = {
      id: self0.id,
      name: self0.name,
      teamId: self0.teamId,
      pos: self0.pos,
      score: self0.score,
      carrying: [],
    }
  }

  foldPerception(snap: PerceptionSnapshot): void {
    const t = snap.tick
    this.lastTick = t
    const obs = this.consts.OBS_DISTANCE

    // 1. self (carrying recomputed at end, after parcel updates)
    this.self = {
      id: snap.self.id,
      name: snap.self.name,
      teamId: snap.self.teamId,
      pos: snap.self.pos,
      score: snap.self.score,
      carrying: this.self.carrying, // placeholder; recomputeCarrying() rewrites below
    }

    // 2. parcels — upsert
    for (const p of snap.parcels) {
      this.parcels.set(p.id, { id: p.id, pos: p.pos, rewardSeen: p.reward, carriedBy: p.carriedBy, lastSeen: t })
      this.dirtyParcels.add(p.id)
      this.removedParcels.delete(p.id)
    }

    // 4. agents — upsert (never deleted/evicted)
    for (const a of snap.agents) {
      this.agents.set(a.id, { id: a.id, pos: a.pos, rel: classifyRel(this.self, a), lastSeen: t })
      this.dirtyAgents.add(a.id)
    }

    // 5. crates — upsert KNOWN (preserve any prior locked flag)
    for (const c of snap.crates) {
      const prior = this.crates.get(c.id)
      this.crates.set(c.id, {
        id: c.id,
        state: 'known',
        pos: c.pos,
        candidates: undefined,
        locked: prior?.locked ?? false,
        lastSeen: t,
      })
      this.dirtyCrates.add(c.id)
    }

    const mePos = this.self.pos
    const perceivedParcels = new Set(snap.parcels.map((p) => p.id))
    const perceivedCrates = new Set(snap.crates.map((c) => c.id))

    // 3. parcels — delete in-range but no longer perceived (gone from the world)
    for (const [id, p] of this.parcels) {
      if (!perceivedParcels.has(id) && inRange(mePos, p.pos, obs)) {
        this.parcels.delete(id)
        this.dirtyParcels.delete(id)
        this.removedParcels.add(id)
      }
    }

    // 6. crates — KNOWN whose in-range tile is now empty => pushed off; go UNKNOWN
    for (const [id, c] of this.crates) {
      if (c.state === 'known' && c.pos && !perceivedCrates.has(id) && inRange(mePos, c.pos, obs)) {
        this.crates.set(id, {
          id,
          state: 'unknown',
          pos: undefined,
          candidates: crateCandidates(this.tileIndex, c.pos),
          locked: c.locked,
          lastSeen: t,
        })
        this.dirtyCrates.add(id)
      }
    }

    // 7. evict stale parcels (Infinity decay => never). Agents/crates never evicted.
    const ttl = STALE_TTL_INTERVALS * this.consts.PARCEL_DECAY_TICKS
    for (const [id, p] of this.parcels) {
      if (t - p.lastSeen > ttl) {
        this.parcels.delete(id)
        this.dirtyParcels.delete(id)
        this.removedParcels.add(id)
      }
    }

    this.recomputeCarrying()
  }

  applyPickup(ids: string[]): void {
    for (const id of ids) {
      const p = this.parcels.get(id)
      if (p) {
        p.carriedBy = this.self.id
        this.dirtyParcels.add(id)
      }
    }
    this.recomputeCarrying()
  }

  applyDelivery(ids: string[]): void {
    for (const id of ids) {
      if (this.parcels.delete(id)) {
        this.dirtyParcels.delete(id)
        this.removedParcels.add(id)
      }
    }
    this.recomputeCarrying()
  }

  applyDrop(ids: string[], pos: Pos): void {
    for (const id of ids) {
      const p = this.parcels.get(id)
      if (p) {
        p.carriedBy = null
        p.pos = pos
        this.dirtyParcels.add(id)
      }
    }
    this.recomputeCarrying()
  }

  private recomputeCarrying(): void {
    const carried: string[] = []
    for (const p of this.parcels.values()) {
      if (p.carriedBy === this.self.id) carried.push(p.id)
    }
    this.self.carrying = carried
    this.dirtySelf = true
  }
}
