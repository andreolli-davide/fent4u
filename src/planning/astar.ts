import type { Pos, Tile, TileType } from '../types/perception.js'

export type Dir = 'up' | 'down' | 'left' | 'right'
export type Step = { kind: 'move'; dir: Dir } | { kind: 'push'; dir: Dir; crateId: string }
export interface PlannedPush { crateId: string; from: Pos; to: Pos; tickOffset: number }

export interface PathResult {
  reachable: boolean
  L: number // tick length; Infinity if unreachable
  firstStep: Step | null // null iff already at goal
  pushes: PlannedPush[]
  timedOut: boolean // search hit budgetMs before settling — NOT proof of unreachability (§15.3)
  tollSum: number // Σ toll(tile) over the chosen path's entered tiles; 0 in pure-tick mode
}

export interface GridTile { type: TileType; dir?: Dir }
export interface Grid {
  w: number
  h: number
  tiles: Map<string, GridTile>
  deliveryZones: Pos[]
}

export interface Obstacles {
  crateAt: Map<string, { id: string; locked: boolean }>
  agentAt: Set<string>
}

export interface PlanCtx {
  obstacles: Obstacles
  protectedTiles: Pos[]
  budgetMs: number
  cratesAsWalls?: boolean
  tolls?: Map<string, number> // tileKey -> toll points; absent/empty ⇒ pure-tick mode
  cTick?: number // §7.1 exchange rate (points per travel tick); required iff tolls non-empty
}

export const key = (p: Pos): string => `${p.x},${p.y}`
// Server convention (GAME_RULES.md §Movement): up = dy +1, down = dy -1.
// These direction→delta tables must match the wire, not screen intuition.
const DIRS: { dir: Dir; dx: number; dy: number }[] = [
  { dir: 'up', dx: 0, dy: 1 },
  { dir: 'down', dx: 0, dy: -1 },
  { dir: 'left', dx: -1, dy: 0 },
  { dir: 'right', dx: 1, dy: 0 },
]

const DELTA: Record<Dir, { dx: number; dy: number }> = {
  up: { dx: 0, dy: 1 },
  down: { dx: 0, dy: -1 },
  left: { dx: -1, dy: 0 },
  right: { dx: 1, dy: 0 },
}

// A one-way tile blocks entry only *against* its arrow (GAME_RULES §Directional):
// an '↑' tile rejects a `down` entry, permits up/left/right. So the forbidden
// move is the OPPOSITE of the tile's dir — not "every dir but the arrow".
const OPPOSITE: Record<Dir, Dir> = { up: 'down', down: 'up', left: 'right', right: 'left' }

function isType5(grid: Grid, p: Pos): boolean {
  const t = grid.tiles.get(key(p))
  return t !== undefined && (t.type === 'slide' || t.type === 'crateSpawner')
}

function connectivityPreserved(grid: Grid, ctx: PlanCtx, vacated: Pos, occupied: Pos): boolean {
  if (ctx.protectedTiles.length < 2) return true
  const vk = key(vacated)
  const ok = key(occupied)
  // Post-push occupancy: the crate now sits on `occupied` and has left `vacated`.
  const blocked = (p: Pos): boolean => {
    const k = key(p)
    if (k === ok) return true
    if (k === vk) return false
    return ctx.obstacles.crateAt.has(k)
  }
  const standable = (p: Pos): boolean => {
    const t = grid.tiles.get(key(p))
    return t !== undefined && t.type !== 'wall' && !blocked(p)
  }
  // One-ways make adjacency directed (same rule as canEnter), so a plain undirected
  // flood would overstate reachability and could authorize a push that severs a
  // region reachable only one-way. Certify the protected set is STRONGLY connected
  // via a hub = protectedTiles[0]: hub reaches all (forward) AND all reach hub
  // (reverse) ⇒ every pair is mutually reachable through the hub.
  const hub = ctx.protectedTiles[0]
  // edgeOk(p, np, dir): does a directed edge exist between geometric neighbours
  // p and np (np = p + DELTA[dir])? Forward and reverse pass different predicates.
  const flood = (edgeOk: (p: Pos, np: Pos, dir: Dir) => boolean): Set<string> => {
    const seen = new Set<string>([key(hub)])
    const stack: Pos[] = [hub]
    while (stack.length > 0) {
      const p = stack.pop()!
      for (const { dir, dx, dy } of DIRS) {
        const np = { x: p.x + dx, y: p.y + dy }
        const nk = key(np)
        if (seen.has(nk) || !standable(np) || !edgeOk(p, np, dir)) continue
        seen.add(nk)
        stack.push(np)
      }
    }
    return seen
  }
  // forward edge p→np exists iff np is enterable moving `dir` (same as A*).
  const fwd = flood((_p, np, dir) => canEnter(grid, np, dir))
  if (!ctx.protectedTiles.every((t) => fwd.has(key(t)))) return false
  // reverse: hub reachable FROM the set. Walk the reversed graph — edge np→p
  // exists iff p is enterable moving OPPOSITE[dir] (the np→p direction).
  const rev = flood((p, _np, dir) => canEnter(grid, p, OPPOSITE[dir]))
  return ctx.protectedTiles.every((t) => rev.has(key(t)))
}

