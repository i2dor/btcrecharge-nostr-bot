/**
 * Entry point. Phase 1.1: just boot identity + config + logger, prove the
 * skeleton compiles and runs. Relay connect, command parser, order client,
 * webhook receiver all land in subsequent slices.
 */
import { getConfig } from './config.js';
import { getIdentity } from './identity.js';
import { getLogger } from './logger.js';

function main(): void {
    const cfg = getConfig();
    const id  = getIdentity();
    const log = getLogger();

    log.info({
        npub:    id.npub,
        pubkey:  id.pubkey.slice(0, 16) + '...',
        relays:  cfg.nostrRelays,
        env:     cfg.appEnv,
        backend: cfg.btcrechargeBaseUrl,
    }, 'bot booted (Phase 1.1 - identity only, no relay loop yet)');

    // Keep the process alive so Railway does not flag it as crashed during
    // the early scaffolding phase. The real event loop attaches in 1.2.
    process.stdin.resume();
}

main();
