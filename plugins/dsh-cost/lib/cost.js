/**
 * dsh-cost pricing core.
 *
 * Pure ESM with NO harness imports: everything here is unit-testable in
 * isolation. It owns the schedule, the rate table, the model matcher, and the
 * event fold that prices a session. The host plugin (`index.js`) is only a thin
 * wiring layer that reads sessions/settings and calls these functions; nothing in
 * this module touches Cordis, `ctx`, or the session store.
 *
 * Conventions (documented for correctness):
 * - Peak windows are half-open `[start, end)` in UTC, expressed as `"HH:MM"`.
 * - `weekdaysOnly` means the window table applies Mon–Fri only; weekends are all
 *   valley. (The reference DeepSeek 2026-08-16 schedule is Mon–Fri 01:00–04:00
 *   and 06:00–10:00 UTC.)
 * - A window whose `end <= start` is treated as wrapping across midnight:
 *   `now >= start || now < end`.
 * - Rates are USD per 1M tokens, keyed `{ input, cacheRead, cacheWrite, output }`
 *   per tier. `input` is uncached input (the provider folds cache hits out).
 * - Cost = Σ(event tokens × tier rate) / 1e6 per request, tiered by the event
 *   timestamp so a session spanning peak+valley is priced correctly.
 * - All tokens are priced at ONE model: the session's current model
 *   (`requestContext().model`), with a per-event `message.source.model` fallback
 *   when no request context exists yet.
 */

/** Default peak windows (UTC, half-open `[start, end)`, Mon–Fri only). */
export const DEFAULT_PEAK_WINDOWS = [
	["01:00", "04:00"],
	["06:00", "10:00"]
];

/**
 * Default price table (2026-08-16 DeepSeek V4 tier rates, USD per 1M tokens).
 * `deepseek-v4-flash-vision*` maps to the Flash rates so a vision-family model id
 * prices like its text sibling; every other model is unpriced until configured.
 */
export const DEFAULT_PRICES = {
	"deepseek-v4-flash": {
		peak: { input: 0.44, cacheRead: 0.014, cacheWrite: 0, output: 1.32 },
		valley: { input: 0.22, cacheRead: 0.007, cacheWrite: 0, output: 0.66 }
	},
	"deepseek-v4-pro": {
		peak: { input: 1.32, cacheRead: 0.044, cacheWrite: 0, output: 3.96 },
		valley: { input: 0.66, cacheRead: 0.022, cacheWrite: 0, output: 1.98 }
	},
	"deepseek-v4-flash-vision*": {
		peak: { input: 0.44, cacheRead: 0.014, cacheWrite: 0, output: 1.32 },
		valley: { input: 0.22, cacheRead: 0.007, cacheWrite: 0, output: 0.66 }
	}
};

/** Lowercase + trim a model id so matching is case/whitespace insensitive. */
export function normalizeModel(model) {
	if (typeof model !== "string") return "";
	return model.trim().toLowerCase();
}

/** Parse a single window into `[startMin, endMin]` minutes-of-day, or `[null, null]`. */
export function parseWindow(window) {
	if (Array.isArray(window)) {
		return [parseClock(window[0]), parseClock(window[1])];
	}
	if (typeof window === "string") {
		const [start, end] = String(window).split("-").map((s) => s.trim());
		return [parseClock(start), parseClock(end)];
	}
	return [null, null];
}

/** Parse `"HH:MM"` to minutes-of-day; `null` when unparseable. */
function parseClock(value) {
	if (typeof value !== "string") return null;
	const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
	if (!match) return null;
	const h = Number(match[1]);
	const m = Number(match[2]);
	if (h < 0 || h > 23 || m < 0 || m > 59) return null;
	return h * 60 + m;
}

/** Minutes-of-day in UTC for any Date-like value. */
function utcMinutes(date) {
	return date.getUTCHours() * 60 + date.getUTCMinutes();
}

/**
 * Is `date` inside any peak window? Applies `weekdaysOnly` (skip Sat/Sun) and
 * the half-open `[start, end)` rule; handles a window that wraps midnight.
 * @param {Date|number|string|undefined} date
 * @param {ReadonlyArray<readonly [string, string]>} windows
 * @param {boolean} weekdaysOnly
 */
export function isInPeak(date, windows, weekdaysOnly = true) {
	if (date == null) return false;
	const d = date instanceof Date ? date : new Date(date);
	if (Number.isNaN(d.getTime())) return false;
	if (weekdaysOnly) {
		const day = d.getUTCDay(); // 0=Sun … 6=Sat
		if (day === 0 || day === 6) return false;
	}
	const now = utcMinutes(d);
	const list = Array.isArray(windows) ? windows : [];
	for (const window of list) {
		const [start, end] = parseWindow(window);
		if (start == null || end == null) continue;
		if (end <= start) {
			// Midnight wrap: peak if past the start or before the end.
			if (now >= start || now < end) return true;
		} else if (now >= start && now < end) {
			return true;
		}
	}
	return false;
}

