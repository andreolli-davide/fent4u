import { test, expect } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

test('mission/ imports nothing from the BDI hot loop', () => {
  const dir = join(import.meta.dir, '..', 'src', 'mission')
  const offenders: string[] = []
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.ts')) continue
    const src = readFileSync(join(dir, f), 'utf8')
    for (const line of src.split('\n')) {
      if (/^\s*import\b/.test(line) && /bdi\/loop/.test(line)) offenders.push(`${f}: ${line.trim()}`)
    }
  }
  expect(offenders).toEqual([])
})
