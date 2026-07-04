// §17.5 — build a grounded PDDL problem from the frozen world snapshot + grid. Slice-1 goal is
// "deliver every currently-known free parcel" (the canonical multi-parcel ordering task, §17.2).
// Deterministic string generation (tiles/parcels in a fixed order) so a given world always yields the
// same problem — replayable and cache-friendly. Returns null (DECLINE ⇒ discard) when nothing is
// plannable: no free parcel, no delivery zone, or the agent/parcels sit off the walkable grid.
import type { Grid } from '../../planning/astar.js'
import type { Pos } from '../../types/perception.js'
import type { WorldSnapshot } from '../agent/snapshot.js'
import { tileName } from './domain.js'

export interface PddlProblemBuild {
  problem: string
  parcelById: Map<string, string> // pddl name (pk{n}) → real parcel id, to rebuild AgentSteps
}

const walkable = (grid: Grid, x: number, y: number): boolean => {
  const t = grid.tiles.get(`${x},${y}`)
  return t !== undefined && t.type !== 'wall'
}

export function buildDeliverAllProblem(grid: Grid, snap: WorldSnapshot): PddlProblemBuild | null {
  const zones = grid.deliveryZones
  if (zones.length === 0) return null
  if (!walkable(grid, snap.selfPos.x, snap.selfPos.y)) return null

  // Free, on-grid parcels only — carried/partner parcels are not this plan's job (§17.8 claims).
  const parcels = snap.parcels
    .filter((p) => p.carriedBy === null && walkable(grid, p.pos.x, p.pos.y))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  if (parcels.length === 0) return null

  // Objects: every walkable tile + one parcel object each. Tiles enumerated in a fixed (x,y) order.
  const tiles: Pos[] = []
  for (let x = 0; x < grid.w; x++) for (let y = 0; y < grid.h; y++) if (walkable(grid, x, y)) tiles.push({ x, y })

  const parcelById = new Map<string, string>()
  const objs: string[] = []
  for (const t of tiles) objs.push(`${tileName(t.x, t.y)} - tile`)
  parcels.forEach((p, i) => {
    const pk = `pk${i}`
    parcelById.set(pk, p.id)
    objs.push(`${pk} - parcel`)
  })

  const init: string[] = [`(at ${tileName(snap.selfPos.x, snap.selfPos.y)})`]
  // Orthogonal adjacency between walkable tiles (both directions; the domain move is directed).
  const N: Array<[number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1]]
  for (const t of tiles) {
    for (const [dx, dy] of N) {
      if (walkable(grid, t.x + dx, t.y + dy)) init.push(`(adjacent ${tileName(t.x, t.y)} ${tileName(t.x + dx, t.y + dy)})`)
    }
  }
  for (const z of zones) if (walkable(grid, z.x, z.y)) init.push(`(delivery ${tileName(z.x, z.y)})`)
  parcels.forEach((p, i) => init.push(`(parcel-at pk${i} ${tileName(p.pos.x, p.pos.y)})`))

  const goal = `(and ${parcels.map((_, i) => `(delivered pk${i})`).join(' ')})`

  const problem = `(define (problem deliveroo-deliver-all)
  (:domain deliveroo)
  (:objects ${objs.join(' ')})
  (:init ${init.join(' ')})
  (:goal ${goal})
)
`
  return { problem, parcelById }
}
