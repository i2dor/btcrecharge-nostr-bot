# TROUBLESHOOTING

Known failure modes with the recovery recipe. Each entry is a real
incident we hit, not a hypothetical.

## Bot is online but the customer's `/menu` returns "Catalog is temporarily unavailable"

**Symptom**. `/start` works (the bot is alive on relays + Redis). `/menu`
returns the friendly fallback. Log shows `country fetch failed` with a
zod parse error per country.

**Cause**. btcrecharge's `/api/operators?country=XX` shape changed -
some field the schema required is missing (real incident on 2026-06-09:
`country_code` was on the wrapper, not on each operator row).

**Recovery**.

1. `curl -s 'https://btcrecharge.com/api/operators?country=RO' | jq .`
   to inspect the live shape
2. Update `OperatorSchema` in `src/catalog.ts` - make the offending
   field optional, back-fill from the wrapper if needed
3. Add a defensive test in `tests/catalog.test.ts` that constructs an
   operator the same shape as the live API and asserts the parse passes
4. Push - Railway auto-deploys; verify with a fresh `/menu`

Catalog cache TTL is 5 min, so a stale cache might serve briefly after
the fix. Delete the Redis key to force fresh:

```bash
railway run --service Redis redis-cli DEL nostr-bot:catalog:v1
```

## Customer pays but never gets the "Done!" DM

**Symptom**. BTCPay confirms the payment, btcrecharge logs
`bitrefill_leg_start` -> `blink_paid_success` -> state `delivered`.
Then a `nostr_callback_failed` event with `err: "Failed to connect to
localhost port 8080"` or similar.

**Cause**. The bot saved `http://localhost:PORT/webhook/order` as the
order's `callback_url` because at boot time neither `BOT_PUBLIC_URL`
nor `RAILWAY_PUBLIC_DOMAIN` was set. Real incident on 2026-06-09 for
orders #1015, #1016, #1017.

**Recovery (per stuck order)**.

1. Confirm via SSH on btcrecharge:
   ```bash
   ssh btcrecharge "cd btcrecharge && sqlite3 storage/db.sqlite \"
     SELECT id, callback_url, callback_status, state FROM orders
     WHERE id IN (...);\""
   ```
2. Set the bot's `BOT_PUBLIC_URL` env in Railway (see
   [DEPLOY.md](DEPLOY.md))
3. Rewrite the stuck orders' callback URL:
   ```bash
   ssh btcrecharge "cd btcrecharge && sqlite3 storage/db.sqlite \"
     UPDATE orders
        SET callback_url = 'https://btcrecharge-nostr-bot-production.up.railway.app/webhook/order',
            callback_status = 'pending',
            callback_attempts = 0
        WHERE id IN (...);\""
   ```
4. Manually trigger the callback via PHP CLI:
   - Upload a tiny PHP script that does
     `require __DIR__.'/src/bootstrap.php'; dispatch_nostr_callback(<id>);`
   - Run with `ssh btcrecharge "cd btcrecharge && php <script>"`
   - For multi-order recovery, loop the script over the id list
5. Watch the bot's Railway log for the inbound webhook + the DM
   publish; verify the customer received the "Done!" DM

**Prevention**. Commit `7eceb2c` added a boot-time warn line if the
resolved callback URL is localhost. Set up a Railway alert on that warn
line ever appearing - if it does, your prod is one customer payment
away from this incident.

## `/confirm` produces no reply at all

**Symptom**. Customer goes through `/buy -> /confirm`, bot stays
silent.

**Cause**. createInvoice in `src/render.ts` threw, and the handler's
silent catch-all swallowed it. Most commonly, catalog.getBySku threw
because the catalog refresh failed.

**Recovery**.

1. Bot log will show `catalog list failed` or
   `catalog lookup failed during invoice` with the underlying error
2. Apply the catalog fix (see first entry above) AND verify
   `src/render.ts:createInvoice` wraps catalog access in try/catch
   surfacing a user-visible error (this was added in 94892ca + 061f780)

## Customer typed `/menu RO` and got "No operators for RO"

**Symptom**. Self-explanatory error from the bot.

**Cause**. Either RO is not in `DEFAULT_COUNTRIES` in `src/catalog.ts`,
or every RO operator is delivery=pin AND `DIRECT_TOPUP_ONLY=true`.

**Recovery**.

1. Check: `curl 'https://btcrecharge.com/api/operators?country=RO' | jq '.operators[] | {id, delivery}'`
2. If RO is genuinely empty for `delivery=direct`, no fix - feature
   missing upstream
3. If there are direct operators, RO is missing from `DEFAULT_COUNTRIES`
   - add it, push, deploy
