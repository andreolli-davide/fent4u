// tests/bdi-loop-bridge.test.ts
import { test, expect } from 'bun:test'
import { BdiLoop } from '../src/bdi/loop.js'
import { DEFAULT_PARAMS } from '../src/bdi/params.js'
import { TeamMissionView } from '../src/mission/view.js'
import { ContractRuntime } from '../src/coordination/contract.js'
import type { ContractMsg } from '../src/coordination/contract.js'
import { syncGateContract, advance } from '../src/coordination/contract.js'
import type { Mission } from '../src/mission/kinds.js'
import type { DeliverooClient } from '../src/external/deliveroo.js'
import type { GameConsts, Tile, Pos, PerceptionSnapshot, PickResult } from '../src/types/perception.js'
import type { A2AMessage } from '../src/types/a2a.js'

const CONSTS: GameConsts = { CLOCK: 50, MOVEMENT_DURATION: 50, OBS_DISTANCE: 5, PARCEL_DECAY_TICKS: 20, PARCEL_DECAY_RAW: '1s', PENALTY: 0 }

// 6x3 grid, delivery at (4,1).
function map(): Tile[] {
  const t: Tile[] = []
  for (let x = 0; x <= 5; x++) for (let y = 0; y <= 2; y++) t.push({ pos: { x, y }, type: x === 4 && y === 1 ? 'delivery' : 'walkable' })
  return t
}
function fakeClient(role: 'liaison' | 'courier'): DeliverooClient {
  return {
    role, consts: CONSTS, map: map(), tick: () => 0,
    onPerception: () => {}, onConnect: () => {}, onDisconnect: () => {},
    move: async () => ({ x: 0, y: 0 } as Pos),
    pickup: async (): Promise<PickResult[]> => [],
    putdown: async (): Promise<PickResult[]> => [],
    onMissionMsg: () => {}, say: async () => 'successful', ask: async () => ({}), shout: async () => ({}), close: () => {},
  }
}
const log = { info: () => {}, debug: () => {}, warn: () => {} }
function coordMission(contractType: string): Mission {
  return { id: 'm1', kind: 'COORDINATION_CONTRACT', payoff: 200, abstractIntent: 'x', params: { contractType }, rawText: 'x', status: 'CLASSIFIED' }
}
// snapshot with a perceived free parcel at (0,0) and the partner visible at (5,2).
function snap(selfPos: Pos): PerceptionSnapshot {
  return {
    tick: 1, self: { id: 'L', name: 'L', teamId: 'A', pos: selfPos, score: 0 },
    parcels: [{ id: 'p1', pos: { x: 0, y: 0 }, reward: 100, carriedBy: null }],
    agents: [{ id: 'C', name: 'C', teamId: 'A', pos: { x: 5, y: 2 } }], crates: [],
  }
}

function liaisonLoop(view: TeamMissionView, rt: ContractRuntime, sent: A2AMessage[]): BdiLoop {
  return new BdiLoop(fakeClient('liaison'), DEFAULT_PARAMS, log, undefined,
    { partner: 'courier', send: (m) => sent.push(m) },
    { view, pursue: true, contracts: rt })
}

test('Liaison proposes a HANDOFF contract once the parcel + partner are perceived', async () => {
  const view = new TeamMissionView(); view.set(coordMission('HANDOFF'))
  const rt = new ContractRuntime(); const sent: A2AMessage[] = []
  await liaisonLoop(view, rt, sent).tick(snap({ x: 1, y: 0 }))
  const proposes = sent.filter((m) => m.type === 'contract').map((m) => m.payload as ContractMsg)
  expect(proposes.length).toBe(1)
  expect(proposes[0].kind).toBe('propose')
  expect(rt.current()!.id).toBe('m1:HANDOFF')
  expect(rt.current()!.status).toBe('PROPOSED')
})

