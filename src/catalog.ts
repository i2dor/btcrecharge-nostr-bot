/**
 * Catalog cache + render.
 *
 * btcrecharge already exposes `GET /api/operators?country=XX` for its own
 * UI (Bitrefill operators in a given country). For the Nostr bot we
 *
 *   - keep a curated list of target countries (Nostr-audience overlap),
 *   - fetch operators for each one,
 *   - cache the aggregated result in Redis with a 5-minute TTL,
 *   - and present them as short, memorable SKUs the customer can type
 *     into `/buy <sku>`.
 *
 * The render side maps each catalog row to a flag emoji + carrier name +
 * available package sizes. Phase 2.3 calls into this from the FSM's
 * `send_menu` action.
 */
import type { Logger } from 'pino';
import { z } from 'zod';

// ----- upstream wire format (what btcrecharge returns) ---------------

const PackageSchema = z.object({
    id:     z.string().min(1).optional(),
    value:  z.string().min(1),
    price:  z.number().int().positive(),
    amount: z.union([z.number(), z.string()]).optional(),
});

// Bitrefill operators inside /api/operators?country=XX are already filtered
// to that country, so the API does NOT repeat `country_code` on each row -
// it lives on the wrapper. We keep the field optional and back-fill it from
// the wrapper before passing the row to transformToCatalog.
const OperatorSchema = z.object({
    id:             z.string().min(1),
    name:           z.string().min(1),
    country_code:   z.string().length(2).optional(),
    country_name:   z.string().min(1).optional(),
    currency:       z.string().min(1).optional(),
    categories:     z.array(z.string()).optional(),
    recipient_type: z.string().optional(),
    // 'direct' (instant phone credit) | 'pin' (voucher needs manual
    // redemption). The bot defaults to direct-only because we have not
    // built a secure PIN-delivery flow on Nostr yet.
    delivery:       z.string().optional(),
    in_stock:       z.boolean().optional(),
    packages:       z.array(PackageSchema).default([]),
});

const OperatorsResponseSchema = z.object({
    ok:        z.literal(true),
    country:   z.string().length(2),
    operators: z.array(OperatorSchema),
});

export type RawOperator = z.infer<typeof OperatorSchema>;

// ----- bot-facing catalog --------------------------------------------

export interface CatalogItem {
    /** Short sku the customer types into `/buy <sku>`. */
    sku:        string;
    /** Bitrefill operator id (e.g. "airtel-india"). */
    operatorId: string;
    /** Display name. */
    label:      string;
    /** ISO-3166-1 alpha-2. */
    country:    string;
    /** Currency code (USD / EUR / local). */
    currency:   string;
    /** Allowed amounts as plain strings. */
    amounts:    readonly string[];
    /** Whether the operator is currently in stock at Bitrefill. */
    inStock:    boolean;
}

/**
 * Countries we prefer for the launch catalog. Originally the launch set was
 * narrowed to Nostr-audience-overlap markets (IN/BR/NG/MX/SV/AR/KE/VN/ZA/ID)
 * but live testing showed that Romanian users are buying for themselves
 * with their own +40 numbers, and the EU corridor matters for the same
 * diaspora-vs-home flows. Broaden the set; the per-country fetch is
 * parallel + cached, so the extra countries cost ~3s on a cold refresh
 * and 0s on every cached hit.
 */
export const DEFAULT_COUNTRIES: readonly string[] = [
    // Nostr-native + remittance corridors
    'IN', 'BR', 'NG', 'MX', 'SV', 'AR', 'KE', 'VN', 'ZA', 'ID',
    // EU / RO operator coverage (real-world users testing with own numbers)
    'RO', 'DE', 'ES', 'IT', 'FR', 'GB', 'NL', 'PL',
];

// ----- client --------------------------------------------------------

export interface CatalogClientOptions {
    baseUrl:    string;
    countries?: readonly string[];
    fetchImpl?: typeof fetch;
    /** TTL on the cached aggregate, seconds. */
    cacheTtl?:  number;
    timeoutMs?: number;
    /**
     * When true (default) we drop operators whose `delivery` field is not
     * `direct`. PIN-redemption operators require us to DM a voucher code
     * to the customer; we have not built that flow on Nostr, and shipping
     * it without is a recipe for stuck orders and chargebacks.
     */
    directOnly?: boolean;
}

/** Minimum Redis surface we touch for the catalog cache. */
export interface RedisCacheLike {
    get(key: string):                                           Promise<string | null>;
    set(key: string, value: string, mode: 'EX', seconds: number): Promise<'OK' | null>;
}

