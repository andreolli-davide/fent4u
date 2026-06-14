// tests/beliefs-delta.test.ts
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
const MAP: Tile[] = [{ pos: { x: 5, y: 5 }, type: 'walkable' }]
const SELF_A: SelfObs = { id: 'A', name: 'A', teamId: 'T', pos: { x: 5, y: 5 }, score: 0 }
const SELF_B: SelfObs = { id: 'B', name: 'B', teamId: 'T', pos: { x: 1, y: 1 }, score: 0 }

function snap(self: SelfObs, partial: Partial<PerceptionSnapshot>): PerceptionSnapshot {
  return {
    tick: 100,
    self: { id: self.id, name: self.name, teamId: self.teamId, pos: self.pos, score: self.score },
    parcels: [],
    agents: [],
    crates: [],
    ...partial,
  }
}

test('computeDelta emits only dirtied entities, then clears', () => {
  const b = new BeliefBase(SELF_A, CONSTS, MAP)
  b.foldPerception(snap(SELF_A, { tick: 100, parcels: [{ id: 'p1', pos: { x: 6, y: 5 }, reward: 9, carriedBy: null }] }))
  const d1 = b.computeDelta()
  expect(d1.tick).toBe(100)
  expect(d1.parcels.upsert.map((p) => p.id)).toEqual(['p1'])
  expect(d1.self?.id).toBe('A')
  // second call with no changes -> empty
  const d2 = b.computeDelta()
  expect(d2.parcels.upsert).toEqual([])
  expect(d2.parcels.remove).toEqual([])
  expect(d2.self).toBeNull()
})

test('round-trip: applyDelta replicates a parcel into a peer base', () => {
  const a = new BeliefBase(SELF_A, CONSTS, MAP)
  const b = new BeliefBase(SELF_B, CONSTS, MAP)
  a.foldPerception(snap(SELF_A, { tick: 100, parcels: [{ id: 'p1', pos: { x: 6, y: 5 }, reward: 9, carriedBy: null }] }))
  b.applyDelta(a.computeDelta())
  expect(b.parcels.get('p1')).toEqual({ id: 'p1', pos: { x: 6, y: 5 }, rewardSeen: 9, carriedBy: null, lastSeen: 100 })
})

test("applyDelta folds sender self into receiver agents as rel=partner with delta tick", () => {
  const a = new BeliefBase(SELF_A, CONSTS, MAP)
  const b = new BeliefBase(SELF_B, CONSTS, MAP)
  a.foldPerception(snap(SELF_A, { tick: 100, self: { id: 'A', name: 'A', teamId: 'T', pos: { x: 8, y: 8 }, score: 5 } }))
  b.applyDelta(a.computeDelta())
  const partner = b.agents.get('A')
  expect(partner).toEqual({ id: 'A', pos: { x: 8, y: 8 }, rel: 'partner', lastSeen: 100, carrying: [] })
  expect(b.self.id).toBe('B') // receiver's own self untouched
})

test('applyDelta does not dirty the receiver (no echo)', () => {
  const a = new BeliefBase(SELF_A, CONSTS, MAP)
  const b = new BeliefBase(SELF_B, CONSTS, MAP)
  a.foldPerception(snap(SELF_A, { tick: 100, parcels: [{ id: 'p1', pos: { x: 6, y: 5 }, reward: 9, carriedBy: null }] }))
  b.applyDelta(a.computeDelta())
  const echo = b.computeDelta()
  expect(echo.parcels.upsert).toEqual([])
  expect(echo.self).toBeNull()
})

test('applyDelta remove deletes the parcel', () => {
  const a = new BeliefBase(SELF_A, CONSTS, MAP)
  const b = new BeliefBase(SELF_B, CONSTS, MAP)
  // seed both with p1
  a.foldPerception(snap(SELF_A, { tick: 100, parcels: [{ id: 'p1', pos: { x: 6, y: 5 }, reward: 9, carriedBy: null }] }))
  b.applyDelta(a.computeDelta())
  // A delivers p1 -> remove
  a.applyDelivery(['p1'])
  b.applyDelta(a.computeDelta())
  expect(b.parcels.has('p1')).toBe(false)
})

test('fold-removed parcel surfaces in computeDelta().parcels.remove', () => {
  const a = new BeliefBase(SELF_A, CONSTS, MAP)
  // see p1 in range at tick 100
  a.foldPerception(snap(SELF_A, { tick: 100, parcels: [{ id: 'p1', pos: { x: 6, y: 5 }, reward: 9, carriedBy: null }] }))
  a.computeDelta() // drain
  // tick 101: p1 in range but no longer perceived -> fold deletes it
  a.foldPerception(snap(SELF_A, { tick: 101, parcels: [] }))
  const d = a.computeDelta()
  expect(d.parcels.remove).toContain('p1')
  expect(d.parcels.upsert.map((p) => p.id)).not.toContain('p1')
})

test('mergeByLastSeen: stale remote upsert does not overwrite fresher local record', () => {
  const b = new BeliefBase(SELF_B, CONSTS, MAP)
  const a = new BeliefBase(SELF_A, CONSTS, MAP)
  // local b has fresh p1 at tick 200
  b.foldPerception(snap(SELF_B, { tick: 200, parcels: [{ id: 'p1', pos: { x: 1, y: 2 }, reward: 50, carriedBy: null }] }))
  // a has stale p1 at tick 100
  a.foldPerception(snap(SELF_A, { tick: 100, parcels: [{ id: 'p1', pos: { x: 6, y: 5 }, reward: 9, carriedBy: null }] }))
  b.applyDelta(a.computeDelta())
  expect(b.parcels.get('p1')?.lastSeen).toBe(200) // fresher local kept
  expect(b.parcels.get('p1')?.rewardSeen).toBe(50)
})

test('computeSnapshot then applySnapshot hydrates an empty base to equality', () => {
  const a = new BeliefBase(SELF_A, CONSTS, MAP)
  a.foldPerception(
    snap(SELF_A, {
      tick: 150,
      parcels: [{ id: 'p1', pos: { x: 6, y: 5 }, reward: 9, carriedBy: null }],
      agents: [{ id: 'E', name: 'E', teamId: 'X', pos: { x: 7, y: 5 }, score: 0 }],
      crates: [{ id: 'c1', pos: { x: 4, y: 5 } }],
    }),
  )
  const fresh = new BeliefBase(SELF_B, CONSTS, MAP)
  fresh.applySnapshot(a.computeSnapshot())
  expect(fresh.parcels.get('p1')).toEqual(a.parcels.get('p1')!)
  expect(fresh.crates.get('c1')).toEqual(a.crates.get('c1')!)
  // enemy E replicated, and sender A folded in as partner
  expect(fresh.agents.get('E')?.rel).toBe('enemy')
  expect(fresh.agents.get('A')?.rel).toBe('partner')
})

test('computeSnapshot carries every record regardless of dirty state', () => {
  const a = new BeliefBase(SELF_A, CONSTS, MAP)
  a.foldPerception(snap(SELF_A, { tick: 150, parcels: [{ id: 'p1', pos: { x: 6, y: 5 }, reward: 9, carriedBy: null }] }))
  a.computeDelta() // drains dirty
  const s = a.computeSnapshot()
  expect(s.parcels.upsert.map((p) => p.id)).toEqual(['p1']) // still present despite no dirt
  expect(s.tick).toBe(150)
})
