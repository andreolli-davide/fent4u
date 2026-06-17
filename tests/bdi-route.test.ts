import { test, expect } from 'bun:test'
import { buildRoute, uRoute, routeFromClaims } from '../src/bdi/route.js'
import { decayConsts, pAvail, rnow, M1, type EnemyThreat } from '../src/bdi/utility.js'
import { buildZoneShaper } from '../src/mission/shapers.js'
import { DEFAULT_PARAMS } from '../src/bdi/params.js'
import type { GameConsts, Pos } from '../src/types/perception.js'
import type { ParcelBelief } from '../src/blackboard/beliefs.js'

const CONSTS: GameConsts = { CLOCK: 50, MOVEMENT_DURATION: 50, OBS_DISTANCE: 5, PARCEL_DECAY_TICKS: 20, PARCEL_DECAY_RAW: '1s', PENALTY: 0 }
const dc = decayConsts(CONSTS)
const manhattan = (a: Pos, b: Pos): number => Math.abs(a.x - b.x) + Math.abs(a.y - b.y)
const md = (a: Pos, b: Pos): { L: number; toll: number } => ({ L: manhattan(a, b), toll: 0 })
const parcel = (id: string, x: number, y: number, reward = 10): ParcelBelief => ({ id, pos: { x, y }, rewardSeen: reward, carriedBy: null, lastSeen: 0 })

const zones: Pos[] = [{ x: 0, y: 0 }]

test('carrying nothing with no pool yields no route', () => {
  expect(buildRoute([], [], { x: 5, y: 5 }, zones, 0, dc, DEFAULT_PARAMS, md)).toBeNull()
})

test('carrying parcels yields a length-0 deliver route', () => {
  const r = buildRoute([parcel('held', 0, 0)], [], { x: 3, y: 0 }, zones, 0, dc, DEFAULT_PARAMS, md)
  expect(r).not.toBeNull()
  expect(r!.pickups).toEqual([])
  expect(r!.zone).toEqual({ x: 0, y: 0 })
})

test('a nearby valuable parcel is folded into the route', () => {
  // self at (1,0), zone at (0,0); a parcel at (2,0) is a cheap fold.
  const r = buildRoute([], [parcel('p1', 2, 0)], { x: 1, y: 0 }, zones, 0, dc, DEFAULT_PARAMS, md)
  expect(r).not.toBeNull()
  expect(r!.pickups.map((p) => p.id)).toEqual(['p1'])
})

test('emergent horizon stops adding when it no longer raises U_route', () => {
  // one good near parcel, one worthless far one; only the near one is folded.
  const pool = [parcel('near', 2, 0, 10), parcel('far', 40, 0, 1)]
  const r = buildRoute([], pool, { x: 1, y: 0 }, zones, 0, dc, DEFAULT_PARAMS, md)
  expect(r!.pickups.map((p) => p.id)).toEqual(['near'])
})

test('uRoute is positive for a valuable reachable route', () => {
  const r = buildRoute([parcel('held', 0, 0)], [], { x: 1, y: 0 }, zones, 0, dc, DEFAULT_PARAMS, md)!
  expect(uRoute(r, 0, dc, DEFAULT_PARAMS)).toBeGreaterThan(0)
})

// ── P_avail weighting (DESIGN §5.5 / §9.2) ──────────────────────────────────
// §9.2: "U_collect(p) is exactly U_route of a length-1 route." That identity
// requires U_route to carry the P_avail factor — value = P_avail · V, not full V.
// The pool is P_avail>0 filtered upstream, but the magnitude must weight value.

