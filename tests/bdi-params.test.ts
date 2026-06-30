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

test('coordination defaults are present and sane', () => {
  expect(DEFAULT_PARAMS.claim_ttl).toBe(10)
  expect(DEFAULT_PARAMS.bid_wait).toBe(1)
  expect(DEFAULT_PARAMS.rebalance_period).toBe(15)
  expect(DEFAULT_PARAMS.auction_budget_ms).toBe(8)
  expect(DEFAULT_PARAMS.theta_disp).toBeGreaterThan(0)
  // partner-lost backstop must outlast normal a2a jitter (≫ claim_ttl) so a live partner
  // is never mistaken for dead and stripped of its claims
  expect(DEFAULT_PARAMS.partner_lost_ticks).toBeGreaterThan(DEFAULT_PARAMS.claim_ttl)
})

test('out-of-range coordination key throws', () => {
  // a 0-tick CLAIM_TTL would expire every claim instantly — reject it
  expect(() => loadParams('tests/fixtures/params-bad-ttl.yaml')).toThrow()
})

test('mission defaults are present and sane', () => {
  expect(DEFAULT_PARAMS.theta_mission).toBeGreaterThan(0)
  expect(DEFAULT_PARAMS.c).toBe(1.5)            // §5.5 rate-ceiling factor
  expect(DEFAULT_PARAMS.p_feasible_min).toBe(0.3) // §12 floor
  expect(DEFAULT_PARAMS.rate_window).toBeGreaterThan(0)
  expect(DEFAULT_PARAMS.rate_bootstrap).toBeGreaterThan(0)
})

test('out-of-range mission param throws', () => {
  expect(() => loadParams(tmpFile('p_feasible_min: 2.0\n'))).toThrow(/p_feasible_min/)
})

test('LLM-branch params have the spec defaults', () => {
  expect(DEFAULT_PARAMS.theta_llm).toBe(0.45)
  expect(DEFAULT_PARAMS.c_llm).toBe(1.2)
  expect(DEFAULT_PARAMS.max_iters).toBe(12)
  expect(DEFAULT_PARAMS.max_iters_query).toBe(3)
  expect(DEFAULT_PARAMS.batch_max).toBe(6)
})

test('executor params carry their slice-2 defaults', () => {
  expect(DEFAULT_PARAMS.kblock_max).toBe(5)
  expect(DEFAULT_PARAMS.antiphantom_n).toBe(8)
  expect(DEFAULT_PARAMS.suppress_ticks).toBe(20)
})
