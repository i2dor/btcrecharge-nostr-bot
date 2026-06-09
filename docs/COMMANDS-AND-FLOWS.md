# COMMANDS-AND-FLOWS

Customer-facing reference for the bot. Every command, every state, what
the customer sees, what the bot does internally.

## Quick reference

| Command | Description |
|---|---|
| `/start` | Re-show the welcome message, reset to idle |
| `/help` | Print the command list |
| `/menu` | Show the country index (5 quick-start codes + total count) |
| `/menu CC` | Show operators in country CC (e.g. `/menu RO`) |
| `/buy <sku>` | Start a purchase for that operator |
| `/cart` | Show items in the current (single-item) cart |
| `/clear` | Empty the cart, return to idle |
| `/cancel` | Abort the current flow, return to idle |
| `/status` | List orders the bot remembers for this customer |
| `/status <id>` | Look up a specific order (Phase 3+: full state read) |
| `/confirm` (or `yes` / `y` / `ok`) | Confirm the pending purchase |

Slash-less variants of `start`, `menu`, `help` also work (customers
often forget the slash).

## The /buy flow (happy path)

```
Customer: /menu
Bot:      Pick a country:

          Quick start: /menu RO  /menu IN  /menu BR  /menu MX  /menu DE

          We cover N countries total - use /menu CC for any.

Customer: /menu RO
Bot:      RO RO operators:

            vodafone-romania             Vodafone Romania  [4.76 / 6.95 / 13.90 / ...] EUR
            orange-romania               Orange Romania    [5 / 10 / 15 / 25 / ...] EUR
            telekom-romania              Telekom Romania   [5.95 / 9.85 / ...] EUR

          Example: Use "/buy vodafone-romania" to start.

Customer: /buy vodafone-romania
Bot:      Vodafone Romania - choose an amount:

            1) 4.76 EUR
            2) 6.95 EUR
            3) 13.90 EUR
            4) 27.80 EUR

          Reply with the number, e.g. "1".

Customer: 2
Bot:      Got it. Reply with the recipient phone number including
          country code, e.g. +918123456789

Customer: +40734145710
Bot:      Confirm: Vodafone Romania 6.95 EUR -> +40734145710.
          Reply /confirm to proceed or /cancel to abort.

Customer: /confirm
Bot:      Order 1018: Vodafone Romania 6.95 EUR -> +40734145710
          Amount: 13105 sats

          lnbc13105n1p0xyz... (BOLT11)

          Pay the Lightning invoice above. I will DM you once it is
          delivered. /status 1018 to check.

(Customer pays via Lightning wallet)

Bot:      Payment received. Dispatching your top-up...
          (state: customer_paid)

Bot:      Done! Your top-up was delivered.
          (state: delivered)
```

## FSM states

```
idle
  +-- /menu          -> selecting_carrier (no real transition; informational)
  +-- /buy <sku>     -> selecting_amount
selecting_amount
  +-- <int>          -> entering_phone
  +-- /menu / /buy   -> resets the flow
entering_phone
  +-- <phone>        -> confirming_amount
confirming_amount
  +-- /confirm       -> awaiting_payment (and the invoice is created)
  +-- /cancel        -> idle
awaiting_payment
  +-- backend sends customer_paid callback   -> bot DMs "Payment received..."
  +-- backend sends delivered callback       -> bot DMs "Done!", state TTL cleanup
  +-- backend sends refund_pending callback  -> awaiting_refund_address (Phase 3)
  +-- backend sends payout_failed callback   -> bot DMs "Hiccup..." stays in awaiting
  +-- backend sends expired callback         -> bot DMs "Invoice expired..."
  +-- backend sends invalid callback         -> bot DMs the error
awaiting_refund_address (Phase 3, not yet implemented)
  +-- <lightning address or LNURL>           -> forwarded to btcrecharge, refund pull-payment
  +-- backend sends refunded callback        -> bot DMs "Refund sent."
```

State is held in Redis under `nostr-bot:session:<pubkey>`. TTL is 7
days, refreshed on every interaction. See `src/session.ts`.

## Catalogue model

The catalogue is fetched from `BTCRECHARGE_BASE_URL/api/operators?country=XX`
once per country, aggregated, cached in Redis under
`nostr-bot:catalog:v1` for 5 minutes.