4. If PIN ops are the only ones and you NEED them visible, flip
   `DIRECT_TOPUP_ONLY=false` ONLY if the Phase 3 PIN delivery flow has
   shipped. Otherwise PIN orders accumulate as stuck.

## Bot replies to `/start` but DMs over Damus do not work

**Symptom**. Bot answers from some clients (Amethyst, Primal) but not
Damus. Or vice versa.

**Cause**. NIP-04 vs NIP-17 capability mismatch. Damus historically
preferred NIP-04; newer Damus accepts NIP-17.

**Recovery**.

1. Verify the bot is sending dual (kind 4 + kind 1059) -
   `crypto.buildOutboundDm` does this when the recipient's capability
   is unknown
2. Capability is detected from the inbound event's kind. If the
   customer's first DM was a kind 1059, the bot replies kind 1059 only
   from then on (saves bandwidth)
3. To reset detection: delete the session
   `railway run --service Redis redis-cli DEL nostr-bot:session:<pubkey>`
   - Customer's next DM re-triggers dual-send

## Profile update via Damus / Primal does not stick

**Symptom**. You edit the bot's `about` field in your Nostr client UI,
hit Save, but the change does not appear after refresh.

**Cause**. The client signed the kind 0 event with whatever NSEC is
loaded in it, not the bot's NSEC. Relays reject the bad signature; UI
shows "Saved" anyway because that's optimistic UX.

**Recovery**. Use the publish-profile script. See
[PROFILE-UPDATES.md](PROFILE-UPDATES.md).

## Redis is "not connected" in the Railway canvas but `/health` is OK

**Symptom**. Cosmetic issue: Railway's project canvas does not draw the
arrow between the bot service and the Redis service.

**Cause**. `REDIS_URL` is a raw string, not a service reference. Railway
needs the `${{Redis.REDIS_URL}}` form to recognise the dependency.

**Recovery**. Edit `REDIS_URL` in the bot service Variables tab,
replace the raw URL with `${{Redis.REDIS_URL}}`. Save. Bot redeploys.
Visual line appears. Functional behaviour does not change because the
template resolves to the same URL anyway, BUT future Redis password
rotations now propagate automatically.

## Bot publishes DM but customer says it never arrived

**Symptom**. Log shows `state DM dispatched` or `publish` with okCount
matching total relays. Customer reports nothing on their side.

**Cause**. Customer's Nostr client connects to a different set of
relays than the bot publishes to. Events sometimes propagate between
relays quickly, sometimes not.

**Recovery**.

1. Ask which client and which relays it uses
2. Add their preferred relay to `NOSTR_RELAYS` in Railway env, redeploy
3. Tell the customer to add one of OUR relays as a backup. Future fix:
   publish to a wider relay set; we deliberately keep the list short to
   avoid hitting any one relay's rate limits

## Bot crashes on boot with zod error

**Symptom**. Railway boot log shows
`Schema parse error: BOT_NSEC is required` or similar zod messages,
then process exits.

**Cause**. Missing or malformed env var.

**Recovery**.

1. Read the zod error - it names the exact field and reason
2. Fix the Variables tab in Railway, redeploy
3. If the var is set but the bot says missing, you might be setting it
   on the wrong service / environment. Confirm you are editing the
   `btcrecharge-nostr-bot` service variables, not Redis or another
   project

## Lots of `mutate retry` lines in the log

**Symptom**. Several `mutate retry` debug lines in a short window for
the same pubkey prefix.

**Cause**. The customer is sending DMs faster than the bot can process
them, and the WATCH/MULTI/EXEC optimistic lock keeps catching the
concurrent writes.

**Recovery**.

- A single retry per DM is fine, that's the design
- More than 5 retries -> `session mutate retries exhausted` error
  surfaces, the DM is dropped. If this happens repeatedly the rate
  limiter should kick in - check `src/anti-spam.ts` settings

## Manual recovery scripts

Stash these in `scripts/` as we accumulate them. So far:

- `scripts/publish-profile.ts` - one-shot kind 0 update
- (proposed) `scripts/dispatch-callback.sh` - given an order id, force
  the callback retry on btcrecharge

## When in doubt

1. **Check the Railway logs first**. 90% of issues have a log line
   pointing at the root cause within a minute of the symptom
2. **Then btcrecharge `payment_events`**. The other 10% are state
   issues on the backend; the event log is the trail
3. **Then Redis directly**. `redis-cli GET nostr-bot:session:<pubkey>`
   shows you exactly what the bot thinks the customer is doing
4. Only after all three: file an issue / ask
