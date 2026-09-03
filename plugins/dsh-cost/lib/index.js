/**
 * dsh-cost host plugin.
 *
 * Contributes a `cost` settings namespace (enabled, currency, precision, the
 * peak-window table, the optional weekday rule, the per-model price table, and
 * an optional live pricing-page refresh) and the client→host handlers the
 * browser half invokes to price a session's token usage.
 *
 * The plugin deliberately references no harness module whose entry pulls in
 * `@deepseek-ai/cordis`: it only uses `@deepseek-ai/schemastery` (a leaf) for the
 * settings schema and `ctx.get("connection")` / `ctx.get("sessions")` / the
 * injected `settings` service at runtime. All pricing math lives in `./cost.js`
 * (pure ESM, unit-tested) so this file is purely wiring.
 *
 * Cost is computed on demand from `session.events`, priced per request by the
 * event's timestamp (peak vs valley) at the session's CURRENT model — no
 * per-model attribution. The client reaches these methods over the generic
 * Connection RPC channel (`ctx.connection.rpc`, authority `trusted-host`), the
 * durable transport that also works over the tailnet.
 */
import z from "@deepseek-ai/schemastery";
import { DEFAULT_PEAK_WINDOWS, DEFAULT_PRICES, isInPeak, matchRate, coerceRate, priceSession } from "./cost.js";

/** Cordis plugin name used by loader diagnostics. */
export const name = "cost";

/** Services the host half requires (the rest are read via `ctx.get(...)`). */
export const inject = ["settings"];

/** How long a fetched pricing document stays trusted before a refetch attempt. */
const PRICING_TIMEOUT_MS = 8000;

/** Deployment/user configuration, editable under Settings → Plugins → Cost. */
export const Config = z.object({
	/** Master switch for the cost chip. */
	enabled: z.boolean().default(true),
	/** Currency prefix rendered before the amount (usually "$"). */
	currency: z.string().default("$"),
	/** Decimal places for the cost figure. */
	precision: z.number().min(0).max(6).default(4),
	/** Apply the peak-window table only Mon–Fri; weekends are all valley. */
	weekdaysOnly: z.boolean().default(true),
	/** Half-open `[start, end)` peak windows, "HH:MM" in UTC. */
	peakWindows: z.array(z.tuple([z.string(), z.string()])).default(DEFAULT_PEAK_WINDOWS),
	/** Per-model price table keyed by model id (or family prefix with a `*`). */
	prices: z.dict(z.any()).default(DEFAULT_PRICES),
	/** Optional JSON pricing document URL that refreshes windows/prices. */
	pricingUrl: z.string(),
	/** Re-check `pricingUrl` after this many ms (default 1h). */
	pricingRefetchMs: z.number().min(0).default(3600000)
});

/** Cache for the optional pricing-fetch result (module-level; per-boot). */
const pricingCache = { at: 0, merged: null };

/**
 * Read the effective config, optionally refreshing it from `pricingUrl` (TTL'd by
 * `pricingRefetchMs`). Always falls back to built-ins on any fetch error — the
 * chip must never be blocked by a flaky pricing page.
 * @returns a Promise of the merged config object.
 */
async function getEffectiveConfig(ctx, scope) {
	const cfg = scope.get();
	const url = cfg.pricingUrl;
	if (!url) return cfg;
	const ttl = Number(cfg.pricingRefetchMs) || 3600000;
	const now = Date.now();
	if (pricingCache.merged && now - pricingCache.at < ttl) return pricingCache.merged;
	try {
		const signal = typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(PRICING_TIMEOUT_MS) : undefined;
		const response = await fetch(url, signal ? { signal } : {});
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		const body = await response.json();
		if (body && typeof body === "object") {
			const merged = {
				...cfg,
				...(Array.isArray(body.peakWindows) ? { peakWindows: body.peakWindows } : {}),
				...(body.prices && typeof body.prices === "object" ? { prices: body.prices } : {})
			};
			pricingCache.merged = merged;
			pricingCache.at = now;
			return merged;
		}
	} catch (error) {
		ctx.logger?.warn(`cost: pricing refresh from ${url} failed (${String(error?.message ?? error)}) — using built-ins`);
	}
	pricingCache.merged = cfg;
	pricingCache.at = now;
	return cfg;
}

