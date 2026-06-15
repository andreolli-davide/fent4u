import { test, expect } from 'bun:test'
import { runAuction, type AgentSnap } from '../src/coordination/auction.js'
import { decayConsts } from '../src/bdi/utility.js'
import { DEFAULT_PARAMS } from '../src/bdi/params.js'
import type { GameConsts, Pos } from '../src/types/perception.js'
import type { ParcelBelief } from '../src/blackboard/beliefs.js'

const CONSTS: GameConsts = { CLOCK: 50, MOVEMENT_DURATION: 50, OBS_DISTANCE: 5, PARCEL_DECAY_TICKS: 20, PARCEL_DECAY_RAW: '1s', PENALTY: 0 }
const dc = decayConsts(CONSTS)
const manhattan = (a: Pos, b: Pos): number => Math.abs(a.x - b.x) + Math.abs(a.y - b.y)
const parcel = (id: string, x: number, reward = 10): ParcelBelief => ({ id, pos: { x, y: 0 }, rewardSeen: reward, carriedBy: null, lastSeen: 0 })
const zones: Pos[] = [{ x: 0, y: 0 }]

const snap = (id: 'liaison' | 'courier', x: number): AgentSnap => ({ id, pos: { x, y: 0 }, carried: [], claimed: [] })

test('synergy: a parcel goes to the closer agent (cheaper marginal insert), not by count', () => {
  // p1 near courier(1,0), far from liaison(9,0)
  const alloc = runAuction({
    pool: [parcel('p1', 2)], agents: [snap('courier', 1), snap('liaison', 9)],
    enemies: [], zones, dist: manhattan, dc, params: DEFAULT_PARAMS, tnow: 0, epoch: 0, budgetMs: 50,
  })
  expect(alloc.get('p1')).toBe('courier')
})

test('two parcels on one path are both assigned (rounds re-bid)', () => {
  const alloc = runAuction({
    pool: [parcel('p1', 2), parcel('p2', 3)], agents: [snap('courier', 1), snap('liaison', 40)],
    enemies: [], zones, dist: manhattan, dc, params: DEFAULT_PARAMS, tnow: 0, epoch: 0, budgetMs: 50,
  })
  expect(alloc.get('p1')).toBe('courier')
  expect(alloc.get('p2')).toBe('courier')
})

test('zero budget assigns nothing (anytime fallback)', () => {
  const alloc = runAuction({
    pool: [parcel('p1', 2)], agents: [snap('courier', 1), snap('liaison', 9)],
    enemies: [], zones, dist: manhattan, dc, params: DEFAULT_PARAMS, tnow: 0, epoch: 0, budgetMs: 0,
  })
  expect(alloc.size).toBe(0)
})
