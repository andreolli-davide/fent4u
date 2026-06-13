import { describe, it, expect } from 'bun:test'
import { makeLogger } from '../src/logger.js'

describe('makeLogger', () => {
  it('injects agentId and module into every log line', () => {
    const lines: string[] = []
    const log = makeLogger('liaison', 'bdi', {
      level: 'debug',
      writeFn: (line) => lines.push(line),
    })

    log.info({ tick: 5 }, 'test message')

    expect(lines).toHaveLength(1)
    const parsed = JSON.parse(lines[0])
    expect(parsed.agentId).toBe('liaison')
    expect(parsed.module).toBe('bdi')
    expect(parsed.tick).toBe(5)
    expect(parsed.msg).toBe('test message')
  })

  it('filters out lines below the configured level', () => {
    const lines: string[] = []
    const log = makeLogger('courier', 'bdi', {
      level: 'warn',
      writeFn: (line) => lines.push(line),
    })

    log.debug('filtered')
    log.info('filtered')
    log.warn('kept')

    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0]).msg).toBe('kept')
  })

  it('writes to process.stdout when no writeFn is provided', () => {
    // just verify it does not throw
    const log = makeLogger('liaison', 'test', { level: 'error' })
    expect(() => log.error('stdout test')).not.toThrow()
  })
})