export function isPushAdmissible(grid: Grid, ctx: PlanCtx, cratePos: Pos, dir: Dir): boolean {
  const beyond = { x: cratePos.x + DELTA[dir].dx, y: cratePos.y + DELTA[dir].dy }
  const bk = key(beyond)
  const crate = ctx.obstacles.crateAt.get(key(cratePos))
  if (crate === undefined) return false
  if (crate.locked) return false
  if (!isType5(grid, beyond)) return false // clause 1: type-5
  if (ctx.obstacles.crateAt.has(bk)) return false // clause 1: crate-free
  if (ctx.obstacles.agentAt.has(bk)) return false // clause 2: no agent on destination
  return connectivityPreserved(grid, ctx, cratePos, beyond) // clause 3
}

export function buildGrid(map: Tile[]): Grid {
  const tiles = new Map<string, GridTile>()
  const deliveryZones: Pos[] = []
  let w = 0
  let h = 0
  for (const t of map) {
    tiles.set(key(t.pos), { type: t.type, dir: t.dir as Dir | undefined })
    if (t.type === 'delivery') deliveryZones.push(t.pos)
    w = Math.max(w, t.pos.x + 1)
    h = Math.max(h, t.pos.y + 1)
  }
  return { w, h, tiles, deliveryZones }
}

function isFloor(grid: Grid, p: Pos): boolean {
  const t = grid.tiles.get(key(p))
  return t !== undefined && t.type !== 'wall'
}

function canEnter(grid: Grid, to: Pos, dir: Dir): boolean {
  const t = grid.tiles.get(key(to))
  if (t === undefined || t.type === 'wall') return false
  if (t.type === 'oneway' && t.dir !== undefined && dir === OPPOSITE[t.dir]) return false
  return true
}

const manhattan = (a: Pos, b: Pos): number => Math.abs(a.x - b.x) + Math.abs(a.y - b.y)

interface Node {
  pos: Pos
  g: number // tick count (steps) — what L is reported from
  cost: number // ordering cost: cTick*g + tollAccum (== g in pure-tick mode)
  tollAccum: number
  f: number
  firstStep: Step | null
  seq: number // insertion order — final, deterministic tie-break (§9)
}

// Heap order: lower f wins; ties prefer the deeper node (larger g ⇒ smaller h,
// fewer expansions); remaining ties broken by insertion order for determinism.
// In toll mode f = cost + h so the heap still correctly orders by total estimated cost.
function before(a: Node, b: Node): boolean {
  if (a.f !== b.f) return a.f < b.f
  if (a.g !== b.g) return a.g > b.g
  return a.seq < b.seq
}

// Binary min-heap. Replaces the old O(V) linear scan of `open` — the linear scan
// made large maps blow ctx.budgetMs, which (via the timeout path) then reported a
// reachable goal as unreachable.
class NodeHeap {
  private readonly h: Node[] = []
  get size(): number {
    return this.h.length
  }
  push(n: Node): void {
    const h = this.h
    h.push(n)
    let i = h.length - 1
    while (i > 0) {
      const p = (i - 1) >> 1
      if (!before(h[i], h[p])) break
      ;[h[i], h[p]] = [h[p], h[i]]
      i = p
    }
  }
  pop(): Node {
    const h = this.h
    const top = h[0]
    const last = h.pop()!
    if (h.length > 0) {
      h[0] = last
      let i = 0
      for (;;) {
        const l = 2 * i + 1
        const r = l + 1
        let s = i
        if (l < h.length && before(h[l], h[s])) s = l
        if (r < h.length && before(h[r], h[s])) s = r
        if (s === i) break
        ;[h[i], h[s]] = [h[s], h[i]]
        i = s
      }
    }
    return top
  }
}

