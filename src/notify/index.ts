import { createHash, randomBytes } from "node:crypto"
import { from } from "@atlas/db"
import { config } from "../config/index.ts"
import { allColumns, db } from "../db/index.ts"
import { rfcMessageId } from "../ids/index.ts"
import { buildMessage } from "../mime/index.ts"
import { enqueue } from "../outbound/index.ts"
import { type Token, tokens, type User } from "../schema/index.ts"

/**
 * Mail the server sends on its own behalf: verification, password resets,
 * address recovery, and quota warnings.
 *
 * These go through the same outbound queue as customer mail, which means they
 * get the same retries and the same log. The one difference is the envelope
 * sender: notices come from postmaster at this server's own hostname, not from
 * a customer domain, so a customer who has not finished DNS setup still
 * receives the message telling them so.
 */

export type NotificationKind =
  | "email_verify"
  | "password_reset"
  | "address_recovery"
  | "quota_warning"
  | "referral_reward"

const postmaster = () => `postmaster@${config.hostname}`

const wrap = (body: string): string =>
  `${body}\n\n—\nThis message was sent by ${new URL(config.publicUrl).hostname}.\nIf you were not expecting it, you can ignore it safely.\n`

export const sendNotification = async (input: {
  to: string
  subject: string
  body: string
  kind: NotificationKind
}): Promise<void> => {
  const raw = buildMessage({
    from: { name: "Corsair", address: postmaster() },
    to: [{ name: null, address: input.to }],
    subject: input.subject,
    text: wrap(input.body),
    messageId: rfcMessageId(config.hostname),
    headers: {
      // Marks this as machine-generated so a recipient's auto-responder does
      // not reply to it and start a loop.
      "Auto-Submitted": "auto-generated",
      "X-Corsair-Notification": input.kind,
    },
  })

  await enqueue({ raw, mailFrom: postmaster(), recipients: [input.to] })
}

// ------------------------------------------------------------------ tokens --

const TTL_SECONDS: Record<string, number> = {
  email_verify: 60 * 60 * 24 * 3,
  password_reset: 60 * 60,
  address_recovery: 60 * 60,
}

export type IssuedToken = { token: string; row: Token }

/**
 * Mints a single-use token.
 *
 * Only the hash is stored, for the same reason a password is only stored
 * hashed: a database dump must not hand an attacker a working reset link for
 * every account in it. The plaintext exists once, in the email.
 */
export const issueToken = async (input: {
  kind: keyof typeof TTL_SECONDS
  userId?: string | null
  addressId?: string | null
}): Promise<IssuedToken> => {
  const token = randomBytes(32).toString("base64url")
  const row = await db().one<Token>(
    from(tokens)
      .insert({
        kind: input.kind,
        token_hash: createHash("sha256").update(token).digest("hex"),
        user_id: input.userId ?? null,
        address_id: input.addressId ?? null,
        expires_at: new Date(Date.now() + (TTL_SECONDS[input.kind] ?? 3600) * 1000),
      })
      .returning(...allColumns(tokens)),
  )
  return { token, row: row! }
}

/**
 * Redeems a token, atomically.
 *
 * The `used_at IS NULL` predicate is inside the UPDATE rather than checked
 * first: two requests arriving with the same token at the same moment would
 * both pass a separate read, and a reset link that works twice is a reset link
 * an attacker can replay.
 */
export const consumeToken = async (
  kind: keyof typeof TTL_SECONDS,
  token: string,
): Promise<Token | null> => {
  const hash = createHash("sha256").update(token).digest("hex")
  const row = await db().one<Token>({
    text: `UPDATE tokens SET used_at = now()
            WHERE token_hash = $1 AND kind = $2 AND used_at IS NULL AND expires_at > now()
        RETURNING *`,
    values: [hash, kind],
  })
  return row ?? null
}

// ----------------------------------------------------------------- notices --

/** Where account notices go — deliberately separate from the sign-in address. */
export const noticeAddress = (user: Pick<User, "email" | "notifications_email">): string =>
  user.notifications_email ?? user.email

export const sendVerification = async (user: User): Promise<void> => {
  const { token } = await issueToken({ kind: "email_verify", userId: user.id })
  await sendNotification({
    to: noticeAddress(user),
    kind: "email_verify",
    subject: "Confirm your email address",
    body: [
      "Confirm this address to finish setting up your account:",
      "",
      `${config.publicUrl}/app/verify?token=${token}`,
      "",
      "The link is good for three days.",
    ].join("\n"),
  })
}

export const sendPasswordReset = async (user: User): Promise<void> => {
  const { token } = await issueToken({ kind: "password_reset", userId: user.id })
  await sendNotification({
    to: noticeAddress(user),
    kind: "password_reset",
    subject: "Reset your password",
    body: [
      "Somebody asked to reset the password for this account.",
      "",
      `${config.publicUrl}/app/reset?token=${token}`,
      "",
      "The link is good for one hour and can only be used once.",
      "If it was not you, nothing has changed and you can ignore this.",
    ].join("\n"),
  })
}

export const sendAddressRecovery = async (input: {
  recoveryAddress: string
  mailbox: string
  addressId: string
}): Promise<void> => {
  const { token } = await issueToken({
    kind: "address_recovery",
    addressId: input.addressId,
  })
  await sendNotification({
    to: input.recoveryAddress,
    kind: "address_recovery",
    subject: `Reset the password for ${input.mailbox}`,
    body: [
      `Somebody asked to reset the mailbox password for ${input.mailbox}.`,
      "",
      `${config.publicUrl}/recover?token=${token}`,
      "",
      "The link is good for one hour and can only be used once.",
      "Every mail client signed in as this mailbox will need updating afterwards.",
    ].join("\n"),
  })
}

export const sendQuotaWarning = async (user: User, used: string, limit: string): Promise<void> => {
  if (user.notification_prefs?.quota === false) return
  await sendNotification({
    to: noticeAddress(user),
    kind: "quota_warning",
    subject: "Your account is nearly out of storage",
    body: [
      `This account has used ${used} of its ${limit} of storage.`,
      "",
      "Once it is full, incoming mail is deferred rather than delivered — senders",
      "will keep retrying for a few days, so freeing space recovers it.",
      "",
      `${config.publicUrl}/app/plans`,
    ].join("\n"),
  })
}

export const sendReferralReward = async (user: User, months: number): Promise<void> => {
  if (user.notification_prefs?.referrals === false) return
  await sendNotification({
    to: noticeAddress(user),
    kind: "referral_reward",
    subject: "You earned free months",
    body: [
      `Somebody signed up with your referral link. ${months} free month(s) have been`,
      "added to your account.",
      "",
      `${config.publicUrl}/app/account`,
    ].join("\n"),
  })
}
