// tests/bdi-loop-mission.test.ts
import { test, expect } from 'bun:test'
import { BdiLoop } from '../src/bdi/loop.js'
import { DEFAULT_PARAMS } from '../src/bdi/params.js'
import { TeamMissionView } from '../src/mission/view.js'
import { assembleMission } from '../src/mission/kinds.js'
import type { DeliverooClient } from '../src/external/deliveroo.js'
import type { GameConsts, Tile, Pos, PerceptionSnapshot, PickResult } from '../src/types/perception.js'

const CONSTS: GameConsts = { CLOCK: 50, MOVEMENT_DURATION: 50, OBS_DISTANCE: 5, PARCEL_DECAY_TICKS: 20, PARCEL_DECAY_RAW: '1s', PENALTY: 0 }

function rowMap(): Tile[] {
  const tiles: Tile[] = [{ pos: { x: 0, y: 0 }, type: 'delivery' }]
  for (let x = 1; x < 5; x++) tiles.push({ pos: { x, y: 0 }, type: 'walkable' })
  return tiles
}

interface Recorder { moves: string[]; putdowns: string[][]; client: DeliverooClient }
function fakeClient(map: Tile[], role: 'liaison' | 'courier'): Recorder {
  const rec: Recorder = { moves: [], putdowns: [], client: null as never }
  rec.client = {
    role, consts: CONSTS, map, tick: () => 0,
    onPerception: () => {}, onConnect: () => {}, onDisconnect: () => {},
    move: async (dir) => { rec.moves.push(dir); return { x: 0, y: 0 } as Pos },
    pickup: async (): Promise<PickResult[]> => [],
    putdown: async (ids?: string[]): Promise<PickResult[]> => { rec.putdowns.push(ids ?? []); return (ids ?? []).map((id) => ({ id })) },
    onMissionMsg: () => {}, say: async () => 'successful', ask: async () => ({}), shout: async () => ({}), close: () => {},
  }
  return rec
}

// self at (1,0); empty world (no parcels, no spawners) → route/explore both null.
const snap = (): PerceptionSnapshot => ({
  tick: 1, self: { id: 'me', name: 'me', teamId: 'A', pos: { x: 1, y: 0 }, score: 0 },
  parcels: [], agents: [], crates: [],
})

const coordMission = (x: number) => assembleMission(
  { kind: 'CANDIDATE_INTENTION', payoff: 100, abstractIntent: 'go', params: { targetTile: { tag: 'TEXT_BOUND', x, y: 0 } } },
  'raw', 'm-1',
)

const log = { info: () => {}, debug: () => {}, warn: () => {} }

test('Liaison diverts toward the mission target tile', async () => {
  const rec = fakeClient(rowMap(), 'liaison')
  const view = new TeamMissionView()
  view.set(coordMission(4)) // target right of self
  const loop = new BdiLoop(rec.client, DEFAULT_PARAMS, log, undefined, undefined, { view, pursue: true })
  await loop.tick(snap())
  expect(rec.moves).toEqual(['right'])
})

test('arriving at the target satisfies the mission (onSatisfied fires)', async () => {
  const rec = fakeClient(rowMap(), 'liaison')
  const view = new TeamMissionView()
  let satisfied = 0
  view.set(coordMission(1)) // target == self position (1,0)
  const loop = new BdiLoop(rec.client, DEFAULT_PARAMS, log, undefined, undefined, { view, pursue: true, onSatisfied: () => { satisfied++ } })
  await loop.tick(snap())
  expect(satisfied).toBe(1)
  expect(rec.moves.length).toBe(0)
})

test('a pursue:false loop (Courier) never chases the coordinate target', async () => {
  const rec = fakeClient(rowMap(), 'courier')
  const view = new TeamMissionView()
  view.set(coordMission(4))
  const loop = new BdiLoop(rec.client, DEFAULT_PARAMS, log, undefined, undefined, { view, pursue: false })
  await loop.tick(snap())
  expect(rec.moves.length).toBe(0) // no mission candidate → idle
})

const shaperMission = () => assembleMission(
  { kind: 'REWARD_SHAPER', payoff: 0, abstractIntent: 'stacks of 3 double', params: { m: { '3': 2 } } },
  'raw', 'm-shaper',
)

