---
title: Affiliates
description: The built-in referral program, and how an operator can use it.
---

# Refer a friend

Corsair ships with a referral program because a mail host grows by word of mouth
more than by advertising — people recommend the thing their email already works
on.

## How it works

Every account gets a referral link from **Account → Refer a friend**:

```
https://your-instance.example.com/signup?referred_by=<code>
```

When somebody signs up through it and chooses a paid plan, both accounts get a
free month. The reward is recorded against the referral and applied as credit
against the next renewal.

## For operators

The rewards are yours to set. A referral is a row in `referrals` with a
`reward_months` count, and the credit is `subscriptions.credit_months`, consumed
before money is charged. Change the default, make it two months, make it a
discount instead — none of it is hard-coded in the panel.

Turn it off entirely by hiding the Refer-a-friend tab; the endpoints stay
harmless because a referral with no reward configured simply grants nothing.

## What a referrer can see

The local part of a referred account's address and whether the reward was
granted — nothing else. Somebody else's full address is not the referrer's to
see, and the panel truncates it deliberately.

## Notifications

Referrers are emailed when a reward is granted, unless they have turned that off
under **Account → Notifications**. The notice goes to the account's notifications
address, which is deliberately allowed to be somewhere other than this server.
