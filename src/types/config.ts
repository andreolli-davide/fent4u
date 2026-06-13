export interface Config {
  DELIVEROO_HOST: string
  DELIVEROO_PORT: number
  TOKEN_LIAISON: string
  TOKEN_COURIER: string
  LITELLM_MODEL: string
  LITELLM_API_KEY: string
  LITELLM_BASE_URL: string
  LOG_LEVEL: 'debug' | 'info' | 'warn' | 'error'
  LOG_DIR: string
}

export function parseConfig(env: Record<string, string | undefined>): Config {
  const required = [
    'DELIVEROO_HOST',
    'DELIVEROO_PORT',
    'TOKEN_LIAISON',
    'TOKEN_COURIER',
    'LITELLM_MODEL',
    'LITELLM_API_KEY',
  ] as const

  for (const key of required) {
    if (!env[key]) throw new Error(`Missing required env var: ${key}`)
  }

  const level = env.LOG_LEVEL ?? 'info'
  if (!['debug', 'info', 'warn', 'error'].includes(level)) {
    throw new Error(`Invalid LOG_LEVEL: ${level}`)
  }

  const port = Number(env.DELIVEROO_PORT)
  if (Number.isNaN(port)) throw new Error('DELIVEROO_PORT must be a valid number')

  return {
    DELIVEROO_HOST: env.DELIVEROO_HOST!,
    DELIVEROO_PORT: port,
    TOKEN_LIAISON: env.TOKEN_LIAISON!,
    TOKEN_COURIER: env.TOKEN_COURIER!,
    LITELLM_MODEL: env.LITELLM_MODEL!,
    LITELLM_API_KEY: env.LITELLM_API_KEY!,
    LITELLM_BASE_URL: env.LITELLM_BASE_URL ?? '',
    LOG_LEVEL: level as Config['LOG_LEVEL'],
    LOG_DIR: env.LOG_DIR ?? './logs',
  }
}
