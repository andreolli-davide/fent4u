// tests/deliveroo-connect.test.ts
import { test, expect } from 'bun:test'
import { connect } from '../src/external/deliveroo.js'
import type {
  DjsClientSocket,
  IOAgent,
  IOConfig,
  IOTile,
  IOSensing,
  IOPing,
} from '@unitn-asa/deliveroo-js-sdk'
import type { Config } from '../src/types/config.js'
import type { PerceptionSnapshot } from '../src/types/perception.js'

const noopLogger = {
  warn: () => {},
  info: () => {},
  debug: () => {},
}

function spyLogger() {
  const warns: unknown[][] = []
  return {
    logger: {
      warn: (...a: unknown[]) => {
        warns.push(a)
      },
      info: () => {},
      debug: () => {},
    },
    warns,
  }
}

const fakeConfig: Config = {
  DELIVEROO_HOST: 'http://localhost',
  DELIVEROO_PORT: 8080,
  TOKEN_LIAISON: 'L',
  TOKEN_COURIER: 'C',
  LITELLM_MODEL: 'm',
  LITELLM_API_KEY: 'k',
  LITELLM_BASE_URL: '',
  LOG_LEVEL: 'info',
  LOG_DIR: './logs',
}

const me: IOAgent = {
  id: 'self', name: 'Me', teamId: 't1', teamName: 'T1', x: 0, y: 0, score: 0, penalty: 0,
}
const ioConfig: IOConfig = {
  CLOCK: 50, PENALTY: 1, AGENT_TIMEOUT: 10000, BROADCAST_LOGS: false,
  GAME: {
    player: { movement_duration: 50, observation_distance: 5 },
    parcels: { decaying_event: '1s', generation_event: '2s' },
  },
}
const tiles: IOTile[] = [
  { x: 0, y: 0, type: '3' },
  { x: 1, y: 0, type: '2' },
  { x: 2, y: 0, type: '↑' },
]

/** Build a fake DjsClientSocket with manual event triggers. */
function makeFakeSocket() {
  let sensingCb: ((io: IOSensing) => void) | null = null
  let youCb: ((m: IOAgent) => void) | null = null
  let pingCb: ((d: IOPing, ack: () => void) => void) | null = null
  const socket = {
    onConnect: () => {},
    onDisconnect: () => {},
    onYou: (cb: (m: IOAgent) => void) => {
      youCb = cb
    },
    onSensing: (cb: (io: IOSensing) => void) => {
      sensingCb = cb
    },
    onMsg: () => {},
    on: (event: string, cb: (...args: unknown[]) => void) => {
      if (event === 'ping') pingCb = cb as (d: IOPing, ack: () => void) => void
    },
    once: (event: string, cb: (...args: unknown[]) => void) => {
      if (event === 'you') void Promise.resolve(me).then((v) => cb(v))
      else if (event === 'config') void Promise.resolve(ioConfig).then((v) => cb(v))
      else if (event === 'map') void Promise.resolve({ width: 3, height: 1, tiles }).then(({ width, height, tiles: t }) => cb(width, height, t))
    },
    emitMove: async () => ({ x: 1, y: 0 }),
    emitPickup: async () => [{ id: 'p1' }],
    emitPutdown: async () => [{ id: 'p1' }],
    emitSay: async () => 'successful' as const,
    emitAsk: async () => ({}),
    emitShout: async () => ({}),
    disconnect: () => socket,
  }
  return {
    socket: socket as unknown as DjsClientSocket,
    fire: {
      sensing: (io: IOSensing) => sensingCb?.(io),
      you: (m: IOAgent) => youCb?.(m),
      ping: (d: IOPing) => pingCb?.(d, () => {}),
    },
  }
}

test('connect resolves a fully-initialized client (consts + map)', async () => {
  const { socket } = makeFakeSocket()
  const client = await connect(fakeConfig, 'courier', noopLogger, () => socket)
  expect(client.role).toBe('courier')
  expect(client.consts.PARCEL_DECAY_TICKS).toBe(20)
  expect(client.map).toHaveLength(3)
  expect(client.map[1].type).toBe('delivery')
  expect(client.map[2]).toEqual({ pos: { x: 2, y: 0 }, type: 'oneway', dir: 'up' })
})

test('connect emits a correctly-ticked snapshot on sensing', async () => {
  const { socket, fire } = makeFakeSocket()
  const client = await connect(fakeConfig, 'courier', noopLogger, () => socket)

  let got: PerceptionSnapshot | null = null
  client.onPerception((s) => {
    got = s
  })

  fire.ping({ frame: 100, roundTrip: 10 })
  fire.sensing({
    positions: [],
    agents: [],
    parcels: [{ id: 'p1', x: 1, y: 1, reward: 9 }],
    crates: [],
  })

  expect(got).not.toBeNull()
  expect(got!.self.id).toBe('self')
  expect(got!.parcels).toEqual([
    { id: 'p1', pos: { x: 1, y: 1 }, reward: 9, carriedBy: null },
  ])
  // tick anchored at frame 100, ~0ms elapsed -> 100 (allow +1 for slow CI)
  expect(got!.tick).toBeGreaterThanOrEqual(100)
  expect(got!.tick).toBeLessThanOrEqual(101)
})

test('snapshot self position tracks the latest you event', async () => {
  const { socket, fire } = makeFakeSocket()
  const client = await connect(fakeConfig, 'courier', noopLogger, () => socket)
  let got: PerceptionSnapshot | null = null
  client.onPerception((s) => {
    got = s
  })

  fire.you({ ...me, x: 4, y: 7 })
  fire.sensing({ positions: [], agents: [], parcels: [], crates: [] })

  expect(got!.self.pos).toEqual({ x: 4, y: 7 })
})