Each operator carries:

- `id` - upstream slug (e.g. `vodafone-romania`)
- `name` - display name (e.g. `Vodafone Romania`)
- `country_code` - ISO-2 (back-filled from the wrapper if missing)
- `currency` - operator's currency (EUR, ARS, INR, ...)
- `delivery` - `direct` (instant phone credit) or `pin` (voucher PIN)
- `packages` - allowed amounts

The bot derives a stable user-facing SKU via `makeSku()`: lowercase,
hyphenated, country suffix appended if not already there. The SKU is
what the customer types after `/buy`.

`DIRECT_TOPUP_ONLY=true` (default) hides operators where
`delivery !== 'direct'`. PIN ops require manual voucher redemption,
which the bot does not handle yet - shipping them risks stuck orders.

## State callbacks (backend -> bot)

btcrecharge POSTs `POST <BOT_PUBLIC_URL>/webhook/order` with HMAC
authentication (`X-Signature`, `X-Timestamp`, sha256 of `ts\n<body>`).

Payload schema (see `src/webhook-server.ts WebhookPayloadSchema`):

```json
{
  "internal_order_id": 1018,
  "state": "delivered",
  "nostr_order_id": "nostr-<uuid>",
  "sats": 13105,
  "voucher_pin": "optional, only when state=delivered and delivery=pin",
  "error": "optional, only on invalid/payout_failed"
}
```

State -> customer DM mapping:

| State | DM text | Notes |
|---|---|---|
| `customer_paid` | "Payment received. Dispatching your top-up..." | Currently emitted only by reconciliation cron, not the live BTCPay webhook. Phase 3 should also emit on transition. |
| `paying_bitrefill` | (silent) | Intermediate; no DM to avoid noise |
| `delivered` | "Done! Your top-up was delivered." | Plus voucher_pin if PIN-delivery (Phase 3+) |
| `payout_failed` | "Hiccup while delivering. I am retrying automatically." | Customer stays in awaiting_payment |
| `refund_pending` | "The order failed. Reply with a Lightning address and I will issue your refund." | Phase 3 captures the reply |
| `refunded` | "Your refund has been sent. Thanks for being patient." | Terminal |
| `expired` | "The Lightning invoice expired before payment. /menu to start over." | Terminal |
| `invalid` | "The order was rejected: <reason>." | Terminal |

Terminal states clean up the order-to-pubkey reverse index (Redis key
deleted) so the index does not grow forever.

## Error messages from the bot

Surfaced when something the customer can read or react to went wrong:

| Message | When | Hint |
|---|---|---|
| `Catalog is temporarily unavailable. Try again in a minute.` | catalog.list or .getBySku threw | btcrecharge returning 5xx, schema mismatch, Redis blip |
| `Unknown SKU "<sku>". Try /menu to see what is available.` | sku not in catalogue | typo, or operator went out of stock and was pruned |
| `That choice is outside the list (1 to N).` | amountIndex > available | customer typed a stale index |
| `Sorry, I could not create your invoice right now. Try again in a moment.` | btcrecharge `/internal/lightning-orders` 5xx | transient backend issue |
| `<Operator> just went out of stock. Try /menu.` | 409 from btcrecharge | operator went out of stock between menu and confirm |
| `Sorry, I did not catch that. Reply /help for the command list.` | unparseable input in idle flow | default catch-all |

## Anti-abuse

- **Token bucket rate limit**: 10 messages / minute per pubkey, refill
  1 token every 6 seconds. See `src/anti-spam.ts`. Configurable; raise
  carefully (relays already throttle).
- **NIP-13 Proof-of-Work**: optional, disabled by default (MVP). Enable
  by setting `minPowBits` in the handler when traffic from spammers
  becomes a problem.
- **Capability detection**: bot remembers each customer's last seen DM
  protocol (NIP-04 vs NIP-17) and replies in the same kind plus the
  other (dual-send) to maximise compatibility. See `src/crypto.ts`.

## NIP-05

The bot is advertised at `bot@btcrecharge.com`. Verification served by
btcrecharge.com at `/.well-known/nostr.json?name=bot` - response is the
bot's pubkey in the `names` map.
