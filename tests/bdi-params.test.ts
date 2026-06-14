import { test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DEFAULT_PARAMS, loadParams } from '../src/bdi/params.js'

function tmpFile(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'params-'))
  const path = join(dir, 'params.yaml')
  writeFileSync(path, contents)
  return path
}

test('missing file falls back to defaults', () => {
  expect(loadParams('/no/such/file.yaml')).toEqual(DEFAULT_PARAMS)
})

test('partial file merges over defaults', () => {
  const p = loadParams(tmpFile('h_commit: 0.4\ntheta_explore: 0.5\n'))
  expect(p.h_commit).toBe(0.4)
  expect(p.theta_explore).toBe(0.5)
  expect(p.beta_comp).toBe(DEFAULT_PARAMS.beta_comp) // untouched
})

test('out-of-range value throws', () => {
  expect(() => loadParams(tmpFile('beta_comp: 2.0\n'))).toThrow(/beta_comp/)
})

test('non-number value throws', () => {
  expect(() => loadParams(tmpFile('alpha: "fast"\n'))).toThrow(/alpha/)
})
