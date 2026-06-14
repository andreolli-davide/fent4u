import { test, expect } from 'bun:test'
import { buildRoute, uRoute } from '../src/bdi/route.js'
import { decayConsts } from '../src/bdi/utility.js'
import { DEFAULT_PARAMS } from '../src/bdi/params.js'
import type { GameConsts, Pos } from '../src/types/perception.js'
import type { ParcelBelief } from '../src/blackboard/beliefs.js'

const CONSTS: GameConsts = { CLOCK: 50, MOVEMENT_DURATION: 50, OBS_DISTANCE: 5, PARCEL_DECAY_TICKS: 20, PARCEL_DECAY_RAW: '1s', PENALTY: 0 }
const dc = decayConsts(CONSTS)
const manhattan = (a: Pos, b: Pos): number => Math.abs(a.x - b.x) + Math.abs(a.y - b.y)
const parcel = (id: string, x: number, y: number, reward = 10): ParcelBelief => ({ id, pos: { x, y }, rewardSeen: reward, carriedBy: null, lastSeen: 0 })

const zones: Pos[] = [{ x: 0, y: 0 }]

test('carrying nothing with no pool yields no route', () => {
  expect(buildRoute([], [], { x: 5, y: 5 }, zones, 0, dc, DEFAULT_PARAMS, manhattan)).toBeNull()
})

test('carrying parcels yields a length-0 deliver route', () => {
  const r = buildRoute([parcel('held', 0, 0)], [], { x: 3, y: 0 }, zones, 0, dc, DEFAULT_PARAMS, manhattan)
  expect(r).not.toBeNull()
  expect(r!.pickups).toEqual([])
  expect(r!.zone).toEqual({ x: 0, y: 0 })
})

test('a nearby valuable parcel is folded into the route', () => {
  // self at (1,0), zone at (0,0); a parcel at (2,0) is a cheap fold.
  const r = buildRoute([], [parcel('p1', 2, 0)], { x: 1, y: 0 }, zones, 0, dc, DEFAULT_PARAMS, manhattan)
  expect(r).not.toBeNull()
  expect(r!.pickups.map((p) => p.id)).toEqual(['p1'])
})

test('emergent horizon stops adding when it no longer raises U_route', () => {
  // one good near parcel, one worthless far one; only the near one is folded.
  const pool = [parcel('near', 2, 0, 10), parcel('far', 40, 0, 1)]
  const r = buildRoute([], pool, { x: 1, y: 0 }, zones, 0, dc, DEFAULT_PARAMS, manhattan)
  expect(r!.pickups.map((p) => p.id)).toEqual(['near'])
})

test('uRoute is positive for a valuable reachable route', () => {
  const r = buildRoute([parcel('held', 0, 0)], [], { x: 1, y: 0 }, zones, 0, dc, DEFAULT_PARAMS, manhattan)!
  expect(uRoute(r, 0, dc, DEFAULT_PARAMS)).toBeGreaterThan(0)
})