const CACHE_KEY = 'nostr-bot:catalog:v1';

export class CatalogClient {
    private readonly baseUrl:    string;
    private readonly countries:  readonly string[];
    private readonly fetchImpl:  typeof fetch;
    private readonly cacheTtl:   number;
    private readonly timeoutMs:  number;
    private readonly directOnly: boolean;
    private readonly redis:      RedisCacheLike;
    private readonly log:        Logger;

    constructor(opts: CatalogClientOptions, redis: RedisCacheLike, logger: Logger) {
        this.baseUrl    = opts.baseUrl.replace(/\/$/, '');
        this.countries  = opts.countries ?? DEFAULT_COUNTRIES;
        this.fetchImpl  = opts.fetchImpl ?? fetch;
        this.cacheTtl   = opts.cacheTtl  ?? 5 * 60;
        this.timeoutMs  = opts.timeoutMs ?? 15_000;
        this.directOnly = opts.directOnly ?? true;
        this.redis      = redis;
        this.log        = logger.child({ component: 'catalog' });
    }

    /** Return the cached catalog if fresh, otherwise refetch + repopulate. */
    async list(): Promise<CatalogItem[]> {
        const cached = await this.redis.get(CACHE_KEY);
        if (cached !== null) {
            try {
                const parsed = JSON.parse(cached) as CatalogItem[];
                if (Array.isArray(parsed) && parsed.length > 0) return parsed;
            } catch {
                this.log.warn('catalog cache corrupted, refetching');
            }
        }
        const fresh = await this.refresh();
        return fresh;
    }

    /** Look up a SKU. Returns null if the sku is unknown or out of stock. */
    async getBySku(sku: string): Promise<CatalogItem | null> {
        const all = await this.list();
        const lower = sku.toLowerCase();
        return all.find(c => c.sku === lower && c.inStock) ?? null;
    }

    /** Force a fresh fetch from btcrecharge. Caller code should rarely need this. */
    async refresh(): Promise<CatalogItem[]> {
        const fetched = await this.fetchAllCountries();
        const items   = transformToCatalog(fetched, { directOnly: this.directOnly });
        await this.redis.set(CACHE_KEY, JSON.stringify(items), 'EX', this.cacheTtl);
        this.log.info(
            { countries: this.countries.length, items: items.length, directOnly: this.directOnly },
            'catalog refreshed',
        );
        return items;
    }

    // ----- internals --------------------------------------------------

    private async fetchAllCountries(): Promise<RawOperator[]> {
        const settled = await Promise.allSettled(
            this.countries.map((cc) => this.fetchCountry(cc)),
        );
        const out: RawOperator[] = [];
        let fails = 0;
        for (const s of settled) {
            if (s.status === 'fulfilled') {
                for (const op of s.value) out.push(op);
            } else {
                fails++;
                this.log.warn({ reason: String((s as PromiseRejectedResult).reason) }, 'country fetch failed');
            }
        }
        if (fails === this.countries.length) {
            throw new Error('every country fetch failed; refusing to serve an empty catalog');
        }
        return out;
    }

    private async fetchCountry(country: string): Promise<RawOperator[]> {
        const ctrl  = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
        try {
            const res = await this.fetchImpl(
                this.baseUrl + '/api/operators?country=' + encodeURIComponent(country),
                { method: 'GET', signal: ctrl.signal },
            );
            if (!res.ok) {
                throw new Error(`upstream HTTP ${res.status} for country ${country}`);
            }
            const json = await res.json() as unknown;
            const parsed = OperatorsResponseSchema.safeParse(json);
            if (!parsed.success) {
                throw new Error(`schema parse failed for country ${country}: ${parsed.error.message}`);
            }
            // Back-fill country_code from the wrapper since the operator rows
            // omit it (they are already scoped to that country).
            const cc = parsed.data.country.toUpperCase();
            return parsed.data.operators.map(op => ({ ...op, country_code: op.country_code ?? cc }));
        } finally {
            clearTimeout(timer);
        }
    }
}

// ----- transform + render --------------------------------------------

const STATIC_FLAGS: Record<string, string> = {
    IN: 'IN', BR: 'BR', NG: 'NG', MX: 'MX', SV: 'SV',
    AR: 'AR', KE: 'KE', VN: 'VN', ZA: 'ZA', ID: 'ID',
    US: 'US', GB: 'GB', DE: 'DE', FR: 'FR', ES: 'ES',
    IT: 'IT', NL: 'NL', RO: 'RO', PL: 'PL', TR: 'TR',
};

