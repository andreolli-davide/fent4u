// tests/bdi-loop.test.ts
import { test, expect } from 'bun:test'
import { BdiLoop } from '../src/bdi/loop.js'
import { DEFAULT_PARAMS } from '../src/bdi/params.js'
import type { DeliverooClient } from '../src/external/deliveroo.js'
import type { GameConsts, Tile, Pos, PerceptionSnapshot, PickResult } from '../src/types/perception.js'

const CONSTS: GameConsts = { CLOCK: 50, MOVEMENT_DURATION: 50, OBS_DISTANCE: 5, PARCEL_DECAY_TICKS: 20, PARCEL_DECAY_RAW: '1s', PENALTY: 0 }

// 1x5 open row with a delivery zone at (0,0).
function rowMap(): Tile[] {
  const tiles: Tile[] = [{ pos: { x: 0, y: 0 }, type: 'delivery' }]
  for (let x = 1; x < 5; x++) tiles.push({ pos: { x, y: 0 }, type: 'walkable' })
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

test('steps toward a visible parcel', async () => {
  const rec = fakeClient(rowMap())
  const loop = new BdiLoop(rec.client, DEFAULT_PARAMS, () => {})
  await loop.tick(snap({ parcels: [{ id: 'p1', pos: { x: 4, y: 0 }, reward: 10, carriedBy: null }] }))
  expect(rec.moves).toEqual(['right']) // self at (3,0), parcel at (4,0)
})

test('picks up when standing on the parcel', async () => {
  const rec = fakeClient(rowMap())
  const loop = new BdiLoop(rec.client, DEFAULT_PARAMS, () => {})
  await loop.tick(snap({ self: { id: 'me', name: 'me', teamId: 'A', pos: { x: 4, y: 0 }, score: 0 }, parcels: [{ id: 'p1', pos: { x: 4, y: 0 }, reward: 10, carriedBy: null }] }))
  expect(rec.pickups).toBe(1)
})

test('explores when nothing is visible and not carrying', async () => {
  const rec = fakeClient(rowMap())
  const loop = new BdiLoop(rec.client, DEFAULT_PARAMS, () => {})
  await loop.tick(snap({ parcels: [] }))
  // No spawner tiles in rowMap(), so chooseExplore returns null → idle → no move
  expect(rec.moves.length).toBe(0)
})
