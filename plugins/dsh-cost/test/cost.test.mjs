/**
 * Unit tests for the dsh-cost pricing core (lib/cost.js).
 * Run with `node --test test/cost.test.mjs` from the plugin directory.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	DEFAULT_PEAK_WINDOWS,
	DEFAULT_PRICES,
	isInPeak,
	parseWindow,
	matchRate,
	tokenBuckets,
	priceSession
} from "../lib/cost.js";

/** Build a synthetic assistant/message session event. */
function assistantEvent(iso, usage, model = "deepseek-v4-flash") {
	return {
		type: "assistant/message",
		seq: 1,
		time: Date.parse(iso),
		data: {
			turn: 1,
			step: 1,
			message: { source: { kind: "model", provider: "deepseek", model } },
			usage
		}
	};
}

test("parseWindow handles array and dashed-string forms", () => {
	assert.deepEqual(parseWindow(["01:00", "04:00"]), [60, 240]);
	assert.deepEqual(parseWindow("06:00-10:00"), [360, 600]);
	assert.deepEqual(parseWindow(["bad", "04:00"]), [null, 240]);
});

test("isInPeak: weekday inside a peak window is peak", () => {
	// 2026-08-19 is a Wednesday.
	assert.equal(isInPeak(new Date("2026-08-19T02:00:00Z"), DEFAULT_PEAK_WINDOWS), true);
	assert.equal(isInPeak(new Date("2026-08-19T07:00:00Z"), DEFAULT_PEAK_WINDOWS), true);
});

test("isInPeak: half-open boundaries — 01:00 in, 04:00/10:00 out", () => {
	assert.equal(isInPeak(new Date("2026-08-19T01:00:00Z"), DEFAULT_PEAK_WINDOWS), true);
	assert.equal(isInPeak(new Date("2026-08-19T04:00:00Z"), DEFAULT_PEAK_WINDOWS), false);
	assert.equal(isInPeak(new Date("2026-08-19T10:00:00Z"), DEFAULT_PEAK_WINDOWS), false);
	assert.equal(isInPeak(new Date("2026-08-19T05:59:00Z"), DEFAULT_PEAK_WINDOWS), false);
});

test("isInPeak: weekend is off-peak by default, in-peak when weekdaysOnly=false", () => {
	// 2026-08-16 is a Sunday.
	assert.equal(isInPeak(new Date("2026-08-16T02:00:00Z"), DEFAULT_PEAK_WINDOWS), false);
	assert.equal(isInPeak(new Date("2026-08-16T02:00:00Z"), DEFAULT_PEAK_WINDOWS, false), true);
});

test("isInPeak: midnight-wrap window (end <= start)", () => {
	const wrap = [["22:00", "02:00"]];
	assert.equal(isInPeak(new Date("2026-08-19T23:00:00Z"), wrap), true); // after start, before midnight
	assert.equal(isInPeak(new Date("2026-08-19T01:00:00Z"), wrap), true); // before end (wrap)
	assert.equal(isInPeak(new Date("2026-08-19T12:00:00Z"), wrap), false);
});

test("isInPeak: invalid date is off-peak", () => {
	assert.equal(isInPeak(null, DEFAULT_PEAK_WINDOWS), false);
	assert.equal(isInPeak(new Date("nope"), DEFAULT_PEAK_WINDOWS), false);
});

test("matchRate resolves exact model", () => {
	const flash = matchRate(DEFAULT_PRICES, "deepseek-v4-flash");
	assert.ok(flash);
	assert.equal(flash.peak.input, 0.44);
});

test("matchRate resolves date-suffixed family prefix", () => {
	const pro = matchRate(DEFAULT_PRICES, "deepseek-v4-pro-0813");
	assert.ok(pro);
	assert.equal(pro.peak.input, 1.32);
	const flash = matchRate(DEFAULT_PRICES, "deepseek-v4-flash-0813");
	assert.equal(flash.peak.output, 1.32);
});

