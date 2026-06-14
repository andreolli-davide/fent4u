// tests/a2a-envelope.test.ts
import { test, expect } from 'bun:test'
import type { WorkerEnvelope } from '../src/types/a2a.js'
import { DEFAULT_PARAMS } from '../src/bdi/params.js'

test('init envelope carries config and params', () => {
  const env: WorkerEnvelope = {
    kind: 'init',
    config: { DELIVEROO_HOST: 'h', DELIVEROO_PORT: 1, TOKEN_LIAISON: 'a', TOKEN_COURIER: 'b', LITELLM_MODEL: 'm', LITELLM_API_KEY: 'k', LITELLM_BASE_URL: '', LOG_LEVEL: 'info', LOG_DIR: './logs' },
    params: DEFAULT_PARAMS,
  }
  expect(env.kind === 'init' && env.params.h_commit).toBe(0.15)
})
