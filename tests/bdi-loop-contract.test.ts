// tests/bdi-loop-contract.test.ts
import { test, expect } from 'bun:test'
import { BdiLoop } from '../src/bdi/loop.js'
import { DEFAULT_PARAMS } from '../src/bdi/params.js'
import { TeamMissionView } from '../src/mission/view.js'
import { ContractRuntime, rendezvousContract, type ContractMsg } from '../src/coordination/contract.js'
import type { DeliverooClient } from '../src/external/deliveroo.js'
import type { GameConsts, Tile, Pos, PerceptionSnapshot, PickResult } from '../src/types/perception.js'
import type { A2AMessage } from '../src/types/a2a.js'

const CONSTS: GameConsts = { CLOCK: 50, MOVEMENT_DURATION: 50, OBS_DISTANCE: 5, PARCEL_DECAY_TICKS: 20, PARCEL_DECAY_RAW: '1s', PENALTY: 0 }

// One straight walkable row x=0..5 at y=0.
function rowMap(): Tile[] {
  const tiles: Tile[] = []
  for (let x = 0; x <= 5; x++) tiles.push({ pos: { x, y: 0 }, type: 'walkable' })
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
    putdown: async (): Promise<PickResult[]> => [],
    onMissionMsg: () => {}, say: async () => 'successful', ask: async () => ({}), shout: async () => ({}), close: () => {},
  }
  return rec
}

const snapAt = (pos: Pos): PerceptionSnapshot => ({
  tick: 1, self: { id: 'me', name: 'me', teamId: 'A', pos, score: 0 },
  parcels: [], agents: [], crates: [],
})

const log = { info: () => {}, debug: () => {}, warn: () => {} }

// An ACTIVE rendezvous runtime targeting (5,0) radius 0 (exact tile, for a clean test).
function activeRuntime(): ContractRuntime {
  const rt = new ContractRuntime()
  // applyMsg(propose) sets status ACTIVE directly (acceptance is immediate this slice).
  rt.applyMsg({ kind: 'propose', contract: rendezvousContract('r1', { x: 5, y: 0 }, 0, 500, 9999) }, 'liaison')
  return rt
}

test('ACTIVE contract: the agent navigates toward its zone (preempts base play)', async () => {
  const rec = fakeClient(rowMap(), 'liaison')
  const contracts = activeRuntime()
  const sent: A2AMessage[] = []
  const loop = new BdiLoop(rec.client, DEFAULT_PARAMS, log, undefined,
    { partner: 'courier', send: (m) => sent.push(m) },
    { view: new TeamMissionView(), pursue: true, contracts })
  await loop.tick(snapAt({ x: 1, y: 0 }))
  expect(rec.moves).toEqual(['right']) // toward (5,0)
})

test('ACTIVE contract: in-zone agent posts its milestone over the contract channel (no move)', async () => {
  const rec = fakeClient(rowMap(), 'liaison')
  const contracts = activeRuntime()
  const sent: A2AMessage[] = []
  const loop = new BdiLoop(rec.client, DEFAULT_PARAMS, log, undefined,
    { partner: 'courier', send: (m) => sent.push(m) },
    { view: new TeamMissionView(), pursue: true, contracts })
  await loop.tick(snapAt({ x: 5, y: 0 })) // exactly on the target
  expect(rec.moves).toEqual([])
  const posts = sent.filter((m) => m.type === 'contract').map((m) => m.payload as ContractMsg)
  expect(posts).toEqual([{ kind: 'post', id: 'r1', milestone: 'liaison_ready' }])
  expect(contracts.current()!.posted.liaison_ready).toBe(true)
})

test('ACTIVE contract: barrier released → onSatisfied fires and a teardown is broadcast', async () => {
  const rec = fakeClient(rowMap(), 'liaison')
  const contracts = activeRuntime()
  // Pre-seed: partner already ready AND I am already ready → advance returns done.
  contracts.applyMsg({ kind: 'post', id: 'r1', milestone: 'courier_ready' }, 'liaison')
  contracts.applyMsg({ kind: 'post', id: 'r1', milestone: 'liaison_ready' }, 'liaison')
  const sent: A2AMessage[] = []
  let satisfied = 0
  const loop = new BdiLoop(rec.client, DEFAULT_PARAMS, log, undefined,
    { partner: 'courier', send: (m) => sent.push(m) },
    { view: new TeamMissionView(), pursue: true, contracts, onSatisfied: () => { satisfied++ } })
  await loop.tick(snapAt({ x: 5, y: 0 }))
  expect(satisfied).toBe(1)
  const tear = sent.filter((m) => m.type === 'contract').map((m) => m.payload as ContractMsg)
  expect(tear).toEqual([{ kind: 'teardown', id: 'r1', status: 'SATISFIED' }])
  expect(contracts.current()).toBeNull()
})