test('Liaison holds (no propose) when the parcel is not yet perceived', async () => {
  const view = new TeamMissionView(); view.set(coordMission('HANDOFF'))
  const rt = new ContractRuntime(); const sent: A2AMessage[] = []
  const noParcel: PerceptionSnapshot = { ...snap({ x: 1, y: 0 }), parcels: [] }
  await liaisonLoop(view, rt, sent).tick(noParcel)
  expect(sent.filter((m) => m.type === 'contract').length).toBe(0)
  expect(rt.current()).toBeNull()
})

test('Liaison does not re-propose once a contract occupies the slot', async () => {
  const view = new TeamMissionView(); view.set(coordMission('HANDOFF'))
  const rt = new ContractRuntime(); const sent: A2AMessage[] = []
  const loop = liaisonLoop(view, rt, sent)
  await loop.tick(snap({ x: 1, y: 0 }))
  await loop.tick(snap({ x: 1, y: 0 }))
  expect(sent.filter((m) => m.type === 'contract' && (m.payload as ContractMsg).kind === 'propose').length).toBe(1)
})

test('Courier (pursue:false) never proposes a contract', async () => {
  const view = new TeamMissionView(); view.set(coordMission('HANDOFF'))
  const rt = new ContractRuntime(); const sent: A2AMessage[] = []
  const loop = new BdiLoop(fakeClient('courier'), DEFAULT_PARAMS, log, undefined,
    { partner: 'liaison', send: (m) => sent.push(m) }, { view, pursue: false, contracts: rt })
  await loop.tick(snap({ x: 1, y: 0 }))
  expect(sent.filter((m) => m.type === 'contract').length).toBe(0)
})

// Build an ACTIVE, fully-staged SYNC_GATE so advance() yields 'gated'.
function gatedRuntime(): ContractRuntime {
  const rt = new ContractRuntime()
  rt.applyMsg({ kind: 'propose', contract: syncGateContract('g1', { x: 0, y: 0 }, 9, 700, 9999) }, 'liaison')
  rt.applyMsg({ kind: 'post', id: 'g1', milestone: 'l_staged' }, 'liaison')
  rt.applyMsg({ kind: 'post', id: 'g1', milestone: 'c_staged' }, 'liaison')
  return rt
}

// A move-recording client so we can see whether base play moved this tick.
function recClient(role: 'liaison' | 'courier'): { client: DeliverooClient; moves: string[] } {
  const moves: string[] = []
  const client = { ...fakeClient(role), move: async (d: string) => { moves.push(d); return { x: 0, y: 0 } as Pos } } as DeliverooClient
  return { client, moves }
}

test('gated + CLOSED gate: agent holds (no base-play move)', async () => {
  const rt = gatedRuntime(); rt.setGate('CLOSED', 1)
  const { client, moves } = recClient('liaison')
  const view = new TeamMissionView()
  // Solo mode (no coord channel): base play routes via buildRoute over the raw parcel pool,
  // so the parcel at (0,0) WOULD produce a move toward it — making moves.toEqual([]) a real
  // discriminator that can only pass when the CLOSED-gate early-return actually fires.
  const loop = new BdiLoop(client, DEFAULT_PARAMS, log, undefined, undefined, { view, pursue: true, contracts: rt })
  await loop.tick(snap({ x: 3, y: 0 }))
  expect(moves).toEqual([])
  expect(advance(rt.active()!, 'liaison', { x: 3, y: 0 })).toEqual({ kind: 'gated' })
})

test('SYNC_GATE aborts on partner loss (Active→Failed) and broadcasts a FAILED teardown', async () => {
  const rt = gatedRuntime()
  const sent: A2AMessage[] = []
  const { client } = recClient('liaison')
  const loop = new BdiLoop(client, DEFAULT_PARAMS, log, undefined, { partner: 'courier', send: (m) => sent.push(m) }, { view: new TeamMissionView(), pursue: true, contracts: rt })
  await loop.tick(snap({ x: 3, y: 0 }), false) // partnerAlive = false
  const tear = sent.filter((m) => m.type === 'contract').map((m) => m.payload as ContractMsg)
  expect(tear).toEqual([{ kind: 'teardown', id: 'g1', status: 'FAILED' }])
  expect(rt.current()).toBeNull()
})
