import { test, expect } from 'bun:test'
import { BdiLoop } from '../src/bdi/loop.js'
import { DEFAULT_PARAMS } from '../src/bdi/params.js'
import { ClaimStore } from '../src/coordination/claims.js'
import type { DeliverooClient } from '../src/external/deliveroo.js'
import type { GameConsts, Tile, Pos, PerceptionSnapshot, PickResult, ParcelObs } from '../src/types/perception.js'

const CONSTS: GameConsts = { CLOCK: 50, MOVEMENT_DURATION: 50, OBS_DISTANCE: 5, PARCEL_DECAY_TICKS: 20, PARCEL_DECAY_RAW: '1s', PENALTY: 0 }

function rowMap(): Tile[] {
  const tiles: Tile[] = [{ pos: { x: 0, y: 0 }, type: 'delivery' }]
  for (let x = 1; x < 7; x++) tiles.push({ pos: { x, y: 0 }, type: 'walkable' })
  return tiles
}
function fakeClient(map: Tile[]): { moves: string[]; pickups: number; client: DeliverooClient } {
  const rec = { moves: [] as string[], pickups: 0, client: null as unknown as DeliverooClient }
  rec.client = {
    role: 'courier', consts: CONSTS, map, tick: () => 0,
    onPerception: () => {}, onConnect: () => {}, onDisconnect: () => {},
    move: async (dir: string) => { rec.moves.push(dir); return { x: 0, y: 0 } as Pos },
    pickup: async (): Promise<PickResult[]> => { rec.pickups++; return [] },
    putdown: async (ids?: string[]): Promise<PickResult[]> => (ids ?? []).map((id) => ({ id })),
    onMissionMsg: () => {}, say: async () => 'successful', ask: async () => ({}), shout: async () => ({}), close: () => {},
  }
  return rec
}
const pcl = (id: string, x: number): ParcelObs => ({ id, pos: { x, y: 0 }, reward: 10, carriedBy: null })
const snap = (over: Partial<PerceptionSnapshot>): PerceptionSnapshot => ({
  tick: 1, self: { id: 'me', name: 'me', teamId: 'A', pos: { x: 3, y: 0 }, score: 0 }, parcels: [], agents: [], crates: [], ...over,
})

test('a parcel claimed by the partner is not pursued (P_avail=0, §9.4)', async () => {
  const rec = fakeClient(rowMap())
  const claims = new ClaimStore()
  claims.add({ parcelId: 'p1', agentId: 'liaison', origin: 'AUCTION', epoch: 0, commitTick: 0, originD: 0, lastD: 0, lastProgressTick: 0 })
  const loop = new BdiLoop(rec.client, DEFAULT_PARAMS, { info: () => {}, debug: () => {}, warn: () => {} }, claims)
  // only parcel present is partner-claimed → agent must not walk toward it
  await loop.tick(snap({ self: { id: 'me', name: 'me', teamId: 'A', pos: { x: 3, y: 0 }, score: 0 }, parcels: [pcl('p1', 5)] }))
  expect(rec.moves).toEqual([]) // idles / explores, does not chase a partner's parcel
  expect(rec.pickups).toBe(0)
})

test('a free parcel is auctioned to self and broadcast as a claim', async () => {
  const rec = fakeClient(rowMap())
  const claims = new ClaimStore()
  const sent: unknown[] = []
  const loop = new BdiLoop(rec.client, DEFAULT_PARAMS, { info: () => {}, debug: () => {}, warn: () => {} }, claims, {
    partner: 'liaison', send: (m) => sent.push(m),
  })
  await loop.tick(snap({ self: { id: 'me', name: 'me', teamId: 'A', pos: { x: 3, y: 0 }, score: 0 }, parcels: [pcl('p1', 4)] }))
  // self is the only agent the auction sees as present → wins p1
  expect(claims.claimedBy('p1')).toBe('courier')
  expect(sent.some((m) => (m as { type: string }).type === 'claims')).toBe(true)
})

test('partner lost (silent past PARTNER_LOST_TICKS) → its soft claim is reclaimed & re-auctioned (§9.7/§11)', async () => {
  const rec = fakeClient(rowMap())
  const claims = new ClaimStore()
  // liaison committed p1 long ago and the a2a channel has since gone silent (partner never
  // appears in beliefs ⇒ lastSeen never advances ⇒ age ≥ PARTNER_LOST_TICKS).
  claims.add({ parcelId: 'p1', agentId: 'liaison', origin: 'AUCTION', epoch: 0, commitTick: 0, originD: 4, lastD: 4, lastProgressTick: 0 })
  const loop = new BdiLoop(rec.client, DEFAULT_PARAMS, { info: () => {}, debug: () => {}, warn: () => {} }, claims, {
    partner: 'liaison', send: () => {},
  })
  await loop.tick(snap({ tick: 100, self: { id: 'me', name: 'me', teamId: 'A', pos: { x: 3, y: 0 }, score: 0 }, parcels: [pcl('p1', 4)] }))
  expect(claims.claimedBy('p1')).toBe('courier') // survivor reclaimed and re-won it
})

test('coordinated mode never opportunistically grabs an un-auctioned parcel (anytime, §9.3/§9.7)', async () => {
  const rec = fakeClient(rowMap())
  const claims = new ClaimStore()
  // zero auction budget ⇒ nothing assigned this tick (anytime fallback). In coordinated mode
  // the route is derived ONLY from claims, so the agent must NOT fall back to buildRoute and
  // chase p1 — it waits for a future tick's auction. (No spawners ⇒ no explore move either.)
  const params = { ...DEFAULT_PARAMS, auction_budget_ms: 0 }
  const loop = new BdiLoop(rec.client, params, { info: () => {}, debug: () => {}, warn: () => {} }, claims, {
    partner: 'liaison', send: () => {},
  })
  await loop.tick(snap({ self: { id: 'me', name: 'me', teamId: 'A', pos: { x: 3, y: 0 }, score: 0 }, parcels: [pcl('p1', 5)] }))
  expect(claims.claimedBy('p1')).toBeNull()
  expect(rec.moves).toEqual([]) // did not chase the un-auctioned parcel
})
