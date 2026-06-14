// src/external/deliveroo.ts
import type { IOConfig, IOTile, IOSensing, IOAgent } from '@unitn-asa/deliveroo-js-sdk'
import type { GameConsts, Tile, ParcelObs, AgentObs, CrateObs, SelfObs, PerceptionSnapshot } from '../types/perception.js'

const EVENT_MS: Record<string, number> = {
  '1s': 1000,
  '2s': 2000,
  '5s': 5000,
  '10s': 10000,
  '1m': 60000,
  '1h': 3600000,
}

/**
 * Convert a clock-event decay string to ticks-per-1-point-decay.
 * 'infinite' -> Infinity (no decay). 'frame' -> 1 (decay every tick, i.e.
 * every clock frame). Unknown string -> '1s' equivalent (matches the SDK's
 * parseClockEvent fallback for genuinely invalid strings). Mechanical only;
 * utility.ts owns the rate formulas (ρ/λ).
 */
export function parseDecayEvent(ev: string, clockMs: number): number {
  if (ev === 'infinite') return Infinity
  if (ev === 'frame') return 1 // decay every frame = 1 tick
  const ms = EVENT_MS[ev]
  if (ms === undefined) return EVENT_MS['1s'] / clockMs
  return ms / clockMs
}

/** Assemble immutable GameConsts from the SDK IOConfig. */
export function buildConsts(io: IOConfig): GameConsts {
  const raw = io.GAME.parcels.decaying_event
  return {
    CLOCK: io.CLOCK,
    MOVEMENT_DURATION: io.GAME.player.movement_duration,
    OBS_DISTANCE: io.GAME.player.observation_distance,
    PARCEL_DECAY_TICKS: parseDecayEvent(raw, io.CLOCK),
    PARCEL_DECAY_RAW: raw,
    PENALTY: io.PENALTY,
  }
}

/**
 * Server-authoritative tick. Anchored to the most recent server frame (delivered
 * via the 1 Hz `ping` event) and interpolated with wall-clock time so it has
 * per-tick resolution between pings. Both agents re-anchor to the same server
 * frame, keeping their ticks cross-comparable (DESIGN §2.3, §6).
 */
export function tickFrom(
  anchorFrame: number,
  anchorWallMs: number,
  nowMs: number,
  clockMs: number,
): number {
  return anchorFrame + Math.floor((nowMs - anchorWallMs) / clockMs)
}

/** The slice of a pino Logger the pure functions need. */
export interface LoggerLike {
  warn: (obj: Record<string, unknown> | string, msg?: string) => void
  info: (obj: Record<string, unknown> | string, msg?: string) => void
  debug: (obj: Record<string, unknown> | string, msg?: string) => void
}

type Arrow = '↑' | '↓' | '←' | '→'
const ARROW_DIR: Record<Arrow, NonNullable<Tile['dir']>> = {
  '↑': 'up',
  '↓': 'down',
  '←': 'left',
  '→': 'right',
}

/**
 * Map an SDK tile to a domain Tile. Unknown type chars become `wall` (safe by
 * default: a wall blocks pathing and can never trigger an unsafe crate push;
 * DESIGN §15 re-checks admissibility against live state anyway).
 */
export function normalizeTile(io: IOTile, logger: LoggerLike): Tile {
  const pos = { x: io.x, y: io.y }
  switch (io.type) {
    case '0':
      return { pos, type: 'wall' }
    case '1':
      return { pos, type: 'spawner' }
    case '2':
      return { pos, type: 'delivery' }
    case '3':
      return { pos, type: 'walkable' }
    case '4':
      return { pos, type: 'base' }
    case '5':
      return { pos, type: 'slide' }
    case '5!':
      return { pos, type: 'crateSpawner' }
    case '↑':
    case '↓':
    case '←':
    case '→':
      return { pos, type: 'oneway', dir: ARROW_DIR[io.type] }
    default: {
      logger.warn({ type: io.type, pos }, 'unknown tile type, defaulting to wall')
      return { pos, type: 'wall' }
    }
  }
}

function hasPos(e: { x?: number; y?: number }): e is { x: number; y: number } {
  return typeof e.x === 'number' && typeof e.y === 'number'
}

/**
 * Map an SDK sensing event to a domain PerceptionSnapshot. `me` is the latest
 * `you` payload (own position; sensing does not report self). Trust boundary:
 * entities missing id/coords are dropped (with a warn) rather than emitted
 * malformed; agents out of view (no x/y) are dropped silently — that is the
 * normal "not visible" case, not an error.
 */
export function normalizeSensing(
  io: IOSensing,
  me: IOAgent,
  tick: number,
  logger: LoggerLike,
): PerceptionSnapshot {
  const self: SelfObs = {
    id: me.id,
    name: me.name,
    teamId: me.teamId,
    pos: { x: me.x ?? 0, y: me.y ?? 0 },
    score: me.score,
  }

  const parcels: ParcelObs[] = []
  for (const p of io.parcels) {
    if (!p.id || !hasPos(p)) {
      logger.warn({ record: 'parcel' }, 'dropping malformed parcel record')
      continue
    }
    parcels.push({
      id: p.id,
      pos: { x: p.x, y: p.y },
      reward: p.reward,
      carriedBy: p.carriedBy ?? null,
    })
  }

  const agents: AgentObs[] = []
  for (const a of io.agents) {
    if (!a.id) {
      logger.warn({ record: 'agent' }, 'dropping malformed agent record')
      continue
    }
    if (!hasPos(a)) continue // out of view — normal, drop silently
    agents.push({
      id: a.id,
      name: a.name,
      teamId: a.teamId,
      pos: { x: a.x, y: a.y },
      score: a.score,
    })
  }

  const crates: CrateObs[] = []
  for (const c of io.crates) {
    if (!c.id || !hasPos(c)) {
      logger.warn({ record: 'crate' }, 'dropping malformed crate record')
      continue
    }
    crates.push({ id: c.id, pos: { x: c.x, y: c.y } })
  }

  return { tick, self, parcels, agents, crates }
}
