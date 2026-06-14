import type { Pos, Tile, TileType } from '../types/perception.js'

export type Dir = 'up' | 'down' | 'left' | 'right'
export type Step = { kind: 'move'; dir: Dir } | { kind: 'push'; dir: Dir; crateId: string }
export interface PlannedPush { crateId: string; from: Pos; to: Pos; tickOffset: number }

export interface PathResult {
  reachable: boolean
  L: number // tick length; Infinity if unreachable
  firstStep: Step | null // null iff already at goal
  pushes: PlannedPush[]
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
}

export const key = (p: Pos): string => `${p.x},${p.y}`
const DIRS: { dir: Dir; dx: number; dy: number }[] = [
  { dir: 'up', dx: 0, dy: -1 },
  { dir: 'down', dx: 0, dy: 1 },
  { dir: 'left', dx: -1, dy: 0 },
  { dir: 'right', dx: 1, dy: 0 },
]

const DELTA: Record<Dir, { dx: number; dy: number }> = {
  up: { dx: 0, dy: -1 },
  down: { dx: 0, dy: 1 },
  left: { dx: -1, dy: 0 },
  right: { dx: 1, dy: 0 },
}

function isType5(grid: Grid, p: Pos): boolean {
  const t = grid.tiles.get(key(p))
  return t !== undefined && (t.type === 'slide' || t.type === 'crateSpawner')
}

function connectivityPreserved(grid: Grid, ctx: PlanCtx, vacated: Pos, occupied: Pos): boolean {
  if (ctx.protectedTiles.length < 2) return true
  const vk = key(vacated)
  const ok = key(occupied)
  const blocked = (p: Pos): boolean => {
    const k = key(p)
    if (k === ok) return true
    if (k === vk) return false
    return ctx.obstacles.crateAt.has(k)
  }
  const passable = (p: Pos): boolean => {
    const t = grid.tiles.get(key(p))
    return t !== undefined && t.type !== 'wall' && !blocked(p)
  }
  const seen = new Set<string>()
  const stack: Pos[] = [ctx.protectedTiles[0]]
  seen.add(key(ctx.protectedTiles[0]))
  while (stack.length > 0) {
    const p = stack.pop()!
    for (const { dx, dy } of Object.values(DELTA)) {
      const np = { x: p.x + dx, y: p.y + dy }
      const nk = key(np)
      if (seen.has(nk) || !passable(np)) continue
      seen.add(nk)
      stack.push(np)
    }
  }
  return ctx.protectedTiles.every((t) => seen.has(key(t)))
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
  if (t.type === 'oneway' && t.dir !== dir) return false
  return true
}

const manhattan = (a: Pos, b: Pos): number => Math.abs(a.x - b.x) + Math.abs(a.y - b.y)

interface Node {
  pos: Pos
  g: number
  f: number
  firstStep: Step | null
}

export function planPath(grid: Grid, ctx: PlanCtx, from: Pos, to: Pos): PathResult {
  if (from.x === to.x && from.y === to.y) return { reachable: true, L: 0, firstStep: null, pushes: [] }

  const deadline = performance.now() + ctx.budgetMs
  const usedPushDest = new Set<string>()
  const open = new Map<string, Node>()
  const closed = new Set<string>()
  const start: Node = { pos: from, g: 0, f: manhattan(from, to), firstStep: null }
  open.set(key(from), start)

  while (open.size > 0) {
    let cur: Node | null = null
    for (const n of open.values()) if (cur === null || n.f < cur.f) cur = n
    if (cur === null) break
    if (performance.now() > deadline) return { reachable: false, L: Infinity, firstStep: null, pushes: [] }
    const ck = key(cur.pos)
    open.delete(ck)
    closed.add(ck)

    if (cur.pos.x === to.x && cur.pos.y === to.y) {
      const pushes: PlannedPush[] = []
      if (cur.firstStep?.kind === 'push') {
        const fp = cur.firstStep
        const d0 = DELTA[fp.dir]
        const cratePos = { x: from.x + d0.dx, y: from.y + d0.dy }
        pushes.push({ crateId: fp.crateId, from: cratePos, to: { x: cratePos.x + d0.dx, y: cratePos.y + d0.dy }, tickOffset: 0 })
      }
      return { reachable: true, L: cur.g, firstStep: cur.firstStep, pushes }
    }

    for (const { dir, dx, dy } of DIRS) {
      const np = { x: cur.pos.x + dx, y: cur.pos.y + dy }
      const nk = key(np)
      if (closed.has(nk)) continue
      if (!isFloor(grid, np) || !canEnter(grid, np, dir)) continue
      if (ctx.obstacles.agentAt.has(nk)) continue
      if (ctx.obstacles.crateAt.has(nk)) {
        // crate ahead: try an admissible push (skip when in crates-as-walls fallback)
        // Only the first-step push is tracked per plan (§15.3 defers multi-push); enforce
        // single-destination-per-search so two push edges cannot claim the same slide tile.
        if (ctx.cratesAsWalls) continue
        if (!isPushAdmissible(grid, ctx, np, dir)) continue
        const beyond = { x: np.x + DELTA[dir].dx, y: np.y + DELTA[dir].dy }
        const beyondKey = key(beyond)
        if (usedPushDest.has(beyondKey)) continue
        const crate = ctx.obstacles.crateAt.get(nk)!
        const g = cur.g + 1
        const existing = open.get(nk)
        if (existing !== undefined && existing.g <= g) continue
        usedPushDest.add(beyondKey)
        const push: Step = { kind: 'push', dir, crateId: crate.id }
        const firstStep: Step = cur.firstStep ?? push
        open.set(nk, { pos: np, g, f: g + manhattan(np, to), firstStep })
        continue
      }
      const g = cur.g + 1
      const existing = open.get(nk)
      if (existing !== undefined && existing.g <= g) continue
      const firstStep: Step = cur.firstStep ?? { kind: 'move', dir }
      open.set(nk, { pos: np, g, f: g + manhattan(np, to), firstStep })
    }
  }
  return { reachable: false, L: Infinity, firstStep: null, pushes: [] }
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
