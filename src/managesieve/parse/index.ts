/**
 * The ManageSieve command grammar (RFC 5804 §4): atoms, quoted strings, and
 * literals, on one line ending in CRLF.
 *
 * Operates on latin1 strings like everything else on the wire, so a literal's
 * `{n}` counts the same octets the client sent. Decode to Unicode only where a
 * script or a name is stored.
 */

export type Token = { kind: "atom" | "string"; value: string }

export type Limits = {
  /** Characters outside literals — the command line itself. */
  line: number
  /** Octets of any one literal. */
  literal: number
  /** Octets of every literal in one command, together. */
  total: number
}

export type Parsed =
  | { status: "more" }
  | { status: "bad"; reason: "syntax" | "toolong" | "toolarge" }
  | { status: "ok"; tokens: Token[]; used: number }

const LITERAL = /^\{(\d{1,9})(\+?)\}\r?\n/

/**
 * Reads one command off the front of `buffer`.
 *
 * "more" means the command is incomplete, never that it is wrong. Bounds are
 * checked on the way, not at the end, because the buffer is attacker-controlled
 * memory: an oversized literal is refused from its header, before a byte of it
 * is held.
 */
export const parseCommand = (buffer: string, limits: Limits): Parsed => {
  const tokens: Token[] = []
  let i = 0
  let literals = 0

  const lineChars = () => i - literals

  // An unterminated token still counts against the line limit.
  const partial = (end: number): Parsed =>
    end - literals > limits.line + 1 ? { status: "bad", reason: "toolong" } : { status: "more" }

  while (true) {
    if (lineChars() > limits.line) return { status: "bad", reason: "toolong" }

    while (buffer[i] === " ") i++
    if (i >= buffer.length) return { status: "more" }
    const c = buffer[i]!

    if (c === "\r") {
      if (i + 1 >= buffer.length) return { status: "more" }
      if (buffer[i + 1] !== "\n") return { status: "bad", reason: "syntax" }
      return { status: "ok", tokens, used: i + 2 }
    }
    if (c === "\n") return { status: "ok", tokens, used: i + 1 }

    if (c === '"') {
      let value = ""
      let j = i + 1
      while (true) {
        if (j >= buffer.length) return partial(buffer.length)
        const d = buffer[j]!
        if (d === "\r" || d === "\n") return { status: "bad", reason: "syntax" }
        if (d === "\\") {
          if (j + 1 >= buffer.length) return partial(buffer.length)
          value += buffer[j + 1]
          j += 2
          continue
        }
        if (d === '"') break
        value += d
        j++
      }
      tokens.push({ kind: "string", value })
      i = j + 1
      continue
    }

    if (c === "{") {
      const head = LITERAL.exec(buffer.slice(i, i + 24))
      if (!head) {
        // Either the header has not all arrived or it is not one.
        const rest = buffer.slice(i, i + 24)
        if (rest.length < 24 && !rest.includes("\n")) return partial(buffer.length)
        return { status: "bad", reason: "syntax" }
      }
      const size = Number(head[1])
      if (size > limits.literal || literals + size > limits.total) {
        return { status: "bad", reason: "toolarge" }
      }
      const start = i + head[0].length
      if (buffer.length < start + size) return { status: "more" }
      tokens.push({ kind: "string", value: buffer.slice(start, start + size) })
      literals += head[0].length + size
      i = start + size
      continue
    }

    // atom
    let j = i
    while (j < buffer.length && !' \r\n"'.includes(buffer[j]!)) j++
    if (j >= buffer.length) return partial(buffer.length)
    tokens.push({ kind: "atom", value: buffer.slice(i, j) })
    i = j
  }
}
