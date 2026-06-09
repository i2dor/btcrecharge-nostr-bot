# Phase 3 - Refund flow for failed top-ups

When a Nostr-source order transitions to `refund_pending` (invalid phone,
operator outage, supplier error), the customer has paid sats but the
top-up did not land. Email refund is not an option - the bot only knows
the customer's npub, not an address. We need a Nostr-native refund path.

Status: **planned, not implemented**. Decisions below are locked - when
this task starts, do not re-litigate them.

## Locked decisions (2026-06-10)

### 1. Accept BOTH Lightning address and LNURL-pay

Surface accepted formats in the prompt:

```
The order failed. Reply with one of:
  - a Lightning address  (e.g. alice@walletofsatoshi.com)
  - an LNURL-pay         (e.g. lnurl1dp68...)
and I will refund <N> sats.
```

Parser order: try Lightning-address regex first (the user-facing common
case), fall back to LNURL bech32 decode. Reject anything else with a
specific message ("That does not look like a Lightning address or
LNURL"). Do not silently accept BOLT11 invoices - they encode a fixed
amount and pull-payment + amount-encoded invoice is a footgun.

Regex for Lightning address: `^[a-z0-9._+-]{1,64}@[a-z0-9.-]{1,253}\.[a-z]{2,}$`
(case-insensitive, lowercase before storage). LNURL: bech32 starts with
`lnurl1` and decodes to a valid URL via NIP-19-style decoding or any
LNURL library.

### 2. Validate with a well-known/lnurlp probe before pull-payment

Before transitioning the order or triggering BTCPay's pull-payment
creation, the bot's `/internal/refund-address` endpoint (PHP side) does:

1. **Lightning address path**: split on `@`, GET
   `https://<domain>/.well-known/lnurlp/<user>` with a 5s timeout.
2. **LNURL path**: bech32-decode, GET the resulting URL.
3. Expect HTTP 200 + JSON with `tag: "payRequest"`, plus a
   `callback` URL and `minSendable`/`maxSendable` that bracket the refund
   amount in milli-satoshis.
4. If the probe fails or the response is malformed: refuse with a
   user-facing error ("That Lightning address does not seem reachable -
   try a different one"). Do NOT mark the order refunded.

Probe failures stay in `refund_pending`; the customer can retry with a
different address. Successful probe authorises the pull-payment + state
transition.

### 3. Reminder cadence + operator escalation

Order state machine after refund_pending with no address reply:

| Elapsed | Action |
|---|---|
| +24h  | Reminder DM #1: "Still waiting on a Lightning address for your refund..." |
| +72h  | Reminder DM #2 |
| +7d   | Final DM: "I will hold this refund for an operator to handle. Reply any time with an address." + operator alert email |
| +30d  | Session-store TTL expires; an operator-only admin queue keeps the order with a `refund_stale` annotation |

Reminders are driven by a cron on the btcrecharge side (already exists
for the reconcile sweep at `/api/cron-tick` - extend it). Each reminder
is a new `nostr_callback` POST so it reuses the existing DM dispatch.
The bot increments a counter in payment_events so the cron does not
over-DM if it runs more than once per window.

Session-store TTL on the order reverse index is already 7 days
(`SESSION_TTL_SECONDS`); needs to extend to 30 days for refund_pending
orders specifically, otherwise the bot loses the pubkey<->order link
between reminder #3 and the final TTL window.

## Implementation slices (sketched, do not start until task is in_progress)

### Slice A - Bot side (TypeScript)

- New flow state `awaiting_refund_address` in `FlowSchema`
- Webhook handler for `state: 'refund_pending'`: set flow to
  `awaiting_refund_address`, push the prompt, mutate session
- Parser: in that flow, recognise `ln_address` or `lnurl` intents
- Action `forward_refund_address {orderId, address}`: HMAC POST to
  btcrecharge's new endpoint, reply with whatever the endpoint returns
- Webhook handler for `state: 'refunded'`: DM "Refund sent. tx ..."
- Reminder webhook (`state: 'refund_reminder'`, attempt: 1/2/3): just
  call renderStateNotification with a per-attempt message

### Slice B - Btcrecharge side (PHP)

- New endpoint `POST /internal/refund-address` with NOSTR_PROXY_SECRET
  HMAC verification (same scheme as `/internal/lightning-orders`)
- Payload: `{ internal_order_id, address }`
- Validation: address regex / LNURL decode -> well-known/lnurlp probe
  (5s timeout, 200 + tag=payRequest + amount-bracket check)
- On valid: `BTCPay::createPullPayment` -> claim by paying the resolved
  callback URL with the amount-encoded BOLT11. Transition
  `refund_pending` -> `refunded`. `dispatch_nostr_callback` to bot.
- On invalid: HTTP 400 with `{ ok: false, reason }`; bot DMs the reason
- Cron extension: every 6h, find orders in `refund_pending` older than
  thresholds, increment `refund_reminder_attempts`,
  `dispatch_nostr_callback` with `state: 'refund_reminder',
  reminder_attempt: N`. Stop after 3.

### Slice C - Tests

- Bot: parser unit tests for both formats, transition tests for
  `awaiting_refund_address`, render tests for the new state messages,
  render test for the reminder messages (attempts 1/2/3)
- Btcrecharge: PHP unit tests for the address regex + a mocked
  well-known probe (real HTTP under integration only)
- E2E: sandbox order intentionally fails (invalid phone), bot receives
  refund_pending DM, customer replies with a Lightning address, bot
  receives refunded DM with the tx detail

## Open items NOT yet decided

- Refund **amount**: today `customer_amount_sats`. After Bitrefill leg
  consumed real sats, the BTCPay invoice covered the full amount; no
  loss to refund. But if we introduce a refund-fee policy later, this
  field is the right knob.
- **Multi-currency refunds**: Lightning addresses denominate in sats;
  if the customer paid in BTC at a different rate, do we refund the
  sats or the original BTC-amount-in-sats? Pin to sats for v1.
- **Reminder localisation**: bot currently English-only. If we add RO
  later, reminders inherit the bot's locale, not the customer's. Punt.
