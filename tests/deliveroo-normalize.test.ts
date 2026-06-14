// tests/deliveroo-normalize.test.ts
import { test, expect } from 'bun:test'
import { normalizeTile } from '../src/external/deliveroo.js'
import type { IOTile } from '@unitn-asa/deliveroo-js-sdk'

// minimal logger spy capturing warn calls
function spyLogger() {
  const warns: unknown[][] = []
  return {
    logger: {
      warn: (...args: unknown[]) => {
        warns.push(args)
      },
      info: () => {},
      debug: () => {},
    },
    warns,
  }
}

test('normalizeTile maps basic tile types', () => {
  const { logger } = spyLogger()
  expect(normalizeTile({ x: 1, y: 2, type: '0' }, logger)).toEqual({
    pos: { x: 1, y: 2 },
    type: 'wall',
  })
  expect(normalizeTile({ x: 0, y: 0, type: '1' }, logger).type).toBe('spawner')
  expect(normalizeTile({ x: 0, y: 0, type: '2' }, logger).type).toBe('delivery')
  expect(normalizeTile({ x: 0, y: 0, type: '3' }, logger).type).toBe('walkable')
  expect(normalizeTile({ x: 0, y: 0, type: '4' }, logger).type).toBe('base')
  expect(normalizeTile({ x: 0, y: 0, type: '5' }, logger).type).toBe('slide')
  expect(normalizeTile({ x: 0, y: 0, type: '5!' }, logger).type).toBe('crateSpawner')
})

test('normalizeTile maps directional arrows to oneway with dir', () => {
  const { logger } = spyLogger()
  expect(normalizeTile({ x: 0, y: 0, type: '↑' }, logger)).toEqual({
    pos: { x: 0, y: 0 },
    type: 'oneway',
    dir: 'up',
  })
  expect(normalizeTile({ x: 0, y: 0, type: '↓' }, logger).dir).toBe('down')
  expect(normalizeTile({ x: 0, y: 0, type: '←' }, logger).dir).toBe('left')
  expect(normalizeTile({ x: 0, y: 0, type: '→' }, logger).dir).toBe('right')
})

test('normalizeTile: unknown char -> wall + warn', () => {
  const { logger, warns } = spyLogger()
  // force an invalid type past the type system
  const bad = { x: 3, y: 4, type: '9' } as unknown as IOTile
  const tile = normalizeTile(bad, logger)
  expect(tile).toEqual({ pos: { x: 3, y: 4 }, type: 'wall' })
  expect(warns.length).toBe(1)
})

// --- normalizeSensing tests (appended) ---
import { normalizeSensing } from '../src/external/deliveroo.js'
import type { IOSensing, IOAgent } from '@unitn-asa/deliveroo-js-sdk'

const selfMe: IOAgent = {
  id: 'self1',
  name: 'Courier',
  teamId: 'team1',
  teamName: 'Team One',
  x: 5,
  y: 5,
  score: 42,
  penalty: 0,
}

test('normalizeSensing builds a snapshot with self, parcels, agents, crates', () => {
  const { logger } = spyLogger()
  const io: IOSensing = {
    positions: [],
    agents: [
      {
        id: 'a2',
        name: 'Other',
        teamId: 'team2',
        teamName: 'Team Two',
        x: 1,
        y: 1,
        score: 3,
        penalty: 0,
      },
    ],
    parcels: [
      { id: 'p1', x: 2, y: 3, reward: 10 }, // carriedBy undefined
      { id: 'p2', x: 4, y: 4, reward: 5, carriedBy: 'self1' },
    ],
    crates: [{ id: 'c1', x: 7, y: 8 }],
  }
  const snap = normalizeSensing(io, selfMe, 123, logger)
  expect(snap.tick).toBe(123)
  expect(snap.self).toEqual({
    id: 'self1',
    name: 'Courier',
    teamId: 'team1',
    pos: { x: 5, y: 5 },
    score: 42,
  })
  expect(snap.parcels).toEqual([
    { id: 'p1', pos: { x: 2, y: 3 }, reward: 10, carriedBy: null },
    { id: 'p2', pos: { x: 4, y: 4 }, reward: 5, carriedBy: 'self1' },
  ])
  expect(snap.agents).toEqual([
    { id: 'a2', name: 'Other', teamId: 'team2', pos: { x: 1, y: 1 }, score: 3 },
  ])
  expect(snap.crates).toEqual([{ id: 'c1', pos: { x: 7, y: 8 } }])
})

test('normalizeSensing drops agents with no position (out of view)', () => {
  const { logger } = spyLogger()
  const io: IOSensing = {
    positions: [],
    agents: [
      { id: 'ghost', name: 'NoPos', teamId: 't', teamName: 'T', score: 0, penalty: 0 },
    ],
    parcels: [],
    crates: [],
  }
  const snap = normalizeSensing(io, selfMe, 1, logger)
  expect(snap.agents).toEqual([])
})

test('normalizeSensing drops a malformed parcel record but keeps the rest', () => {
  const { logger, warns } = spyLogger()
  const io = {
    positions: [],
    agents: [],
    parcels: [
      { id: 'good', x: 1, y: 1, reward: 5 },
      { x: 2, y: 2, reward: 5 }, // missing id
    ],
    crates: [],
  } as unknown as IOSensing
  const snap = normalizeSensing(io, selfMe, 1, logger)
  expect(snap.parcels).toEqual([
    { id: 'good', pos: { x: 1, y: 1 }, reward: 5, carriedBy: null },
  ])
  expect(warns.length).toBe(1)
})
