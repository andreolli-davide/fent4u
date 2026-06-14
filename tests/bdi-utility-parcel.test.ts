import { test, expect } from 'bun:test'
import { decayConsts, rnow, psurv, raceDiscount, pAvail } from '../src/bdi/utility.js'
import type { GameConsts } from '../src/types/perception.js'
import type { ParcelBelief } from '../src/blackboard/beliefs.js'

const CONSTS: GameConsts = {
  CLOCK: 50,
  MOVEMENT_DURATION: 50,
  OBS_DISTANCE: 5,
  PARCEL_DECAY_TICKS: 20,
  PARCEL_DECAY_RAW: '1s',
  PENALTY: 0,
}
const dc = decayConsts(CONSTS)

function parcel(over: Partial<ParcelBelief> = {}): ParcelBelief {
  return { id: 'p', pos: { x: 0, y: 0 }, rewardSeen: 10, carriedBy: null, lastSeen: 0, ...over }
}

test('rho = 1/decayIntervalTicks under default config', () => {
  expect(dc.rho).toBeCloseTo(0.05, 6)
})

test('rnow decays linearly and floors at 0', () => {
  expect(rnow(parcel(), 0, dc)).toBe(10)
  expect(rnow(parcel(), 20, dc)).toBeCloseTo(9, 6) // 10 - 0.05*20
  expect(rnow(parcel({ rewardSeen: 1 }), 1000, dc)).toBe(0) // floored
})

test('psurv decays with age + travel', () => {
  // lambda = ln2/(3*20); at age+d = 60, exactly one halving => ~0.5
  expect(psurv(parcel(), 0, 60, dc)).toBeCloseTo(0.5, 3)
})

test('raceDiscount: a fresh closer enemy discounts; an equal/farther one does not', () => {
  const enemiesCloser = [{ age: 0, dToP: 1 }] // dSelf=5, dEnemy=1 => closer
  expect(raceDiscount(5, enemiesCloser, dc.lambdaAgent, 0.7, dc)).toBeLessThan(1)
  const enemiesFarther = [{ age: 0, dToP: 9 }]
  expect(raceDiscount(5, enemiesFarther, dc.lambdaAgent, 0.7, dc)).toBe(1) // clamp at 0
})

test('pAvail is 0 for a carried parcel', () => {
  expect(pAvail(parcel({ carriedBy: 'enemy1' }), 1, [], 0.7, 0, dc)).toBe(0)
})
