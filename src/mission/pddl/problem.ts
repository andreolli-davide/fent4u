// §17.5 — build a grounded PDDL problem from the frozen world snapshot + grid. Two task builders:
//   buildDeliverAllProblem — "deliver every currently-known free parcel" (multi-parcel ordering, §17.2);
//   buildCoverageProblem   — "visit every target tile" (traversal goal, §17.5.2).
// Both accept a `mask` set of tiles the constraints (StayOn/KeepAway/Avoid) forbid: masked tiles are
// dropped from the walkable set, so `adjacent` never references them and the plan routes around them
// (§17.5.2 grid-level :init filtering). Deterministic string generation (fixed (x,y) order) so a given
// world always yields the same problem — replayable and cache-friendly. Returns null (DECLINE ⇒
// discard) when nothing is plannable: no free parcel / no zone / empty targets / off-grid agent.
import type { Grid } from '../../planning/astar.js'
import type { Pos } from '../../types/perception.js'
import type { WorldSnapshot } from '../agent/snapshot.js'
import { tileName } from './domain.js'

export interface PddlProblemBuild {
  problem: string
  parcelById: Map<string, string> // pddl name (pk{n}) → real parcel id, to rebuild AgentSteps
}

const keyOf = (p: Pos): string => `${p.x},${p.y}`

function walkableSet(grid: Grid, mask: Pos[]): Set<string> {
  const blocked = new Set(mask.map(keyOf))
  const w = new Set<string>()
  for (let x = 0; x < grid.w; x++) {
    for (let y = 0; y < grid.h; y++) {
      const k = keyOf({ x, y })
      if (blocked.has(k)) continue
      const t = grid.tiles.get(k)
      if (t !== undefined && t.type !== 'wall') w.add(k)
    }
  }
  return w
}

// Orthogonal adjacency facts between walkable tiles (both directions; the domain move is directed).
function adjacencyFacts(walk: Set<string>): string[] {
  const N: Array<[number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1]]
  const out: string[] = []
  for (const k of walk) {
    const [x, y] = k.split(',').map(Number) as [number, number]
    for (const [dx, dy] of N) {
      const nk = keyOf({ x: x + dx, y: y + dy })
      if (walk.has(nk)) out.push(`(adjacent ${tileName(x, y)} ${tileName(x + dx, y + dy)})`)
    }
  }
  return out
}

export function buildDeliverAllProblem(grid: Grid, snap: WorldSnapshot, mask: Pos[] = []): PddlProblemBuild | null {
  const zones = grid.deliveryZones
  if (zones.length === 0) return null
  const walk = walkableSet(grid, mask)
  if (!walk.has(keyOf(snap.selfPos))) return null

  // Free, on-(unmasked)-grid parcels only — carried/partner parcels are not this plan's job (§17.8).
  const parcels = snap.parcels
    .filter((p) => p.carriedBy === null && walk.has(keyOf(p.pos)))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  if (parcels.length === 0) return null

  const tiles: Pos[] = [...walk].map((k) => { const [x, y] = k.split(',').map(Number) as [number, number]; return { x, y } })
    .sort((a, b) => a.x - b.x || a.y - b.y)

  const parcelById = new Map<string, string>()
  const objs: string[] = []
  for (const t of tiles) objs.push(`${tileName(t.x, t.y)} - tile`)
  parcels.forEach((p, i) => { parcelById.set(`pk${i}`, p.id); objs.push(`pk${i} - parcel`) })

  const init: string[] = [`(at ${tileName(snap.selfPos.x, snap.selfPos.y)})`, ...adjacencyFacts(walk)]
  for (const z of zones) if (walk.has(keyOf(z))) init.push(`(delivery ${tileName(z.x, z.y)})`)
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

// §17.5.2 Coverage: visit every tile in `targets`. Domain is deliveroo-coverage (visited on entry).
export function buildCoverageProblem(grid: Grid, snap: WorldSnapshot, targets: Pos[], mask: Pos[] = []): PddlProblemBuild | null {
  const walk = walkableSet(grid, mask)
  if (!walk.has(keyOf(snap.selfPos))) return null
  const tgt = targets.filter((t) => walk.has(keyOf(t)))
  if (tgt.length === 0) return null

  const tiles: Pos[] = [...walk].map((k) => { const [x, y] = k.split(',').map(Number) as [number, number]; return { x, y } })
    .sort((a, b) => a.x - b.x || a.y - b.y)

  const objs = tiles.map((t) => `${tileName(t.x, t.y)} - tile`)
  const self = tileName(snap.selfPos.x, snap.selfPos.y)
  const init: string[] = [`(at ${self})`, `(visited ${self})`, ...adjacencyFacts(walk)]
  const goal = `(and ${tgt.map((t) => `(visited ${tileName(t.x, t.y)})`).join(' ')})`
  const problem = `(define (problem deliveroo-coverage)
  (:domain deliveroo-coverage)
  (:objects ${objs.join(' ')})
  (:init ${init.join(' ')})
  (:goal ${goal})
)
`
  return { problem, parcelById: new Map() }
}
