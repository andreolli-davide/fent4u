// Safe arithmetic over a CLOSED grammar: number literals and + - * / ( ) with unary minus.
// NEVER eval / Function: the input originates from an external (server/opponent) NL message
// transcribed by the LLM — eval would be remote code execution in the Liaison worker.

const MAX_EXPR_LEN = 120

type Token = { t: 'num'; v: number } | { t: 'op'; v: '+' | '-' | '*' | '/' | '(' | ')' }

function tokenize(s: string): Token[] | null {
  const out: Token[] = []
  let i = 0
  while (i < s.length) {
    const c = s[i]!
    if (c === ' ' || c === '\t') { i++; continue }
    if (c === '+' || c === '-' || c === '*' || c === '/' || c === '(' || c === ')') {
      out.push({ t: 'op', v: c })
      i++
      continue
    }
    if ((c >= '0' && c <= '9') || c === '.') {
      let j = i + 1
      while (j < s.length && ((s[j]! >= '0' && s[j]! <= '9') || s[j] === '.')) j++
      const num = Number(s.slice(i, j))
      if (!Number.isFinite(num)) return null
      out.push({ t: 'num', v: num })
      i = j
      continue
    }
    return null // any other character → outside the grammar
  }
  return out
}

class Parser {
  private pos = 0
  constructor(private readonly toks: Token[]) {}

  atEnd(): boolean { return this.pos >= this.toks.length }
  private peek(): Token | undefined { return this.toks[this.pos] }

  // expr = term (('+' | '-') term)*
  parseExpr(): number | null {
    let left = this.parseTerm()
    if (left === null) return null
    for (;;) {
      const tk = this.peek()
      if (tk?.t === 'op' && (tk.v === '+' || tk.v === '-')) {
        this.pos++
        const right = this.parseTerm()
        if (right === null) return null
        left = tk.v === '+' ? left + right : left - right
      } else break
    }
    return left
  }

  // term = factor (('*' | '/') factor)*
  private parseTerm(): number | null {
    let left = this.parseFactor()
    if (left === null) return null
    for (;;) {
      const tk = this.peek()
      if (tk?.t === 'op' && (tk.v === '*' || tk.v === '/')) {
        this.pos++
        const right = this.parseFactor()
        if (right === null) return null
        if (tk.v === '/' && right === 0) return null
        left = tk.v === '*' ? left * right : left / right
      } else break
    }
    return left
  }

  // factor = number | '(' expr ')' | '-' factor
  private parseFactor(): number | null {
    const tk = this.peek()
    if (tk === undefined) return null
    if (tk.t === 'num') { this.pos++; return tk.v }
    if (tk.t === 'op' && tk.v === '-') { this.pos++; const f = this.parseFactor(); return f === null ? null : -f }
    if (tk.t === 'op' && tk.v === '(') {
      this.pos++
      const inner = this.parseExpr()
      if (inner === null) return null
      const close = this.peek()
      if (close?.t === 'op' && close.v === ')') { this.pos++; return inner }
      return null
    }
    return null
  }
}

export function calc(expr: string): number | null {
  if (typeof expr !== 'string' || expr.length === 0 || expr.length > MAX_EXPR_LEN) return null
  const toks = tokenize(expr)
  if (toks === null || toks.length === 0) return null
  const p = new Parser(toks)
  const v = p.parseExpr()
  if (v === null || !p.atEnd()) return null
  return Number.isFinite(v) ? v : null
}
