/*!
 * dsh-notify browser half — a lazy-CJS bundle served by the harness client
 * module system. It renders the Settings -> Plugins -> Notify card (ntfy topic,
 * toggles, token write/clear, a Send-test button) and reports page visibility to
 * the host so "done" pings are suppressed while you are actually looking at DSH.
 *
 * All ntfy delivery runs on the host (the access token never crosses the wire);
 * the client calls the host through the generic Connection RPC channel
 * (`ctx.connection.rpc.call('/rpc', method, args)`), whose handlers live in
 * lib/index.js. It reads the `notify` settings namespace for the scalar config
 * fields (edits are batched behind a Save button, matching dsh-github).
 */

window.__ModuleLoader__.load({
	id: "dsh-notify",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		var React = require("react");

		/* Package-owned stylesheet, injected once on load. Kept lean and themed
		 * with the harness alias tokens so the card matches the other plugins'
		 * settings cards. */
		var STYLE_ID = "dsh-notify-style";
		var STYLES = [
			".dsh-notify-card{background:#242429;color:#e6e6e8;border:1px solid rgba(255,255,255,.09);border-radius:10px;min-width:224px;padding:6px;display:flex;flex-direction:column;gap:2px;font:inherit;}",
			".dsh-notify-status{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#8f8f98;padding:8px 10px 6px;}",
			".dsh-notify-status .dsh-notify-detail{font-weight:400;text-transform:none;letter-spacing:0;}",
			".dsh-notify-field{display:flex;flex-direction:column;gap:4px;padding:6px 10px;font-size:12px;color:#8f8f98;}",
			".dsh-notify-check{display:flex;align-items:center;gap:6px;padding:6px 10px;font-size:12px;color:#8f8f98;}",
			".dsh-notify-field input[type=text],.dsh-notify-field input[type=password],.dsh-notify-field input[type=number]{padding:6px 8px;border:1px solid rgba(255,255,255,.14);border-radius:7px;background:#1c1c21;color:#e6e6e8;font:inherit;}",
			".dsh-notify-actions{display:flex;flex-wrap:wrap;gap:8px;padding:8px 10px 4px;}",
			".dsh-notify-btn{background:#3b82f6;color:#fff;border:0;border-radius:7px;padding:7px 12px;font:inherit;font-size:12px;cursor:pointer;}",
			".dsh-notify-btn:disabled{opacity:.6;cursor:default;}",
			".dsh-notify-btn2{background:transparent;border:1px solid rgba(255,255,255,.14);border-radius:7px;padding:7px 12px;color:#e6e6e8;font:inherit;font-size:12px;cursor:pointer;}"
		].join("\n");

		function injectStyles() {
			if (typeof document === "undefined" || document.getElementById(STYLE_ID)) return;
			var el = document.createElement("style");
			el.id = STYLE_ID;
			el.textContent = STYLES;
			document.head.appendChild(el);
		}
		injectStyles();

		/** Required client services (Cordis fibre inject). */
		var inject = ["slots"];

		/** Bound client -> host caller over the generic Connection RPC channel. */
		function hostCall(ctx, method, args) {
			var rpc = ctx.get("connection")?.rpc;
			if (!rpc || typeof rpc.call !== "function") {
				return Promise.reject(new Error("Notify host channel is unavailable"));
			}
			return rpc.call("/rpc", method, args).then(function (result) {
				if (result && result.ok) return result.value;
				var message = (result && result.error && result.error.message) || "Notify request failed";
				throw new Error(message);
			});
		}

		/** Read a settings namespace snapshot as a flat object. */
		function flatOf(snap) {
			if (!snap) return {};
			if (typeof snap.getSnapshot === "function") return snap.getSnapshot() || {};
			return snap || {};
		}

		/**
		 * Settings -> Plugins -> Notify card. Edits are held in local state and
		 * committed with Save (batched writes), mirroring dsh-github; the token
		 * and Send test go through the host RPC.
		 */
		function NotifySettingsCard(props) {
			var getStatus = props.getStatus;
			var setToken = props.setToken;
			var clearToken = props.clearToken;
			var sendTest = props.sendTest;
			var settingsScope = props.settingsScope;

			var scope = settingsScope && settingsScope.bind ? settingsScope.bind({ ns: "notify" }) : null;

			var baseState = React.useState({});
			var base = baseState[0];
			var setBase = baseState[1];
			var formState = React.useState({});
			var form = formState[0];
			var setForm = formState[1];
			var statusState = React.useState({ configured: false, tokenSet: false });
			var status = statusState[0];
			var setStatus = statusState[1];
			var tokenState = React.useState("");
			var tokenInput = tokenState[0];
			var setTokenInput = tokenState[1];
			var noticeState = React.useState("");
			var notice = noticeState[0];
			var setNotice = noticeState[1];
			var busyState = React.useState(false);
			var busy = busyState[0];
			var setBusy = busyState[1];

			function applyBase(snap) {
				var f = flatOf(snap);
				setBase(f);
				setForm({
					enabled: f.enabled !== false,
					topicUrl: f.topicUrl || "",
					titlePrefix: f.titlePrefix || "DSH",
					notifyDone: f.notifyDone !== false,
					notifyInput: f.notifyInput !== false,
					minDoneSeconds: f.minDoneSeconds === undefined ? 60 : f.minDoneSeconds,
					cooldownSeconds: f.cooldownSeconds === undefined ? 30 : f.cooldownSeconds,
					suppressWhenVisible: f.suppressWhenVisible !== false
				});
			}

			React.useEffect(function () {
				if (!scope) { setNotice("Settings channel unavailable"); return; }
				applyBase(scope.getSnapshot ? scope.getSnapshot() : null);
				getStatus().then(function (s) {
					setStatus({ configured: !!s.configured, tokenSet: !!s.tokenSet });
				}).catch(function () {
					setStatus({ configured: false, tokenSet: false });
				});
				var unsub = scope.subscribe && scope.subscribe(function () { applyBase(scope.getSnapshot ? scope.getSnapshot() : null); });
				return function () { if (unsub) unsub(); };
				/* eslint-disable-line react-hooks/exhaustive-deps */
			}, []);

			function update(key) {
				return function (e) {
					var value = e && e.target ? e.target.value : e;
					setForm(function (prev) {
						var next = Object.assign({}, prev);
						next[key] = value;
						return next;
					});
				};
			}

			function toggle(key) {
				return function (e) {
					var checked = !!(e && e.target ? e.target.checked : e);
					setForm(function (prev) {
						var next = Object.assign({}, prev);
						next[key] = checked;
						return next;
					});
				};
			}

			function save() {
				if (!scope || typeof scope.set !== "function") { setNotice("Settings channel unavailable"); return; }
				setBusy(true); setNotice("");
				var writes = [];
				if (form.topicUrl !== base.topicUrl) writes.push(scope.set("topicUrl", form.topicUrl));
				if (form.titlePrefix !== base.titlePrefix) writes.push(scope.set("titlePrefix", form.titlePrefix));
				if (form.enabled !== (base.enabled !== false)) writes.push(scope.set("enabled", form.enabled));
				if (form.notifyDone !== (base.notifyDone !== false)) writes.push(scope.set("notifyDone", form.notifyDone));
				if (form.notifyInput !== (base.notifyInput !== false)) writes.push(scope.set("notifyInput", form.notifyInput));
				if (form.minDoneSeconds !== base.minDoneSeconds) writes.push(scope.set("minDoneSeconds", form.minDoneSeconds));
				if (form.cooldownSeconds !== base.cooldownSeconds) writes.push(scope.set("cooldownSeconds", form.cooldownSeconds));
				if (form.suppressWhenVisible !== (base.suppressWhenVisible !== false)) writes.push(scope.set("suppressWhenVisible", form.suppressWhenVisible));
				var tokenSave = tokenInput.trim() ? setToken({ value: tokenInput.trim() }) : Promise.resolve();
				Promise.all(writes.concat([tokenSave])).then(function () {
					setTokenInput(""); setNotice("Saved");
					return getStatus().then(function (s) { setStatus({ configured: !!s.configured, tokenSet: !!s.tokenSet }); }).catch(function () {});
				}).catch(function (err) { setNotice(String(err && err.message || err)); }).then(function () { setBusy(false); });
			}

			function onTest() {
				setBusy(true); setNotice("");
				sendTest().then(function () { setNotice("Test push sent"); })
					.catch(function (err) { setNotice("Test failed: " + String(err && err.message || err)); })
					.then(function () { setBusy(false); });
			}

			function onClearToken() {
				setBusy(true); setNotice("");
				clearToken().then(function () {
					setStatus({ configured: status.configured, tokenSet: false });
					setNotice("Token cleared");
				}).catch(function (err) { setNotice(String(err && err.message || err)); }).then(function () { setBusy(false); });
			}

			return React.createElement("div", { className: "dsh-notify-card" },
				React.createElement("div", { className: "dsh-notify-status" },
					"Notify",
					notice
						? React.createElement("span", { className: "dsh-notify-detail" }, " (" + notice + ")")
						: status.tokenSet
							? React.createElement("span", { className: "dsh-notify-detail" }, " · token set · " + (status.configured ? "topic configured" : "no topic"))
							: null),
				React.createElement("label", { className: "dsh-notify-field" },
					"ntfy topic URL (e.g. https://ntfy.sh/dsh-mytopic)",
					React.createElement("input", {
						type: "text", value: form.topicUrl || "", placeholder: "https://ntfy.sh/dsh-…",
						onChange: update("topicUrl")
					})),
				React.createElement("label", { className: "dsh-notify-field" },
					"Title prefix",
					React.createElement("input", { type: "text", value: form.titlePrefix || "DSH", onChange: update("titlePrefix") })),
				React.createElement("div", { className: "dsh-notify-check" },
					React.createElement("input", { type: "checkbox", checked: form.enabled !== false, onChange: toggle("enabled") }),
					" Enabled"),
				React.createElement("div", { className: "dsh-notify-check" },
					React.createElement("input", { type: "checkbox", checked: form.notifyDone !== false, onChange: toggle("notifyDone") }),
					" Ping when a task completes"),
				React.createElement("div", { className: "dsh-notify-check" },
					React.createElement("input", { type: "checkbox", checked: form.notifyInput !== false, onChange: toggle("notifyInput") }),
					" Ping when input is needed"),
				React.createElement("label", { className: "dsh-notify-field" },
					"Min run seconds before a done ping",
					React.createElement("input", { type: "number", value: form.minDoneSeconds, onChange: update("minDoneSeconds") })),
				React.createElement("label", { className: "dsh-notify-field" },
					"Cooldown (s) between pings",
					React.createElement("input", { type: "number", value: form.cooldownSeconds, onChange: update("cooldownSeconds") })),
				React.createElement("div", { className: "dsh-notify-check" },
					React.createElement("input", { type: "checkbox", checked: form.suppressWhenVisible !== false, onChange: toggle("suppressWhenVisible") }),
					" Stay quiet while you're looking at DSH"),
				React.createElement("label", { className: "dsh-notify-field" },
					"ntfy access token (optional)",
					React.createElement("input", {
						type: "password", value: tokenInput, placeholder: status.tokenSet ? "•••••••• (leave blank to keep)" : "tk_…",
						onChange: function (e) { setTokenInput(e.target.value); }
					})),
				React.createElement("div", { className: "dsh-notify-actions" },
					React.createElement("button", { className: "dsh-notify-btn", disabled: busy, onClick: onTest }, busy ? "Sending…" : "Send test"),
					React.createElement("button", { className: "dsh-notify-btn2", disabled: busy, onClick: save }, "Save"),
					status.tokenSet
						? React.createElement("button", { className: "dsh-notify-btn2", disabled: busy, onClick: onClearToken }, "Clear token")
						: null));
		}

		/**
		 * Plugin body: report page visibility to the host (done-ping
		 * suppression) and register the Settings -> Plugins -> Notify card.
		 */
		function apply(ctx) {
			// Page visibility heartbeat -> host. Best-effort; the host uses the
			// most recent "visible" report to suppress done-pings while the user
			// is actually looking at DSH.
			if (typeof document !== "undefined") {
				var report = function () {
					var visible = document.visibilityState === "visible";
					hostCall(ctx, "notify/visible", { visible: visible }).catch(function () { /* ignore */ });
				};
				document.addEventListener("visibilitychange", report);
				document.addEventListener("focus", report);
				document.addEventListener("blur", report);
				report();
			}

			var injected = {
				getStatus: function () { return hostCall(ctx, "notify/status", {}); },
				setToken: function (args) { return hostCall(ctx, "notify/set-token", args); },
				clearToken: function () { return hostCall(ctx, "notify/clear-token", {}); },
				sendTest: function () { return hostCall(ctx, "notify/test", {}); },
				settingsScope: ctx.get("settingsScope")
			};

			ctx.slots.inject("settings.plugin.item", function () {
				return ctx.slots.register({
					name: "settings.plugin.item",
					key: "notify",
					locale: "notify",
					inject: injected
				}, NotifySettingsCard);
			});
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
