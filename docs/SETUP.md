# SETUP

Get the bot running locally for development, testing, or one-shot
operations like profile updates. For production deploy see
[DEPLOY.md](DEPLOY.md).

## Prerequisites

- **Node.js 22.13.0 or newer** (`engines.node` in `package.json`
  pins the floor). Use `nvm`, `mise`, `asdf`, or any version manager
  - `node --version` -> `v22.13.0` or higher
- **npm** (ships with Node)
- **Redis** for session state, rate-limit buckets, order reverse index
  - For local dev: `brew install redis && brew services start redis`
    (port 6379 by default)
- **A running btcrecharge.com backend with `NOSTR_PROXY_SECRET` env set**
  - For local-only dev you can mock this; for any integration test you
    need the real backend reachable + that env var configured to match
    the bot's `NOSTR_PROXY_SECRET`
- **A bot NSEC** (the bot's Nostr private key)
  - Generate once with `npx nostr-tools` or any Nostr key tool; persist
    OFFLINE. Loss of NSEC = loss of bot identity, every customer
    conversation orphaned, npub changes
  - Already provisioned for prod; in Railway under
    `BOT_NSEC` env var

## Install

```bash
git clone git@github.com:i2dor/btcrecharge-nostr-bot.git
cd btcrecharge-nostr-bot
npm install
```

## Environment

Copy the template and edit:

```bash
cp .env.example .env
```

Every var, what it does, and what happens when it is wrong:

| Var | Required | Default | What it does |
|---|---|---|---|
| `BOT_NSEC` | yes | (no default) | The bot's secret key. `nsec1...` bech32 or 64 hex. Missing => boot refuses (do not silently rotate identity). |
| `NOSTR_PROXY_SECRET` | yes | (no default) | 64-hex shared secret with btcrecharge for HMAC on `/internal/*` calls. Separate from the ppay PROXY_SECRET so leaking one does not compromise the other. |
| `BTCRECHARGE_BASE_URL` | no | `https://btcrecharge.com` | Backend origin. For staging or local point at the staging btcrecharge instance. |
| `NOSTR_RELAYS` | no | `wss://relay.damus.io,wss://nos.lol,wss://relay.snort.social` | Comma-separated wss:// list. Bot subscribes to all and publishes to all. Tune up if customers report missed DMs. |
| `REDIS_URL` | no | `redis://localhost:6379` | ioredis-compatible URL. Railway template form `${{Redis.REDIS_URL}}` is preferred in prod so credential rotation needs one edit. |
| `PORT` | no | `3000` | HTTP server port for `/webhook/order` + `/health`. Railway sets this automatically. |
| `LOG_LEVEL` | no | `info` | pino level: `trace` / `debug` / `info` / `warn` / `error`. Use `debug` when chasing relay or btcrecharge issues. |
| `APP_ENV` | no | `development` | Telemetry tag. `development` / `test` / `staging` / `production`. |
| `BOT_PUBLIC_URL` | recommended in prod | (unset) | Public origin btcrecharge POSTs callbacks to. When unset the bot falls back to `RAILWAY_PUBLIC_DOMAIN`, then `http://localhost:PORT` (useless to btcrecharge). Set explicitly to skip the auto-detection. |
| `DIRECT_TOPUP_ONLY` | no | `true` | Hide PIN-delivery operators from the catalogue. Keep `true` until Phase 3 refund flow + PIN delivery flow ship. |

`BOT_NSEC` and `NOSTR_PROXY_SECRET` are secrets - never commit them,
never paste them into chat, treat them like production database
credentials.

## First boot

```bash
npm run dev
```

You should see, in order:

1. `bot booting` with the npub + pubkey prefix + relay count
2. `redis connected` (if it does not log this within a second, Redis is
   not running or `REDIS_URL` is wrong)
3. `callback URL resolved` with the URL the bot will hand to btcrecharge
   - If you see `callback URL is localhost ...` and you are in prod, fix
     `BOT_PUBLIC_URL` / `RAILWAY_PUBLIC_DOMAIN` before anyone pays
4. `relay connected: wss://...` lines as each relay opens
5. `webhook server listening` on `PORT`
6. `bot online`

Test the HTTP side:

```bash
curl -s http://localhost:3000/health
# {"ok":true}
```

Test the Nostr side: from your Nostr client, DM the bot's npub with
`/start`. You should receive the welcome message back within a second.

## Tests + lint

```bash
npm test       # node:test runner, all files under tests/
npm run lint   # tsc --noEmit, no emit, zero output on success
```

Test count today: 141 across catalog, callback-url, commands, render,
session, anti-spam, webhook-server, identity, btcrecharge-client,
crypto, relay-pool, publish-profile, config. Add to the existing files,
follow the established pattern.

## Build for production

```bash
npm run build  # tsc -> dist/
npm start      # node dist/index.js
```

In Railway this is wrapped by their build step automatically; you only
need to run it locally for ad-hoc deploy tests.

## Common local dev gotchas

- **`Invalid url` on boot from zod**: `REDIS_URL` is something the
  regex does not accept. Should start with `redis://` or `rediss://`.
  Internal Railway hostnames with dots (e.g. `redis.railway.internal`)
  pass the regex but fail Node URL parsing on some versions - paste the
  full `redis://default:pass@host:6379` form rather than the template
  if you are debugging.
- **Bot connects but does not see DMs**: subscription was made but
  relays did not push. The relay pool re-subscribes every
  `DEFAULT_RESUBSCRIBE_MS` (currently 2 min) - if you are impatient,
  restart. If even after restart no DMs arrive, the relay you DMed via
  is not in `NOSTR_RELAYS`.
- **`every country fetch failed` from catalog**: catalog cannot reach
  `BTCRECHARGE_BASE_URL/api/operators`. Check the URL is the public
  https origin and not the bot's own host.
- **Tests pass, prod fails**: the diff probably touches network code
  not covered by unit tests. Run a manual end-to-end on staging before
  promoting.