test("matchRate maps the vision family to Flash rates", () => {
	const vision = matchRate(DEFAULT_PRICES, "deepseek-v4-flash-vision-exp");
	assert.ok(vision);
	assert.equal(vision.peak.input, 0.44);
	assert.equal(vision.valley.output, 0.66);
});

test("matchRate is case/whitespace insensitive", () => {
	const m = matchRate(DEFAULT_PRICES, "  DeepSeek-V4-Flash  ");
	assert.ok(m);
	assert.ok(matchRate(DEFAULT_PRICES, "DEEPSEEK-V4-PRO"));
});

test("matchRate returns undefined for an unknown model", () => {
	assert.equal(matchRate(DEFAULT_PRICES, "some-other-model"), undefined);
});

test("tokenBuckets defaults missing fields to zero", () => {
	assert.deepEqual(tokenBuckets(undefined), { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 });
	assert.deepEqual(tokenBuckets({ inputTokens: 10, outputTokens: 5 }), { input: 10, cacheRead: 0, cacheWrite: 0, output: 5 });
});

test("priceSession prices a peak+valley split at the current model", () => {
	const events = [
		assistantEvent("2026-08-19T02:00:00Z", { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 500, cacheWriteTokens: 10 }),
		assistantEvent("2026-08-19T12:00:00Z", { inputTokens: 2000, outputTokens: 300 })
	];
	const result = priceSession(events, { model: "deepseek-v4-flash", prices: DEFAULT_PRICES, peakWindows: DEFAULT_PEAK_WINDOWS, weekdaysOnly: true });
	assert.equal(result.priced, true);
	assert.equal(result.model, "deepseek-v4-flash");
	assert.equal(result.count, 2);
	assert.equal(result.totalTokens, 1710 + 2300);
	assert.deepEqual(result.tokens, { peak: 1710, valley: 2300, total: 4010 });
	// peak cost = (1000*0.44 + 500*0.014 + 10*0 + 200*1.32)/1e6
	// valley cost = (2000*0.22 + 0 + 0 + 300*0.66)/1e6
	const expected = (1000 * 0.44 + 500 * 0.014 + 200 * 1.32) / 1e6 + (2000 * 0.22 + 300 * 0.66) / 1e6;
	assert.ok(Math.abs(result.cost - expected) < 1e-12, `expected ${expected}, got ${result.cost}`);
});

test("priceSession derives the model from message.source.model when none is given", () => {
	const events = [
		assistantEvent("2026-08-19T12:00:00Z", { inputTokens: 2500, outputTokens: 500 }, "deepseek-v4-pro")
	];
	const result = priceSession(events, { prices: DEFAULT_PRICES, peakWindows: DEFAULT_PEAK_WINDOWS, weekdaysOnly: true });
	assert.equal(result.model, "deepseek-v4-pro");
	assert.equal(result.priced, true);
	// valley cost = (2500*0.66 + 500*1.98)/1e6 = (1650 + 990)/1e6 = 0.002640
	assert.ok(Math.abs(result.cost - 0.002640) < 1e-12);
});

test("priceSession: unknown model reports priced=false but still counts tokens", () => {
	const events = [
		assistantEvent("2026-08-19T02:00:00Z", { inputTokens: 100, outputTokens: 20 }, "deepseek-unknown")
	];
	const result = priceSession(events, { prices: DEFAULT_PRICES, peakWindows: DEFAULT_PEAK_WINDOWS, weekdaysOnly: true });
	assert.equal(result.model, "deepseek-unknown");
	assert.equal(result.priced, false);
	assert.equal(result.cost, 0);
	assert.equal(result.totalTokens, 120);
});

test("priceSession: empty/usage-free events are a zero-cost, priced session", () => {
	const result = priceSession([], { model: "deepseek-v4-flash", prices: DEFAULT_PRICES, peakWindows: DEFAULT_PEAK_WINDOWS, weekdaysOnly: true });
	assert.equal(result.count, 0);
	assert.equal(result.cost, 0);
	assert.equal(result.totalTokens, 0);
	assert.equal(result.priced, true);
});