test('courier role-gates the mission channel', async () => {
  const { socket } = makeFakeSocket()
  const client = await connect(fakeConfig, 'courier', noopLogger, () => socket)
  expect(() => client.onMissionMsg(() => {})).toThrow('mission channel: liaison only')
  expect(() => client.say('x', 'hi')).toThrow('mission channel: liaison only')
  expect(() => client.ask('x', 'hi')).toThrow('mission channel: liaison only')
  expect(() => client.shout('hi')).toThrow('mission channel: liaison only')
})

test('liaison can use the mission channel', async () => {
  const { socket } = makeFakeSocket()
  const client = await connect(fakeConfig, 'liaison', noopLogger, () => socket)
  expect(await client.say('x', 'hi')).toBe('successful')
})

test('move resolving false passes through as a normal outcome (not thrown, not logged)', async () => {
  const { logger, warns } = spyLogger()
  const socket = {
    onConnect: () => {}, onDisconnect: () => {}, onYou: () => {}, onSensing: () => {},
    onMsg: () => {}, on: () => {},
    once: (event: string, cb: (...args: unknown[]) => void) => {
      if (event === 'you') void Promise.resolve(me).then((v) => cb(v))
      else if (event === 'config') void Promise.resolve(ioConfig).then((v) => cb(v))
      else if (event === 'map') void Promise.resolve({ width: 3, height: 1, tiles }).then(({ width, height, tiles: t }) => cb(width, height, t))
    },
    emitMove: async () => false as const,
    emitPickup: async () => [], emitPutdown: async () => [],
    emitSay: async () => 'successful' as const, emitAsk: async () => ({}), emitShout: async () => ({}),
    disconnect() { return this },
  } as unknown as DjsClientSocket
  const client = await connect(fakeConfig, 'courier', logger, () => socket)
  expect(await client.move('up')).toBe(false)
  expect(warns.length).toBe(0)
})

test('action rejection is logged at warn and propagates to the caller', async () => {
  const { logger, warns } = spyLogger()
  const socket = {
    onConnect: () => {}, onDisconnect: () => {}, onYou: () => {}, onSensing: () => {},
    onMsg: () => {}, on: () => {},
    once: (event: string, cb: (...args: unknown[]) => void) => {
      if (event === 'you') void Promise.resolve(me).then((v) => cb(v))
      else if (event === 'config') void Promise.resolve(ioConfig).then((v) => cb(v))
      else if (event === 'map') void Promise.resolve({ width: 3, height: 1, tiles }).then(({ width, height, tiles: t }) => cb(width, height, t))
    },
    emitMove: async () => { throw new Error('ack timeout') },
    emitPickup: async () => [], emitPutdown: async () => [],
    emitSay: async () => 'successful' as const, emitAsk: async () => ({}), emitShout: async () => ({}),
    disconnect() { return this },
  } as unknown as DjsClientSocket
  const client = await connect(fakeConfig, 'courier', logger, () => socket)
  await expect(client.move('up')).rejects.toThrow('ack timeout')
  expect(warns.length).toBe(1)
})

test('close() disconnects the socket', async () => {
  let disconnected = false
  const socket = {
    onConnect: () => {}, onDisconnect: () => {}, onYou: () => {}, onSensing: () => {},
    onMsg: () => {}, on: () => {},
    once: (event: string, cb: (...args: unknown[]) => void) => {
      if (event === 'you') void Promise.resolve(me).then((v) => cb(v))
      else if (event === 'config') void Promise.resolve(ioConfig).then((v) => cb(v))
      else if (event === 'map') void Promise.resolve({ width: 3, height: 1, tiles }).then(({ width, height, tiles: t }) => cb(width, height, t))
    },
    emitMove: async () => false as const, emitPickup: async () => [], emitPutdown: async () => [],
    emitSay: async () => 'successful' as const, emitAsk: async () => ({}), emitShout: async () => ({}),
    disconnect() { disconnected = true; return this },
  } as unknown as DjsClientSocket
  const client = await connect(fakeConfig, 'courier', noopLogger, () => socket)
  client.close()
  expect(disconnected).toBe(true)
})

test('liaison onMissionMsg receives delivered messages', async () => {
  let msgCb: ((id: string, name: string, msg: unknown, reply: (a: unknown) => void) => void) | null = null
  const socket = {
    onConnect: () => {}, onDisconnect: () => {}, onYou: () => {}, onSensing: () => {},
    onMsg: (cb: (id: string, name: string, msg: unknown, reply: (a: unknown) => void) => void) => {
      msgCb = cb
    },
    on: () => {},
    once: (event: string, cb: (...args: unknown[]) => void) => {
      if (event === 'you') void Promise.resolve(me).then((v) => cb(v))
      else if (event === 'config') void Promise.resolve(ioConfig).then((v) => cb(v))
      else if (event === 'map') void Promise.resolve({ width: 3, height: 1, tiles }).then(({ width, height, tiles: t }) => cb(width, height, t))
    },
    emitMove: async () => false as const, emitPickup: async () => [], emitPutdown: async () => [],
    emitSay: async () => 'successful' as const, emitAsk: async () => ({}), emitShout: async () => ({}),
    disconnect() { return this },
  } as unknown as DjsClientSocket
  const client = await connect(fakeConfig, 'liaison', noopLogger, () => socket)

  const received: Array<{ from: string; name: string; msg: unknown }> = []
  client.onMissionMsg((from, name, msg) => {
    received.push({ from, name, msg })
  })
  msgCb!('agentX', 'Liaison X', { hello: 'world' }, () => {})

  expect(received).toEqual([{ from: 'agentX', name: 'Liaison X', msg: { hello: 'world' } }])
})
