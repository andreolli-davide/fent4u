import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { parseConfig } from './types/config.js'
import { makeLogger } from './logger.js'
import { relay } from './relay.js'
import type { AgentId, WorkerEnvelope } from './types/a2a.js'
import { loadParams } from './bdi/params.js'

const config = parseConfig(Bun.env)
const params = loadParams() // reads config/params.yaml, falls back to defaults

mkdirSync(config.LOG_DIR, { recursive: true })
const logPath = join(config.LOG_DIR, `session-${Date.now()}.ndjson`)
const logFile = Bun.file(logPath).writer()

const log = makeLogger('main', 'main', {
  level: config.LOG_LEVEL,
  writeFn: (line) => {
    process.stdout.write(line)
    logFile.write(line)
  },
})

const liaison = new Worker(new URL('./agents/liaison.ts', import.meta.url))
const courier = new Worker(new URL('./agents/courier.ts', import.meta.url))

const workers: Record<AgentId, Worker> = { liaison, courier }

function handleMessage(from: AgentId): (event: MessageEvent) => void {
  return (event: MessageEvent) => {
    const envelope = event.data as WorkerEnvelope
    relay(envelope, from, workers, (line) => {
      process.stdout.write(line)
      logFile.write(line)
    })
  }
}

liaison.addEventListener('message', handleMessage('liaison'))
courier.addEventListener('message', handleMessage('courier'))

liaison.addEventListener('error', (e) => log.error({ err: e.message }, 'liaison worker error'))
courier.addEventListener('error', (e) => log.error({ err: e.message }, 'courier worker error'))

liaison.postMessage({ kind: 'init', config, params } satisfies WorkerEnvelope)
courier.postMessage({ kind: 'init', config, params } satisfies WorkerEnvelope)

log.info({ logPath }, 'fent4u started — both workers spawned')

process.on('SIGINT', async () => {
  log.info('shutting down')
  liaison.terminate()
  courier.terminate()
  try {
    await logFile.flush()
  } catch (err) {
    process.stderr.write(`Failed to flush logs: ${String(err)}\n`)
  }
  process.exit(0)
})
