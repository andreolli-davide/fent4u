// tests/bdi-utility-kernel.test.ts
import { test, expect } from 'bun:test'
import { decayConsts, vValue, deliverBundle, bestZone, rate } from '../src/bdi/utility.js'
import type { GameConsts, Pos } from '../src/types/perception.js'
import type { ParcelBelief } from '../src/blackboard/beliefs.js'

const CONSTS: GameConsts = { CLOCK: 50, MOVEMENT_DURATION: 50, OBS_DISTANCE: 5, PARCEL_DECAY_TICKS: 20, PARCEL_DECAY_RAW: '1s', PENALTY: 0 }
const dc = decayConsts(CONSTS)
const p = (id: string, reward: number): ParcelBelief => ({ id, pos: { x: 0, y: 0 }, rewardSeen: reward, carriedBy: null, lastSeen: 0 })

test('vValue sums travel-decayed rewards (m=g=1)', () => {
  // two parcels worth 10 each, L=0, tnow=0 => 20
  expect(vValue([p('a', 10), p('b', 10)], { x: 0, y: 0 }, 0, 0, dc)).toBe(20)
  // L=20 ticks => each loses 0.05*20=1 => 18
  expect(vValue([p('a', 10), p('b', 10)], { x: 0, y: 0 }, 20, 0, dc)).toBeCloseTo(18, 6)
})

test('deliverBundle keeps all positive-reward parcels (default m=1)', () => {
  const b = deliverBundle([p('a', 10), p('b', 6)], { x: 0, y: 0 }, 0, dc)
  expect(b.set.map((x) => x.id).sort()).toEqual(['a', 'b'])
  expect(b.value).toBe(16)
})

test('bestZone prefers the nearer zone after en-route decay (§6.0 check)', () => {
  // 3 parcels @10, rho=0.05. Zone A d=2; Zone B d=58. Decayed: A wins.
  const parcels = [p('a', 10), p('b', 10), p('c', 10)]
  const zones: Pos[] = [{ x: 2, y: 0 }, { x: 58, y: 0 }]
  const dist = (_: Pos, z: Pos): number => z.x // distance == x for this fixture
  const z = bestZone(parcels, { x: 0, y: 0 }, zones, 0, dc, dist, 1.0)
  expect(z?.zone).toEqual({ x: 2, y: 0 })
})

test('rate = value / (L+1)^alpha', () => {
  expect(rate(20, 3, 1.0)).toBe(5) // 20/4
})
