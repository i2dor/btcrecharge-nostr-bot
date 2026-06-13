# Railway deployment

Step-by-step setup for the `btcrecharge-nostr-bot` service.

## 1. Create project

1. Open https://railway.app/dashboard
2. Click **New Project** -> **Deploy from GitHub repo**
3. Select **i2dor2/btcrecharge-nostr-bot** (private; you may need to grant
   Railway access to the repo)
4. Name the project `btcrecharge-nostr-bot`

Railway will auto-detect Node.js + npm + `package.json` scripts. The
build runs `npm install && npm run build`; the start command is
`npm start` which executes `node dist/index.js`.

## 2. Add Redis database

1. In the project view, click **+ New** -> **Database** -> **Redis**
2. Railway provisions a managed Redis instance (~$5/month)
3. Auto-injected env var: `REDIS_URL` (Railway sets this on the bot
   service automatically; do not paste it manually)

## 3. Set environment variables on the bot service

In the bot service -> **Variables** tab, add:

| Key                    | Value                                                                 |
|------------------------|-----------------------------------------------------------------------|
| `BOT_NSEC`             | `<your bot nsec - generate once, keep offline>`                       |
| `NOSTR_PROXY_SECRET`   | `<64-hex, openssl rand -hex 32 - must match the backend .env>`         |
| `BTCRECHARGE_BASE_URL` | `https://btcrecharge.com`                                             |
| `NOSTR_RELAYS`         | `wss://relay.damus.io,wss://nos.lol,wss://relay.snort.social`         |
| `PORT`                 | `3000`                                                                |
| `LOG_LEVEL`            | `info`                                                                |
| `APP_ENV`              | `production`                                                          |

Do NOT add `REDIS_URL` manually - it is injected by the Redis service.

Critical: both `BOT_NSEC` and `NOSTR_PROXY_SECRET` are secrets. Confirm
you also have them backed up offline (password manager). Losing
`BOT_NSEC` means losing the bot identity permanently; rotating it
strands every in-flight conversation.

## 4. Configure the build (if Railway does not auto-detect)

If the auto-detected build fails, set these explicitly:

- **Build command**: `npm install && npm run build`
- **Start command**: `npm start`
- **Watch paths**: `src/**`, `package.json`, `tsconfig.json`
- **Root directory**: leave empty (repo root)

## 5. Configure deploy trigger

Default: Railway auto-deploys on every push to `main`. No change needed.

## 6. Add `NOSTR_PROXY_SECRET` to btcrecharge `.env` (prod)

This is a separate task on the btcrecharge side, not in Railway:

```
ssh btcrecharge "echo 'NOSTR_PROXY_SECRET=<64-hex, same value as the bot Railway env>' >> ~/public_html/.env"
```

Then reload PHP-FPM / opcache (Krystal/LiteSpeed):

```
ssh btcrecharge "killall -USR1 lsphp 2>/dev/null || true"
```

Verify with the smoke-test scripts in Phase 2.5.

## 7. Custom domain (Phase 3.4)

Once the bot is healthy, set up the webhook URL at
`https://nostr-bot.btcrecharge.com` (or wherever). Phase 3.4 wires this.

## 8. Sanity checklist before declaring deploy ready

- [ ] Logs show `bot booted` with the expected npub on first boot
- [ ] Redis is connected (Phase 2.1+ will log the ping result)
- [ ] No secret values leak into logs (pino redact list is enforced)
- [ ] Manual smoke test from a Nostr client to the bot npub returns a
      reply within seconds (Phase 2 happy path)

## 9. Cost

- Bot service:  ~$5/month (Hobby plan)
- Redis:        ~$5/month
- Total:        ~$10/month

## 10. Rollback

Railway keeps the previous deployment hot. To roll back:

1. **Deployments** tab -> pick the previous green build
2. Click **Redeploy**
3. Verify logs

For nsec emergency rotation (compromised key):

1. Generate fresh `BOT_NSEC` offline
2. Update Railway env var
3. Restart the service
4. Update NIP-05 nostr.json on btcrecharge.com to the new pubkey
5. Announce the new npub via the existing channels (web, social,
   pinned note on the old npub if still accessible)
