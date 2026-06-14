// src/external/deliveroo.ts
import type { IOConfig } from '@unitn-asa/deliveroo-js-sdk'
import type { GameConsts } from '../types/perception.js'

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
 * 'infinite' -> Infinity (no decay). Unknown string -> '1s' equivalent
 * (matches the SDK's parseClockEvent fallback). Mechanical only; utility.ts
 * owns the rate formulas (ρ/λ).
 */
export function parseDecayEvent(ev: string, clockMs: number): number {
  if (ev === 'infinite') return Infinity
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
