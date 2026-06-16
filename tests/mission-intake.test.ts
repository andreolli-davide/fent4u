import { test, expect } from 'bun:test'
import { createIntake } from '../src/mission/intake.js'
import { MissionSlot } from '../src/mission/slot.js'
import { assembleMission, type MissionDraft } from '../src/mission/kinds.js'
import type { CompileResult } from '../src/mission/compiler.js'
import { pino } from 'pino'

const draft: MissionDraft = { kind: 'CANDIDATE_INTENTION', payoff: 10, abstractIntent: 'go', params: {} }
const missionResult = (id: string): CompileResult => ({ kind: 'mission', mission: assembleMission(draft, 'raw', id) })
const queryResult = (answer: string): CompileResult => ({ kind: 'query', answer })
const silentLog = pino({ level: 'silent' })

test('a burst answers every query and installs exactly one mission (the last)', async () => {
  const slot = new MissionSlot()
  const said: Array<[string, unknown]> = []
  const byText: Record<string, CompileResult> = {
    q1: queryResult('Rome'), q2: queryResult('25'), m1: missionResult('a'), m2: missionResult('b'),
  }
  const intake = createIntake({
    slot,
    compile: async (raw) => byText[raw]!,
    say: async (to, msg) => { said.push([to, msg]); return 'successful' },
    logger: silentLog,
  })
  intake.onMessage('srv', 'q1')
  intake.onMessage('srv', 'm1')
  intake.onMessage('srv', 'q2')
  intake.onMessage('srv', 'm2')
  await intake.flush()

  expect(said.map((s) => s[1])).toEqual(['Rome', '25'])
  expect(slot.current()?.id).toBe('b') // last mission wins
})

test('queries never touch the slot', async () => {
  const slot = new MissionSlot()
  const intake = createIntake({
    slot,
    compile: async () => queryResult('Rome'),
    say: async () => 'successful',
    logger: silentLog,
  })
  intake.onMessage('srv', 'capital of Italy?')
  await intake.flush()
  expect(slot.current()).toBeNull()
})

test('a stale flush (superseded mid-await) does not install', async () => {
  const slot = new MissionSlot()
  let release!: () => void
  const gate = new Promise<void>((r) => { release = r })
  const intake = createIntake({
    slot,
    compile: async (raw) => { if (raw === 'slow') await gate; return missionResult(raw) },
    say: async () => 'successful',
    logger: silentLog,
  })
  intake.onMessage('srv', 'slow')
  const first = intake.flush()        // begins, awaits the gate
  intake.onMessage('srv', 'fast')
  await intake.flush()                // second flush bumps gen, installs 'fast'
  expect(slot.current()?.id).toBe('fast')
  release()
  await first                         // first resolves stale → must NOT overwrite
  expect(slot.current()?.id).toBe('fast')
})

test('discards neither answer nor install', async () => {
  const slot = new MissionSlot()
  const said: unknown[] = []
  const intake = createIntake({
    slot,
    compile: async () => ({ kind: 'discard', reason: 'malformed' }),
    say: async (_to, msg) => { said.push(msg); return 'successful' },
    logger: silentLog,
  })
  intake.onMessage('srv', 'garbage')
  await intake.flush()
  expect(said).toEqual([])
  expect(slot.current()).toBeNull()
})
