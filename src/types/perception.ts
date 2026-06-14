// src/types/perception.ts
// Project-owned perception domain types. The SDK's IO* wire shapes never escape
// src/external/deliveroo.ts — these are what the rest of the project consumes.

export type Role = 'liaison' | 'courier'

export type Pos = { x: number; y: number }

export type TileType =
  | 'wall' // '0'
  | 'spawner' // '1' parcel spawner
  | 'delivery' // '2'
  | 'base' // '4'
  | 'walkable' // '3'
  | 'slide' // '5' crate sliding tile
  | 'crateSpawner' // '5!'
  | 'oneway' // '←' '↑' '→' '↓' (direction in `dir`)

export interface Tile {
  pos: Pos
  type: TileType
  dir?: 'up' | 'down' | 'left' | 'right'
}

export interface ParcelObs {
  id: string
  pos: Pos
  reward: number
  carriedBy: string | null
}

export interface AgentObs {
  id: string
  name: string
  teamId: string
  pos: Pos
  score: number
}

export interface CrateObs {
  id: string
  pos: Pos
}

export interface SelfObs {
  id: string
  name: string
  teamId: string
  pos: Pos
  score: number
}

// Action result. The SDK's emitPickup/emitPutdown resolve to { id }[] only — no
// pos/reward/carriedBy. The stateless wrapper passes these through verbatim; the
// BDI belief base holds the full ParcelObs and looks up by id.
export interface PickResult {
  id: string
}

export interface GameConsts {
  CLOCK: number // ms per frame (IOConfig.CLOCK), default 50
  MOVEMENT_DURATION: number // GAME.player.movement_duration, default 50
  OBS_DISTANCE: number // GAME.player.observation_distance, default 5
  PARCEL_DECAY_TICKS: number // decaying_event parsed to ticks; Infinity if 'infinite'
  PARCEL_DECAY_RAW: string // raw decaying_event ('1s' | '2s' | ... | 'infinite')
  PENALTY: number // IOConfig.PENALTY
}

export interface PerceptionSnapshot {
  tick: number
  self: SelfObs
  parcels: ParcelObs[]
  agents: AgentObs[]
  crates: CrateObs[]
}

/** Canonical position key: string representation of a tile coordinate. */
export const posKey = (p: Pos): string => `${p.x},${p.y}`
