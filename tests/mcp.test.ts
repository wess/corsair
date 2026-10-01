import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Subprocess } from "bun"

/**
 * The MCP server a harness runs to give an agent its inbox, driven over stdio
 * the way a harness does, against a stub of the `/api/agent` routes. No
 * database: what is under test is the protocol and the mapping onto the API.
 */

const calls: { method: string; url: string; auth: string | null; body: string }[] = []
let stub: ReturnType<typeof Bun.serve>
let proc: Subprocess<"pipe", "pipe", "inherit">
let reader: ReadableStreamDefaultReader<Uint8Array>
let pending = ""
let nextId = 1

const send = async (method: string, params?: unknown) => {
  const id = nextId++
  proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`)
  await proc.stdin.flush()
  const decoder = new TextDecoder()
  while (true) {
    const newline = pending.indexOf("\n")
    if (newline !== -1) {
      const line = pending.slice(0, newline)
      pending = pending.slice(newline + 1)
      return JSON.parse(line)
    }
    const { value, done } = await reader.read()
    if (done) throw new Error("server exited")
    pending += decoder.decode(value)
  }
}

const tool = async (name: string, args: unknown = {}) => {
  const reply = await send("tools/call", { name, arguments: args })
  return reply.result
}

beforeAll(() => {
  stub = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      calls.push({
        method: req.method,
        url: url.pathname + url.search,
        auth: req.headers.get("authorization"),
        body: await req.text(),
      })
      if (url.pathname === "/api/agent/messages/gone") {
        return Response.json(
          { statusCode: 404, name: "not_found", message: "Message not found." },
          { status: 404 },
        )
      }
      if (url.pathname.endsWith("/attachments/1")) {
        return new Response("hello", {
          headers: { "content-disposition": 'attachment; filename="a.txt"' },
        })
      }
      return Response.json({ ok: true, path: url.pathname })
    },
  })
  proc = Bun.spawn(["bun", "plugin/mcp/server.mjs"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
    env: {
      ...process.env,
      CORSAIR_URL: `http://localhost:${stub.port}/`,
      CORSAIR_AGENT_TOKEN: "ca_test",
    },
  })
  reader = proc.stdout.getReader()
})

afterAll(() => {
  proc.kill()
  stub.stop(true)
})

describe("mcp server", () => {
  test("initializes and lists the tools", async () => {
    const init = await send("initialize", { protocolVersion: "2025-06-18", capabilities: {} })
    expect(init.result.serverInfo.name).toBe("corsair-agent-email")
    expect(init.result.capabilities.tools).toBeDefined()

    const list = await send("tools/list")
    const names = list.result.tools.map((t: { name: string }) => t.name)
    expect(names).toEqual([
      "agent_email_address",
      "wait_for_email",
      "list_emails",
      "read_email",
      "download_attachment",
      "send_email",
    ])
    for (const t of list.result.tools) expect(t.inputSchema.type).toBe("object")
  })

  test("wait_for_email asks the API to wait, with the token", async () => {
    calls.length = 0
    const result = await tool("wait_for_email", { subject: "verify", timeout: 20 })
    expect(result.isError).toBeUndefined()
    expect(calls[0]?.url).toBe("/api/agent/wait?subject=verify&timeout=20")
    expect(calls[0]?.auth).toBe("Bearer ca_test")
  })

  test("send_email posts the reply", async () => {
    calls.length = 0
    await tool("send_email", { reply_to_message_id: "abc", text: "Confirmed." })
    expect(calls[0]?.method).toBe("POST")
    expect(calls[0]?.url).toBe("/api/agent/send")
    expect(JSON.parse(calls[0]!.body)).toEqual({ reply_to_message_id: "abc", text: "Confirmed." })
  })

  test("an API error is a result the model can read, not a protocol error", async () => {
    const result = await tool("read_email", { id: "gone" })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toBe("Message not found.")
  })

  test("an attachment comes back as base64 with its filename", async () => {
    const result = await tool("download_attachment", { id: "m1", section: "1" })
    const body = JSON.parse(result.content[0].text)
    expect(body.filename).toBe("a.txt")
    expect(Buffer.from(body.base64, "base64").toString()).toBe("hello")
  })

  test("an unknown tool and an unknown method are protocol errors", async () => {
    expect((await send("tools/call", { name: "nope", arguments: {} })).error.code).toBe(-32602)
    expect((await send("nope")).error.code).toBe(-32601)
  })
})
