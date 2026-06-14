// tests/deliveroo-consts.test.ts
import { test, expect } from 'bun:test'
import { parseDecayEvent, buildConsts } from '../src/external/deliveroo.js'
import type { IOConfig } from '@unitn-asa/deliveroo-js-sdk'

test('parseDecayEvent maps clock-event strings to ticks at CLOCK=50', () => {
  expect(parseDecayEvent('1s', 50)).toBe(20)
  expect(parseDecayEvent('2s', 50)).toBe(40)
  expect(parseDecayEvent('5s', 50)).toBe(100)
  expect(parseDecayEvent('10s', 50)).toBe(200)
  expect(parseDecayEvent('1m', 50)).toBe(1200)
  expect(parseDecayEvent('1h', 50)).toBe(72000)
})

test('parseDecayEvent: infinite -> Infinity', () => {
  expect(parseDecayEvent('infinite', 50)).toBe(Infinity)
})

test('parseDecayEvent: unknown string falls back to 1s equivalent', () => {
  expect(parseDecayEvent('frame', 50)).toBe(20) // '1s' fallback at CLOCK=50
  expect(parseDecayEvent('banana', 50)).toBe(20)
})

test('buildConsts assembles GameConsts from IOConfig', () => {
  const io: IOConfig = {
    CLOCK: 50,
    PENALTY: 1,
    AGENT_TIMEOUT: 10000,
    BROADCAST_LOGS: false,
    GAME: {
      player: { movement_duration: 50, observation_distance: 5 },
      parcels: { decaying_event: '1s', generation_event: '2s' },
    },
  }
  const consts = buildConsts(io)
  expect(consts).toEqual({
    CLOCK: 50,
    MOVEMENT_DURATION: 50,
    OBS_DISTANCE: 5,
    PARCEL_DECAY_TICKS: 20,
    PARCEL_DECAY_RAW: '1s',
    PENALTY: 1,
  })
})

test('buildConsts: infinite decay yields Infinity ticks, raw preserved', () => {
  const io: IOConfig = {
    CLOCK: 50,
    PENALTY: 1,
    AGENT_TIMEOUT: 10000,
    BROADCAST_LOGS: false,
    GAME: {
      player: { movement_duration: 50, observation_distance: 5 },
      parcels: { decaying_event: 'infinite', generation_event: '2s' },
    },
  }
  const consts = buildConsts(io)
  expect(consts.PARCEL_DECAY_TICKS).toBe(Infinity)
  expect(consts.PARCEL_DECAY_RAW).toBe('infinite')
})
