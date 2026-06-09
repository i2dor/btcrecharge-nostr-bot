# OPERATIONS

Day-to-day operator handbook. For deploy see [DEPLOY.md](DEPLOY.md); for
known issues see [TROUBLESHOOTING.md](TROUBLESHOOTING.md).

## Common tasks

### Update the bot's Nostr profile

See [PROFILE-UPDATES.md](PROFILE-UPDATES.md) - dedicated runbook for the
publish-profile script (about / picture / banner / nip05 / lud16).

### Change an env var

1. Railway Dashboard -> bot service -> Variables -> edit -> Save
2. Railway redeploys automatically within ~30s
3. After Active again, hit `/health` to confirm boot
4. Tail logs for the first minute - missed env errors show up as zod
   validation failures on boot

### Inspect a customer's session

Sessions live in Redis under `nostr-bot:session:<pubkey>`. From a shell
with access to the Redis service:

```bash
railway run --service Redis redis-cli GET nostr-bot:session:<pubkey>
```

The value is JSON; pipe through `jq` for readability.

Order to pubkey reverse index lives under
`nostr-bot:order-to-pubkey:<orderId>`. Useful when btcrecharge logs an
internal order id and you want to find which Nostr customer owns it.

### Inspect an order on btcrecharge

```bash
ssh btcrecharge "cd btcrecharge && sqlite3 storage/db.sqlite '
  SELECT id, state, source, nostr_order_id, customer_amount_sats,
         callback_url, callback_status, callback_attempts, created_at
  FROM orders WHERE id = <ORDER_ID>;'"
```

For the timeline of events on an order:

```bash
ssh btcrecharge "cd btcrecharge && sqlite3 storage/db.sqlite '
  SELECT id, from_state, to_state, event, substr(detail, 1, 200) AS detail,
         created_at
  FROM payment_events WHERE order_id = <ORDER_ID> ORDER BY id ASC;'"
```

The `event` column tells you what happened at each step
(`btcpay_invoice_created`, `webhook:InvoicePaymentSettled`,
`bitrefill_leg_start`, `blink_paid_success`, `nostr_callback_sent`,
`nostr_callback_failed`, ...).

### Retrigger a stuck nostr callback manually

Sometimes a callback failed (HTTP 5xx, bot was restarting, etc.) and
you want to force a retry without waiting for the reconcile cron.
Easiest: bump `callback_status` back to `pending`, the cron picks it up:

```bash
ssh btcrecharge "cd btcrecharge && sqlite3 storage/db.sqlite '
  UPDATE orders SET callback_status = \"pending\", callback_attempts = 0
  WHERE id = <ORDER_ID>;'"
```

Or invoke directly via PHP CLI:

```bash
scp scripts/dispatch-callback.php btcrecharge:/home/btcrecha/btcrecharge/
ssh btcrecharge "cd /home/btcrecha/btcrecharge && php dispatch-callback.php <ORDER_ID> ; rm dispatch-callback.php"
```

Where `scripts/dispatch-callback.php` is a 4-line script that requires
`bootstrap.php` and calls `dispatch_nostr_callback(<order_id>)`. See
the worked example in [TROUBLESHOOTING.md](TROUBLESHOOTING.md) under
"missing payment-confirmation DM".

### Roll the catalogue cache

Catalog has a 5-minute TTL. Force a refresh by deleting the Redis key:

```bash
railway run --service Redis redis-cli DEL nostr-bot:catalog:v1
```

Next customer `/menu` will trigger a fresh fetch from btcrecharge.

### Enable/disable PIN-delivery operators

```
Variables tab -> DIRECT_TOPUP_ONLY -> set to `false` to enable PIN ops
-> Save -> auto-redeploy
```

**Do not set `false` until Phase 3 refund flow is live**; PIN ops have
no DM-delivery flow on the bot yet and stuck orders pile up fast.

### Add a new country to the catalogue

