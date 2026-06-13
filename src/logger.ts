import pino, { type Logger } from 'pino'
import type { AgentId } from './types/a2a.js'

export interface LoggerOptions {
  level: string
  writeFn?: (line: string) => void
}

export function makeLogger(
  agentId: AgentId | 'main',
  module: string,
  options: LoggerOptions
): Logger {
  const stream = {
    write(line: string): void {
      if (options.writeFn) {
        options.writeFn(line)
      } else {
        process.stdout.write(line)
      }
    },
  }
  return pino({ level: options.level }, stream).child({ agentId, module })
}
