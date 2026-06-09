# Bot profile updates (kind 0 metadata)

How to update the bot's profile fields (`about`, `picture`, `banner`,
`name`, `display_name`, `nip05`, `lud16`, `website`) on Nostr.

## Why a script and not a Nostr client UI

Nostr profile edits in Damus / Primal / Amethyst sign the kind 0 event
with whatever NSEC is loaded in the client. The bot's NSEC lives only
in Railway env, so a client UI without it cannot publish a valid event
for the bot pubkey - relays reject the bad signature, but most clients
display "Saved" anyway. The change appears to take, then quietly does
not propagate. We saw this once already.

The `publish-profile` script in `scripts/publish-profile.ts` signs with
the actual BOT_NSEC, broadcasts to every relay in `NOSTR_RELAYS`, and
reports the per-relay ack so you know whether it landed.

## One-time prep

1. Grab the bot NSEC from Railway:
   - Railway Dashboard -> `btcrecharge-nostr-bot` service -> Variables
   - Click `BOT_NSEC` -> "Show" -> copy. Starts with `nsec1`.

2. **Do not paste the NSEC into chat, commit messages, anywhere public.**
   It is the bot's identity; whoever has it can DM customers as the bot.

## Update the `about` field

Verify first with `--dry-run` (prints the signed event without
broadcasting):

```bash
cd /Users/i2dor/Sites/btcrecharge-nostr-bot

BOT_NSEC=<nsec1...> npm run publish-profile -- \
  --about=$'https://btcrecharge.com\nInternational mobile top-ups paid in Bitcoin and Lightning.\nDM me and type  /menu  to start.' \
  --dry-run
```

The `$'...'` (ANSI-C quoting in bash and zsh) preserves literal
newlines and the two spaces around `/menu`. Verify the JSON `content`
on stdout looks right, then rerun without `--dry-run`:

```bash
BOT_NSEC=<nsec1...> npm run publish-profile -- \
  --about=$'https://btcrecharge.com\nInternational mobile top-ups paid in Bitcoin and Lightning.\nDM me and type  /menu  to start.'
```

The script fetches the current kind 0 first and merges your flag into
it. Fields you do not pass (e.g. `name`, `nip05`) are preserved verbatim.

## Update `picture` + `banner`

After uploading the PNGs (e.g. via nostr.build), pass the URLs:

```bash
BOT_NSEC=<nsec1...> npm run publish-profile -- \
  --picture=https://nostr.build/i/<id>.png \
  --banner=https://nostr.build/i/<id>.png
```

Asset files live in `~/Downloads/btcrecharge-bot-assets/` after
generation; design source is `/tmp/btcrecharge-{avatar,banner}.svg`.

## All supported flags

| Flag | Field | Notes |
|---|---|---|
| `--name=<str>` | `name` | The handle Nostr clients show |
| `--display-name=<str>` | `display_name` | Longer display name |
| `--picture=<url>` | `picture` | Avatar URL, square crops to circle in clients |
| `--banner=<url>` | `banner` | Banner URL, 1500x500 native Nostr aspect |
| `--about=<multiline>` | `about` | Profile description, supports `\n` via `$'...'` |
| `--nip05=<addr>` | `nip05` | NIP-05 verification identifier |
| `--lud16=<addr>` | `lud16` | Lightning address for zaps |
| `--website=<url>` | `website` | Linked website |
| `--dry-run` | (flag) | Sign + print, do not broadcast |
| `--no-fetch` | (flag) | Skip merge with existing kind 0 (clean slate) |
| `--timeout=<ms>` | (number) | Per-relay fetch + publish timeout, default 8000 |

Both kebab-case (`--display-name`) and snake-case (`--display_name`) are
accepted on the CLI.

## Removing a field entirely

Pass an empty value to **delete** the key from the published JSON:

```bash
BOT_NSEC=<nsec1...> npm run publish-profile -- --website=
```

This removes `website` from the kind 0 content. Useful when a client
renders the field as a clickable element next to the bio (Primal does
this for `website`), which competes with your "DM me" call-to-action.
A plain "blank" string is not enough - the key has to be gone from the
event for clients to stop drawing the chip.

## After publish - verify propagation

The script prints per-relay outcome:

```
wss://relay.damus.io                  ok
wss://nos.lol                         ok
wss://relay.snort.social              ok

Published to 3/3 relays.
```

Exit code 0 iff at least one relay acknowledged. Anything less than the
full set is worth investigating, but a 1/3 broadcast is still a working
publish from the customer's side - other clients will sync the event
across relays in seconds.

Nostr clients cache profile data, often for 5-10 minutes. To see the
update right away:

- Damus: pull-to-refresh on the bot profile, or kill + relaunch
- Primal: scroll out of the profile and back in
- Amethyst: pull-to-refresh works; restart if it does not pick up

If a client still shows the old `about` after 10 minutes and a fresh
session, check the script's per-relay output - if some relays did not
ack, the customer's client might be hitting one of those. Add more
relays to `NOSTR_RELAYS` and republish.
