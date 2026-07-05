import { test, expect } from 'bun:test'
import { buildGrid } from '../src/planning/astar.js'
import { resolveRegion, resolveLandmark, walkableTiles } from '../src/mission/region.js'
import type { Tile } from '../src/types/perception.js'

// 4x3 grid, walkable everywhere except a wall at (0,0); delivery zones at (0,1) and (3,1).
function grid() {
  const tiles: Tile[] = []
  for (let x = 0; x < 4; x++) {
    for (let y = 0; y < 3; y++) {
      const type = x === 0 && y === 0 ? 'wall' : (x === 0 && y === 1) || (x === 3 && y === 1) ? 'delivery' : 'walkable'
      tiles.push({ pos: { x, y }, type })
    }
  }
  return buildGrid(tiles)
}

test('walkableTiles excludes walls', () => {
  const g = grid()
  const all = walkableTiles(g)
  expect(all.length).toBe(11) // 12 tiles − 1 wall
  expect(all.some((p) => p.x === 0 && p.y === 0)).toBe(false)
})

test('resolveRegion: left / right halves and border', () => {
  const g = grid()
  const left = resolveRegion(g, 'the left room')
  expect(left.every((p) => p.x <= 1.5)).toBe(true)
  const right = resolveRegion(g, 'right side')
  expect(right.every((p) => p.x >= 1.5)).toBe(true)
  const border = resolveRegion(g, 'the border')
  expect(border.every((p) => p.x === 0 || p.y === 0 || p.x === 3 || p.y === 2)).toBe(true)
  expect(resolveRegion(g, 'the moon')).toEqual([]) // unknown ⇒ grounding fail
})

test('resolveLandmark: leftmost / rightmost delivery zone', () => {
  const g = grid()
  expect(resolveLandmark(g, 'leftmost delivery')).toEqual({ x: 0, y: 1 })
  expect(resolveLandmark(g, 'rightmost tile')).toEqual({ x: 3, y: 1 })
})
