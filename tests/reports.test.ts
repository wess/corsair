import { describe, expect, test } from "bun:test"
import {
  isRecipientGone,
  parseBounceAddress,
  parseReport,
  returnPathFor,
  verdicts,
} from "../src/reports/index.ts"

/**
 * Reading what comes back to an API send's bounce address.
 *
 * The asymmetry that matters: a missed bounce keeps mailing a dead address,
 * which costs reputation slowly, while a false one suppresses a live person,
 * who then silently stops receiving their password resets. The tests on
 * `isRecipientGone` hold down the second failure as much as the first.
 */

const ID = "5d0c1c9e-7f53-4c1a-9a47-2f0f8d6d2b10"

const dsn = (
  entries: { recipient?: string; action?: string; status?: string; diagnostic?: string }[],
) =>
  [
    "From: Mail Delivery System <MAILER-DAEMON@far.invalid>",
    `To: <bounces+${ID}@example.test>`,
    "Subject: Undelivered Mail Returned to Sender",
    "MIME-Version: 1.0",
    'Content-Type: multipart/report; report-type=delivery-status; boundary="b1"',
    "",
    "--b1",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Your message could not be delivered.",
    "",
    "--b1",
    "Content-Type: message/delivery-status",
    "",
    "Reporting-MTA: dns; far.invalid",
    "",
    ...entries.flatMap((e) => [
      ...(e.recipient ? [`Final-Recipient: rfc822; ${e.recipient}`] : []),
      `Action: ${e.action ?? "failed"}`,
      ...(e.status ? [`Status: ${e.status}`] : []),
      ...(e.diagnostic ? [`Diagnostic-Code: smtp; ${e.diagnostic}`] : []),
      "",
    ]),
    "--b1",
    "Content-Type: text/rfc822-headers",
    "",
    "Message-ID: <original@example.test>",
    "Subject: Your receipt",
    "",
    "--b1--",
    "",
  ].join("\r\n")

const arf = (feedbackType: string, recipient?: string) =>
  [
    "From: <fbl@far.invalid>",
    "Subject: Complaint",
    "MIME-Version: 1.0",
    'Content-Type: multipart/report; report-type=feedback-report; boundary="b2"',
    "",
    "--b2",
    "Content-Type: text/plain",
    "",
    "This is an abuse report.",
    "",
    "--b2",
    "Content-Type: message/feedback-report",
    "",
    `Feedback-Type: ${feedbackType}`,
    "User-Agent: Generator/1.0",
    "Version: 1",
    ...(recipient ? [`Original-Rcpt-To: <${recipient}>`] : []),
    "",
    "--b2",
    "Content-Type: message/rfc822",
    "",
    "Message-ID: <original@example.test>",
    "Subject: Your receipt",
    "",
    "Body.",
    "",
    "--b2--",
    "",
  ].join("\r\n")

describe("bounce addresses", () => {
  test("round-trip an email id and domain", () => {
    expect(parseBounceAddress(returnPathFor(ID, "example.test"))).toEqual({
      emailId: ID,
      domain: "example.test",
    })
  })

  test("are case-insensitive on the way back in", () => {
    expect(parseBounceAddress(`Bounces+${ID.toUpperCase()}@Example.TEST`)).toEqual({
      emailId: ID,
      domain: "example.test",
    })
  })

  test("a bounces+ address with no id belongs to whoever owns the mailbox", () => {
    expect(parseBounceAddress("bounces+newsletter@example.test")).toBeNull()
    expect(parseBounceAddress("bounces@example.test")).toBeNull()
    expect(parseBounceAddress(`someone+${ID}@example.test`)).toBeNull()
  })
})

