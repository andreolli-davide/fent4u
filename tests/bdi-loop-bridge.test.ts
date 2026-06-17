// tests/bdi-loop-bridge.test.ts
import { test, expect } from 'bun:test'
import { BdiLoop } from '../src/bdi/loop.js'
import { DEFAULT_PARAMS } from '../src/bdi/params.js'
import { TeamMissionView } from '../src/mission/view.js'
import { ContractRuntime } from '../src/coordination/contract.js'
import type { ContractMsg } from '../src/coordination/contract.js'
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
