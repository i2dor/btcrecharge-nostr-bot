# DEPLOY (Railway)

Deploy the bot to Railway. The legacy [RAILWAY_SETUP.md](RAILWAY_SETUP.md)
covers the original bootstrap; this doc is the current, post-Phase-2.7
canonical reference.

## Service topology

The bot lives in a single Railway project alongside a Redis service:

```
Railway Project: btcrecharge-nostr-bot
  +- Service: btcrecharge-nostr-bot    (this repo, deploys from main)
  +- Service: Redis                    (Railway managed Redis volume)
```

The bot connects to Redis over Railway's private network at
`redis.railway.internal:6379`. Inbound HTTP comes through the public
domain `btcrecharge-nostr-bot-production.up.railway.app` (assigned by
Railway when you generate a domain).

## One-time setup (already done in prod)

These steps were run on 2026-06-09 to bring prod online. Replay only if
recreating the deploy from scratch.

1. **Create the Railway project** + connect this GitHub repo. Pick the
   `main` branch as the deploy source.
2. **Add the Redis plugin** in the same project. Take note of its
   service name - in our case `Redis` with capital R (the name appears
   in reference variables, so case matters).
3. **Set the environment variables** on the bot service - see the env
   var table below.
4. **Generate a public domain**: Settings -> Networking -> Generate
   Domain. Target port = the value of `PORT` env (Railway uses 8080 by
   default; we go with whatever it injects). Railway sets
   `RAILWAY_PUBLIC_DOMAIN` automatically after this.
5. **First deploy**: push to main, Railway picks it up. Watch the build
   logs for any TS errors.

## Environment variables in Railway

Set these in the bot service's Variables tab:

| Var | Set to |
|---|---|
| `BOT_NSEC` | The bot's nsec1... (the actual key, not a template) |
| `NOSTR_PROXY_SECRET` | 64-hex matching btcrecharge's `NOSTR_PROXY_SECRET` env. NOT the ppay PROXY_SECRET. |
| `BTCRECHARGE_BASE_URL` | `https://btcrecharge.com` |
| `NOSTR_RELAYS` | Comma-separated wss:// list. Default in code is fine. |
| `REDIS_URL` | **Use the reference form**: `${{Redis.REDIS_URL}}` so credential rotation in the Redis service propagates here automatically. Raw URL also works but you lose the connection visualisation in Railway's canvas. |
| `LOG_LEVEL` | `info` for prod. Flip to `debug` temporarily when chasing issues. |
| `APP_ENV` | `production` |
| `BOT_PUBLIC_URL` | `https://btcrecharge-nostr-bot-production.up.railway.app` - explicit override, belt-and-braces over the Railway auto-injected variable |
| `DIRECT_TOPUP_ONLY` | `true` until Phase 3 ships |
| `PORT` | leave unset, Railway injects |

## Post-deploy verification

Once Railway reports the deploy as Active:

```bash
# 1. Healthcheck
curl -s https://btcrecharge-nostr-bot-production.up.railway.app/health
# Expected: {"ok":true}

# 2. NIP-05 verification
curl -s https://btcrecharge.com/.well-known/nostr.json?name=bot
# Expected: {"names":{"bot":"<bot-pubkey-hex>"}}

# 3. End-to-end via Nostr (manual)
# From your Nostr client, DM the bot npub with `/start`
# Expected: reply with the welcome message within ~2s
```

All three should pass before declaring the deploy good.

## Reading the boot log

In the Railway log, the first 10 seconds after a deploy should show:

```
{... "msg":"bot booting", "npub":"npub1...", "env":"production", "relays":3, "redisUrl":"redis://default:***@redis.railway.internal:6379"}
{... "msg":"redis connected"}
{... "msg":"callback URL resolved", "callbackUrl":"https://btcrecharge-nostr-bot-production.up.railway.app/webhook/order"}
{... "msg":"webhook server listening", "port":8080}
{... "msg":"bot online"}
```

Red flags to look for:

- `callback URL is localhost ...` warn line - means
  `BOT_PUBLIC_URL`/`RAILWAY_PUBLIC_DOMAIN` are both unset. New orders
  will store an unreachable callback URL. **Stop deploys, fix env, redeploy.**
- `redis error: ...` - Redis credential mismatch or service not
  reachable. Verify `REDIS_URL` matches the Redis service.
- Missing `bot online` line - boot crashed before completion. Scroll up
  for the zod validation error or import failure.

## Rollback

```
Railway Dashboard -> Service -> Deployments -> pick the previous
  successful deploy -> "..." menu -> "Redeploy"
```

Or revert the offending commit, push, Railway auto-deploys.

## Cost notes

- Bot service: ~$5-10/mo on Railway's hobby tier given the load profile
  (mostly idle, bursts when a customer DMs)
- Redis service: ~$5/mo for the 256 MB volume; usage is tiny (session
  payloads + rate-limit buckets), nowhere near the limit
- Public network egress is the variable. Currently negligible.

## Service references

When you set `REDIS_URL=${{Redis.REDIS_URL}}`, Railway substitutes the
Redis service's `REDIS_URL` at deploy time AND draws a visual line in
the project canvas connecting the two services. If you ever rotate the
Redis password (see [TROUBLESHOOTING.md](TROUBLESHOOTING.md) #security),
the bot picks up the new credential on its next restart without you
touching its env at all. This is why reference form is preferred over
the raw URL even though both work.
