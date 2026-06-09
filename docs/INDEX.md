# btcrecharge-nostr-bot - documentation index

Pick the entry point that matches what you are trying to do.

## I want to run the bot for the first time

- [SETUP.md](SETUP.md) - local dev environment, every env var explained,
  prerequisites, first-boot smoke test
- [DEPLOY.md](DEPLOY.md) - Railway deploy, service references, public
  domain, post-deploy verification
- [RAILWAY_SETUP.md](RAILWAY_SETUP.md) - original Railway setup notes
  (legacy, kept as reference for the initial bootstrap)

## I am operating a running bot day-to-day

- [OPERATIONS.md](OPERATIONS.md) - reading logs, common admin tasks,
  inspecting prod state, checking customer orders
- [PROFILE-UPDATES.md](PROFILE-UPDATES.md) - update the bot's Nostr
  profile (about / picture / banner / nip05 / lud16) via the
  publish-profile script
- [EVENT-DELETION.md](EVENT-DELETION.md) - retract a published event
  via NIP-09 (kind 5 deletion request) with the delete-event script
- [TROUBLESHOOTING.md](TROUBLESHOOTING.md) - known failure modes with
  recovery recipes, debugging cookbook

## I want to understand how the bot works

- [ARCHITECTURE.md](ARCHITECTURE.md) - system diagram, data flow,
  pinned decisions, why the bot is a thin client over btcrecharge
- [COMMANDS-AND-FLOWS.md](COMMANDS-AND-FLOWS.md) - every customer-facing
  command with example DMs, the FSM walkthrough, the catalogue model

## I am about to implement Phase 3 (refund flow)

- [PHASE-3-REFUND-FLOW.md](PHASE-3-REFUND-FLOW.md) - locked decisions
  on Lightning address vs LNURL, dry-run probe, reminder cadence;
  do not relitigate
