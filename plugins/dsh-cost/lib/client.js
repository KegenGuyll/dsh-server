/*!
 * dsh-cost browser half — a lazy-CJS bundle served by the harness client module
 * system. It adds a live session-cost chip to the session header utilities strip
 * (`conversation.session.header.utilities`) with a hover/click breakdown, and a
 * Settings → Plugins → Cost card that edits the pricing schedule and per-model
 * rates.
 *
 * All cost computation runs on the host over the durable Connection RPC channel
 * (`ctx.connection.rpc.call('/rpc', ...)`); the browser only displays. The chip
 * reads the `tokenUsage` projection as a change signal (a frame-to-frame refresh
 * trigger) and re-prices on demand.
 *
 * The occupant components are defined inside `apply(ctx)` so they close over
 * `ctx` — the same pattern the sibling git-changes plugin uses for this exact
 * header seat — and receive the slot's standard props (`sessionId`,
 * `useProjection`) directly, without depending on an `inject` registration key.
 *
 * Unlike a dynamic closure, this is a durable page module, so `document` is a
 * real browser global here (used only for style injection).
 */
window.__ModuleLoader__.load({
	id: "dsh-cost",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		var React = require("react");

		/* Chip, breakdown popover, and settings-card styles. Colors ride the
		 * harness theme aliases so the surface matches the app in light/dark. */
		var STYLES = [
			".dsh-cost{position:relative;display:inline-flex;align-items:center;gap:4px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;height:28px;padding:2px 10px;font-size:12px;font-weight:500;color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family);background:var(--dsw-alias-bg-base);cursor:default;user-select:none;white-space:nowrap;line-height:20px;}",
			".dsh-cost:hover{border-color:var(--dsw-alias-border-l2);}",
			".dsh-cost[data-peak=\"true\"]{color:var(--dsw-alias-state-error-primary);border-color:rgba(255,90,60,.55);animation:dsh-cost-fire 1.5s ease-in-out infinite;}",
			".dsh-cost-fire{font-size:12px;line-height:1;width:1em;text-align:center;}",
			"@keyframes dsh-cost-fire{0%,100%{box-shadow:0 0 0 0 rgba(255,80,40,.4);}50%{box-shadow:0 0 9px 2px rgba(255,80,40,.55);}}",
			".dsh-cost-amount{min-width:0;}",
			".dsh-cost-pop{position:absolute;top:calc(100% + 8px);right:0;z-index:1000;min-width:230px;max-width:340px;background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:9px;box-shadow:0 8px 28px rgba(0,0,0,.35);padding:10px 12px;font-size:12px;font-family:var(--dsw-font-family);text-align:left;white-space:normal;}",
			".dsh-cost-pop h4{margin:0 0 6px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--dsw-alias-label-secondary);}",
			".dsh-cost-row{display:flex;justify-content:space-between;gap:12px;padding:2px 0;}",
			".dsh-cost-row .k{color:var(--dsw-alias-label-secondary);}",
			".dsh-cost-row .v{font-weight:600;font-family:var(--ds-font-family-code);}",
			".dsh-cost-note{margin-top:6px;font-size:11px;color:var(--dsw-alias-label-secondary);}",
			".dsh-cost-peak-now{color:var(--dsw-alias-state-error-primary);font-weight:700;margin-top:6px;font-size:11px;}",
			".dsh-cost-snap{display:flex;flex-direction:column;gap:10px;}",
			".dsh-cost-sfield{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--dsw-alias-label-secondary);}",
			".dsh-cost-sfield input[type=text],.dsh-cost-sfield input[type=number],.dsh-cost-sfield textarea{flex:1;box-sizing:border-box;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:7px;padding:5px 8px;font-size:12px;font-family:var(--ds-font-family-code);}",
			".dsh-cost-sfield textarea{min-height:74px;resize:vertical;line-height:1.4;}",
			".dsh-cost-sfield input:focus,.dsh-cost-sfield textarea:focus{outline:none;border-color:var(--dsw-alias-border-l2);}",
			".dsh-cost-sfield input[type=checkbox]{width:14px;height:14px;flex:none;}",
			".dsh-cost-sactions{display:flex;gap:8px;padding-top:4px;align-items:center;}",
			".dsh-cost-sbtn{background:transparent;color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:7px;padding:5px 12px;font:inherit;font-size:12px;cursor:pointer;}",
			".dsh-cost-sbtn:hover{background:rgba(128,128,128,.08);}",
			".dsh-cost-sbtn:disabled{opacity:.5;cursor:default;}",
			".dsh-cost-sstatus{font-size:12px;color:var(--dsw-alias-label-secondary);}",
			".dsh-cost-serr{color:var(--dsw-alias-state-error-primary);}"
		].join("\n");

		function injectStyles() {
			if (typeof document === "undefined" || document.getElementById("dsh-cost-style")) return;
			var el = document.createElement("style");
			el.id = "dsh-cost-style";
			el.textContent = STYLES;
			document.head.appendChild(el);
		}
		injectStyles();

		/** Required client services (Cordis fibre inject). */
		var inject = ["slots"];

		/** Bound client→host caller over the generic Connection RPC channel. */
		function hostCall(ctx, method, args) {
			var rpc = ctx.get("connection") && ctx.get("connection").rpc;
			if (!rpc || typeof rpc.call !== "function") {
				return Promise.reject(new Error("Cost host channel is unavailable"));
			}
			return rpc.call("/rpc", method, args).then(function (result) {
				if (result && result.ok) return result.value;
				var message = (result && result.error && result.error.message) || "Cost request failed";
				throw new Error(message);
			});
		}

		/** Format an amount with a currency prefix and bounded precision. */
		function dollar(value, currency, precision) {
			var p = Math.max(0, Math.min(6, Number(precision) || 4));
			return (currency || "$") + (Number(value) || 0).toFixed(p);
		}

		/** Group a token count with thousands separators. */
		function thousands(value) {
			var n = Math.max(0, Math.round(Number(value) || 0));
			return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
		}

		/** One tier's rates as a compact "priced per 1M tokens" line. */
		function tierRateText(peak) {
			if (!peak) return null;
			return "in " + peak.input + " · cacheRead " + peak.cacheRead + " · cacheWrite " + peak.cacheWrite + " · out " + peak.output;
		}

		/** Render the breakdown popover from a `cost/session` payload. */
		function Breakdown({ data, currency, precision }) {
			if (!data) return null;
			var tokens = data.tokens || { peak: 0, valley: 0, total: 0 };
			var model = data.model || "unknown model";
			var unpriced = data.priced === false;
			return React.createElement("div", { className: "dsh-cost-pop" },
				React.createElement("h4", null, "Session cost"),
				React.createElement("div", { className: "dsh-cost-row" },
					React.createElement("span", { className: "k" }, "Since"),
					React.createElement("span", { className: "v" }, dollar(data.cost, currency, precision))),
				React.createElement("div", { className: "dsh-cost-row" },
					React.createElement("span", { className: "k" }, "Model"),
					React.createElement("span", { className: "v" }, model)),
				React.createElement("div", { className: "dsh-cost-row" },
					React.createElement("span", { className: "k" }, "Peak tokens"),
					React.createElement("span", { className: "v" }, thousands(tokens.peak))),
				React.createElement("div", { className: "dsh-cost-row" },
					React.createElement("span", { className: "k" }, "Valley tokens"),
					React.createElement("span", { className: "v" }, thousands(tokens.valley))),
				React.createElement("div", { className: "dsh-cost-row" },
					React.createElement("span", { className: "k" }, "Total tokens"),
					React.createElement("span", { className: "v" }, thousands(tokens.total))),
				unpriced
					? React.createElement("div", { className: "dsh-cost-note" }, "Model has no price configured — tokens shown, cost unbilled.")
					: data.rates
						? React.createElement("div", { className: "dsh-cost-note" },
							React.createElement("div", null, "Peak (per 1M): " + tierRateText(data.rates.peak)),
							React.createElement("div", null, "Valley (per 1M): " + tierRateText(data.rates.valley)))
						: null,
				data.nowIsPeak
					? React.createElement("div", { className: "dsh-cost-peak-now" }, "\u{1F525} Peak window now" + (Array.isArray(data.peakWindows) && data.peakWindows.length ? " (" + data.peakWindows.map(function (w) { return w[0] + "\u2013" + w[1]; }).join(", ") + " UTC)" : ""))
					: React.createElement("div", { className: "dsh-cost-note" }, data.weekdaysOnly ? "Weekday off-peak (weekends valley)" : "Off-peak"));
		}

		/** Plugin body: build the chip + settings card and register them. */
		function apply(ctx) {
			var costOf = function (sid) { return hostCall(ctx, "cost/session", { sessionId: sid }); };
			var settingsScope = ctx.get("settingsScope");

			/** The session cost chip occupant of the header utilities strip. */
			function CostChip(props) {
				var sessionId = props && props.sessionId;
				var useProjection = props && props.useProjection;
				var usage = useProjection ? useProjection("tokenUsage") : undefined;

				var dataState = React.useState(null);
				var data = dataState[0];
				var setData = dataState[1];
				var errState = React.useState(false);
				var error = errState[0];
				var setError = errState[1];
				var openState = React.useState(false);
				var open = openState[0];
				var setOpen = openState[1];

				/* Re-price on a tokenUsage change or a session switch, debounced
				 * ~250 ms. `costOf` is stable per apply() so it is safe to close
				 * over but we keep it out of the deps anyway (identity is ours). */
				React.useEffect(function () {
					var cancelled = false;
					if (typeof costOf !== "function" || !sessionId) return undefined;
					var timer = setTimeout(function () {
						costOf(sessionId).then(function (res) {
							if (cancelled) return;
							setData(res);
							setError(false);
						}).catch(function () {
							if (cancelled) return;
							setError(true);
						});
					}, 250);
					return function () { cancelled = true; clearTimeout(timer); };
					/* eslint-disable-line react-hooks/exhaustive-deps */
				}, [sessionId, usage]);

				if (data && data.enabled === false) return null; // disabled via Settings

				var total = data ? data.totalTokens : 0;
				var text;
				if (error) text = "\u2014"; // RPC/command unavailable — never break the header
				else if (!data) text = "\u2026";
				else if (data.priced === false && total > 0) text = thousands(total) + " \u2014";
				else text = dollar(data.cost, data.currency, data.precision);

				var peak = !!(data && data.nowIsPeak);
				var currency = data ? data.currency : "$";
				var precision = data ? data.precision : 4;

				return React.createElement("div", {
					className: "dsh-cost",
					"data-peak": peak ? "true" : "false",
					title: "Session cost",
					onClick: function () { setOpen(!open); },
					onMouseEnter: function () { setOpen(true); },
					onMouseLeave: function () { setOpen(false); }
				},
					peak ? React.createElement("span", { className: "dsh-cost-fire", title: "Peak window" }, "\u{1F525}") : null,
					React.createElement("span", { className: "dsh-cost-amount" }, text),
					open ? React.createElement(Breakdown, { data: data, currency: currency, precision: precision }) : null);
			}

			/** Settings → Plugins → Cost card: edit schedule + per-model rates. */
			function CostSettingsCard(props) {
				var scope = settingsScope && settingsScope.bind ? settingsScope.bind({ ns: "cost" }) : null;

				var enabledState = React.useState(true);
				var enabled = enabledState[0];
				var setEnabled = enabledState[1];
				var weekdaysOnlyState = React.useState(true);
				var weekdaysOnly = weekdaysOnlyState[0];
				var setWeekdaysOnly = weekdaysOnlyState[1];
				var precisionState = React.useState(4);
				var precision = precisionState[0];
				var setPrecision = precisionState[1];
				var currencyState = React.useState("$");
				var currency = currencyState[0];
				var setCurrency = currencyState[1];
				var windowsState = React.useState("");
				var windows = windowsState[0];
				var setWindows = windowsState[1];
				var pricesState = React.useState("");
				var pricesJson = pricesState[0];
				var setPricesJson = pricesState[1];
				var pricingUrlState = React.useState("");
				var pricingUrl = pricingUrlState[0];
				var setPricingUrl = pricingUrlState[1];
				var statusState = React.useState("");
				var status = statusState[0];
				var setStatus = statusState[1];
				var busyState = React.useState(false);
				var busy = busyState[0];
				var setBusy = busyState[1];

				function refresh() {
					if (!scope) { setStatus("Settings channel unavailable"); return; }
					var snap = scope.getSnapshot();
					setEnabled(!!(snap && snap.enabled !== false));
					setWeekdaysOnly(!!(snap && snap.weekdaysOnly !== false));
					setPrecision(snap ? Number(snap.precision) : 4);
					setCurrency(snap ? (snap.currency || "$") : "$");
					setWindows(JSON.stringify(snap && snap.peakWindows ? snap.peakWindows : [], null, 2));
					setPricesJson(JSON.stringify(snap && snap.prices ? snap.prices : {}, null, 2));
					setPricingUrl(snap ? (snap.pricingUrl || "") : "");
				}

				React.useEffect(function () {
					if (!scope) { setStatus("Settings channel unavailable"); return; }
					refresh();
					var unsub = scope.subscribe && scope.subscribe(function () { refresh(); });
					return function () { if (unsub) unsub(); };
					/* eslint-disable-line react-hooks/exhaustive-deps */
				}, []);

				function save() {
					if (!scope) return;
					setBusy(true);
					setStatus("");
					try {
						var parsedWindows = JSON.parse(windows || "[]");
						var parsedPrices = JSON.parse(pricesJson || "{}");
						if (!Array.isArray(parsedWindows)) throw new Error("peakWindows must be an array of [start, end]");
						scope.set("enabled", enabled);
						scope.set("weekdaysOnly", weekdaysOnly);
						scope.set("precision", Math.max(0, Math.min(6, Number(precision) || 4)));
						scope.set("currency", currency || "$");
						scope.set("peakWindows", parsedWindows);
						scope.set("prices", parsedPrices);
						scope.set("pricingUrl", pricingUrl);
						setStatus("Saved");
					} catch (err) {
						setStatus("Invalid JSON: " + String((err && err.message) || err));
					}
					setBusy(false);
				}

				var field = function (labelText) {
					var rest = Array.prototype.slice.call(arguments, 1);
					return React.createElement("label", { className: "dsh-cost-sfield" }, [labelText].concat(rest));
				};

				return React.createElement("div", { className: "dsh-cost-snap" },
					field(null,
						React.createElement("input", { type: "checkbox", checked: enabled, onChange: function (e) { setEnabled(e.target.checked); } }),
						" Enabled"),
					field(null,
						React.createElement("input", { type: "checkbox", checked: weekdaysOnly, onChange: function (e) { setWeekdaysOnly(e.target.checked); } }),
						" Peak windows on weekdays only (weekends valley)"),
					field("Currency",
						React.createElement("input", { type: "text", value: currency, onChange: function (e) { setCurrency(e.target.value); } })),
					field("Precision (decimals)",
						React.createElement("input", { type: "number", min: 0, max: 6, step: 1, value: precision, onChange: function (e) { setPrecision(e.target.value); } })),
					field("Peak windows (UTC, [start, end])",
						React.createElement("textarea", { value: windows, onChange: function (e) { setWindows(e.target.value); } })),
					field("Prices (per model, per 1M tokens)",
						React.createElement("textarea", { value: pricesJson, onChange: function (e) { setPricesJson(e.target.value); } })),
					field("Pricing page URL (optional)",
						React.createElement("input", { type: "text", value: pricingUrl, onChange: function (e) { setPricingUrl(e.target.value); } })),
					React.createElement("div", { className: "dsh-cost-sactions" },
						React.createElement("button", { className: "dsh-cost-sbtn", disabled: busy, onClick: save }, busy ? "Saving\u2026" : "Save"),
						status ? React.createElement("span", { className: "dsh-cost-sstatus" }, status) : null));
			}

			ctx.slots.inject("conversation.session.header.utilities", function () {
				return ctx.slots.register(
					{ name: "conversation.session.header.utilities", id: "cost", order: 2, label: "Cost" },
					CostChip
				);
			});

			ctx.slots.inject("settings.plugin.item", function () {
				return ctx.slots.register(
					{ name: "settings.plugin.item", key: "cost", locale: "cost" },
					CostSettingsCard
				);
			});
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
