import { test, expect } from 'bun:test'
import { calc } from '../src/mission/calc.js'

test('evaluates basic arithmetic with precedence', () => {
  expect(calc('4*2')).toBe(8)
  expect(calc('(1+3)*3')).toBe(12)
  expect(calc('10 - 2 / 2')).toBe(9)
  expect(calc('-10')).toBe(-10)
})

test('returns null for tokens outside the grammar', () => {
  expect(calc('process.exit(1)')).toBeNull()
  expect(calc('1; 2')).toBeNull()
  expect(calc('() => 1')).toBeNull()
  expect(calc('x + 1')).toBeNull()
  expect(calc('')).toBeNull()
})

test('returns null for malformed expressions and div-by-zero', () => {
  expect(calc('1 +')).toBeNull()
  expect(calc('(1+2')).toBeNull()
  expect(calc('1/0')).toBeNull()
})

test('rejects over-long input', () => {
  expect(calc('1+'.repeat(200) + '1')).toBeNull()
})
