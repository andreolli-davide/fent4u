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

test('modulo and exponent (right-associative)', () => {
  expect(calc('10 % 3')).toBe(1)
  expect(calc('2 ^ 3')).toBe(8)
  expect(calc('2 ^ 3 ^ 2')).toBe(512) // right-assoc: 2^(3^2)
  expect(calc('2 * 3 ^ 2')).toBe(18) // ^ binds tighter than *
  expect(calc('7 % 0')).toBeNull()
})

test('whitelisted functions', () => {
  expect(calc('abs(-5)')).toBe(5)
  expect(calc('min(3, 7, 2)')).toBe(2)
  expect(calc('max(3, 7, 2)')).toBe(7)
  expect(calc('floor(3.9)')).toBe(3)
  expect(calc('ceil(3.1)')).toBe(4)
  expect(calc('round(2.5)')).toBe(3)
  expect(calc('sqrt(16)')).toBe(4)
  expect(calc('max(1, 2) * 3')).toBe(6)
})

test('rejects unknown functions, bad arity, sqrt of negative', () => {
  expect(calc('foo(1)')).toBeNull()
  expect(calc('abs(1, 2)')).toBeNull()
  expect(calc('min()')).toBeNull()
  expect(calc('sqrt(-1)')).toBeNull()
  expect(calc('sqrt')).toBeNull()
})
