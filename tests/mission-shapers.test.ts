// tests/mission-shapers.test.ts
import { test, expect } from 'bun:test'
import { buildCountShaper, buildZoneShaper, bestSubset } from '../src/mission/shapers.js'
import { M1, G1, decayConsts, type BundleFilter } from '../src/bdi/utility.js'
import type { GameConsts } from '../src/types/perception.js'
import type { ParcelBelief } from '../src/blackboard/beliefs.js'

const CONSTS: GameConsts = { CLOCK: 50, MOVEMENT_DURATION: 50, OBS_DISTANCE: 5, PARCEL_DECAY_TICKS: 20, PARCEL_DECAY_RAW: '1s', PENALTY: 0 }
const dc = decayConsts(CONSTS)
const p = (id: string, reward: number): ParcelBelief => ({ id, pos: { x: 0, y: 0 }, rewardSeen: reward, carriedBy: null, lastSeen: 0 })
const tile = { x: 0, y: 0 }

test('buildCountShaper maps stated counts, identity elsewhere; identity when absent', () => {
  const m = buildCountShaper({ '3': 2, '5': 0.3 })
  expect(m(3)).toBe(2)
  expect(m(5)).toBe(0.3)
  expect(m(1)).toBe(1)
  expect(m(4)).toBe(1)
  expect(buildCountShaper(undefined)).toBe(M1)
  expect(buildCountShaper({})).toBe(M1)
})

test('buildCountShaper ignores non-positive / non-integer / non-finite keys & factors', () => {
  const m = buildCountShaper({ '0': 5, '-1': 5, '2.5': 5, '2': Infinity, '3': 4 })
  expect(m(3)).toBe(4)
  expect(m(0)).toBe(1)
  expect(m(2)).toBe(1)
})

test('buildZoneShaper maps TEXT_BOUND tiles, identity elsewhere; skips RUNTIME_BOUND', () => {
  const g = buildZoneShaper([
    { tile: { tag: 'TEXT_BOUND', x: 1, y: 2 }, factor: 5 },
    { tile: { tag: 'RUNTIME_BOUND', rule: 'nearest' }, factor: 9 },
  ])
  expect(g({ x: 1, y: 2 })).toBe(5)
  expect(g({ x: 0, y: 0 })).toBe(1)
  expect(buildZoneShaper(undefined)).toBe(G1)
  expect(buildZoneShaper([])).toBe(G1)
  expect(buildZoneShaper([{ tile: { tag: 'RUNTIME_BOUND', rule: 'x' }, factor: 5 }])).toBe(G1)
})

test('m=1: keeps all positive-Rnow parcels (base play unchanged)', () => {
  const b = bestSubset([p('a', 10), p('b', 6)], tile, 0, dc, M1, G1, 3)
  expect(b.set.map((x) => x.id).sort()).toEqual(['a', 'b'])
  expect(b.value).toBe(16)
})

test('count shaper x2 at k=3: drop-3-hold-1 from 4 carried', () => {
  const carried = [p('a', 10), p('b', 9), p('c', 8), p('d', 1)]
  const b = bestSubset(carried, tile, 0, dc, buildCountShaper({ '3': 2 }), G1, 3)
  expect(b.set.map((x) => x.id).sort()).toEqual(['a', 'b', 'c'])
  expect(b.value).toBe(54)
})

test('count penalty m(5)=0.3: never delivers the penalised count (splits to 4)', () => {
  const carried = [p('a', 10), p('b', 10), p('c', 10), p('d', 10), p('e', 10)]
  const b = bestSubset(carried, tile, 0, dc, buildCountShaper({ '5': 0.3 }), G1, 3)
  expect(b.set.length).toBe(4)
  expect(b.value).toBe(40)
})

test('zone shaper multiplies the bundle value', () => {
  const b = bestSubset([p('a', 10)], { x: 1, y: 2 }, 0, dc, M1, buildZoneShaper([{ tile: { tag: 'TEXT_BOUND', x: 1, y: 2 }, factor: 5 }]), 3)
  expect(b.value).toBe(50)
})

test('expiry floor forces an about-to-decay parcel into the bundle despite a hold bonus', () => {
  // d at Rnow=0.1 <= rho*floor (0.05*3=0.15) -> forced. m(3)=2 would otherwise drop it.
  const carried = [p('a', 10), p('b', 9), p('c', 8), p('d', 0.1)]
  const b = bestSubset(carried, tile, 0, dc, buildCountShaper({ '3': 2 }), G1, 3)
  expect(b.set.map((x) => x.id)).toContain('d')
})

test('drops zero/negative Rnow parcels; empty carried -> empty bundle', () => {
  expect(bestSubset([], tile, 0, dc, M1, G1, 3).set).toEqual([])
  const b = bestSubset([p('a', 10), p('z', 0)], tile, 0, dc, M1, G1, 3)
  expect(b.set.map((x) => x.id)).toEqual(['a'])
})

test('bestSubset excludes a parcel that trips a REWARD_THRESHOLD filter', () => {
  const dcInf = { rho: 0, lambda: 0, lambdaAgent: 0, decayIntervalTicks: Infinity }
  const mkc = (id: string, reward: number) => ({ id, pos: { x: 0, y: 0 }, rewardSeen: reward, carriedBy: 'me', lastSeen: 0 })
  const carried = [mkc('a', 5), mkc('b', 50)] // b > 10
  const overTen: BundleFilter = (S) => S.every((p) => p.rewardSeen <= 10)
  const r = bestSubset(carried, { x: 1, y: 1 }, 0, dcInf, M1, G1, 0, overTen)
  expect(r.set.map((p) => p.id)).toEqual(['a'])
  expect(r.value).toBe(5)
})

test('bestSubset with F1 default is unchanged', () => {
  const dcInf = { rho: 0, lambda: 0, lambdaAgent: 0, decayIntervalTicks: Infinity }
  const mkc = (id: string, reward: number) => ({ id, pos: { x: 0, y: 0 }, rewardSeen: reward, carriedBy: 'me', lastSeen: 0 })
  const carried = [mkc('a', 5), mkc('b', 50)]
  const r = bestSubset(carried, { x: 1, y: 1 }, 0, dcInf, M1, G1, 0)
  expect(r.value).toBe(55)
})
