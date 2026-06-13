import { makeLogger } from '../logger.js'
import type { WorkerEnvelope, A2AMessage } from '../types/a2a.js'
import type { Config } from '../types/config.js'

let log: ReturnType<typeof makeLogger> | null = null

function send(msg: A2AMessage): void {
  const envelope: WorkerEnvelope = { kind: 'a2a', data: msg }
  self.postMessage(envelope)
}

self.onmessage = (event: MessageEvent<WorkerEnvelope>) => {
  const envelope = event.data

  if (envelope.kind === 'init') {
    const config: Config = envelope.config
    log = makeLogger('liaison', 'agent', {
      level: config.LOG_LEVEL,
      writeFn: (line) => {
        const logEnvelope: WorkerEnvelope = { kind: 'log', data: line }
        self.postMessage(logEnvelope)
      },
    })
    log.info({ tick: 0 }, 'Liaison initialised')
    return
  }

  if (envelope.kind === 'a2a') {
    log?.debug({ type: envelope.data.type, from: envelope.data.from }, 'a2a received')
    // BDI loop wired here in subsequent tasks
  }
}
