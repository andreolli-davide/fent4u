// onMissionMsg intake: a ~1-tick coalescing window + epoch-guarded single-flight driver.
// DESIGN §10: every QUERY answered individually; the latest non-query becomes the active mission.

import type { Logger } from 'pino'
import type { MissionSlot } from './slot.js'
import type { CompileResult } from './compiler.js'

export interface IntakeDeps {
  slot: MissionSlot
  compile: (raw: string) => Promise<CompileResult>
  say: (toId: string, msg: unknown) => Promise<unknown>
  logger: Logger
  windowMs?: number // coalescing window; default ~1 tick (50ms)
}

export interface Intake {
  onMessage: (from: string, raw: string) => void
  flush: () => Promise<void>
}

export function createIntake(deps: IntakeDeps): Intake {
  const { slot, compile, say, logger } = deps
  const windowMs = deps.windowMs ?? 50
  let buffer: Array<{ from: string; raw: string }> = []
  let timer: ReturnType<typeof setTimeout> | null = null
  let gen = 0

  async function flush(): Promise<void> {
    if (timer) { clearTimeout(timer); timer = null }
    const burst = buffer
    buffer = []
    if (burst.length === 0) return
    const myGen = ++gen // a later flush bumps gen → marks this one's mission install stale

    let lastMission: CompileResult & { kind: 'mission' } | null = null
    for (const { from, raw } of burst) {
      let res: CompileResult
      try {
        res = await compile(raw)
      } catch (err) {
        logger.warn({ module: 'mission', err: String(err) }, 'compile failed; keeping prior state')
        continue
      }
      if (res.kind === 'query') {
        void say(from, res.answer)
      } else if (res.kind === 'mission') {
        lastMission = res
      } else {
        logger.info({ module: 'mission', reason: res.reason }, 'mission discarded')
      }
    }

    if (lastMission && gen === myGen) {
      slot.install(lastMission.mission)
      logger.info(
        { module: 'mission', missionId: lastMission.mission.id, kind: lastMission.mission.kind, status: lastMission.mission.status },
        'mission installed',
      )
    } else if (lastMission) {
      logger.debug({ module: 'mission', missionId: lastMission.mission.id }, 'stale compile result discarded')
    }
  }

  function onMessage(from: string, raw: string): void {
    buffer.push({ from, raw })
    if (!timer) timer = setTimeout(() => { void flush() }, windowMs)
  }

  return { onMessage, flush }
}
