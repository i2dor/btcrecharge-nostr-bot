# ARCHITECTURE

Why the bot is shaped the way it is. What every module owns. The
locked decisions.

## Bird's-eye view

```
                                Nostr relays (wss://)
                                |  ^
                                |  |  encrypted DMs (NIP-04 + NIP-17)
                                v  |
   +----------------------------------------------------+
   |  Bot (this repo)                                   |
   |                                                    |
   |    Relay pool   (subscribe + publish, dedup, re-REQ)
   |        |                                           |
   |        v                                           |
   |    Crypto       (NIP-04 + NIP-17 encrypt/decrypt) |
   |        |                                           |
   |        v                                           |
   |    Anti-spam    (token bucket, NIP-13 PoW gate)   |
   |        |                                           |
   |        v                                           |
   |    Session store (Redis, atomic mutate, 7d TTL)   |
   |        |                                           |
   |        v                                           |
   |    Parser+FSM    (commands.ts, pure functions)    |
   |        |                                           |
   |        v                                           |
   |    Render        (FSM actions -> reply text)      |
   |        |                                           |
   |        v                                           |
   |    btcrecharge HTTP client (HMAC-signed POSTs)    |
   |        |                                           |
   +--------|-------------------------------------------+
            v
   +----------------------------------------------------+
   |  btcrecharge backend (existing, separate repo)     |
   |                                                    |
   |    POST /internal/lightning-orders                 |
   |    POST /webhook/order  (callback to bot)          |
   |    GET  /api/operators?country=XX                  |
   |    GET  /.well-known/nostr.json (NIP-05)           |
   |                                                    |
   |    Owns: BTCPay invoice, Bitrefill dispatch,       |
   |          retry, refund (via pull-payment), state   |
   |          machine, persistence (SQLite).            |
   +----------------------------------------------------+
```

The bot is a **thin client**. The backend owns the money path; the bot
owns the conversation.

## Pinned decisions

These are locked. Do not relitigate without a recorded reason in a
follow-up runbook entry.

| # | Topic | Decision | Rationale |
|---|---|---|---|
| 1 | SDK | `nostr-tools` v2 | Creator-driven, low obsolescence risk. Self-host strfry relay deferred to Phase 2 when traction warrants. |
| 2 | Encryption | Dual NIP-04 + NIP-17 with per-pubkey capability detection | Migrate to NIP-17-only after 12 months once usage proves it. |
| 3 | State | Hot in Redis (TTL 7d) + cold in btcrecharge SQLite (`/internal/orders` proxy) | Reuse btcrecharge's order FSM, do not duplicate it. |
| 4 | Catalogue default | `delivery=direct` only | PIN-delivery flow not built. See Phase 3. |
| 5 | Profile updates | publish-profile script with mandatory `--no-fetch` or merged kind 0 | Client UI cannot sign for the bot pubkey; running through the script is the only reliable way. |
| 6 | Refund flow | Lightning address + LNURL-pay, well-known/lnurlp dry-run probe, reminder cadence at 24h/72h/7d | See [PHASE-3-REFUND-FLOW.md](PHASE-3-REFUND-FLOW.md). |

## Module map

Source files in `src/`, one purpose each.

| File | Owns |
|---|---|
| `index.ts` | Bootstrap. Wires identity + config + logger + redis + sessionStore + catalog + btcrecharge client + relayPool + webhook server + signal handling. Computes `callbackUrl` once via `resolveCallbackUrl`. |
| `identity.ts` | Loads BOT_NSEC, returns `{ secret, pubkey, npub }`. Refuses to boot if missing. |
| `config.ts` | zod-validated env contract. Every env var validated at boot; bad value = loud crash. |
| `logger.ts` | pino with a redact list for secrets. Used everywhere via `.child({ component: 'X' })`. |
| `callback-url.ts` | Resolve the public origin btcrecharge POSTs to. Resolution order: BOT_PUBLIC_URL > RAILWAY_PUBLIC_DOMAIN > localhost. Unit-testable. |
| `relay-pool.ts` | SimplePool wrapper. Re-issues subscriptions periodically, dedupes events, tracks connection status for `/health`. `publish(event, extraRelays)` unions the recipient's relays into the pool list; `query(filter, opts)` is a one-shot fetch for relay-list lookups. |
| `nip65.ts` | `RecipientRelays` resolver: kind 10050 (NIP-17 DM inbox) preferred, kind 10002 (NIP-65, read/unmarked) fallback, queried via pool + purplepag.es aggregator, cached 10 min per pubkey. |
| `crypto.ts` | NIP-04 + NIP-17 encrypt/decrypt + `buildOutboundDm` that picks the kind(s) to send based on detected capability. |
| `anti-spam.ts` | Token bucket per-pubkey, plus optional NIP-13 PoW verifier. |
| `session.ts` | `SessionStore` over Redis: `get`, `save`, `mutate` (WATCH/MULTI/EXEC retry), `linkOrder`/`lookupPubkey` reverse index. |
| `commands.ts` | Parser: text -> Intent. FSM: `(session, intent) -> { session, actions }`. Pure - no IO, no clocks. |
| `catalog.ts` | Fetch `/api/operators` per country, aggregate, cache, transform, render. `transformToCatalog` handles `directOnly` filter + `delivery` field. |
| `btcrecharge-client.ts` | HMAC-signed POST to `/internal/lightning-orders`. Surface error shape via `BtcrechargeApiError`. |
| `render.ts` | Action -> reply text. Owns the strings the customer sees; one place to localise later. |
| `webhook-server.ts` | Node stdlib HTTP server. `GET /health`, `POST /webhook/order` (HMAC + zod + renderStateNotification + DM publish). |
| `handler.ts` | The DM pipeline: PoW gate -> decrypt -> freshness gate on the real send time -> mutate session combining rate-limit + FSM -> render -> publish (pool + recipient relays). Also exports `buildInboundFilters` with per-kind `since` windows (kind 1059 needs a 2-day lookback because NIP-59 backdates wrap timestamps). |

