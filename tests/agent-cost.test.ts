import { test, expect } from 'bun:test'
import { buildGrid } from '../src/planning/astar.js'
import { decayConsts } from '../src/bdi/utility.js'
import { costPlan } from '../src/mission/agent/cost.js'
import type { Tile, GameConsts, Pos } from '../src/types/perception.js'
import type { WorldSnapshot } from '../src/mission/agent/snapshot.js'

// 1x6 open corridor, y=0, x=0..5; delivery zone at x=5 (TileType 'delivery').
const map: Tile[] = []
for (let x = 0; x <= 5; x++) map.push({ pos: { x, y: 0 }, type: x === 5 ? 'delivery' : 'walkable' })
const grid = buildGrid(map)
const consts: GameConsts = { PARCEL_DECAY_TICKS: Infinity, MOVEMENT_DURATION: 50, CLOCK: 50, OBS_DISTANCE: 5, PARCEL_DECAY_RAW: 'infinite', PENALTY: 0 }
const dc = decayConsts(consts)

const snap: WorldSnapshot = {
  t0: 0, selfPos: { x: 0, y: 0 }, carried: [], delivered: [],
  parcels: [{ id: 'p1', pos: { x: 2, y: 0 }, reward: 30, carriedBy: null }],
  zones: [{ x: 5, y: 0 }], partnerPos: null, sig: 's',
}

// ── Choke-point fixture for mask test ───────────────────────────────────────
// 2-row grid (mirror of dodgeMap in bdi-loop-mission.test.ts):
//   y=0: (0,0)=walkable [START], (1,0)=walkable [CHOKE], (2,0)=delivery [TARGET]
//   y=1: (0,1)=walkable,         (1,1)=walkable,         (2,1)=walkable
// Free straight path: START→CHOKE→TARGET = L 2.
// Masked (CHOKE): detour via y=1 row = START→(0,1)→(1,1)→(2,1)→TARGET = L 4.
const chokeMap: Tile[] = [
  { pos: { x: 0, y: 0 }, type: 'walkable' },
  { pos: { x: 1, y: 0 }, type: 'walkable' },
  { pos: { x: 2, y: 0 }, type: 'delivery' },
  { pos: { x: 0, y: 1 }, type: 'walkable' },
  { pos: { x: 1, y: 1 }, type: 'walkable' },
  { pos: { x: 2, y: 1 }, type: 'walkable' },
]
const chokeGrid = buildGrid(chokeMap)
const START_TILE: Pos = { x: 0, y: 0 }
const CHOKE_TILE: Pos = { x: 1, y: 0 }
const FAR_TILE: Pos = { x: 2, y: 0 }

const makeChokeSnap = (overrides?: Partial<WorldSnapshot>): WorldSnapshot => ({
  t0: 0, selfPos: START_TILE, carried: [], delivered: [],
  parcels: [], zones: [FAR_TILE], partnerPos: null, sig: 'c',
  ...overrides,
})

test('costs goto legs into L and values a delivered parcel into vPlan', () => {
  const steps = [
    { op: 'goto', target: { x: 2, y: 0 } },
    { op: 'pickup', parcelId: 'p1' },
    { op: 'goto', target: { x: 5, y: 0 } },
    { op: 'deliver', zone: { x: 5, y: 0 } },
  ] as const
  const cost = costPlan([...steps], grid, snap, 0, dc, 8)
  expect(cost.reachable).toBe(true)
  expect(cost.L).toBe(5)        // 0->2 (2) + 2->5 (3)
  expect(cost.vPlan).toBe(30)   // p1 reward, no decay (infinite decay), delivered at zone
})

test('unreachable goto marks the plan not reachable', () => {
  const walled: Tile[] = [{ pos: { x: 0, y: 0 }, type: 'walkable' }]
  const g2 = buildGrid(walled)
  const cost = costPlan([{ op: 'goto', target: { x: 9, y: 9 } }], g2, snap, 0, dc, 8)
  expect(cost.reachable).toBe(false)
})

test('a masked tile forces a detour: masked L is strictly greater than free L', () => {
  // Free: START→CHOKE→FAR_TILE = L 2 (straight line).
  // Masked CHOKE: detour via y=1 row = L 4.
  // This is a genuine discriminator — if the mask is silently ignored, both paths score 2.
  const steps = [{ op: 'goto' as const, target: FAR_TILE }]
  const free = costPlan([...steps], chokeGrid, makeChokeSnap(), 0, dc, 8)
  const masked = costPlan([...steps], chokeGrid, makeChokeSnap({ maskTiles: [CHOKE_TILE] }), 0, dc, 8)
  expect(free.L).toBe(2)
  expect(masked.L).toBeGreaterThan(free.L) // detour = 4, never equal if mask is honoured
})
