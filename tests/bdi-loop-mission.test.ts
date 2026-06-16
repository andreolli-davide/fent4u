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

interface Recorder { moves: string[]; client: DeliverooClient }
function fakeClient(map: Tile[], role: 'liaison' | 'courier'): Recorder {
  const rec: Recorder = { moves: [], client: null as never }
  rec.client = {
    role, consts: CONSTS, map, tick: () => 0,
    onPerception: () => {}, onConnect: () => {}, onDisconnect: () => {},
    move: async (dir) => { rec.moves.push(dir); return { x: 0, y: 0 } as Pos },
    pickup: async (): Promise<PickResult[]> => [],
    putdown: async (ids?: string[]): Promise<PickResult[]> => (ids ?? []).map((id) => ({ id })),
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
