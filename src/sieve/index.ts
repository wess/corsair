/**
 * A Sieve (RFC 5228) interpreter.
 *
 * Sieve is the right language for this because it is deliberately not
 * Turing-complete — no loops, no recursion, no way to call out — so a script a
 * customer writes cannot hang the delivery path or reach anything. That
 * property is the reason filters are a scripting feature at all, and it is why
 * this is an interpreter over a parsed tree rather than anything that compiles
 * to host code.
 *
 * Supported: require, if/elsif/else, stop, keep, discard, fileinto (+ :create),
 * redirect, addflag/setflag/removeflag, reject, and the address / envelope /
 * header / exists / size / true / false / not / allof / anyof tests with the
 * :is :contains :matches :regex comparators and :all :localpart :domain
 * address parts.
 */

import { decodeWords, headerValue, headerValues, type ParsedMessage } from "../mime/index.ts"

// ------------------------------------------------------------------ lexer --

type Token =
  | { kind: "identifier"; value: string }
  | { kind: "tag"; value: string }
  | { kind: "number"; value: number }
  | { kind: "string"; value: string }
  | { kind: "punct"; value: string }

export class SieveError extends Error {
  readonly line: number
  constructor(message: string, line: number) {
    super(`line ${line}: ${message}`)
    this.name = "SieveError"
    this.line = line
  }
}

const tokenize = (source: string): { tokens: Token[]; lines: number[] } => {
  const tokens: Token[] = []
  const lines: number[] = []
  let i = 0
  let line = 1

  const push = (token: Token) => {
    tokens.push(token)
    lines.push(line)
  }

  while (i < source.length) {
    const c = source[i]!

    if (c === "\n") {
      line++
      i++
      continue
    }
    if (c === " " || c === "\t" || c === "\r") {
      i++
      continue
    }
    if (c === "#") {
      while (i < source.length && source[i] !== "\n") i++
      continue
    }
    if (c === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2)
      const chunk = source.slice(i, end === -1 ? source.length : end)
      line += (chunk.match(/\n/g) ?? []).length
      i = end === -1 ? source.length : end + 2
      continue
    }

    if (c === '"') {
      let value = ""
      i++
      while (i < source.length && source[i] !== '"') {
        if (source[i] === "\\" && i + 1 < source.length) {
          i++
          value += source[i]
        } else {
          if (source[i] === "\n") line++
          value += source[i]
        }
        i++
      }
      i++
      push({ kind: "string", value })
      continue
    }

    // Multi-line form: text: ... CRLF . CRLF
    if (source.startsWith("text:", i)) {
      const nl = source.indexOf("\n", i)
      const start = nl === -1 ? source.length : nl + 1
      const terminator = source.indexOf("\n.\r\n", start - 1)
      const alt = source.indexOf("\n.\n", start - 1)
      const end = terminator !== -1 ? terminator : alt !== -1 ? alt : source.length
      const value = source.slice(start, end === source.length ? end : end + 1)
      line += (source.slice(i, end).match(/\n/g) ?? []).length
      i = end === source.length ? end : end + (terminator !== -1 ? 4 : 3)
      push({ kind: "string", value })
      continue
    }

    if (c === ":") {
      let j = i + 1
      while (j < source.length && /[A-Za-z0-9_]/.test(source[j]!)) j++
      push({ kind: "tag", value: source.slice(i + 1, j).toLowerCase() })
      i = j
      continue
    }

    if (/[0-9]/.test(c)) {
      let j = i
      while (j < source.length && /[0-9]/.test(source[j]!)) j++
      let value = Number(source.slice(i, j))
      const suffix = source[j]?.toUpperCase()
      // Sieve's size test uses K/M/G suffixes.
      if (suffix === "K") {
        value *= 1024
        j++
      } else if (suffix === "M") {
        value *= 1024 * 1024
        j++
      } else if (suffix === "G") {
        value *= 1024 * 1024 * 1024
        j++
      }
      push({ kind: "number", value })
      i = j
      continue
    }

    if (/[A-Za-z_]/.test(c)) {
      let j = i
      while (j < source.length && /[A-Za-z0-9_.]/.test(source[j]!)) j++
      push({ kind: "identifier", value: source.slice(i, j).toLowerCase() })
      i = j
      continue
    }

    if ("{}()[],;".includes(c)) {
      push({ kind: "punct", value: c })
      i++
      continue
    }

    throw new SieveError(`unexpected character "${c}"`, line)
  }

  return { tokens, lines }
}