test('uRoute of a length-1 route equals P_avail(p)·V({p})/(L+1)^α (the §9.2 identity)', () => {
  const risky = parcel('r', 5, 0, 10)
  const self: Pos = { x: 3, y: 0 }
  const dSelfP = manhattan(self, risky.pos) // 2
  const threats: EnemyThreat[] = [{ age: 0, dToP: 1 }] // an enemy hugging the parcel
  const pa = pAvail(risky, dSelfP, threats, DEFAULT_PARAMS.beta_comp, 0, dc)
  const L = dSelfP + manhattan(risky.pos, zones[0]!) // 2 + 5 = 7
  const expected = (pa * Math.max(0, rnow(risky, 0, dc) - dc.rho * L)) / Math.pow(L + 1, DEFAULT_PARAMS.alpha)

  const weightOf = (q: ParcelBelief): number => (q.id === 'r' ? pa : 1)
  const r = buildRoute([], [risky], self, zones, 0, dc, DEFAULT_PARAMS, md, weightOf)!
  expect(r.L).toBe(L)
  expect(uRoute(r, 0, dc, DEFAULT_PARAMS, weightOf)).toBeCloseTo(expected, 10)
})

test('a contested route is worth strictly less than the same route at full value', () => {
  // identical route; the only difference is the P_avail weight on the pickup.
  const r = buildRoute([], [parcel('r', 5, 0, 10)], { x: 3, y: 0 }, zones, 0, dc, DEFAULT_PARAMS, md)!
  const contested = (q: ParcelBelief): number => (q.id === 'r' ? 0.3 : 1)
  expect(uRoute(r, 0, dc, DEFAULT_PARAMS, contested)).toBeLessThan(uRoute(r, 0, dc, DEFAULT_PARAMS))
})

// ── routeFromClaims: service a committed parcel set in full (§9.7) ──────────

test('routeFromClaims includes every claimed parcel (never drops a low-value one)', () => {
  // a worthless far parcel that buildRoute's emergent horizon would drop is still serviced
  const claimed = [parcel('near', 2, 0, 10), parcel('far', 40, 0, 1)]
  const r = routeFromClaims([], claimed, { x: 1, y: 0 }, zones, 0, dc, DEFAULT_PARAMS, md)!
  expect(r.pickups.map((p) => p.id).sort()).toEqual(['far', 'near'])
})

test('routeFromClaims of an empty commitment is null', () => {
  expect(routeFromClaims([], [], { x: 1, y: 0 }, zones, 0, dc, DEFAULT_PARAMS, md)).toBeNull()
})

test('buildRoute routes to a g=5 zone over a nearer identity zone (§6.0)', () => {
  // self at (0,0); zone A (x=2, g=1), zone B (x=6, g=5). carry one parcel @10, rho=0.05.
  const carried = [parcel('a', 0, 0, 10)]
  const twoZones: Pos[] = [{ x: 2, y: 0 }, { x: 6, y: 0 }]
  const dist = (a: Pos, b: Pos): { L: number; toll: number } => ({ L: Math.abs(b.x - a.x) + Math.abs(b.y - a.y), toll: 0 })
  const g = buildZoneShaper([{ tile: { tag: 'TEXT_BOUND', x: 6, y: 0 }, factor: 5 }])
  const r = buildRoute(carried, [], { x: 0, y: 0 }, twoZones, 0, dc, DEFAULT_PARAMS, dist, undefined, M1, g)
  expect(r?.zone).toEqual({ x: 6, y: 0 })
})

test('Dist tolls flow into Route.toll and reduce uRoute (§7.1)', () => {
  const held = parcel('held', 0, 0, 30) // already at the delivery zone (0,0)
  const noToll = (a: Pos, b: Pos): { L: number; toll: number } => ({ L: manhattan(a, b), toll: 0 })
  const withToll = (a: Pos, b: Pos): { L: number; toll: number } => ({ L: manhattan(a, b), toll: b.x === 0 && b.y === 0 ? 40 : 0 })
  const r0 = buildRoute([held], [], { x: 3, y: 0 }, zones, 0, dc, DEFAULT_PARAMS, noToll)!
  const r1 = buildRoute([held], [], { x: 3, y: 0 }, zones, 0, dc, DEFAULT_PARAMS, withToll)!
  expect(r0.toll).toBe(0)
  expect(r1.toll).toBe(40)
  expect(uRoute(r1, 0, dc, DEFAULT_PARAMS)).toBeLessThan(uRoute(r0, 0, dc, DEFAULT_PARAMS))
})