`scripts/publish-profile.ts` is a one-shot CLI, not part of the running
bot. See [PROFILE-UPDATES.md](PROFILE-UPDATES.md).

## Data flow walkthroughs

### Customer DMs `/buy vodafone-romania`

1. Relay pool receives kind 4 or kind 1059 event tagged with bot pubkey
2. Handler:
   - PoW gate (skip when `minPowBits=0`)
   - `crypto.decryptIncoming` -> plain text + protocol used + real send time
   - Freshness gate: DMs older than 10 min (relay replay / redeploy
     backlog) drop without a reply
   - Kick off the NIP-65/10050 recipient-relay lookup in parallel
3. SessionStore `mutate(pubkey, fn)`:
   - In Redis: WATCH key, GET current session
   - `parseCommand(text, session.flow)` -> Intent
   - Apply anti-spam token bucket (decrement, reject if 0)
   - `transition(session, intent)` -> `{ next session, actions[] }`
   - MULTI: SET session JSON with 7d EX; EXEC
   - On WATCH conflict (another writer touched the key), retry up to 5x
4. For each Action returned by the FSM:
   - `render.actionToText(action, session, deps)` -> reply string
   - `crypto.buildOutboundDm(...)` -> array of signed events
     (NIP-04 + NIP-17 depending on protocol detection)
   - `relayPool.publish(event, recipientRelays)` for each - pool relays
     plus the customer's resolved inbox relays

### Customer pays the Lightning invoice

1. Customer's Lightning wallet pays the BOLT11
2. BTCPay server fires `InvoiceSettled` webhook to btcrecharge
3. btcrecharge:
   - Transitions order from `awaiting_payment` to `customer_paid`
   - Kicks off `process_bitrefill_leg(<order_id>)`
   - Pays Bitrefill from Blink (wallet B = 0aa5fb02 for btcrecharge)
   - On success, transitions to `delivered`
   - Calls `dispatch_channel_callback(<order_id>)` which routes to
     `dispatch_nostr_callback(<order_id>)` for source='nostr'
4. btcrecharge POSTs `<callback_url>` with the new state, HMAC-signed
5. Bot's `/webhook/order`:
   - Verifies HMAC against `NOSTR_PROXY_SECRET`
   - Parses payload via zod
   - `sessionStore.lookupPubkey(orderId)` -> customer pubkey
   - `renderStateNotification(payload)` -> reply text or null
   - Build + publish DM via crypto.buildOutboundDm + relayPool
   - On terminal states, unlink the order from the reverse index
6. Customer receives the "Done!" DM

## Storage layout

### Redis

| Key | Type | TTL | Purpose |
|---|---|---|---|
| `nostr-bot:session:<pubkey>` | string (JSON) | 7d sliding | Customer session state |
| `nostr-bot:order-to-pubkey:<orderId>` | string | 7d | Reverse index for webhook routing |
| `nostr-bot:catalog:v1` | string (JSON) | 5m | Aggregated catalogue cache |
| `nostr-bot:seen-event:<eventId>` | (LRU in process) | - | Event dedup; lives in the relay pool, not Redis |

### btcrecharge SQLite

Bot-related columns on `orders`:

- `source` = `'nostr'`
- `nostr_pubkey` (hex)
- `nostr_order_id` (UUID-derived, `nostr-<uuid>`, idempotency key)
- `callback_url`, `callback_status`, `callback_attempts`,
  `callback_last_attempt` (callback delivery state)

`payment_events` has rows like:

- `(from_state, to_state, event)` = `(null, 'awaiting_payment',
  'btcpay_invoice_created')`
- `event = 'nostr_callback_sent' | 'nostr_callback_failed'`
- `detail` is JSON with HTTP status, body snippet, curl error

## Test posture

141 tests across `tests/*.test.ts`. Strictly behavioural - assert on
observable output of the public surface, not which internal method was
called. Stub external dependencies (fetch, Redis, SimplePool, btcrecharge
client) but never the production class itself.

Categories:

- Pure: parser, FSM (`transition`), `transformToCatalog`,
  `renderMenu`, `resolveCallbackUrl`, `parseFlags`, `mergeContent`
- Stubbed-deps: catalog client (mocked fetch + in-memory Redis stub),
  session store (in-memory Redis stub with WATCH/MULTI/EXEC sim),
  webhook server (in-memory deps + HMAC math)
- Identity / crypto: round-trip tests with deterministic keys

Run with `npm test`. Lint with `npm run lint`. Both must pass before
push; CI does not yet exist (open follow-up).

## Why a thin client

Trade-off table:

| Option | Bot owns money path | btcrecharge owns money path |
|---|---|---|
| Order FSM | duplicate the work, drift | single source of truth |
| BTCPay integration | rebuild it | already done |
| Bitrefill dispatch | rebuild it | already done |
| Refund pull-payment | rebuild it | already done |
| Failure scenarios | re-test all of them | inherit btcrecharge's coverage |
| Operator visibility | new admin UI | reuse existing btcrecharge admin |

Thin client wins on every row except "loose coupling". We accept the
HMAC + callback contract as a stable interface and let the bot focus on
the Nostr-specific concerns: protocol negotiation, capability detection,
session state across messages, anti-spam, catalogue presentation.
