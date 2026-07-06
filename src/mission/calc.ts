// Safe arithmetic over a CLOSED grammar (§3.1 / §18.5): number literals, the binary operators
// + - * / % ^ (^ right-associative), unary minus, parentheses, and a whitelist of functions
// (abs min max floor ceil round sqrt). NEVER eval / Function: the input originates from an external
// (server/opponent) NL message transcribed by the LLM — eval would be remote code execution in the
// Liaison worker. Values are float64 (exact for integer arithmetic up to 2^53); the closed grammar,
// not the numeric width, is the safety guarantee.

const MAX_EXPR_LEN = 120

// Whitelisted functions (§18.5). Arity: min/max are variadic (≥1); the rest are unary.
const FUNCS: Record<string, (args: number[]) => number | null> = {
  abs: (a) => (a.length === 1 ? Math.abs(a[0]!) : null),
  floor: (a) => (a.length === 1 ? Math.floor(a[0]!) : null),
  ceil: (a) => (a.length === 1 ? Math.ceil(a[0]!) : null),
  round: (a) => (a.length === 1 ? Math.round(a[0]!) : null),
  sqrt: (a) => (a.length === 1 && a[0]! >= 0 ? Math.sqrt(a[0]!) : null),
  min: (a) => (a.length >= 1 ? Math.min(...a) : null),
  max: (a) => (a.length >= 1 ? Math.max(...a) : null),
}

type Token =
  | { t: 'num'; v: number }
  | { t: 'op'; v: '+' | '-' | '*' | '/' | '%' | '^' | '(' | ')' | ',' }
  | { t: 'fn'; v: string }

function tokenize(s: string): Token[] | null {
  const out: Token[] = []
  let i = 0
  while (i < s.length) {
    const c = s[i]!
    if (c === ' ' || c === '\t') { i++; continue }
    if (c === '+' || c === '-' || c === '*' || c === '/' || c === '%' || c === '^' || c === '(' || c === ')' || c === ',') {
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
    if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')) {
      let j = i + 1
      while (j < s.length && ((s[j]! >= 'a' && s[j]! <= 'z') || (s[j]! >= 'A' && s[j]! <= 'Z'))) j++
      const name = s.slice(i, j).toLowerCase()
      if (!(name in FUNCS)) return null // unknown identifier → outside the grammar
      out.push({ t: 'fn', v: name })
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

  // term = power (('*' | '/' | '%') power)*
  private parseTerm(): number | null {
    let left = this.parsePower()
    if (left === null) return null
    for (;;) {
      const tk = this.peek()
      if (tk?.t === 'op' && (tk.v === '*' || tk.v === '/' || tk.v === '%')) {
        this.pos++
        const right = this.parsePower()
        if (right === null) return null
        if ((tk.v === '/' || tk.v === '%') && right === 0) return null
        left = tk.v === '*' ? left * right : tk.v === '/' ? left / right : left % right
      } else break
    }
    return left
  }

  // power = unary ('^' power)?   — right-associative exponent
  private parsePower(): number | null {
    const base = this.parseUnary()
    if (base === null) return null
    const tk = this.peek()
    if (tk?.t === 'op' && tk.v === '^') {
      this.pos++
      const exp = this.parsePower()
      if (exp === null) return null
      const v = Math.pow(base, exp)
      return Number.isFinite(v) ? v : null
    }
    return base
  }

  // unary = '-' unary | atom
  private parseUnary(): number | null {
    const tk = this.peek()
    if (tk?.t === 'op' && tk.v === '-') { this.pos++; const f = this.parseUnary(); return f === null ? null : -f }
    return this.parseAtom()
  }

  // atom = number | '(' expr ')' | fn '(' args ')'
  private parseAtom(): number | null {
    const tk = this.peek()
    if (tk === undefined) return null
    if (tk.t === 'num') { this.pos++; return tk.v }
    if (tk.t === 'fn') {
      this.pos++
      const open = this.peek()
      if (open?.t !== 'op' || open.v !== '(') return null
      this.pos++
      const args = this.parseArgs()
      if (args === null) return null
      const close = this.peek()
      if (close?.t !== 'op' || close.v !== ')') return null
      this.pos++
      const v = FUNCS[tk.v]!(args)
      return v === null || !Number.isFinite(v) ? null : v
    }
    if (tk.t === 'op' && tk.v === '(') {
      this.pos++
      const inner = this.parseExpr()
      if (inner === null) return null
      const cl = this.peek()
      if (cl?.t === 'op' && cl.v === ')') { this.pos++; return inner }
      return null
    }
    return null
  }

  // args = expr (',' expr)*   — at least one argument
  private parseArgs(): number[] | null {
    const first = this.parseExpr()
    if (first === null) return null
    const out = [first]
    for (;;) {
      const tk = this.peek()
      if (tk?.t === 'op' && tk.v === ',') {
        this.pos++
        const next = this.parseExpr()
        if (next === null) return null
        out.push(next)
      } else break
    }
    return out
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
