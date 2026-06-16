export interface Config {
  DELIVEROO_HOST: string
  DELIVEROO_PORT: number
  TOKEN_LIAISON: string
  TOKEN_COURIER: string
  OPENAI_MODEL: string
  OPENAI_API_KEY: string
  OPENAI_BASE_URL: string
  LOG_LEVEL: 'debug' | 'info' | 'warn' | 'error'
  LOG_DIR: string
}

export function parseConfig(env: Record<string, string | undefined>): Config {
  const required = [
    'DELIVEROO_HOST',
    'DELIVEROO_PORT',
    'TOKEN_LIAISON',
    'TOKEN_COURIER',
    'OPENAI_MODEL',
    'OPENAI_API_KEY',
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
    OPENAI_MODEL: env.OPENAI_MODEL!,
    OPENAI_API_KEY: env.OPENAI_API_KEY!,
    OPENAI_BASE_URL: env.OPENAI_BASE_URL ?? '',
    LOG_LEVEL: level as Config['LOG_LEVEL'],
    LOG_DIR: env.LOG_DIR ?? './logs',
  }
}
