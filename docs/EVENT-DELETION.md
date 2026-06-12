# Event deletion (NIP-09)

How to retract an event the bot published by mistake (a repost, a stray
note, a wrong reply). Uses the `delete-event` script and NIP-09.

## What this can and cannot do

**Can**:
- Publish a kind 5 "deletion request" event signed by the bot's NSEC.
- Reference the target event id via an `e` tag.
- Broadcast to every relay in `NOSTR_RELAYS`. Compliant relays stop
  serving the target event.

**Cannot**:
- Force-delete. NIP-09 is a request, not a hard delete. Non-compliant
  relays keep the event. Clients that already cached it may keep
  showing it until the cache is evicted (often 24h).
- Delete events from a different pubkey. The signature would not match,
  every relay would reject.

In practice, broadcasting to the major public relays (damus.io,
nos.lol, snort.social) catches the event for most clients within a few
minutes.

## What event kinds this can delete

NIP-09 is kind-agnostic. The same `delete-event` script works for
anything the bot published. Common cases:

| Kind | What it is | Notes on deletion |
|---|---|---|
| 1 | Short text note | Standard - what people usually think of as "the post" |
| 6 | Repost (NIP-18) | Wraps a foreign event id; the original is not affected, only the bot's repost vanishes |
| 7 | Reaction / like (NIP-25) | The `+` reaction event itself. Deleting it removes the bot's like from the target note's reaction count once clients pick up the delete |
| 9735 | Zap receipt (NIP-57) | Deleting a zap receipt does not refund anything, the payment already happened on Lightning. Only the receipt event is retracted |
| 30023 | Long-form article (NIP-23) | Standard delete; replaceable, so a new version with the same `d` tag overrides the old without needing a kind 5 |
| 30000+ | Replaceable / parameterized replaceable | A delete suppresses every version; usually you want to publish a new version instead, not delete |

For a wrong like specifically (e.g. you tapped heart on someone's note
from the bot account by accident), the flow is identical to deleting a
repost: find the like's event id, run `delete-event --event-id=<hex>`.
Some clients show the like remained in the count until they refresh -
that is the client cache; force-refresh to verify.

## Find the event id

The event id is 64 hex chars and uniquely identifies the event.

| Source | How |
|---|---|
| Damus | tap the event -> "..." menu -> "Copy event ID" -> paste; if it starts with `note1` it is bech32, decode via njump.me or any Nostr tool to get the hex |
| Primal | event -> three dots -> "Copy ID" |
| Amethyst | long-press the event -> "Copy event ID" |
| njump.me | `https://njump.me/<bot-npub>` -> recent events list -> click the bad one -> the URL contains the bech32 or hex id |
| Raw query | any relay client; query kind 6 (repost) by author=<bot-pubkey> for recent events |

If you only have a `note1...` bech32 form, decode to hex with
`nostr-tools`:

```bash
node -e "const { nip19 } = require('nostr-tools'); console.log(nip19.decode('note1...').data)"
```

## Run the deletion

Same env contract as `publish-profile`: `BOT_NSEC` from Railway,
`NOSTR_RELAYS` defaults to the canonical five if unset.

Dry-run first (prints the signed event without broadcasting):

```bash
cd btcrecharge-nostr-bot

BOT_NSEC=<nsec1...> npm run delete-event -- \
  --event-id=<64-hex> \
  --reason="reposted by mistake" \
  --dry-run
```

The dry-run output is the kind 5 event the script would publish. The
`tags: [["e","<64-hex>"]]` line is what tells relays which event to
forget. If the `e` tag looks right, rerun without `--dry-run`:

```bash
BOT_NSEC=<nsec1...> npm run delete-event -- \
  --event-id=<64-hex> \
  --reason="reposted by mistake"
```

`--reason` is optional. It travels in the kind 5 event's `content`
field. Some clients show it next to the deletion notice; others ignore.

## Output

Per-relay outcome, similar to publish-profile:

```
wss://relay.damus.io                  ok
wss://nos.lol                         ok
wss://relay.snort.social              ok
wss://relay.primal.net                ok
wss://offchain.pub                    ok

Deletion request broadcast to 5/5 relays.

Reminder: NIP-09 is a request, not a hard delete. Relays may
ignore it, and clients that already cached the event may still
show it for up to 24h. Wait 1-2 min then check your client.
```

Exit code 0 iff at least one relay acknowledged.

## Verify the deletion took

1. Wait ~2 minutes for client caches to roll over.
2. Open the bot profile in your Nostr client.
3. The deleted event should be gone from the timeline. If a client
   still shows it, force-refresh / restart that client.
4. Check another client to confirm; cross-client verification rules out
   one-client cache hits.

If the event still shows everywhere after 5 minutes:

- Check the script output: were all relays `ok`? A `fail` or `timeout`
  on a relay means the deletion did not reach that relay - other
  clients may still pull the original from there.
- Add the suspect relay to `NOSTR_RELAYS` if it is not already there,
  rerun the deletion (idempotent - re-publishing the same kind 5 with
  the same `e` tag is harmless).
- Some relays are publicly known to ignore deletion requests as a
  policy. Nothing to do about those except adding more relays to your
  publish set so the majority view honours the delete.

## All supported flags

| Flag | Required | Description |
|---|---|---|
| `--event-id=<64-hex>` | yes | The id of the event to retract |
| `--event_id=<64-hex>` | yes (alt) | Snake-case alternative |
| `--reason=<text>` | no | Free-text reason; lands in the kind 5 `content` |
| `--dry-run` | no | Sign + print, do not broadcast |
| `--timeout=<ms>` | no | Per-relay timeout; default 8000 |

## When deletion is the wrong tool

- **The event has been widely propagated for hours/days**: deletion
  catches a small fraction; the original will keep surfacing. Better
  to publish a clarifying follow-up note from the bot account.
- **You want to "edit" a profile metadata event (kind 0)**: do not
  delete - just publish a new kind 0 via `publish-profile`. NIP-01
  says clients only consider the LATEST kind 0 per pubkey.
- **You want to "edit" a regular note**: Nostr does not have edits;
  publish a corrected follow-up. Some clients (Amethyst) support
  NIP-A2 "Comments" / "Edits" but support is partial.
- **The bad event was a DM (kind 4 or kind 1059)**: deletion does not
  unencrypt anything for any third party who already received the
  event. The recipient still has the plaintext locally. Move on.

## Recovery if you deleted the wrong event

You cannot un-delete. Once a kind 5 is out, every compliant relay
stops serving the target.

If you noticed within seconds and had `--dry-run` first, no harm done.
If you noticed after publishing: republish the original event content
as a NEW event. It will have a new id and survive future deletions
unless you delete it again. The lost likes/zaps on the old event are
gone for good.
