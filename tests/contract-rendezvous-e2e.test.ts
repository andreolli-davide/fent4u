// tests/contract-rendezvous-e2e.test.ts
import { test, expect } from 'bun:test'
import { BdiLoop } from '../src/bdi/loop.js'
import { DEFAULT_PARAMS } from '../src/bdi/params.js'
import { TeamMissionView } from '../src/mission/view.js'
import { ContractRuntime, rendezvousContract, isContractMsg } from '../src/coordination/contract.js'
import type { DeliverooClient } from '../src/external/deliveroo.js'
import type { GameConsts, Tile, Pos, PerceptionSnapshot, PickResult } from '../src/types/perception.js'
import type { A2AMessage, AgentId } from '../src/types/a2a.js'

const CONSTS: GameConsts = { CLOCK: 50, MOVEMENT_DURATION: 50, OBS_DISTANCE: 5, PARCEL_DECAY_TICKS: 20, PARCEL_DECAY_RAW: '1s', PENALTY: 0 }

// 6x1 walkable row, x=0..5 at y=0. Liaison starts at x=0, Courier at x=5. Target (3,0), radius 0.
function rowMap(): Tile[] {
  const tiles: Tile[] = []
  for (let x = 0; x <= 5; x++) tiles.push({ pos: { x, y: 0 }, type: 'walkable' })
  return tiles
}

// A fake client whose position is mutated by move(), so successive ticks advance the agent.
function movingClient(map: Tile[], role: AgentId, start: Pos): { client: DeliverooClient; pos: Pos } {
  const state = { pos: { ...start } }
  const client: DeliverooClient = {
    role, consts: CONSTS, map, tick: () => 0,
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
const snapAt = (pos: Pos): PerceptionSnapshot => ({
  tick: 1, self: { id: 'me', name: 'me', teamId: 'A', pos, score: 0 }, parcels: [], agents: [], crates: [],
})

test('two loops complete a rendezvous through the a2a contract channel', async () => {
  const L = movingClient(rowMap(), 'liaison', { x: 0, y: 0 })
  const C = movingClient(rowMap(), 'courier', { x: 5, y: 0 })
  const lc = new ContractRuntime()
  const cc = new ContractRuntime()

  // In-memory a2a buses: each agent's outbound contract msgs are applied to the OTHER's runtime.
  const inbox: Record<AgentId, A2AMessage[]> = { liaison: [], courier: [] }
  const send = (m: A2AMessage): void => { inbox[m.to].push(m) }
  // Drain a runtime's inbox, applying contract msgs and re-broadcasting any replies.
  function drain(rt: ContractRuntime, self: AgentId): void {
    for (const m of inbox[self].splice(0)) {
      if (m.type === 'contract' && isContractMsg(m.payload)) {
        const reply = rt.applyMsg(m.payload, self)
        if (reply !== null) send({ from: self, to: m.from, type: 'contract', payload: reply })
      }
    }
  }

  const loopL = new BdiLoop(L.client, DEFAULT_PARAMS, log, undefined,
    { partner: 'courier', send }, { view: new TeamMissionView(), pursue: true, contracts: lc })
  const loopC = new BdiLoop(C.client, DEFAULT_PARAMS, log, undefined,
    { partner: 'liaison', send }, { view: new TeamMissionView(), pursue: false, contracts: cc })

  // Liaison proposes; wrap in an A2AMessage envelope so the inbox routing works correctly.
  // lc.propose() returns a ContractMsg; the loop's sendContract() wraps it — we mirror that
  // here for the initial manual propose injection.
  const proposeMsg = lc.propose(rendezvousContract('r1', { x: 3, y: 0 }, 0, 500, 9999))
  send({ from: 'liaison', to: 'courier', type: 'contract', payload: proposeMsg })

  // Drive ticks until both runtimes have torn the contract down (SATISFIED), bounded.
  let guard = 0
  while ((lc.current() !== null || cc.current() !== null) && guard++ < 30) {
    drain(lc, 'liaison'); drain(cc, 'courier')
    await loopL.tick(snapAt(L.pos))
    await loopC.tick(snapAt(C.pos))
    drain(lc, 'liaison'); drain(cc, 'courier')
  }

  expect(guard).toBeLessThan(30)            // converged, did not spin out
  expect(lc.current()).toBeNull()           // Liaison tore down on SATISFIED
  expect(cc.current()).toBeNull()           // Courier tore down on the broadcast teardown
  expect(L.pos).toEqual({ x: 3, y: 0 })     // both ended inside the (radius-0) zone
  expect(C.pos).toEqual({ x: 3, y: 0 })
})
