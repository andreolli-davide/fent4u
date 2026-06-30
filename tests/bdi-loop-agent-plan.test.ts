// tests/bdi-loop-agent-plan.test.ts
// §17.7 step-list executor: 4 TDD scenarios for BdiLoop.actAgentPlan.
// Harness mirrors bdi-loop-mission.test.ts (fakeClient / rowMap / log).

import { test, expect } from 'bun:test'
import { BdiLoop } from '../src/bdi/loop.js'
import { DEFAULT_PARAMS } from '../src/bdi/params.js'
import { TeamMissionView } from '../src/mission/view.js'
import type { Mission } from '../src/mission/kinds.js'
import type { DeliverooClient } from '../src/external/deliveroo.js'
import type { GameConsts, Tile, Pos, PerceptionSnapshot, PickResult } from '../src/types/perception.js'

const CONSTS: GameConsts = { CLOCK: 50, MOVEMENT_DURATION: 50, OBS_DISTANCE: 5, PARCEL_DECAY_TICKS: 20, PARCEL_DECAY_RAW: '1s', PENALTY: 0 }

function rowMap(): Tile[] {
  const tiles: Tile[] = [{ pos: { x: 0, y: 0 }, type: 'delivery' }]
  for (let x = 1; x < 5; x++) tiles.push({ pos: { x, y: 0 }, type: 'walkable' })
  return tiles
}

interface Recorder { moves: string[]; putdowns: string[][]; picks: number; client: DeliverooClient }
function fakeClient(map: Tile[]): Recorder {
  const rec: Recorder = { moves: [], putdowns: [], picks: 0, client: null as never }
  rec.client = {
    role: 'liaison', consts: CONSTS, map, tick: () => 0,
    onPerception: () => {}, onConnect: () => {}, onDisconnect: () => {},
    move: async (dir) => { rec.moves.push(dir); return { x: 0, y: 0 } as Pos },
    pickup: async (): Promise<PickResult[]> => { rec.picks++; return [{ id: 'p1' }] },
    putdown: async (ids?: string[]): Promise<PickResult[]> => { rec.putdowns.push(ids ?? []); return (ids ?? []).map((id) => ({ id })) },
    onMissionMsg: () => {}, say: async () => 'successful', ask: async () => ({}), shout: async () => ({}), close: () => {},
  }
  return rec
}
const log = { info: () => {}, debug: () => {}, warn: () => {} }

// Base snap: NO parcels — mission always wins the argmax (no route candidate).
const snap = (selfX = 1): PerceptionSnapshot => ({
  tick: 1, self: { id: 'me', name: 'me', teamId: 'A', pos: { x: selfX, y: 0 }, score: 0 },
  parcels: [], agents: [], crates: [],
})

// Snap with p1 at reward=0: pAvail>0 but uRoute=0, so mission still wins; p1 is present
// for pickup-step validation in test 2 (revalidateStep sees it as 'ok').
const snapWithParcel = (selfX = 1): PerceptionSnapshot => ({
  tick: 1, self: { id: 'me', name: 'me', teamId: 'A', pos: { x: selfX, y: 0 }, score: 0 },
  parcels: [{ id: 'p1', pos: { x: 3, y: 0 }, reward: 0, carriedBy: null }],
  agents: [], crates: [],
})

// Default AGENT_PLAN: self(1,0) → goto(3,0) → pickup(p1) → goto(0,0) → deliver(0,0).
const makePlan = (): Mission => ({
  kind: 'AGENT_PLAN', payoff: 100, abstractIntent: 'fetch p1 to zone', params: {},
  id: 'ap-1', rawText: 'fetch the parcel and deliver', status: 'CLASSIFIED',
  plan: {
    steps: [
      { op: 'goto', target: { x: 3, y: 0 } },
      { op: 'pickup', parcelId: 'p1' },
      { op: 'goto', target: { x: 0, y: 0 } },
      { op: 'deliver', zone: { x: 0, y: 0 } },
    ],
    L: 6, vPlan: 20,
  },
})

test('AGENT_PLAN executor moves toward the first goto target', async () => {
  const rec = fakeClient(rowMap())
  const view = new TeamMissionView(); view.set(makePlan())
  const loop = new BdiLoop(rec.client, DEFAULT_PARAMS, log, undefined, undefined, { view, pursue: true })
  await loop.tick(snap(1)) // self (1,0), target (3,0) → step right
  expect(rec.moves).toEqual(['right'])
})

test('on the pickup step at the parcel tile the executor picks up', async () => {
  const rec = fakeClient(rowMap())
  const view = new TeamMissionView(); view.set(makePlan())
  const loop = new BdiLoop(rec.client, DEFAULT_PARAMS, log, undefined, undefined, { view, pursue: true })
  // p1 visible (reward=0 keeps route u=0, mission wins). Self (3,0): goto target reached →
  // ptr advances to pickup; same tick is fine to just arrive.
  await loop.tick(snapWithParcel(3))
  // second tick still at (3,0): now on the pickup step → pickup fires.
  await loop.tick(snapWithParcel(3))
  expect(rec.picks).toBeGreaterThanOrEqual(1)
})

test('an invalid pickup step (parcel gone) requests a re-plan with rawText', async () => {
  const rec = fakeClient(rowMap())
  const view = new TeamMissionView()
  // plan whose current step pickups a parcel that is absent from perception
  const m = makePlan(); m.plan!.steps = [{ op: 'pickup', parcelId: 'ghost' }]
  view.set(m)
  const calls: Array<{ raw: string; mask?: Pos[] }> = []
  const loop = new BdiLoop(rec.client, DEFAULT_PARAMS, log, undefined, undefined, {
    view, pursue: true, requestReplan: (raw, mask) => calls.push({ raw, mask }),
  })
  // snap() has parcels:[] so 'ghost' is absent; mission wins (no route candidate).
  await loop.tick(snap(1))
  expect(calls).toHaveLength(1)
  expect(calls[0]!.raw).toBe('fetch the parcel and deliver')
})

test('completing the last step fires onSatisfied', async () => {
  const rec = fakeClient(rowMap())
  const view = new TeamMissionView()
  const m = makePlan(); m.plan!.steps = [{ op: 'deliver', zone: { x: 0, y: 0 } }]
  view.set(m)
  let satisfied = 0
  const loop = new BdiLoop(rec.client, DEFAULT_PARAMS, log, undefined, undefined, {
    view, pursue: true, onSatisfied: () => { satisfied++ },
  })
  // self at (0,0) == delivery zone; snap() has no parcels (mission wins); ptr reaches end → onSatisfied.
  await loop.tick(snap(0))
  expect(satisfied).toBe(1)
})
