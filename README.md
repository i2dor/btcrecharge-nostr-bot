# btcrecharge-nostr-bot

Nostr DM bot for [btcrecharge.com](https://btcrecharge.com). Customers DM the
bot's npub (NIP-05: `bot@btcrecharge.com`), pick an international mobile
top-up SKU, pay a Lightning invoice, and receive the top-up confirmation back
over Nostr.

The bot is a thin client over btcrecharge's existing `/internal/orders`
proxy endpoint. Every order flows through btcrecharge's order FSM, BTCPay
invoice machinery, Bitrefill dispatch, retry, and refund logic - the bot
itself owns only session state (capability detection, cart, rate limits)
and the Nostr <-> HTTP translation layer.

See `/Users/i2dor/.claude/runbooks/nostr-bot-btcrecharge-2026-06-09.md` for
the architectural decisions (library, encryption, state, secrets).

## Architecture in one diagram

```
[Nostr DM] --> Bot
                +-- Hot session in Redis (capability, cart, rate limit, order map)
                +-- POST btcrecharge.com/internal/orders (HMAC-signed)
                              |
              [btcrecharge backend - ZERO mods needed]
                +-- SQLite orders + FSM
                +-- BTCPay invoice (Greenfield, shared btcpay.btcfactura.com)
                +-- Bitrefill dispatch (Blink wallet B = 0aa5fb02)
                +-- On state change -> POST bot's callback_url
                              |
              [Bot webhook receiver]
                +-- Verify HMAC
                +-- Lookup pubkey from order_id (Redis)
                +-- Send Nostr DM (NIP-04 / NIP-17 dual, capability-aware)
```

## Pinned decisions

| # | Topic       | Decision |
|---|-------------|----------|
| 1 | SDK         | `nostr-tools` v2 (creator-driven, lowest obsolescence risk). Self-host strfry relay deferred to Phase 2 when traction warrants. |
| 2 | Encryption  | Dual NIP-04 + NIP-17 with per-pubkey capability detection. Migrate to NIP-17-only after 12 months once usage proves it. |
| 3 | State       | Hot in Redis (TTL 7d), cold in btcrecharge SQLite (reuse `/internal/orders` as the proxy-as-a-service endpoint). |

## Prerequisites

- Node.js 22.13.0 (`.nvmrc` planned)
- Redis (Railway add-on in production)
- btcrecharge.com running with `NOSTR_PROXY_SECRET` env set (dedicated, not the ppay one)

## Setup

```bash
git clone https://github.com/i2dor2/btcrecharge-nostr-bot.git
cd btcrecharge-nostr-bot
cp .env.example .env
# fill BOT_NSEC, NOSTR_PROXY_SECRET, etc.
npm install
npm run dev
```

## Identity

- npub: `npub1zgzksmumsy5q3tq3ywzj6trmdehfvlhts6lpx9799wqz862qr4nqljlucd`
- NIP-05: `bot@btcrecharge.com`
- The matching nsec lives in the password vault. Never in git, never in chat
  logs, never in source.

## Deploy

Railway (planned, Phase 3.4). `main` branch auto-deploys.

## Repo layout

```
src/        # bot source (TypeScript, ESM, strict)
tests/      # unit + integration suites
scripts/    # one-off operational scripts (key rotation, smoke tests)
.github/    # CI workflows
```

## License

Proprietary. All rights reserved.
