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
