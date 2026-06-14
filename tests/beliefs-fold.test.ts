// tests/beliefs-fold.test.ts
import { test, expect } from 'bun:test'
import { BeliefBase } from '../src/blackboard/beliefs.js'
import type { GameConsts, Tile, SelfObs, PerceptionSnapshot } from '../src/types/perception.js'

const CONSTS: GameConsts = {
  CLOCK: 50,
  MOVEMENT_DURATION: 50,
  OBS_DISTANCE: 5,
  PARCEL_DECAY_TICKS: 20,
  PARCEL_DECAY_RAW: '1s',
  PENALTY: 1,
}

const SELF0: SelfObs = { id: 'me', name: 'me', teamId: 'A', pos: { x: 5, y: 5 }, score: 0 }

// a tiny map: enough tiles that crate candidates can resolve in later tasks
const MAP: Tile[] = [{ pos: { x: 5, y: 5 }, type: 'walkable' }]

function snap(partial: Partial<PerceptionSnapshot>): PerceptionSnapshot {
  return {
    tick: 100,
    self: { id: 'me', name: 'me', teamId: 'A', pos: { x: 5, y: 5 }, score: 7 },
    parcels: [],
    agents: [],
    crates: [],
    ...partial,
  }
}

test('construction seeds self, empty maps', () => {
  const b = new BeliefBase(SELF0, CONSTS, MAP)
  expect(b.self).toEqual({ id: 'me', name: 'me', teamId: 'A', pos: { x: 5, y: 5 }, score: 0, carrying: [] })
  expect(b.parcels.size).toBe(0)
  expect(b.agents.size).toBe(0)
  expect(b.crates.size).toBe(0)
})

test('foldPerception upserts parcels with frozen reward and lastSeen=tick', () => {
  const b = new BeliefBase(SELF0, CONSTS, MAP)
  b.foldPerception(snap({ tick: 100, parcels: [{ id: 'p1', pos: { x: 6, y: 5 }, reward: 42, carriedBy: null }] }))
  expect(b.parcels.get('p1')).toEqual({ id: 'p1', pos: { x: 6, y: 5 }, rewardSeen: 42, carriedBy: null, lastSeen: 100 })
})

test('foldPerception updates self position/score from snapshot', () => {
  const b = new BeliefBase(SELF0, CONSTS, MAP)
  b.foldPerception(snap({ self: { id: 'me', name: 'me', teamId: 'A', pos: { x: 9, y: 1 }, score: 30 } }))
  expect(b.self.pos).toEqual({ x: 9, y: 1 })
  expect(b.self.score).toBe(30)
})

test('foldPerception classifies agents by teamId', () => {
  const b = new BeliefBase(SELF0, CONSTS, MAP)
  b.foldPerception(
    snap({
      agents: [
        { id: 'p', name: 'p', teamId: 'A', pos: { x: 4, y: 5 }, score: 0 },
        { id: 'e', name: 'e', teamId: 'B', pos: { x: 7, y: 5 }, score: 0 },
      ],
    }),
  )
  expect(b.agents.get('p')?.rel).toBe('partner')
  expect(b.agents.get('e')?.rel).toBe('enemy')
  expect(b.agents.get('p')?.lastSeen).toBe(100)
})

test('foldPerception upserts crates as KNOWN, defaulting locked false', () => {
  const b = new BeliefBase(SELF0, CONSTS, MAP)
  b.foldPerception(snap({ crates: [{ id: 'c1', pos: { x: 4, y: 5 } }] }))
  expect(b.crates.get('c1')).toEqual({ id: 'c1', state: 'known', pos: { x: 4, y: 5 }, candidates: undefined, locked: false, lastSeen: 100 })
})

test('self.carrying derives parcels carriedBy self', () => {
  const b = new BeliefBase(SELF0, CONSTS, MAP)
  b.foldPerception(
    snap({
      parcels: [
        { id: 'mine', pos: { x: 5, y: 5 }, reward: 10, carriedBy: 'me' },
        { id: 'other', pos: { x: 6, y: 5 }, reward: 10, carriedBy: 'e' },
        { id: 'free', pos: { x: 4, y: 5 }, reward: 10, carriedBy: null },
      ],
    }),
  )
  expect(b.self.carrying).toEqual(['mine'])
})