/** Map a 2-letter country code to a flag emoji using regional indicators. */
export function countryFlag(cc: string): string {
    if (!/^[A-Z]{2}$/.test(cc)) return STATIC_FLAGS[cc] ?? cc;
    const base = 0x1F1E6 - 'A'.charCodeAt(0);
    return String.fromCodePoint(base + cc.charCodeAt(0)) + String.fromCodePoint(base + cc.charCodeAt(1));
}

/** Stable short SKU we promise to customers ("operator-cc" or, if collision-prone, "operator-cc-N"). */
export function makeSku(op: RawOperator): string {
    const id = op.id.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    const cc = (op.country_code ?? '').toLowerCase();
    if (!cc) return id;
    if (id.endsWith('-' + cc)) return id;
    return id + '-' + cc;
}

export interface TransformOptions {
    /** Drop operators whose `delivery` is not `direct`. Defaults to true. */
    directOnly?: boolean;
}

/** Map the upstream operator shape to our user-facing CatalogItem. */
export function transformToCatalog(
    raw:  readonly RawOperator[],
    opts: TransformOptions = {},
): CatalogItem[] {
    const directOnly = opts.directOnly ?? true;
    return raw
        .filter(op => Array.isArray(op.packages) && op.packages.length > 0)
        // PIN-delivery operators DM a voucher code that the customer redeems
        // manually. We have not shipped that flow on Nostr yet, so by
        // default we hide them; toggle off via DIRECT_TOPUP_ONLY=false when
        // a PIN-delivery flow lands.
        .filter(op => !directOnly || op.delivery === 'direct')
        .map((op) => ({
            sku:        makeSku(op),
            operatorId: op.id,
            label:      op.name,
            country:    (op.country_code ?? '').toUpperCase(),
            currency:   op.currency ?? '',
            amounts:    op.packages.map(p => p.value),
            inStock:    op.in_stock !== false,
        }));
}

/**
 * Render the catalog as a Nostr-friendly /menu reply.
 *
 * - `country` omitted: a compact list of countries with operator counts.
 *   The full per-operator dump was overwhelming customers, so the default
 *   view is now a drill-down hint.
 * - `country` set (ISO-2): only operators in that country, with SKUs.
 */
export function renderMenu(items: readonly CatalogItem[], country?: string): string {
    if (items.length === 0) return 'Catalog is empty right now. Try again in a minute.';
    const byCountry = new Map<string, CatalogItem[]>();
    for (const it of items) {
        const arr = byCountry.get(it.country);
        if (arr) arr.push(it); else byCountry.set(it.country, [it]);
    }

    if (country) {
        const cc   = country.toUpperCase();
        const rows = byCountry.get(cc);
        if (!rows || rows.length === 0) {
            const available = Array.from(byCountry.keys()).sort().join(', ');
            return `No operators for ${cc}. Available countries: ${available}.`;
        }
        const lines: string[] = [`${countryFlag(cc)} ${cc} operators:`, ''];
        for (const row of rows) {
            const amts = row.amounts.slice(0, 6).join(' / ');
            lines.push(`  ${row.sku.padEnd(28)} ${row.label}  [${amts}${row.amounts.length > 6 ? ' ...' : ''}] ${row.currency}`);
        }
        lines.push('');
        // Customers were copy-pasting "<sku>" verbatim. Show a concrete
        // example using the first operator in this country so the format
        // is unambiguous.
        const exampleSku = rows[0]!.sku;
        lines.push(`Example: Use "/buy ${exampleSku}" to start.`);
        return lines.join('\n');
    }

    // Compact intro. Listing every country one-per-line was still too long
    // (18 corridors -> 20+ lines per /menu). We surface a small hint set
    // and the total count; the customer can /menu CC for any of the rest.
    const all      = Array.from(byCountry.keys()).sort();
    // Preference order favours likely-tested corridors first (operator
    // testing with own RO number) then the diaspora-remittance set.
    const preferred = ['RO', 'IN', 'BR', 'MX', 'DE', 'GB', 'NG', 'AR', 'KE', 'ID'];
    const hints    = preferred.filter(cc => byCountry.has(cc)).slice(0, 5);
    const hintLine = hints.length > 0 ? hints.map(cc => `/menu ${cc}`).join('  ') : '/menu RO';
    return [
        'Pick a country:',
        '',
        `Quick start: ${hintLine}`,
        '',
        `We cover ${all.length} countries total - use /menu CC for any.`,
    ].join('\n');
}
