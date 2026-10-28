import { db } from "../db/index.ts"
import { isSafeAddress } from "../mime/index.ts"

/**
 * The people each mailbox has written to.
 *
 * Mail back from someone you wrote to is the one "not spam" signal that needs
 * no corpus and no training, so the inbound path gives it a strong negative
 * score and lets it past greylisting — but only when SPF or DKIM authenticates
 * the sender as that address. A known correspondent's address in a forged From
 * is the classic attack, and this table would hand it a free pass otherwise.
 *
 * Recorded by every path a person sends through: SMTP submission, the webmail
 * (`sendFromMailbox`), and JMAP `EmailSubmission`. Not by an agent mailbox: what
 * an agent sends may be a prompt injection's choice, and trust in the reply is
 * a judgement about the human who wrote the first message.
 */

/** Rows kept per mailbox; the least recently written-to go first. */
export const CORRESPONDENT_CAP = 5000

// One message to a thousand-strong list is not a thousand correspondents worth
// trusting, and recording them would evict everyone the person actually knows.
const PER_SEND = 100

/** Never throws: a failure to remember a recipient must not fail the send. */
export const recordCorrespondents = async (
  address: { id: string; type?: string | null },
  recipients: readonly string[],
  cap = CORRESPONDENT_CAP,
): Promise<void> => {
  if (address.type === "agent") return
  const emails = [...new Set(recipients.map((r) => r.trim().toLowerCase()).filter(isSafeAddress))]
  if (!emails.length || emails.length > PER_SEND) return
  try {
    await db().execute({
      text: `INSERT INTO correspondents (address_id, email)
             SELECT $1, e FROM jsonb_array_elements_text($2::jsonb) AS e
             ON CONFLICT (address_id, email) DO UPDATE SET last_at = now()`,
      values: [address.id, emails],
    })
    await db().execute({
      text: `DELETE FROM correspondents WHERE id IN (
               SELECT id FROM correspondents WHERE address_id = $1
                ORDER BY last_at DESC OFFSET $2)`,
      values: [address.id, cap],
    })
  } catch (e) {
    console.error("[corsair] could not record correspondents:", (e as Error).message)
  }
}

export const isCorrespondent = async (addressId: string, email: string): Promise<boolean> => {
  if (!email) return false
  const row = await db().one<{ found: number }>({
    text: "SELECT 1 AS found FROM correspondents WHERE address_id = $1 AND email = $2",
    values: [addressId, email.trim().toLowerCase()],
  })
  return Boolean(row)
}