export function planPath(grid: Grid, ctx: PlanCtx, from: Pos, to: Pos): PathResult {
  if (from.x === to.x && from.y === to.y) return { reachable: true, L: 0, firstStep: null, pushes: [], timedOut: false, tollSum: 0 }

  const tolls = ctx.tolls
  const tollMode = tolls !== undefined && tolls.size > 0
  const cTick = tollMode ? (ctx.cTick ?? 1) : 1
  const tollOf = (k: string): number => (tollMode ? (tolls!.get(k) ?? 0) : 0)

  const deadline = performance.now() + ctx.budgetMs
  const open = new NodeHeap()
  const bestCost = new Map<string, number>() // best known cost per tile — drives relaxation and stale-pop skips
  const closed = new Set<string>()
  let seq = 0
  open.push({ pos: from, g: 0, cost: 0, tollAccum: 0, f: cTick * manhattan(from, to), firstStep: null, seq: seq++ })
  bestCost.set(key(from), 0)

  while (open.size > 0) {
    if (performance.now() > deadline) return { reachable: false, L: Infinity, firstStep: null, pushes: [], timedOut: true, tollSum: 0 }
    const cur = open.pop()
    const ck = key(cur.pos)
    if (closed.has(ck)) continue // stale heap duplicate (lazy decrease-key)
    closed.add(ck)

    if (cur.pos.x === to.x && cur.pos.y === to.y) {
      const pushes: PlannedPush[] = []
      if (cur.firstStep?.kind === 'push') {
        const fp = cur.firstStep
        const d0 = DELTA[fp.dir]
        const cratePos = { x: from.x + d0.dx, y: from.y + d0.dy }
        pushes.push({ crateId: fp.crateId, from: cratePos, to: { x: cratePos.x + d0.dx, y: cratePos.y + d0.dy }, tickOffset: 0 })
      }
      return { reachable: true, L: cur.g, firstStep: cur.firstStep, pushes, timedOut: false, tollSum: cur.tollAccum }
    }

    for (const { dir, dx, dy } of DIRS) {
      const np = { x: cur.pos.x + dx, y: cur.pos.y + dy }
      const nk = key(np)
      if (closed.has(nk)) continue
      if (!isFloor(grid, np) || !canEnter(grid, np, dir)) continue
      if (ctx.obstacles.agentAt.has(nk)) continue
      let firstStep: Step
      if (ctx.obstacles.crateAt.has(nk)) {
        // crate ahead: try an admissible push (skip in crates-as-walls fallback).
        // Only the first-step push is executed (§15.2/§15.3 defers multi-push), so no
        // cross-branch destination dedup is needed — each A* path pushes any crate once.
        if (ctx.cratesAsWalls) continue
        if (!isPushAdmissible(grid, ctx, np, dir)) continue
        const crate = ctx.obstacles.crateAt.get(nk)!
        firstStep = cur.firstStep ?? { kind: 'push', dir, crateId: crate.id }
      } else {
        firstStep = cur.firstStep ?? { kind: 'move', dir }
      }
      const stepToll = tollOf(nk)
      const cost = cur.cost + cTick + stepToll
      const prev = bestCost.get(nk)
      if (prev !== undefined && prev <= cost) continue
      bestCost.set(nk, cost)
      open.push({ pos: np, g: cur.g + 1, cost, tollAccum: cur.tollAccum + stepToll, f: cost + cTick * manhattan(np, to), firstStep, seq: seq++ })
    }
  }
  return { reachable: false, L: Infinity, firstStep: null, pushes: [], timedOut: false, tollSum: 0 }
}

export function d(grid: Grid, ctx: PlanCtx, from: Pos, to: Pos): number {
  return planPath(grid, ctx, from, to).L
}

export function buildObstacles(
  crates: { id: string; state: string; pos?: Pos; locked: boolean }[],
  agents: { pos: Pos }[],
): Obstacles {
  const crateAt = new Map<string, { id: string; locked: boolean }>()
  for (const c of crates) {
    if (c.state === 'known' && c.pos) crateAt.set(key(c.pos), { id: c.id, locked: c.locked })
  }
  const agentAt = new Set<string>()
  for (const a of agents) agentAt.add(key(a.pos))
  return { crateAt, agentAt }
}
