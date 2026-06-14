import { makeLogger } from '../logger.js'
import { connect } from '../external/deliveroo.js'
import { Blackboard } from '../blackboard/blackboard.js'
import { BdiLoop } from '../bdi/loop.js'
import type { WorkerEnvelope, A2AMessage } from '../types/a2a.js'
import type { Config } from '../types/config.js'
import type { Params } from '../bdi/params.js'

let log: ReturnType<typeof makeLogger> | null = null
let blackboard: Blackboard | null = null
let booting = false

function send(msg: A2AMessage): void {
  self.postMessage({ kind: 'a2a', data: msg } satisfies WorkerEnvelope)
}

async function boot(config: Config, params: Params): Promise<void> {
  log = makeLogger('courier', 'agent', {
    level: config.LOG_LEVEL,
    writeFn: (line) => self.postMessage({ kind: 'log', data: line } satisfies WorkerEnvelope),
  })
  const logger = {
    warn: (o: unknown, m?: string) => log!.warn(o as object, m),
    info: (o: unknown, m?: string) => log!.info(o as object, m),
    debug: (o: unknown, m?: string) => log!.debug(o as object, m),
  }
  const client = await connect(config, 'courier', logger)

  const loop = new BdiLoop(client, params, {
    info: (obj, msg) => log!.info(obj as object, msg),
    debug: (obj, msg) => log!.debug(obj as object, msg),
    warn: (obj, msg) => log!.warn(obj as object, msg),
  })
  let booted = false
  client.onPerception((snap) => {
    if (!booted) {
      blackboard = new Blackboard(loop.beliefBase(snap), { self: 'courier', partner: 'liaison', send, logger })
      blackboard.hello(snap.tick)
      booted = true
    }
    void loop.tick(snap)
      .then(() => blackboard?.onTick(snap.tick))
      .catch((err: unknown) => log?.error({ err }, 'tick error'))
  })
  log.info({}, 'Courier BDI online')
}

self.onmessage = (event: MessageEvent<WorkerEnvelope>) => {
  const envelope = event.data
  if (envelope.kind === 'init') {
    if (booting) return
    booting = true
    void boot(envelope.config, envelope.params)
    return
  }
  if (envelope.kind === 'a2a') blackboard?.receive(envelope.data)
}
