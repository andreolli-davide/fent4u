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

  const open = new Map<string, Node>()
  const closed = new Set<string>()
  const start: Node = { pos: from, g: 0, f: manhattan(from, to), firstStep: null }
  open.set(key(from), start)

  while (open.size > 0) {
    let cur: Node | null = null
    for (const n of open.values()) if (cur === null || n.f < cur.f) cur = n
    if (cur === null) break
    const ck = key(cur.pos)
    open.delete(ck)
    closed.add(ck)

    if (cur.pos.x === to.x && cur.pos.y === to.y) {
      return { reachable: true, L: cur.g, firstStep: cur.firstStep, pushes: [] }
    }

    for (const { dir, dx, dy } of DIRS) {
      const np = { x: cur.pos.x + dx, y: cur.pos.y + dy }
      const nk = key(np)
      if (closed.has(nk)) continue
      if (!isFloor(grid, np) || !canEnter(grid, np, dir)) continue
      if (ctx.obstacles.crateAt.has(nk)) continue
      if (ctx.obstacles.agentAt.has(nk)) continue
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
