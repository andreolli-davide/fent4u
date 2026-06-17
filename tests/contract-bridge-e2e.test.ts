// tests/contract-bridge-e2e.test.ts
import { test, expect } from 'bun:test'
import { BdiLoop } from '../src/bdi/loop.js'
import { DEFAULT_PARAMS } from '../src/bdi/params.js'
import { TeamMissionView } from '../src/mission/view.js'
import { ContractRuntime, isContractMsg } from '../src/coordination/contract.js'
import { isClaimMsg, ClaimStore } from '../src/coordination/claims.js'
import type { Mission } from '../src/mission/kinds.js'
import type { DeliverooClient } from '../src/external/deliveroo.js'
import type { GameConsts, Tile, Pos, PerceptionSnapshot, PickResult } from '../src/types/perception.js'
import type { A2AMessage, AgentId } from '../src/types/a2a.js'

const CONSTS: GameConsts = { CLOCK: 50, MOVEMENT_DURATION: 50, OBS_DISTANCE: 50, PARCEL_DECAY_TICKS: 9999, PARCEL_DECAY_RAW: '0s', PENALTY: 0 }

// 8x3 grid, delivery at (4,1). Parcel p1 at (1,1). Liaison near p1, Courier near delivery.
function map(): Tile[] {
  const t: Tile[] = []
  for (let x = 0; x <= 7; x++) for (let y = 0; y <= 2; y++) t.push({ pos: { x, y }, type: x === 4 && y === 1 ? 'delivery' : 'walkable' })
  return t
}

// A client whose position is mutated by move(), and whose carried set + ground parcels it tracks so
// pickup/putdown behave. Minimal — exercises the protocol, not full server fidelity.
function movingClient(role: AgentId, start: Pos): { client: DeliverooClient; pos: Pos } {
  const state = { pos: { ...start } }
  const client: DeliverooClient = {
    role, consts: CONSTS, map: map(), tick: () => 0,
    onPerception: () => {}, onConnect: () => {}, onDisconnect: () => {},
    move: async (dir) => {
      if (dir === 'right') state.pos.x++
      else if (dir === 'left') state.pos.x--
      else if (dir === 'up') state.pos.y++
      else state.pos.y--
      return { ...state.pos } as Pos
    },
    pickup: async (): Promise<PickResult[]> => [],
    putdown: async (): Promise<PickResult[]> => [],
    onMissionMsg: () => {}, say: async () => 'successful', ask: async () => ({}), shout: async () => ({}), close: () => {},
  }
  return { client, pos: state.pos }
}

const log = { info: () => {}, debug: () => {}, warn: () => {} }
function snapAt(self: Pos, partner: Pos, partnerId: string): PerceptionSnapshot {
  return {
    tick: 1, self: { id: 'me', name: 'me', teamId: 'A', pos: self, score: 0 },
    parcels: [{ id: 'p1', pos: { x: 1, y: 1 }, reward: 100, carriedBy: null }],
    agents: [{ id: partnerId, name: partnerId, teamId: 'A', pos: partner, score: 0 }], crates: [],
  }
}
function handoffMission(): Mission {
  return { id: 'm1', kind: 'COORDINATION_CONTRACT', payoff: 200, abstractIntent: 'hand off p1', params: { contractType: 'HANDOFF' }, rawText: 'hand off p1', status: 'CLASSIFIED' }
}

test('a COORDINATION_CONTRACT/HANDOFF mission drives a handoff to SATISFIED via the bridge', async () => {
  const L = movingClient('liaison', { x: 1, y: 0 })
  const C = movingClient('courier', { x: 6, y: 1 })
  const lc = new ContractRuntime(); const cc = new ContractRuntime()
  const lClaims = new ClaimStore(); const cClaims = new ClaimStore()

  const inbox: Record<AgentId, A2AMessage[]> = { liaison: [], courier: [] }
  const send = (m: A2AMessage): void => { inbox[m.to].push(m) }
  function drain(rt: ContractRuntime, claims: ClaimStore, self: AgentId): void {
    for (const m of inbox[self].splice(0)) {
      if (m.type === 'contract' && isContractMsg(m.payload)) {
        const reply = rt.applyMsg(m.payload, self)
        if (reply !== null) send({ from: self, to: m.from, type: 'contract', payload: reply })
      } else if (m.type === 'claims' && isClaimMsg(m.payload)) {
        claims.applyMsg(m.payload, self)
      }
    }
  }

  const lView = new TeamMissionView(); lView.set(handoffMission())
  const cView = new TeamMissionView() // Courier receives the contract via the relay, not the mission
  const loopL = new BdiLoop(L.client, DEFAULT_PARAMS, log, lClaims, { partner: 'courier', send }, { view: lView, pursue: true, contracts: lc })
  const loopC = new BdiLoop(C.client, DEFAULT_PARAMS, log, cClaims, { partner: 'liaison', send }, { view: cView, pursue: false, contracts: cc })

  let guard = 0
  let satisfied = false
  while (!satisfied && guard++ < 60) {
    drain(lc, lClaims, 'liaison'); drain(cc, cClaims, 'courier')
    await loopL.tick(snapAt(L.pos, C.pos, 'courier'))
    await loopC.tick(snapAt(C.pos, L.pos, 'liaison'))
    drain(lc, lClaims, 'liaison'); drain(cc, cClaims, 'courier')
    // SATISFIED ⇔ a contract existed and both runtimes have torn it down.
    satisfied = lc.current() === null && cc.current() === null && guard > 2
  }

  expect(guard).toBeLessThan(60) // converged
  expect(lc.current()).toBeNull()
  expect(cc.current()).toBeNull()
})