describe("delivery status notifications", () => {
  test("a permanent failure names its recipient and the original message", () => {
    const report = parseReport(
      dsn([{ recipient: "gone@far.invalid", status: "5.1.1", diagnostic: "550 5.1.1 unknown" }]),
    )
    expect(report?.kind).toBe("dsn")
    expect(report?.originalMessageId).toBe("<original@example.test>")
    expect(verdicts(report!)).toEqual([
      {
        severity: "hard",
        recipient: "gone@far.invalid",
        status: "5.1.1",
        detail: "550 5.1.1 unknown",
      },
    ])
  })

  test("a delay is soft", () => {
    const report = parseReport(
      dsn([{ recipient: "slow@far.invalid", action: "delayed", status: "4.4.7" }]),
    )
    expect(verdicts(report!)[0]?.severity).toBe("soft")
  })

  test("a report with no Status still reads the class from the diagnostic", () => {
    const report = parseReport(
      dsn([{ recipient: "gone@far.invalid", diagnostic: "550 Requested action not taken" }]),
    )
    expect(verdicts(report!)[0]?.severity).toBe("hard")
  })

  test("each recipient becomes its own verdict", () => {
    const report = parseReport(
      dsn([
        { recipient: "gone@far.invalid", status: "5.1.1" },
        { recipient: "fine@far.invalid", action: "delivered", status: "2.0.0" },
      ]),
    )
    expect(verdicts(report!).map((v) => v.severity)).toEqual(["hard", "delivered"])
  })

  test("an ordinary message is not a report", () => {
    const reply = "From: a@b.test\r\nSubject: Out of office\r\n\r\nBack Monday.\r\n"
    expect(parseReport(reply)).toBeNull()
  })
})

describe("feedback reports", () => {
  test("a complaint names the recipient who complained", () => {
    const report = parseReport(arf("abuse", "annoyed@far.invalid"))
    expect(report?.kind).toBe("arf")
    expect(report?.originalMessageId).toBe("<original@example.test>")
    expect(verdicts(report!)[0]).toMatchObject({
      severity: "complaint",
      recipient: "annoyed@far.invalid",
    })
  })

  test("not-spam is a retraction, never a complaint", () => {
    expect(verdicts(parseReport(arf("not-spam"))!)[0]?.severity).toBe("unknown")
  })
})

describe("whether an address is gone", () => {
  test("address-status codes are", () => {
    expect(isRecipientGone({ status: "5.1.1" })).toBe(true)
    expect(isRecipientGone({ status: "5.1.10" })).toBe(true)
    expect(isRecipientGone({ status: "5.2.1" })).toBe(true)
    expect(isRecipientGone({ code: 550, detail: "550 5.1.1 <x@y> User unknown" })).toBe(true)
  })

  test("a permanent refusal of the message is not", () => {
    // Policy, a full mailbox, a message too large: the person is still there.
    expect(isRecipientGone({ status: "5.7.1" })).toBe(false)
    expect(isRecipientGone({ status: "5.2.2" })).toBe(false)
    expect(isRecipientGone({ code: 552, detail: "552 5.3.4 Message size exceeds limit" })).toBe(
      false,
    )
    expect(isRecipientGone({ code: 554, detail: "554 Message rejected as spam" })).toBe(false)
  })

  test("a transient failure never is", () => {
    expect(isRecipientGone({ status: "4.1.1" })).toBe(false)
    expect(isRecipientGone({ code: 450, detail: "450 mailbox busy" })).toBe(false)
  })

  test("without an enhanced code, only a reply that says the user does not exist", () => {
    expect(isRecipientGone({ code: 550, detail: "No such user here: gone@far.invalid" })).toBe(true)
    expect(isRecipientGone({ code: 550, detail: "550 Recipient address rejected: unknown" })).toBe(
      true,
    )
    expect(isRecipientGone({ code: 550, detail: "550 Administrative prohibition" })).toBe(false)
  })

  test("an address in the reply is not mistaken for a status code", () => {
    expect(isRecipientGone({ code: 550, detail: "550 Connection from 10.5.1.12 refused" })).toBe(
      false,
    )
  })
})
