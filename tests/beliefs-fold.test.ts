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

// crate map for UNKNOWN candidate resolution
const CRATE_MAP: Tile[] = [
  { pos: { x: 5, y: 5 }, type: 'walkable' },
  { pos: { x: 4, y: 5 }, type: 'slide' }, // left of (5,5)
  { pos: { x: 5, y: 4 }, type: 'slide' }, // up of (5,5)
]

test('in-range absent parcel is deleted; out-of-range absent parcel is retained', () => {
  const b = new BeliefBase(SELF0, CONSTS, MAP)
  // tick 100: see two parcels, one near (in range), one far (out of range)
  b.foldPerception(
    snap({
      tick: 100,
      parcels: [
        { id: 'near', pos: { x: 6, y: 5 }, reward: 10, carriedBy: null }, // dist 1
        { id: 'far', pos: { x: 5, y: 12 }, reward: 10, carriedBy: null }, // dist 7 > 5
      ],
    }),
  )
  // tick 101: see neither. 'near' is in range -> deleted; 'far' out of range -> kept
  b.foldPerception(snap({ tick: 101, parcels: [] }))
  expect(b.parcels.has('near')).toBe(false)
  expect(b.parcels.has('far')).toBe(true)
})

test('KNOWN crate seen to have left its in-range tile becomes UNKNOWN with candidates', () => {
  const b = new BeliefBase(SELF0, CONSTS, CRATE_MAP)
  b.foldPerception(snap({ tick: 100, crates: [{ id: 'c1', pos: { x: 5, y: 5 } }] }))
  // tick 101: c1 no longer reported, its tile (5,5) is in range -> it moved
  b.foldPerception(snap({ tick: 101, crates: [] }))
  const c = b.crates.get('c1')
  expect(c?.state).toBe('unknown')
  expect(c?.pos).toBeUndefined()
  expect(c?.candidates).toEqual([{ x: 4, y: 5 }, { x: 5, y: 4 }])
})

test('re-sighting an UNKNOWN crate restores KNOWN and clears candidates', () => {
  const b = new BeliefBase(SELF0, CONSTS, CRATE_MAP)
  b.foldPerception(snap({ tick: 100, crates: [{ id: 'c1', pos: { x: 5, y: 5 } }] }))
  b.foldPerception(snap({ tick: 101, crates: [] })) // -> unknown
  b.foldPerception(snap({ tick: 102, crates: [{ id: 'c1', pos: { x: 4, y: 5 } }] })) // re-seen
  const c = b.crates.get('c1')
  expect(c?.state).toBe('known')
  expect(c?.pos).toEqual({ x: 4, y: 5 })
  expect(c?.candidates).toBeUndefined()
})

test('parcel evicted once age exceeds STALE_TTL (9 * PARCEL_DECAY_TICKS = 180)', () => {
  const b = new BeliefBase(SELF0, CONSTS, MAP)
  // far parcel so it is never deleted by the in-range rule
  b.foldPerception(snap({ tick: 100, parcels: [{ id: 'far', pos: { x: 5, y: 12 }, reward: 10, carriedBy: null }] }))
  // age exactly 180 -> kept (not > 180)
  b.foldPerception(snap({ tick: 280, parcels: [] }))
  expect(b.parcels.has('far')).toBe(true)
  // age 181 -> evicted
  b.foldPerception(snap({ tick: 281, parcels: [] }))
  expect(b.parcels.has('far')).toBe(false)
})

test('agents are never evicted regardless of age', () => {
  const b = new BeliefBase(SELF0, CONSTS, MAP)
  b.foldPerception(snap({ tick: 100, agents: [{ id: 'e', name: 'e', teamId: 'B', pos: { x: 7, y: 5 }, score: 0 }] }))
  b.foldPerception(snap({ tick: 9999, agents: [] }))
  expect(b.agents.has('e')).toBe(true)
})

test('applyPickup sets carriedBy to self and updates carrying', () => {
  const b = new BeliefBase(SELF0, CONSTS, MAP)
  b.foldPerception(snap({ parcels: [{ id: 'p1', pos: { x: 5, y: 5 }, reward: 10, carriedBy: null }] }))
  b.applyPickup(['p1'])
  expect(b.parcels.get('p1')?.carriedBy).toBe('me')
  expect(b.self.carrying).toEqual(['p1'])
})

test('applyDelivery deletes delivered parcels and clears carrying', () => {
  const b = new BeliefBase(SELF0, CONSTS, MAP)
  b.foldPerception(snap({ parcels: [{ id: 'p1', pos: { x: 5, y: 5 }, reward: 10, carriedBy: 'me' }] }))
  b.applyDelivery(['p1'])
  expect(b.parcels.has('p1')).toBe(false)
  expect(b.self.carrying).toEqual([])
})

test('applyDrop nulls carriedBy and repositions at drop tile', () => {
  const b = new BeliefBase(SELF0, CONSTS, MAP)
  b.foldPerception(snap({ parcels: [{ id: 'p1', pos: { x: 5, y: 5 }, reward: 10, carriedBy: 'me' }] }))
  b.applyDrop(['p1'], { x: 3, y: 3 })
  expect(b.parcels.get('p1')?.carriedBy).toBeNull()
  expect(b.parcels.get('p1')?.pos).toEqual({ x: 3, y: 3 })
  expect(b.self.carrying).toEqual([])
})
