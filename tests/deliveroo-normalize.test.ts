// tests/deliveroo-normalize.test.ts
import { test, expect } from 'bun:test'
import { normalizeTile } from '../src/external/deliveroo.js'
import type { IOTile } from '@unitn-asa/deliveroo-js-sdk'

// minimal logger spy capturing warn calls
function spyLogger() {
  const warns: unknown[][] = []
  return {
    logger: {
      warn: (...args: unknown[]) => {
        warns.push(args)
      },
      info: () => {},
      debug: () => {},
    },
    warns,
  }
}

test('normalizeTile maps basic tile types', () => {
  const { logger } = spyLogger()
  expect(normalizeTile({ x: 1, y: 2, type: '0' }, logger)).toEqual({
    pos: { x: 1, y: 2 },
    type: 'wall',
  })
  expect(normalizeTile({ x: 0, y: 0, type: '1' }, logger).type).toBe('spawner')
  expect(normalizeTile({ x: 0, y: 0, type: '2' }, logger).type).toBe('delivery')
  expect(normalizeTile({ x: 0, y: 0, type: '3' }, logger).type).toBe('walkable')
  expect(normalizeTile({ x: 0, y: 0, type: '4' }, logger).type).toBe('base')
  expect(normalizeTile({ x: 0, y: 0, type: '5' }, logger).type).toBe('slide')
  expect(normalizeTile({ x: 0, y: 0, type: '5!' }, logger).type).toBe('crateSpawner')
})

test('normalizeTile maps directional arrows to oneway with dir', () => {
  const { logger } = spyLogger()
  expect(normalizeTile({ x: 0, y: 0, type: '↑' }, logger)).toEqual({
    pos: { x: 0, y: 0 },
    type: 'oneway',
    dir: 'up',
  })
  expect(normalizeTile({ x: 0, y: 0, type: '↓' }, logger).dir).toBe('down')
  expect(normalizeTile({ x: 0, y: 0, type: '←' }, logger).dir).toBe('left')
  expect(normalizeTile({ x: 0, y: 0, type: '→' }, logger).dir).toBe('right')
})

test('normalizeTile: unknown char -> wall + warn', () => {
  const { logger, warns } = spyLogger()
  // force an invalid type past the type system
  const bad = { x: 3, y: 4, type: '9' } as unknown as IOTile
  const tile = normalizeTile(bad, logger)
  expect(tile).toEqual({ pos: { x: 3, y: 4 }, type: 'wall' })
  expect(warns.length).toBe(1)
})
