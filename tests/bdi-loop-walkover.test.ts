// tests/bdi-loop-walkover.test.ts
// Investigation (systematic-debugging Phase 1/3): the reported bug is
// "agent walks over a parcel without picking it up, then comes back later".
// Hypothesis A (opportunistic-grab missing): falsified below — routing already
// folds any in-pool parcel that lies on the path (ΔL≈0) or underfoot (d=0).
// Hypothesis B (pool exclusion via race discount): reproduced below.
import { test, expect } from 'bun:test'
import { BdiLoop } from '../src/bdi/loop.js'
import { DEFAULT_PARAMS } from '../src/bdi/params.js'
import { decayConsts, pAvail, rnow, type EnemyThreat } from '../src/bdi/utility.js'
import type { ParcelBelief } from '../src/blackboard/beliefs.js'
import type { DeliverooClient } from '../src/external/deliveroo.js'
import type { GameConsts, Tile, Pos, PerceptionSnapshot, PickResult, ParcelObs, AgentObs } from '../src/types/perception.js'

const CONSTS: GameConsts = { CLOCK: 50, MOVEMENT_DURATION: 50, OBS_DISTANCE: 5, PARCEL_DECAY_TICKS: 20, PARCEL_DECAY_RAW: '1s', PENALTY: 0 }
const dc = decayConsts(CONSTS)

// open row x=0..6, delivery zone at (0,0)
function rowMap(): Tile[] {
  const tiles: Tile[] = [{ pos: { x: 0, y: 0 }, type: 'delivery' }]
  for (let x = 1; x < 7; x++) tiles.push({ pos: { x, y: 0 }, type: 'walkable' })
  return tiles
}

interface Recorder {
  moves: string[]
  pickups: number
  putdowns: string[][]
  client: DeliverooClient
}

function fakeClient(map: Tile[]): Recorder {
  const rec: Recorder = { moves: [], pickups: 0, putdowns: [], client: null as never }
  rec.client = {
    role: 'courier', consts: CONSTS, map, tick: () => 0,
    onPerception: () => {}, onConnect: () => {}, onDisconnect: () => {},
    move: async (dir) => { rec.moves.push(dir); return { x: 0, y: 0 } as Pos },
    pickup: async (): Promise<PickResult[]> => { rec.pickups++; return [] },
    putdown: async (ids?: string[]): Promise<PickResult[]> => { rec.putdowns.push(ids ?? []); return (ids ?? []).map((id) => ({ id })) },
    onMissionMsg: () => {}, say: async () => 'successful', ask: async () => ({}), shout: async () => ({}), close: () => {},
  }
  return rec
}

const snap = (over: Partial<PerceptionSnapshot>): PerceptionSnapshot => ({
  tick: 1,
  self: { id: 'me', name: 'me', teamId: 'A', pos: { x: 3, y: 0 }, score: 0 },
  parcels: [], agents: [], crates: [], ...over,
})

const at = (x: number): PerceptionSnapshot['self'] => ({ id: 'me', name: 'me', teamId: 'A', pos: { x, y: 0 }, score: 0 })
const pcl = (id: string, x: number, reward = 10): ParcelObs => ({ id, pos: { x, y: 0 }, reward, carriedBy: null })

// ── Hypothesis A: an available parcel underfoot is grabbed, never walked over ──
test('A1: standing on a free parcel while empty-handed → picks up (folded as head, d=0)', async () => {
  const rec = fakeClient(rowMap())
  const loop = new BdiLoop(rec.client, DEFAULT_PARAMS, { info: () => {}, debug: () => {}, warn: () => {} })
  await loop.tick(snap({ self: at(3), parcels: [pcl('here', 3), pcl('far', 6)] }))
  expect(rec.pickups).toBe(1)
  expect(rec.moves).toEqual([]) // no walk-past
})

test('A2: a parcel on the path to a farther target becomes the head (no walk-over)', async () => {
  const rec = fakeClient(rowMap())
  const loop = new BdiLoop(rec.client, DEFAULT_PARAMS, { info: () => {}, debug: () => {}, warn: () => {} })
  // self at (1,0); cross parcel at (3,0) on the way to far (6,0). Heads to cross first.
  await loop.tick(snap({ self: at(1), parcels: [pcl('cross', 3), pcl('far', 6)] }))
  expect(rec.moves).toEqual(['right']) // toward cross, not skipping it
})

// ── Fixed: route value is weighted by P_avail (DESIGN §5.5/§9.2) ──
// A parcel guarded by a strictly-closer fresh enemy is race-discounted, so the
// committed route's utility is P_avail · V — NOT full V. The first *move* on a
// 1-D row is geometry-determined (the contested parcel is the only candidate, so
// the agent still heads toward it), so we assert the committed *value* instead,
// read from the intent-switch log's `uTo`. Fixed by weighting vValue per parcel.
test('a strongly-contested parcel commits at its P_avail-weighted value, not full V', async () => {
  const rec = fakeClient(rowMap())
  const infos: { obj: Record<string, unknown>; msg?: string }[] = []
  const log = { info: (obj: Record<string, unknown>, msg?: string) => infos.push({ obj, msg }), debug: () => {}, warn: () => {} }
  const loop = new BdiLoop(rec.client, DEFAULT_PARAMS, log)
  // self (3,0); risky parcel (5,0); a fresh enemy hugging it from the far side (6,0).
  const enemies: AgentObs[] = [{ id: 'e1', name: 'e1', teamId: 'B', pos: { x: 6, y: 0 }, score: 0 }]
  await loop.tick(snap({ self: at(3), parcels: [pcl('risky', 5)], agents: enemies }))

  // Expected P_avail-weighted route utility on the open row (planPath == manhattan):
  //   dSelfP = 2, L = d(self,risky) + d(risky,zone) = 2 + 5 = 7, enemy is 1 from risky.
  const risky: ParcelBelief = { id: 'risky', pos: { x: 5, y: 0 }, rewardSeen: 10, carriedBy: null, lastSeen: 1 }
  const threats: EnemyThreat[] = [{ age: 0, dToP: 1 }]
  const pa = pAvail(risky, 2, threats, DEFAULT_PARAMS.beta_comp, 1, dc)
  const L = 7
  const weighted = (pa * Math.max(0, rnow(risky, 1, dc) - dc.rho * L)) / Math.pow(L + 1, DEFAULT_PARAMS.alpha)
  const fullV = Math.max(0, rnow(risky, 1, dc) - dc.rho * L) / Math.pow(L + 1, DEFAULT_PARAMS.alpha)

  const sw = infos.find((i) => i.msg === 'intent switch')
  expect(sw).toBeDefined()
  expect(sw!.obj.to).toBe('route')
  expect(sw!.obj.uTo as number).toBeCloseTo(weighted, 10)
  expect((sw!.obj.uTo as number)).toBeLessThan(fullV) // strictly discounted vs full V
})
