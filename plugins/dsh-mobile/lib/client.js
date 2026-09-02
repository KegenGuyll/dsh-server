/*!
 * dsh-mobile browser half — a lazy-CJS bundle served by the harness client
 * module system. It adds a Gemini-style mobile skin to the web UI:
 *
 *   - A floating top bar (menu button top-left, workspace/brand label center,
 *     New Session button top-right) rendered from the frame-wide
 *     `shell.overlay` seat, shown only at mobile widths.
 *   - Tapping the menu button opens a lightweight custom drawer (its own
 *     workspace -> session list; this is NOT the shipped sidebar browser) with
 *     a translucent backdrop that dismisses it.
 *   - The shipped left sidebar and session header are hidden on mobile via
 *     injected CSS (the AppFrame grid is collapsed), and the prompt bar is left
 *     untouched.
 *
 * Everything runs on the client: session/workspace actions use the existing
 * Client services (`ctx.get("workspaces").startSession(...)`,
 * `ctx.get("sessions").open(id)`), so there is no host logic and no RPC.
 */

window.__ModuleLoader__.load({
	id: "dsh-mobile",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		var React = require("react");

		/* Package-owned stylesheet, injected once on load and removed on dispose.
		 * The bundle cannot use the dynamic `styles` builtin, so it mirrors the
		 * dsh-github style-tag technique. The mobile-only rules collapse the
		 * AppFrame grid (hide sidebar + details) and the session header; the
		 * desktop media query hides the floating UI entirely, so desktop is
		 * unaffected. */
		var STYLE_ID = "dsh-mobile-style";
		var STYLES = [
			"@media (max-width: 768px) {",
			"  /* Collapse the AppFrame sidebar + details tracks on mobile. */",
			"  :has(> [data-shell-overlay]) { grid-template-columns: 0 minmax(0, 1fr) 0 !important; }",
			"  /* Reserve space for the fixed top bar by padding the conversation root",
			"     (box-sizing keeps its height:100% intact so the composer isn't pushed off).",
			"     Scope it with :has(> [data-conversation-scroll]) so the SELECTOR ONLY matches",
			"     the conversation root -- the raw [data-phase] also matches the composer",
			"     <textarea> (it carries data-phase = input phase), which would give the",
			"     textarea an extra 53px top padding and push the backdrop text above the caret. */",
			"  [data-phase]:has(> [data-conversation-scroll]) { padding-top: 53px !important; box-sizing: border-box !important; }",
			"}",
			".dsh-mobile-root{position:fixed;inset:0;z-index:1000;pointer-events:none;",
			"  --dshm-bg:#151517;--dshm-bar:#1b1b1c;--dshm-overlay:#232324;--dshm-text:#e6e6e8;--dshm-dim:#9aa0a6;",
			"  --dshm-border:rgba(255,255,255,.09);--dshm-hover:rgba(255,255,255,.07);--dshm-accent:#4d93f8;}",
			".dsh-mobile-root[data-dsh-theme=light]{",
			"  --dshm-bg:#ffffff;--dshm-bar:#f5f6f7;--dshm-overlay:#ececef;--dshm-text:#1b1b1f;--dshm-dim:#6b6b73;",
			"  --dshm-border:rgba(0,0,0,.12);--dshm-hover:rgba(0,0,0,.06);--dshm-accent:#2563eb;}",
			".dsh-mobile-topbar{pointer-events:auto;display:flex;align-items:center;gap:8px;height:52px;padding:0 10px;background:var(--dshm-bar);border-bottom:1px solid var(--dshm-border);}",
			".dsh-mobile-btn{pointer-events:auto;display:grid;place-items:center;width:36px;height:36px;border:none;border-radius:999px;background:transparent;color:var(--dshm-text);font-size:18px;cursor:pointer;flex:none;}",
			".dsh-mobile-btn:active{background:var(--dshm-hover);}",
			".dsh-mobile-label{flex:1;min-width:0;text-align:center;font-size:16px;font-weight:500;color:var(--dshm-text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}",
			".dsh-mobile-backdrop{pointer-events:auto;position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:1001;}",
			".dsh-mobile-drawer-wrap{pointer-events:auto;position:fixed;top:0;left:0;bottom:0;width:min(84vw,320px);z-index:1002;}",
			".dsh-mobile-drawer{position:absolute;top:0;left:0;bottom:0;width:min(84vw,320px);background:var(--dshm-overlay);color:var(--dshm-text);padding:10px 14px 20px 12px;overflow-y:auto;box-shadow:var(--dsw-shadow-lv2);}",
			".dsh-mobile-search{box-sizing:border-box;pointer-events:auto;display:flex;align-items:center;gap:6px;width:100%;margin-bottom:12px;padding:0 10px;height:32px;border:1px solid var(--dshm-border);border-radius:10px;background:var(--dshm-bg);color:var(--dshm-dim);}",
			".dsh-mobile-search svg{flex:none;}",
			".dsh-mobile-search input{pointer-events:auto;flex:1;min-width:0;border:none;outline:none;background:transparent;color:var(--dshm-text);font-size:13px;}",
			".dsh-mobile-search input::placeholder{color:var(--dshm-dim);}",
			".dsh-mobile-ws{margin-bottom:14px;}",
			".dsh-mobile-ws-head{display:flex;align-items:center;gap:6px;font-weight:600;font-size:13px;padding:6px 4px;color:var(--dshm-text);}",
			".dsh-mobile-ws-head svg{flex:none;color:var(--dshm-dim);}",
			".dsh-mobile-ws-title{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}",
			".dsh-mobile-ws-new{pointer-events:auto;display:grid;place-items:center;flex:none;width:26px;height:26px;border:none;border-radius:6px;background:transparent;color:var(--dshm-dim);cursor:pointer;padding:0;}",
			".dsh-mobile-ws-new:active{background:var(--dshm-hover);color:var(--dshm-text);}",
			".dsh-mobile-session{display:flex;align-items:center;gap:8px;width:100%;text-align:left;border:none;background:transparent;color:var(--dshm-dim);padding:8px;border-radius:8px;font-size:14px;}",
			".dsh-mobile-session .dsh-mobile-session-title{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}",
			".dsh-mobile-session:active{background:var(--dshm-hover);}",
			".dsh-mobile-time{flex:none;font-size:12px;color:var(--dshm-dim);}",
			".dsh-mobile-empty{padding:16px 8px;font-size:13px;color:var(--dshm-dim);}",
			"@media (min-width: 769px) {",
			"  .dsh-mobile-root{display:none !important;}",
			"}"
		].join("\n");

		/** Inject the style tag once; returns a disposer removing it. */
		function injectStyles() {
			if (typeof document === "undefined") return function () {};
			var existing = document.getElementById(STYLE_ID);
			if (existing) {
				existing.textContent = STYLES;
				return function () {};
			}
			var el = document.createElement("style");
			el.id = STYLE_ID;
			el.dataset.plugin = "dsh-mobile";
			el.textContent = STYLES;
			document.head.appendChild(el);
			return function () {
				if (el.parentNode) el.parentNode.removeChild(el);
			};
		}

		/** Required client services (Cordis fibre inject). */
		var inject = ["slots"];

		/**
		 * Detect the harness theme. The authoritative signal is
		 * document.body[data-ds-dark-theme] (the theme plugin toggles this attribute
		 * on <body>). The documentElement data-theme/.dark/prefers-color-scheme path is
		 * a fallback only; returning the wrong theme is what painted the drawer light
		 * in a dark app.
		 */
		function isDark() {
			try {
				if (document.body && document.body.hasAttribute("data-ds-dark-theme")) return true;
			} catch (e) {}
			try {
				var el = document.documentElement;
				if (el) {
					var t = el.getAttribute("data-theme");
					if (t === "dark") return true;
					if (t === "light") return false;
					if (el.classList && el.classList.contains("dark")) return true;
				}
			} catch (e) {}
			try { if (typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches) return true; } catch (e) {}
			return false;
		}

		/** Compact relative time, mirroring the desktop sidebar's buckets ("now"/"5min"/"1h"/"5d"/"4mo"/"1y"). */
		function relativeTimeLabel(updatedAt, now) {
			var MIN = 6e4;
			var HOUR = 36e5;
			var DAY = 864e5;
			var diff = Math.max(0, now - updatedAt);
			if (diff < MIN) return "now";
			if (diff < HOUR) return Math.floor(diff / MIN) + "min";
			if (diff < DAY) return Math.floor(diff / HOUR) + "h";
			if (diff < 30 * DAY) return Math.floor(diff / DAY) + "d";
			if (diff < 365 * DAY) return Math.floor(diff / (30 * DAY)) + "mo";
			return Math.floor(diff / (365 * DAY)) + "y";
		}

		/** Inline magnifier for the search bar (the primitives module isn't bundle-requirable). */
		function SearchIcon() {
			return React.createElement("svg", { width: 14, height: 14, viewBox: "0 0 16 16", fill: "none", "aria-hidden": true },
				React.createElement("circle", { cx: 7, cy: 7, r: 4.5, stroke: "currentColor", strokeWidth: 1.5 }),
				React.createElement("path", { d: "M10.5 10.5 L14 14", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round" }));
		}

		/** Inline folder glyph, matching the desktop workspace-header folder icon look. */
		function FolderIcon() {
			return React.createElement("svg", { width: 16, height: 16, viewBox: "0 0 16 16", fill: "currentColor", "aria-hidden": true },
				React.createElement("path", { d: "M1.6 4.2A1.4 1.4 0 0 1 3 2.8h2.8c.4 0 .78.17 1.05.46l.7.74h5.45A1.4 1.4 0 0 1 14.4 5.4v5.4a1.4 1.4 0 0 1-1.4 1.4H3a1.4 1.4 0 0 1-1.4-1.4z" }));
		}

		/** Inline plus glyph: the per-workspace New Session action, leading the folder row. */
		function PlusIcon() {
			return React.createElement("svg", { width: 16, height: 16, viewBox: "0 0 16 16", fill: "none", "aria-hidden": true },
				React.createElement("path", { d: "M8 3.2v9.6M3.2 8h9.6", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round" }));
		}

		/**
		 * Gemini-style top bar + lightweight drawer, registered into the
		 * frame-wide `shell.overlay` seat. Reads only scalar leaves from the
		 * standard `useSessions` / `useWorkspaces` props.
		 */
		function MobileShell(props) {
			var useSessions = props.useSessions;
			var useWorkspaces = props.useWorkspaces;
			var workspaces = props.workspaces;
			var sessions = props.sessions;

			var openState = React.useState(false);
			var open = openState[0];
			var setOpen = openState[1];
			var mobileState = React.useState(false);
			var mobile = mobileState[0];
			var setMobile = mobileState[1];
			var queryState = React.useState("");
			var query = queryState[0];
			var setQuery = queryState[1];
			var nowState = React.useState(function () { return Date.now(); });
			var now = nowState[0];
			var setNow = nowState[1];

			/* All hooks run unconditionally, before any conditional return, so the
			 * hook order is stable across the mobile<->narrow render transition
			 * (React error #310 otherwise: fewer hooks on the first render, more
			 * once the matchMedia flip re-renders). */
			var items = useWorkspaces(function (s) { return s.items; }) || [];
			var byId = useSessions(function (s) { return s.byId; }) || {};
			var current = useSessions(function (s) { return s.current; });
			var recent = useWorkspaces(function (s) { return s.recentWorkspaceId; });

			React.useEffect(function () {
				var mq = window.matchMedia("(max-width: 768px)");
				var update = function () { setMobile(mq.matches); };
				update();
				mq.addEventListener("change", update);
				return function () { mq.removeEventListener("change", update); };
			}, []);

			/* Keep the relative-time labels fresh (~1min tick) while the drawer is open. */
			React.useEffect(function () {
				var tick = window.setInterval(function () { setNow(Date.now()); }, 60000);
				return function () { window.clearInterval(tick); };
			}, []);

			if (!mobile) return null;

			var curWs = null;
			for (var i = 0; i < items.length; i++) {
				var w = items[i];
				if (w.sessionIds && w.sessionIds.indexOf(current) !== -1) { curWs = w; break; }
			}
			if (!curWs) {
				for (var j = 0; j < items.length; j++) {
					if (items[j].workspaceId === recent) { curWs = items[j]; break; }
				}
			}
			var currentSession = current ? byId[current] : undefined;
			/* The mobile header shows the current session's name, falling back to the
			 * workspace title, then the generic brand. */
			var label = currentSession && currentSession.displayTitle
				? currentSession.displayTitle
				: (curWs && curWs.title ? curWs.title : "DSH");
			var dark = isDark();

			var nodes = [];
			nodes.push(React.createElement("div", { className: "dsh-mobile-topbar" },
				React.createElement("button", {
					className: "dsh-mobile-btn",
					"aria-label": "Menu",
					onClick: function () { setOpen(true); }
				}, "\u2630"),
				React.createElement("span", { className: "dsh-mobile-label" }, label),
				React.createElement("button", {
					className: "dsh-mobile-btn",
					"aria-label": "New Session",
					onClick: function () { if (workspaces) workspaces.startSession(); }
				}, "+")
			));

			if (open) {
				var q = query.trim().toLowerCase();
				var wsNodes = [];
				for (var k = 0; k < items.length; k++) {
					var wks = items[k];
					var wsSessions = [];
					if (wks.sessionIds) {
						for (var m = 0; m < wks.sessionIds.length; m++) {
							var sess = byId[wks.sessionIds[m]];
							if (sess) wsSessions.push(sess);
						}
					}
					/* Client-side title filter, mirroring the desktop sidebar's search. */
					var visible = [];
					for (var p = 0; p < wsSessions.length; p++) {
						var cand = wsSessions[p];
						if (!q) { visible.push(cand); continue; }
						var hay = ((cand.displayTitle || cand.title || cand.id) || "").toLowerCase();
						if (hay.indexOf(q) !== -1) visible.push(cand);
					}
					if (q && visible.length === 0) continue;
					(function (workspace) {
						/* Workspace header row: folder icon, workspace title, and a
						 * trailing New Session plus button at the right-most end. */
						var sec = [React.createElement("div", { className: "dsh-mobile-ws-head" },
							React.createElement(FolderIcon, {}),
							React.createElement("span", { className: "dsh-mobile-ws-title" }, workspace.title || workspace.workspaceId),
							React.createElement("button", {
								type: "button",
								className: "dsh-mobile-ws-new",
								"aria-label": "New Session",
								onClick: function (e) {
									e.stopPropagation();
									if (workspaces) workspaces.startSession(workspace.workspaceId);
									setOpen(false);
								}
							}, React.createElement(PlusIcon, {})))];
						for (var n = 0; n < visible.length; n++) {
							(function (session) {
								var rowChildren = [
									React.createElement("span", { className: "dsh-mobile-session-title" }, session.displayTitle || session.id)
								];
								if (!session.blank) rowChildren.push(React.createElement("span", { className: "dsh-mobile-time" }, relativeTimeLabel(session.updatedAt, now)));
								sec.push(React.createElement("button", {
									key: session.id,
									className: "dsh-mobile-session",
									onClick: function () {
										if (sessions) sessions.open(session.id);
										setOpen(false);
									}
								}, rowChildren));
							})(visible[n]);
						}
						wsNodes.push(React.createElement("div", { key: workspace.workspaceId, className: "dsh-mobile-ws" }, sec));
					})(wks);
				}
				/* backdrop and drawer-wrap are SIBLINGS: the drawer (z-index 1002)
				 * paints above the backdrop (z-index 1001) so its buttons receive taps. */
				nodes.push(React.createElement("div", { className: "dsh-mobile-backdrop", onClick: function () { setOpen(false); } }));
				nodes.push(React.createElement("div", { className: "dsh-mobile-drawer-wrap" },
					React.createElement("div", { className: "dsh-mobile-drawer" },
						React.createElement("div", { className: "dsh-mobile-search" },
							React.createElement(SearchIcon, {}),
							React.createElement("input", { type: "text", placeholder: "Search sessions", value: query, onChange: function (e) { setQuery(e.target.value); } })
						),
						wsNodes.length ? wsNodes : React.createElement("div", { className: "dsh-mobile-empty" }, "No matching sessions")
					)
				));
			}

			return React.createElement("div", { className: "dsh-mobile-root", "data-dsh-theme": dark ? "dark" : "light" }, nodes);
		}

		/**
		 * Register the top bar + drawer into the frame-wide overlay seat. The
		 * style tag is injected once here (idempotent) and the slot inject's
		 * disposer is hung on the calling fiber by the client runtime, so both
		 * are cleaned up when the package unloads. Mirrors dsh-github's apply
		 * contract: no manual return-swapped disposer.
		 */
		function apply(ctx) {
			injectStyles();
			var workspaces = ctx.get("workspaces");
			var sessions = ctx.get("sessions");

			ctx.slots.inject("shell.overlay", function () {
				return ctx.slots.register(
					{ name: "shell.overlay", id: "dsh-mobile" },
					function (props) {
						return React.createElement(MobileShell, {
							useSessions: props.useSessions,
							useWorkspaces: props.useWorkspaces,
							workspaces: workspaces,
							sessions: sessions
						});
					}
				);
			});
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
