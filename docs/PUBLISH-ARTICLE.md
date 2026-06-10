# Publishing long-form articles (NIP-23, kind 30023)

How to publish a markdown article as the bot via the `publish-article`
script. Used for announcement posts, feature notes, postmortems, etc.

## What kind 30023 means

NIP-23 long-form notes are "parameterized replaceable" events: the
tuple `(pubkey, kind=30023, d-tag)` uniquely identifies an article. The
same `d` tag = the same article slot. Re-publishing with the same `d`
tag overrides the previous version across compliant relays + clients
(Habla, Yakihonne, Highlighter all do this). No deletion needed for
edits - just re-publish.

This is the canonical place to put announcement posts, feature notes,
long-form changelog entries, postmortems. NIP-23 markdown supports
headings, lists, code blocks, links, images. Most modern Nostr clients
render it nicely.

## Quick start

```bash
cd btcrecharge-nostr-bot

# Dry-run first (signs + prints, does not broadcast)
BOT_NSEC=<nsec1...> npm run publish-article -- \
  --file=docs/ANNOUNCEMENT.md \
  --title="The first Nostr DM bot for international mobile top-ups" \
  --summary="DM the bot, pay a Lightning invoice, the recipient phone is topped up in seconds." \
  --slug=first-nostr-mobile-topup-bot \
  --tag=nostr --tag=bitcoin --tag=lightning --tag=mobile-topups \
  --dry-run

# If the event preview looks right, repeat without --dry-run
BOT_NSEC=<nsec1...> npm run publish-article -- \
  --file=docs/ANNOUNCEMENT.md \
  --title="The first Nostr DM bot for international mobile top-ups" \
  --summary="DM the bot, pay a Lightning invoice, the recipient phone is topped up in seconds." \
  --slug=first-nostr-mobile-topup-bot \
  --tag=nostr --tag=bitcoin --tag=lightning --tag=mobile-topups
```

## Defaults so you can omit flags

| Flag | Default if omitted |
|---|---|
| `--title` | First `# heading` line in the markdown file |
| `--slug` | basename of `--file` lowercased and kebab-cased (e.g. `ANNOUNCEMENT.md` -> `announcement`) |
| `--published-at` | current unix timestamp |
| `--summary`, `--image`, `--tag` | absent |

Minimum viable invocation - this just works if your markdown has a
clear `# heading`:

```bash
BOT_NSEC=<nsec1...> npm run publish-article -- --file=docs/ANNOUNCEMENT.md
```

## All supported flags

| Flag | Required | Notes |
|---|---|---|
| `--file=<path>` | yes | Markdown file to publish |
| `--title=<str>` | no | Headline; default = first H1 in file |
| `--summary=<str>` | no | TLDR / preview text |
| `--slug=<str>` | no | `d` tag; default = file basename kebab-cased |
| `--image=<url>` | no | Header / hero image URL |
| `--tag=<topic>` | no, repeatable | One `--tag=x` per topic; emits one `t` tag each |
| `--published-at=<unix>` | no | Unix seconds; default = now. Use the original timestamp on a re-publish if you want clients to keep the original "Published" date |
| `--published_at=<unix>` | no | Snake-case alternative |
| `--dry-run` | no | Sign + print, do not broadcast |
| `--timeout=<ms>` | no | Per-relay publish timeout; default 8000 |

## Updating a published article

NIP-23 events are replaceable by the `(pubkey, kind, d-tag)` tuple. To
edit an article you previously published:

1. Edit the markdown file in the repo
2. Re-run the script with the **same `--slug`** (and same `--file`)
3. The new event replaces the old version on all compliant relays;
   clients reading the article now show the updated content

You usually want to leave `--published-at` alone on a re-publish - if
omitted it picks up the current time, which most clients render as
"Updated <today>". To preserve the original "Published" date and only
update the body, pass `--published-at=<original-unix>` and the new
`created_at` (set automatically to now) is what clients use as the
"Updated" timestamp.

## After publish - where the article lives

The script prints the addressable form on success:

```
naddr -> kind=30023, pubkey=npub1zgz..., d=first-nostr-mobile-topup-bot
```

You can craft an `naddr1...` bech32 share-link with any NIP-19 tool;
that link works in Habla, Yakihonne, Highlighter, Damus' long-form
preview, etc.

To DM the link to readers or paste it into a kind 1 short note for
distribution, encode the `naddr` with kind=30023, the bot pubkey, the
slug, and the relays the article was broadcast to.

## Verify propagation

The script reports per-relay outcome and exit-codes 0 iff at least one
relay acknowledged. If the publish reports `2/3` or worse, suspect
either:

- A relay is rate-limiting the bot pubkey (rare for kind 30023 since
  the event size is small)
- The relay is configured to reject parameterized replaceable events
  (almost no relay does this in practice)

If a Nostr client cannot find the article, check the `NOSTR_RELAYS` env
includes a relay that client reads from. Add more relays and re-publish
with the same slug - replacement semantics apply, no duplication.

## Common workflow for announcements

1. Draft markdown in `docs/ANNOUNCEMENT.md` (versioned in the repo)
2. Iterate with feedback - commit each round so the diff is visible
3. Once happy, `--dry-run` to inspect the signed event
4. Real publish with topic tags (`--tag=nostr --tag=bitcoin --tag=lightning ...`)
5. Share the `naddr` in a short kind 1 note, tag relevant accounts
   (Lucas Ontivero, Mostro, Bitrefill, BTCPay, etc. as relevant)
6. Future edits: re-run the script with the same slug; the article
   updates in place across clients
