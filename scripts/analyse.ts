import { DuckDBInstance } from '@duckdb/node-api'

const LOG_GLOB = process.argv[2] ?? './logs/*.ndjson'

const instance = await DuckDBInstance.create(':memory:')
const conn = await instance.connect()

console.log(`\nAnalysing logs: ${LOG_GLOB}\n`)

// Intent switches over time
console.log('=== Intent switches ===')
const intentResult = await conn.runAndReadAll(`
  SELECT
    CAST(tick AS INTEGER) AS tick,
    agentId,
    json_extract_string(json, '$.from') AS from_intent,
    json_extract_string(json, '$.to')   AS to_intent,
    json_extract_string(json, '$.uFrom') AS u_from,
    json_extract_string(json, '$.uTo')   AS u_to
  FROM read_ndjson_auto('${LOG_GLOB}', columns={tick:'VARCHAR', agentId:'VARCHAR', msg:'VARCHAR', json:'JSON'})
  WHERE msg = 'intent-switch'
  ORDER BY tick
`)
console.table(intentResult.getRowObjects())

// BDI tick durations
console.log('\n=== Tick duration percentiles (ms) ===')
const perfResult = await conn.runAndReadAll(`
  SELECT
    agentId,
    ROUND(quantile_cont(CAST(durationMs AS DOUBLE), 0.50), 2) AS p50,
    ROUND(quantile_cont(CAST(durationMs AS DOUBLE), 0.95), 2) AS p95,
    ROUND(quantile_cont(CAST(durationMs AS DOUBLE), 0.99), 2) AS p99,
    COUNT(*) AS ticks
  FROM read_ndjson_auto('${LOG_GLOB}', columns={agentId:'VARCHAR', msg:'VARCHAR', durationMs:'VARCHAR'})
  WHERE msg = 'tick-done'
  GROUP BY agentId
`)
console.table(perfResult.getRowObjects())

conn.closeSync()
instance.closeSync()