// self ON the delivery tile (0,0) carrying 4 parcels. m(3)=2 ⇒ top-3 bundle (×2) beats all-4 (×1).
const carrySnap = (): PerceptionSnapshot => ({
  tick: 1, self: { id: 'me', name: 'me', teamId: 'A', pos: { x: 0, y: 0 }, score: 0 },
  parcels: [
    { id: 'a', pos: { x: 0, y: 0 }, reward: 10, carriedBy: 'me' },
    { id: 'b', pos: { x: 0, y: 0 }, reward: 9, carriedBy: 'me' },
    { id: 'c', pos: { x: 0, y: 0 }, reward: 8, carriedBy: 'me' },
    { id: 'd', pos: { x: 0, y: 0 }, reward: 1, carriedBy: 'me' },
  ],
  agents: [], crates: [],
})

// Phase-2 "Done when … on BOTH agents": the Courier reads shapers despite pursue:false.
test('Courier (pursue:false) honours a REWARD_SHAPER: delivers the shaped subset (drop-3-hold-1)', async () => {
  const rec = fakeClient(rowMap(), 'courier')
  const view = new TeamMissionView()
  view.set(shaperMission())
  const loop = new BdiLoop(rec.client, DEFAULT_PARAMS, log, undefined, undefined, { view, pursue: false })
  await loop.tick(carrySnap())
  expect(rec.putdowns).toHaveLength(1)
  expect(rec.putdowns[0]!.slice().sort()).toEqual(['a', 'b', 'c']) // 'd' held: m(3)=2·27 > m(4)=1·28
})

// Control: with NO mission the same Courier delivers all four (base play, m≡1).
test('no mission: the same delivery ships all positive-Rnow parcels (base play)', async () => {
  const rec = fakeClient(rowMap(), 'courier')
  const loop = new BdiLoop(rec.client, DEFAULT_PARAMS, log)
  await loop.tick(carrySnap())
  expect(rec.putdowns).toHaveLength(1)
  expect(rec.putdowns[0]!.slice().sort()).toEqual(['a', 'b', 'c', 'd'])
})

// ── §7.1 priced toll: the agent dodges a forbidden tile on its delivery run ──────────────
// 2 rows so a detour exists; delivery at (0,0). Self at (2,0) carrying one parcel.
function dodgeMap(): Tile[] {
  const tiles: Tile[] = [{ pos: { x: 0, y: 0 }, type: 'delivery' }]
  for (let x = 1; x <= 2; x++) tiles.push({ pos: { x, y: 0 }, type: 'walkable' })
  for (let x = 0; x <= 2; x++) tiles.push({ pos: { x, y: 1 }, type: 'walkable' })
  return tiles
}
const dodgeSnap = (): PerceptionSnapshot => ({
  tick: 1, self: { id: 'me', name: 'me', teamId: 'A', pos: { x: 2, y: 0 }, score: 0 },
  parcels: [{ id: 'c', pos: { x: 2, y: 0 }, reward: 50, carriedBy: 'me' }],
  agents: [], crates: [],
})
const tollMission = () => assembleMission(
  { kind: 'HARD_CONSTRAINT', payoff: -100, abstractIntent: 'avoid (1,0)', sub: 'PRICED',
    params: { priced: [{ tile: { tag: 'TEXT_BOUND', x: 1, y: 0 }, toll: 100 }] } },
  'avoid', 'm-toll',
)

// §7 "on BOTH agents": Liaison (pursue:true) and Courier (pursue:false) both honour the toll.
// Straight (2,0)->(1,0)->(0,0) crosses the 100-point tile (cost cTick·2 + 100); the detour up
// through row y=1 is 4 ticks, no toll (cost cTick·4). cTick = ρ·1 + ū_forgone ≪ 50, so the
// toll-aware A* skirts the tile — first step is 'up' to (2,1).
test('both agents dodge a priced tile when delivering (§7.1, pursue:true/false)', async () => {
  for (const role of ['liaison', 'courier'] as const) {
    const rec = fakeClient(dodgeMap(), role)
    const view = new TeamMissionView()
    view.set(tollMission())
    const loop = new BdiLoop(rec.client, DEFAULT_PARAMS, log, undefined, undefined, { view, pursue: role === 'liaison' })
    await loop.tick(dodgeSnap())
    expect(rec.moves[0]).toBe('up')
  }
})

// Control: with NO mission, tolls is empty ⇒ pure-tick A* ⇒ straight delivery (base play).
test('no constraint: the carried delivery goes straight through (1,0) (base play)', async () => {
  const rec = fakeClient(dodgeMap(), 'liaison')
  const loop = new BdiLoop(rec.client, DEFAULT_PARAMS, log)
  await loop.tick(dodgeSnap())
  expect(rec.moves[0]).toBe('left')
})