Edit `src/catalog.ts` `DEFAULT_COUNTRIES` array. Push to main. Railway
auto-deploys. The catalogue cache is bypassed on first hit after deploy.

## Reading logs effectively

### Filter to one customer

The bot logs the customer's pubkey prefix (first 8 hex chars) on every
event. To filter the Railway log:

```
log search: pubkey:abcd1234
```

### Filter to one order

Bot logs `internal_order_id` on every callback. btcrecharge logs the
order id on every state event in `payment_events`.

### Common log lines and what they mean

| Log message | Severity | Meaning + action |
|---|---|---|
| `bot booting` | info | Bot just started. |
| `redis connected` | info | Redis handshake completed. |
| `callback URL resolved` | info | Reports which URL btcrecharge will be told to call back. |
| `callback URL is localhost ...` | warn | `BOT_PUBLIC_URL`/`RAILWAY_PUBLIC_DOMAIN` missing. **Customers will lose delivery DMs.** Fix env, redeploy. |
| `bot online` | info | Subscription opened, ready for DMs. |
| `relay connected/disconnected` | info/warn | Relay churn is normal; only worry if many disconnect at once. |
| `publish` | info | Bot sent a DM. `okCount` < `total` indicates partial relay propagation. |
| `state DM dispatched` | info | Customer was told about a state change (invoice settled, delivered, refund, ...). |
| `no pubkey for order id` | warn | Callback came in for an order the bot does not remember. Either TTL expired or order belongs to a different bot. |
| `webhook signature rejected` | warn | btcrecharge HMAC mismatch. Probably a secret rotation that did not propagate. |
| `mutate retry` | debug | Session WATCH/MULTI/EXEC race. Single retry is fine; many in a row means a hot customer is hammering the bot. |

## Monitoring suggestions

Not yet wired - capture for when the next outage motivates them:

- Alert on `callback URL is localhost ...` ever appearing in logs
- Alert on `nostr_callback_failed` count per order > 2 (callback host
  is wrong / unreachable)
- Alert on Redis disconnect lasting > 60s
- Weekly: count orders in `refund_pending` older than 7 days; manually
  reach out until the Phase 3 reminder cron lands

## Operational hygiene

### Secrets you should rotate periodically

- `NOSTR_PROXY_SECRET` - every 90 days; coordinate the rotation across
  bot and btcrecharge env at the same moment. Recommended: schedule a
  short maintenance window, rotate both, redeploy both, smoke-test, done
- `REDIS_URL` password - once a year unless leaked. Use the Railway
  Redis service "Reset password" + `${{Redis.REDIS_URL}}` reference
  form so the bot picks up the new value automatically
- `BOT_NSEC` - should never be rotated unless leaked. Rotating it
  changes the bot's npub and orphans every existing customer conversation,
  loses your nip05, breaks bookmarks. If it leaks, the cost is worse than
  the rotation - prepare a migration DM script + nip05 swap + announce

### Secrets you should NEVER paste

In chat, screen shares, commit messages, PR comments, public Discord,
issue tracker, Slack, anywhere indexable:

- `BOT_NSEC`
- `NOSTR_PROXY_SECRET`
- `REDIS_URL` (contains the password)
- Any `nsec1...` value
- Any value of the `Authorization:` headers in dev tools

The 2026-06-09 session leaked `REDIS_URL` in chat during debugging.
That password is on the open follow-ups list for rotation; do not add
to the pile.

## Backups

- **Bot state**: ephemeral by design. Redis volume on Railway is
  durable but if it died we lose pending session state + the order
  reverse index. Customers in `awaiting_payment` would lose their state
  but the order survives on btcrecharge, so they can re-find via
  `/status <id>`. Not worth dedicated backup beyond Railway's own.
- **btcrecharge data**: see the btcrecharge runbook; it has its own
  SQLite backup story.
- **Bot NSEC**: stored OFFLINE - paper, hardware key, encrypted
  password manager. NOT in any cloud service that could be locked out.
  Loss = identity loss, see "Secrets you should NEVER paste" above.