// ----------------------------------------------------------------- parser --

export type Argument =
  | { kind: "tag"; value: string }
  | { kind: "number"; value: number }
  | { kind: "strings"; value: string[] }

export type Test = {
  name: string
  args: Argument[]
  tests: Test[]
}

export type Command = {
  name: string
  args: Argument[]
  test: Test | null
  block: Command[] | null
}

const TESTS = new Set([
  "address",
  "allof",
  "anyof",
  "envelope",
  "exists",
  "false",
  "header",
  "not",
  "size",
  "true",
])

const parse = (source: string): Command[] => {
  const { tokens, lines } = tokenize(source)
  let pos = 0

  const lineAt = () => lines[Math.min(pos, lines.length - 1)] ?? 1
  const peek = (): Token | undefined => tokens[pos]
  const next = (): Token => {
    const token = tokens[pos++]
    if (!token) throw new SieveError("unexpected end of script", lineAt())
    return token
  }
  const expect = (value: string) => {
    const token = next()
    if (token.kind !== "punct" || token.value !== value) {
      throw new SieveError(`expected "${value}"`, lineAt())
    }
  }

  const parseStringList = (): string[] => {
    const token = peek()
    if (token?.kind === "string") {
      pos++
      return [token.value]
    }
    expect("[")
    const out: string[] = []
    while (true) {
      const item = next()
      if (item.kind !== "string") throw new SieveError("expected a string", lineAt())
      out.push(item.value)
      const sep = peek()
      if (sep?.kind === "punct" && sep.value === ",") {
        pos++
        continue
      }
      expect("]")
      return out
    }
  }

  const parseArguments = (): Argument[] => {
    const args: Argument[] = []
    while (true) {
      const token = peek()
      if (!token) break
      if (token.kind === "tag") {
        pos++
        args.push({ kind: "tag", value: token.value })
        continue
      }
      if (token.kind === "number") {
        pos++
        args.push({ kind: "number", value: token.value })
        continue
      }
      if (token.kind === "string" || (token.kind === "punct" && token.value === "[")) {
        args.push({ kind: "strings", value: parseStringList() })
        continue
      }
      break
    }
    return args
  }

  const parseTest = (): Test => {
    const token = next()
    if (token.kind !== "identifier") throw new SieveError("expected a test", lineAt())
    const name = token.value
    if (!TESTS.has(name)) throw new SieveError(`unknown test "${name}"`, lineAt())

    const args = parseArguments()
    const tests: Test[] = []

    const after = peek()
    if (after?.kind === "punct" && after.value === "(") {
      pos++
      while (true) {
        tests.push(parseTest())
        const sep = peek()
        if (sep?.kind === "punct" && sep.value === ",") {
          pos++
          continue
        }
        expect(")")
        break
      }
    } else if (name === "not") {
      tests.push(parseTest())
    }

    return { name, args, tests }
  }

  const parseBlock = (): Command[] => {
    expect("{")
    const out: Command[] = []
    while (true) {
      const token = peek()
      if (!token) throw new SieveError("unterminated block", lineAt())
      if (token.kind === "punct" && token.value === "}") {
        pos++
        return out
      }
      out.push(parseCommand())
    }
  }

  const parseCommand = (): Command => {
    const token = next()
    if (token.kind !== "identifier") throw new SieveError("expected a command", lineAt())
    const name = token.value

    if (name === "if" || name === "elsif") {
      const test = parseTest()
      return { name, args: [], test, block: parseBlock() }
    }
    if (name === "else") {
      return { name, args: [], test: null, block: parseBlock() }
    }

    const args = parseArguments()
    const terminator = peek()
    if (terminator?.kind === "punct" && terminator.value === "{") {
      return { name, args, test: null, block: parseBlock() }
    }
    expect(";")
    return { name, args, test: null, block: null }
  }

  const program: Command[] = []
  while (pos < tokens.length) program.push(parseCommand())
  return program
}