/**
 * Resolve a rate entry for a model id: exact normalized match first, then the
 * longest family prefix (a stored key, with a trailing `*` stripped for
 * matching, that prefixes the model id — e.g. `deepseek-v4-pro-0813` matches the
 * `deepseek-v4-pro` entry, and `deepseek-v4-flash-vision*` owns vision ids).
 * @param {Record<string, unknown>|undefined} prices
 * @param {string|undefined} model
 * @returns {{ peak: object, valley: object }|undefined}
 */
export function matchRate(prices, model) {
	const m = normalizeModel(model);
	if (!m || !prices || typeof prices !== "object") return undefined;
	if (Object.prototype.hasOwnProperty.call(prices, m)) return prices[m];
	let best;
	for (const key of Object.keys(prices)) {
		const base = key.endsWith("*") ? key.slice(0, -1) : key;
		if (!base) continue;
		if (!m.startsWith(base)) continue;
		if (!best || base.length > best.base.length) best = { base, rate: prices[key] };
	}
	return best ? best.rate : undefined;
}

/** Sanitize one `TokenUsage` into the four billed buckets (defaults to 0). */
export function tokenBuckets(usage) {
	if (!usage) return { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
	const n = (value) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
	return {
		input: n(usage.inputTokens),
		cacheRead: n(usage.cacheReadTokens),
		cacheWrite: n(usage.cacheWriteTokens),
		output: n(usage.outputTokens)
	};
}

/** Return a well-formed rate entry, or `undefined` if either tier is missing. */
export function coerceRate(rate) {
	if (!rate || typeof rate !== "object") return undefined;
	if (!rate.peak || !rate.valley || typeof rate.peak !== "object" || typeof rate.valley !== "object") return undefined;
	const tiers = (t) => ({
		input: Number(t.input) || 0,
		cacheRead: Number(t.cacheRead) || 0,
		cacheWrite: Number(t.cacheWrite) || 0,
		output: Number(t.output) || 0
	});
	return { peak: tiers(rate.peak), valley: tiers(rate.valley) };
}

/** Cost of one event's buckets at a rate tier, in dollars. */
function costOfBuckets(buckets, tier) {
	return (buckets.input * tier.input
		+ buckets.cacheRead * tier.cacheRead
		+ buckets.cacheWrite * tier.cacheWrite
		+ buckets.output * tier.output) / 1e6;
}

/**
 * Price a session's token usage, tiering each usage-bearing `assistant/message`
 * event into peak or valley by its own timestamp, all priced at one model.
 *
 * Reads the `SessionEvent` envelope `{ type, time, data }`; uses
 * `data.usage` (a `TokenUsage`) and, when `model` is not supplied,
 * `data.message.source.model` (the last one seen) as the pricing model.
 *
 * @param {ReadonlyArray<{ type: string, time: number, data?: any }>} events
 * @param {{ model?: string, prices?: Record<string, unknown>, peakWindows?: ReadonlyArray<readonly [string, string]>, weekdaysOnly?: boolean }} opts
 * @returns {{ cost: number, priced: boolean, model: string, totalTokens: number, tokens: { peak: number, valley: number, total: number }, count: number }}
 */
export function priceSession(events, opts = {}) {
	const prices = opts.prices || DEFAULT_PRICES;
	const peakWindows = opts.peakWindows || DEFAULT_PEAK_WINDOWS;
	const weekdaysOnly = opts.weekdaysOnly !== false;

	let model = normalizeModel(opts.model);
	if (!model) {
		const list = Array.isArray(events) ? events : [];
		for (let i = list.length - 1; i >= 0; i--) {
			const event = list[i];
			if (!event || event.type !== "assistant/message") continue;
			const source = event.data && event.data.message && event.data.message.source;
			if (source && source.model) {
				model = normalizeModel(source.model);
				break;
			}
		}
	}

	const matched = model ? matchRate(prices, model) : undefined;
	const rate = coerceRate(matched);
	const priced = !!rate;

	let cost = 0;
	let totalTokens = 0;
	let peakTokens = 0;
	let valleyTokens = 0;
	let count = 0;

	const list = Array.isArray(events) ? events : [];
	for (const event of list) {
		if (!event || event.type !== "assistant/message") continue;
		const data = event.data;
		const usage = data && data.usage;
		if (!usage) continue;

		const buckets = tokenBuckets(usage);
		const eventTokens = buckets.input + buckets.cacheRead + buckets.cacheWrite + buckets.output;
		const eventInPeak = isInPeak(event.time != null ? new Date(event.time) : null, peakWindows, weekdaysOnly);
		if (eventInPeak) {
			peakTokens += eventTokens;
			if (priced) cost += costOfBuckets(buckets, rate.peak);
		} else {
			valleyTokens += eventTokens;
			if (priced) cost += costOfBuckets(buckets, rate.valley);
		}
		totalTokens += eventTokens;
		count++;
	}

	return {
		cost,
		priced,
		model,
		totalTokens,
		tokens: { peak: peakTokens, valley: valleyTokens, total: totalTokens },
		count
	};
}
