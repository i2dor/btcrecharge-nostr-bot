# The first Nostr DM bot for international mobile top-ups, paid in Bitcoin and Lightning

You DM the bot. It DMs back. You walk through a guided flow. You pay a
Lightning invoice. The recipient's phone is topped up within seconds.

No website checkout. No signup. No KYC. No platform that can change its
mind tomorrow.

Verify the bot via NIP-05 at `bot@btcrecharge.com`, or paste the npub
`npub1zgzksmumsy5q3tq3ywzj6trmdehfvlhts6lpx9799wqz862qr4nqljlucd` into
your Nostr client and DM `/start`.

## What it does

Every customer interaction runs entirely through encrypted Nostr DMs.
The bot recognises a small set of commands:

```
/menu              -> see the country index
/menu RO           -> drill into operators for that country
/buy <operator>    -> start a purchase; the bot then asks for
                      amount and phone number, one step at a time
/confirm           -> the bot mints a BOLT11 Lightning invoice;
                      pay it and the top-up lands on the phone
/status            -> see your pending orders
/status <id>       -> details for one order
/cancel            -> abort the current flow
```

One DM per step. The bot speaks back over the same conversation. There
is no menu to navigate in a web UI, no email confirmation, no account
dashboard. The state of the conversation lives in your wallet's view
of your DMs with this npub.

## Coverage

The launch catalogue covers operators in 18 countries, weighted toward
Nostr-audience overlap and remittance corridors:

- **South America**: Brazil, Argentina, El Salvador, Mexico
- **Asia**: India, Indonesia, Vietnam
- **Africa**: Nigeria, Kenya, South Africa
- **Europe**: Romania, Germany, Spain, Italy, France, Netherlands, Poland, United Kingdom

Default filter is `delivery=direct` - only operators that credit the
phone instantly. Voucher-PIN operators are hidden for v1 until the bot
can hand-off PIN delivery over Nostr DMs safely.

## How a purchase actually flows

The bot is a thin client over an existing payment + fulfilment
backend. The mechanics:

1. You `/confirm` a purchase. The bot HMAC-signs the order details and
   POSTs them to its backend.
2. The backend mints a BTCPay Server invoice on a shared store backed
   by a working Lightning wallet, extracts the BOLT11, returns it.
3. The bot DMs the BOLT11 to you with the order id and the sats
   amount. You pay it from any Lightning wallet.
4. BTCPay's `InvoiceSettled` webhook fires the moment your payment
   confirms.
5. The backend pays the upstream supplier (Bitrefill) from the working
   wallet, which credits the phone.
6. State callbacks flow back to the bot, which DMs you the final
   confirmation: "Done! Your top-up was delivered."

The customer never sees the supplier, never sees the wallet, never
sees the store config. The bot translates between Nostr DMs and the
payment pipeline; everything else is invisible.

## Why Nostr was the right venue

Three things you cannot get on Telegram or a website:

**The npub is the identity.** The bot does not ask for a phone number
or email. It does not have an account system. The npub paid the
invoice, the npub receives the delivery confirmation. Session state
is keyed by npub end-to-end. A throwaway npub gets the same flow as a
well-known one - the bot rate-limits per pubkey but does not
discriminate.

**Encrypted by default.** Dual NIP-04 + NIP-17 with per-pubkey
capability detection. Relays see the wrapped event, not the content.
Bot session state lives in Redis keyed by pubkey, with a 7-day
sliding TTL.

**No platform risk.** Telegram bots die when Telegram decides to
change its mind. A website checkout dies the moment your payment
processor flags you. Nostr is a protocol; if one relay drops, the bot
publishes to three others. If a client renders the bio in a way the
bot operator does not like, push a new kind 0 and move on.

## Privacy posture

- The bot does not know your phone number unless you give one, and
  the only one it ever needs is the recipient's, not yours.
- It does not store recipient phone numbers after the order
  completes; the upstream invoice is the source of truth.
- DMs are encrypted; the relays carry ciphertext.
- The backend logs `nostr_pubkey` on each order for support traceability;
  nothing else is correlated to the npub.

This is not a privacy product. It is a commerce bot that respects the
basics.

## What is open

The known limitations, in plain language:

- **Refund flow** just shipped. If your top-up fails for any reason -
  invalid phone, upstream operator outage, supplier hiccup - the bot
  DMs you asking for a Lightning address. The refund hits seconds
  later, automatic, via a BTCPay pull-payment claim.
- **LNURL-pay bech32** for refunds is not decoded yet. Lightning
  addresses in LUD-16 form (`alice@walletofsatoshi.com`) work; bare
  `lnurl1...` is rejected with a friendly nudge to use the address
  form for now.
- **PIN-delivery operators** are hidden until the bot can hand off
  voucher PINs over Nostr DMs in a way that does not leave stuck
  orders behind.
- **Localisation**: English only at launch. Replies will localise per
  customer locale once traction warrants the work.

## Try it

Open any Nostr client (Damus, Primal, Amethyst, Iris, Snort - all
tested with the dual NIP-04 + NIP-17 mode), and:

1. Search for `bot@btcrecharge.com` (NIP-05 lookup) or paste the npub
2. Start a DM with `/start`
3. From the welcome message, `/menu` to see the country index

The first interaction is free. You only commit when you `/confirm` an
order and pay the Lightning invoice. Cancelling before that point
costs nothing and the bot does not retain anything beyond the session
TTL.

## Open source

The bot is open source under the MIT licence:
https://github.com/i2dor/btcrecharge-nostr-bot

That is the TypeScript code for the Nostr-facing side - relay pool,
NIP-04 + NIP-17 dual encryption, FSM, refund-address capture, the
publish-profile + delete-event CLIs. The PHP payment backend
(BTCPay client, supplier integration, pricing engine) is operational
infrastructure and stays private.

Documentation lives under `docs/` in the repo: SETUP, DEPLOY,
ARCHITECTURE, OPERATIONS, COMMANDS-AND-FLOWS, TROUBLESHOOTING. The
TROUBLESHOOTING.md has eight named incident recipes derived from real
bugs we hit during launch week. If you are building a Nostr commerce
bot, that document alone is worth the read.

## Stack credits

- `nostr-tools` v2 for the SDK
- BTCPay Server for the Greenfield Lightning side
- Bitrefill for the upstream operator catalogue
- Blink for the working Lightning wallet
- The Nostr maintainers and relay operators who keep this protocol
  alive

## What is next

If you try it, tell me what broke. If you think it solves a
remittance problem someone you know has, send them the npub. If you
are building something adjacent - Nostr-native commerce, Lightning
self-custody UX, multi-channel bots - DM me on Nostr. Not on the
website.