/** Parses without running, so the panel can reject a broken script on save. */
export const compile = (source: string): { ok: true } | { ok: false; error: string } => {
  try {
    parse(source)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

// -------------------------------------------------------------- evaluate --

export type SieveContext = {
  message: ParsedMessage
  size: number
  /** Envelope values, which are not headers and can differ from them. */
  envelopeFrom: string
  envelopeTo: string
}

export type SieveResult = {
  /** Folders to file into. Empty plus `keep` false means the message is dropped. */
  fileInto: string[]
  keep: boolean
  discard: boolean
  redirect: string[]
  reject: string | null
  flags: string[]
  createFolders: boolean
}

const matchGlob = (value: string, pattern: string): boolean => {
  // Sieve :matches uses * and ? with no character classes.
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&")
  const expanded = escaped.replace(/\*/g, "[\\s\\S]*").replace(/\?/g, "[\\s\\S]")
  return new RegExp(`^${expanded}$`, "i").test(value)
}

const compare = (value: string, patterns: string[], comparator: string): boolean => {
  const subject = value ?? ""
  for (const pattern of patterns) {
    switch (comparator) {
      case "is":
        if (subject.toLowerCase() === pattern.toLowerCase()) return true
        break
      case "contains":
        if (subject.toLowerCase().includes(pattern.toLowerCase())) return true
        break
      case "matches":
        if (matchGlob(subject, pattern)) return true
        break
      case "regex":
        try {
          if (new RegExp(pattern, "i").test(subject)) return true
        } catch {
          // An invalid pattern matches nothing rather than aborting delivery.
        }
        break
      default:
        if (subject.toLowerCase() === pattern.toLowerCase()) return true
    }
  }
  return false
}

const tagsOf = (args: Argument[]): string[] =>
  args.filter((a): a is { kind: "tag"; value: string } => a.kind === "tag").map((a) => a.value)

const stringListsOf = (args: Argument[]): string[][] =>
  args
    .filter((a): a is { kind: "strings"; value: string[] } => a.kind === "strings")
    .map((a) => a.value)

const numberOf = (args: Argument[]): number | null => {
  const found = args.find((a) => a.kind === "number")
  return found?.kind === "number" ? found.value : null
}

const comparatorOf = (args: Argument[]): string => {
  const tags = tagsOf(args)
  for (const candidate of ["is", "contains", "matches", "regex"]) {
    if (tags.includes(candidate)) return candidate
  }
  return "is"
}

const addressPartOf = (args: Argument[]): "all" | "localpart" | "domain" => {
  const tags = tagsOf(args)
  if (tags.includes("localpart")) return "localpart"
  if (tags.includes("domain")) return "domain"
  return "all"
}

const partOfAddress = (address: string, part: "all" | "localpart" | "domain"): string => {
  const at = address.lastIndexOf("@")
  if (part === "all" || at === -1) return address
  return part === "localpart" ? address.slice(0, at) : address.slice(at + 1)
}

const bareAddresses = (value: string): string[] => {
  const out: string[] = []
  for (const chunk of value.split(",")) {
    const angle = chunk.match(/<([^>]+)>/)
    const candidate = (angle?.[1] ?? chunk).trim()
    if (candidate.includes("@")) out.push(candidate)
  }
  return out
}

const evaluateTest = (test: Test, ctx: SieveContext): boolean => {
  switch (test.name) {
    case "true":
      return true
    case "false":
      return false
    case "not":
      return !evaluateTest(test.tests[0]!, ctx)
    case "allof":
      return test.tests.every((t) => evaluateTest(t, ctx))
    case "anyof":
      return test.tests.some((t) => evaluateTest(t, ctx))

    case "size": {
      const tags = tagsOf(test.args)
      const limit = numberOf(test.args) ?? 0
      return tags.includes("under") ? ctx.size < limit : ctx.size > limit
    }

    case "exists": {
      const [names = []] = stringListsOf(test.args)
      return names.every((name) => headerValue(ctx.message.headers, name) !== null)
    }

    case "header": {
      const [names = [], patterns = []] = stringListsOf(test.args)
      const comparator = comparatorOf(test.args)
      for (const name of names) {
        for (const raw of headerValues(ctx.message.headers, name)) {
          if (compare(decodeWords(raw), patterns, comparator)) return true
        }
      }
      return false
    }

    case "address": {
      const [names = [], patterns = []] = stringListsOf(test.args)
      const comparator = comparatorOf(test.args)
      const part = addressPartOf(test.args)
      for (const name of names) {
        for (const raw of headerValues(ctx.message.headers, name)) {
          for (const address of bareAddresses(decodeWords(raw))) {
            if (compare(partOfAddress(address, part), patterns, comparator)) return true
          }
        }
      }
      return false
    }

    case "envelope": {
      const [names = [], patterns = []] = stringListsOf(test.args)
      const comparator = comparatorOf(test.args)
      const part = addressPartOf(test.args)
      for (const name of names) {
        const value = name.toLowerCase() === "from" ? ctx.envelopeFrom : ctx.envelopeTo
        if (compare(partOfAddress(value, part), patterns, comparator)) return true
      }
      return false
    }

    default:
      return false
  }
}

const MAX_ACTIONS = 100

/**
 * Runs a script against one message and returns what should happen to it.
 *
 * The script never touches the mail store itself — it produces a decision the
 * caller applies. That keeps delivery atomic and means a script that names a
 * folder the caller refuses to create cannot half-deliver.
 */
export const run = (source: string, ctx: SieveContext): SieveResult => {
  const program = parse(source)
  const result: SieveResult = {
    fileInto: [],
    keep: false,
    discard: false,
    redirect: [],
    reject: null,
    flags: [],
    createFolders: false,
  }

  let actions = 0
  let stopped = false

  const execute = (commands: Command[]) => {
    let lastTestMatched = false

    for (const command of commands) {
      if (stopped) return
      if (++actions > MAX_ACTIONS) {
        // Sieve cannot loop, but it can be pathologically long. A ceiling keeps
        // one script from dominating the delivery path.
        stopped = true
        return
      }

      switch (command.name) {
        case "require":
          // Extensions are accepted and ignored: refusing an unknown one would
          // break a script that only uses it in a branch that never runs.
          break

        case "if":
          lastTestMatched = evaluateTest(command.test!, ctx)
          if (lastTestMatched) execute(command.block ?? [])
          break

        case "elsif":
          if (!lastTestMatched) {
            lastTestMatched = evaluateTest(command.test!, ctx)
            if (lastTestMatched) execute(command.block ?? [])
          }
          break

        case "else":
          if (!lastTestMatched) execute(command.block ?? [])
          lastTestMatched = true
          break

        case "stop":
          stopped = true
          return

        case "keep":
          result.keep = true
          break

        case "discard":
          result.discard = true
          break

        case "fileinto": {
          const [targets = []] = stringListsOf(command.args)
          if (tagsOf(command.args).includes("create")) result.createFolders = true
          for (const target of targets) if (target) result.fileInto.push(target)
          break
        }

        case "redirect": {
          const [targets = []] = stringListsOf(command.args)
          for (const target of targets) if (target.includes("@")) result.redirect.push(target)
          break
        }

        case "reject":
        case "ereject": {
          const [reasons = []] = stringListsOf(command.args)
          result.reject = reasons[0] ?? "Message rejected by filter."
          break
        }

        case "setflag":
          result.flags = stringListsOf(command.args)[0] ?? []
          break

        case "addflag":
          result.flags = [...result.flags, ...(stringListsOf(command.args)[0] ?? [])]
          break

        case "removeflag": {
          const remove = new Set(stringListsOf(command.args)[0] ?? [])
          result.flags = result.flags.filter((f) => !remove.has(f))
          break
        }

        default:
          // An unrecognised action is ignored rather than fatal, for the same
          // reason `require` is: partial support must not lose mail.
          break
      }
    }
  }

  execute(program)

  // RFC 5228 §2.10.2: with no filing action, the implicit keep applies.
  if (!result.fileInto.length && !result.discard && !result.reject && !result.redirect.length) {
    result.keep = true
  }
  return result
}
