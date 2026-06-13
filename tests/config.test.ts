import { describe, it, expect } from 'bun:test'
import { parseConfig } from '../src/types/config.js'

const base = {
  DELIVEROO_HOST: 'localhost',
  DELIVEROO_PORT: '8080',
  TOKEN_LIAISON: 'tok-a',
  TOKEN_COURIER: 'tok-b',
  LITELLM_MODEL: 'gpt-4o',
  LITELLM_API_KEY: 'sk-test',
}

describe('parseConfig', () => {
  it('returns a valid Config when all required vars are present', () => {
    const config = parseConfig(base)
    expect(config.DELIVEROO_HOST).toBe('localhost')
    expect(config.DELIVEROO_PORT).toBe(8080)
    expect(config.LOG_LEVEL).toBe('info')
    expect(config.LOG_DIR).toBe('./logs')
    expect(config.LITELLM_BASE_URL).toBe('')
  })

  it('coerces DELIVEROO_PORT to number', () => {
    const config = parseConfig({ ...base, DELIVEROO_PORT: '3000' })
    expect(config.DELIVEROO_PORT).toBe(3000)
    expect(typeof config.DELIVEROO_PORT).toBe('number')
  })

  it('throws when a required var is missing', () => {
    const { LITELLM_API_KEY: _, ...incomplete } = base
    expect(() => parseConfig(incomplete)).toThrow('Missing required env var: LITELLM_API_KEY')
  })

  it('throws on invalid LOG_LEVEL', () => {
    expect(() => parseConfig({ ...base, LOG_LEVEL: 'verbose' })).toThrow('Invalid LOG_LEVEL')
  })

  it('accepts optional vars', () => {
    const config = parseConfig({
      ...base,
      LOG_LEVEL: 'debug',
      LOG_DIR: '/tmp/logs',
      LITELLM_BASE_URL: 'http://proxy:4000',
    })
    expect(config.LOG_LEVEL).toBe('debug')
    expect(config.LOG_DIR).toBe('/tmp/logs')
    expect(config.LITELLM_BASE_URL).toBe('http://proxy:4000')
  })

  it('throws when DELIVEROO_PORT is not a valid number', () => {
    expect(() => parseConfig({ ...base, DELIVEROO_PORT: 'abc' })).toThrow(
      'DELIVEROO_PORT must be a valid number'
    )
  })
})
