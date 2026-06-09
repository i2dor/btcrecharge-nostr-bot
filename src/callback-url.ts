/**
 * Resolve the public URL btcrecharge should POST callbacks to.
 *
 * The previous version of this code lived inside index.ts and silently
 * fell back to `http://localhost:PORT/webhook/order` when neither
 * BOT_PUBLIC_URL nor RAILWAY_PUBLIC_DOMAIN was set. In production that
 * meant orders #1015/#1016/#1017 stored `http://localhost:8080/...` as
 * their callback URL; the bitrefill leg for #1016 succeeded but the
 * delivery DM never reached the customer because btcrecharge could not
 * reach the bot. Extracted so the resolution order is unit-testable.
 *
 * Resolution order:
 *   1. BOT_PUBLIC_URL          - explicit override, trim trailing slash
 *   2. RAILWAY_PUBLIC_DOMAIN   - injected by Railway when a public
 *                                domain is generated for the service
 *   3. http://localhost:PORT   - dev fallback; useless to btcrecharge
 */
export interface CallbackUrlInputs {
    botPublicUrl: string | undefined;
    railwayPublicDomain: string | undefined;
    port: number;
}

export function resolveCallbackUrl(inputs: CallbackUrlInputs): string {
    if (inputs.botPublicUrl) {
        return inputs.botPublicUrl.replace(/\/$/, '') + '/webhook/order';
    }
    if (inputs.railwayPublicDomain) {
        return `https://${inputs.railwayPublicDomain}/webhook/order`;
    }
    return `http://localhost:${inputs.port}/webhook/order`;
}