/** Resolve the model to price at: the session's request context, else last seen. */
function resolveModel(session) {
	if (session && typeof session.requestContext === "function") {
		try {
			const context = session.requestContext();
			if (context && context.model) return context.model;
		} catch {
			/* fall through to the event-derived model inside priceSession */
		}
	}
	return "";
}

/**
 * Price one session: tokens from every `assistant/message` usage event, tiered
 * peak/valley by the event timestamp, all priced at the current model.
 */
async function costSession(ctx, scope, sessionId) {
	const cfg = await getEffectiveConfig(ctx, scope);
	const enabled = cfg.enabled !== false;
	const precision = Number(cfg.precision) || 4;
	const base = {
		cost: 0,
		currency: cfg.currency || "$",
		precision,
		model: "",
		priced: false,
		nowIsPeak: isInPeak(new Date(), cfg.peakWindows, cfg.weekdaysOnly),
		peakWindows: cfg.peakWindows,
		weekdaysOnly: cfg.weekdaysOnly !== false,
		tokens: { peak: 0, valley: 0, total: 0 },
		totalTokens: 0,
		rates: null,
		count: 0,
		enabled
	};
	if (!enabled) return base;

	const sessions = ctx.get("sessions");
	const session = sessions && sessionId ? sessions.get(sessionId) : undefined;
	const events = session ? session.events : [];
	const model = resolveModel(session);
	const result = priceSession(events, {
		model,
		prices: cfg.prices,
		peakWindows: cfg.peakWindows,
		weekdaysOnly: cfg.weekdaysOnly
	});
	const rate = result.model ? matchRate(cfg.prices, result.model) : undefined;
	return {
		...base,
		cost: result.cost,
		model: result.model,
		priced: result.priced,
		tokens: result.tokens,
		totalTokens: result.totalTokens,
		count: result.count,
		rates: rate ? coerceRate(rate) : null,
		nowIsPeak: isInPeak(new Date(), cfg.peakWindows, cfg.weekdaysOnly)
	};
}

/** Effective price table + schedule, for the UI breakdown / rate display. */
async function costPrices(ctx, scope) {
	const cfg = await getEffectiveConfig(ctx, scope);
	return {
		currency: cfg.currency || "$",
		precision: Number(cfg.precision) || 4,
		enabled: cfg.enabled !== false,
		weekdaysOnly: cfg.weekdaysOnly !== false,
		peakWindows: cfg.peakWindows,
		prices: cfg.prices,
		defaultPeakWindows: DEFAULT_PEAK_WINDOWS,
		defaultPrices: DEFAULT_PRICES
	};
}

/** Register the client→host handlers on the generic Connection RPC channel. */
function registerHandlers(ctx, scope) {
	const conn = ctx.get("connection");
	const rpc = conn && conn.rpc;
	if (!rpc || typeof rpc.handle !== "function") {
		ctx.logger?.warn("cost: connection RPC unavailable — the cost chip cannot reach the host");
		return;
	}
	rpc.handle("/rpc", async (endpoint, payload) => {
		try {
			let value;
			switch (endpoint) {
				case "cost/session": return { ok: true, value: await costSession(ctx, scope, payload && payload.sessionId) };
				case "cost/prices": return { ok: true, value: await costPrices(ctx, scope) };
				default: throw new Error(`cost: unknown endpoint '${endpoint}'`);
			}
		} catch (error) {
			ctx.logger?.error(`cost RPC ${endpoint} failed: ${String(error?.message ?? error)}${error?.stack ? `\n${error.stack}` : ""}`);
			return { ok: false, error: { code: "internal", message: String(error?.message ?? error), details: {} } };
		}
	}, { authority: "trusted-host" });
}

/**
 * Cordis plugin body: register the `cost` settings namespace (so the Settings →
 * Plugins card can edit it and per-operation reads see live values) and the
 * client→host handlers.
 * @param ctx - host composition context.
 * @param config - entry config, composed over the bundle/settings layers.
 */
export function apply(ctx, config) {
	const scope = ctx.settings.register("cost", Config, { base: config });
	registerHandlers(ctx, scope);
}
