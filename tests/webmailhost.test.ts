import { expect, test } from "bun:test"

test("customer webmail hosts and certificate approval", async () => {
  for (const target of ["", "mail.example.net"]) {
    const child = Bun.spawn([process.execPath, "test", "./tests/support/webmailhost.ts"], {
      cwd: `${import.meta.dir}/..`,
      env: { ...process.env, MAIL_WEBMAIL_HOST: target, NODE_ENV: "production", HOST: "127.0.0.1" },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect(code, stdout + stderr).toBe(0)
  }
}, 60_000)
