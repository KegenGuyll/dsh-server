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
		var primitives = require("@deepseek-ai/dsh-client-ui-primitives");

		/* Package-owned stylesheet, injected once on load and removed on dispose.
		 * The bundle cannot use the dynamic `styles` builtin, so it mirrors the
		 * dsh-github style-tag technique. The mobile-only rules collapse the
		 * AppFrame grid (hide sidebar + details) and the session header; the
		 * desktop media query hides the floating UI entirely, so desktop is
		 * unaffected. Colors come from the shared DSH design tokens
		 * (`--dsw-alias-*`), so the top bar/drawer track the active theme and no
		 * separate theme detection is needed. */
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
			"  /* Hide the shipped session header (breadcrumb/title row, Chat/Details tabs, and",
			"     the session-log action) on mobile -- the floating dsh-mobile top bar replaces it.",
			"     Selector: the conversation root (the only [data-phase] with a direct child",
			"     [data-conversation-scroll]) whose FIRST CHILD is the slot outlet for the header. The",
			"     slot runtime wraps every slot in a <div data-slot=...> (display:contents), so we",
			"     hide that outlet — it always contains exactly the session <header>. This is",
			"     structural and stable across the harness, unlike the hashed CSS-module class. */",
			"  [data-phase]:has(> [data-conversation-scroll]) > [data-slot='conversation.session.header'] { display: none !important; }",
			"}",
			".dsh-mobile-root{position:fixed;inset:0;z-index:1000;pointer-events:none;}",
			".dsh-mobile-topbar{pointer-events:auto;display:flex;align-items:center;gap:8px;height:52px;padding:0 10px;background:var(--dsw-alias-bg-layer-3);border-bottom:1px solid var(--dsw-alias-border-l2);}",
			".dsh-mobile-btn{pointer-events:auto;display:grid;place-items:center;width:36px;height:36px;border:none;border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;flex:none;}",
			".dsh-mobile-btn:active{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);}",
			".dsh-mobile-label{flex:1;min-width:0;text-align:center;font-size:16px;font-weight:500;color:var(--dsw-alias-label-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}",
			".dsh-mobile-backdrop{pointer-events:auto;position:fixed;inset:0;background:var(--dsw-alias-bg-mask-1);z-index:1001;}",
			".dsh-mobile-drawer-wrap{pointer-events:auto;position:fixed;top:0;left:0;bottom:0;width:min(84vw,320px);z-index:1002;}",
			".dsh-mobile-drawer{position:absolute;top:0;left:0;bottom:0;width:min(84vw,320px);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);padding:10px 14px 20px 12px;overflow-y:auto;box-shadow:var(--dsw-shadow-lv2);}",
			".dsh-mobile-search{box-sizing:border-box;pointer-events:auto;display:flex;align-items:center;gap:6px;width:100%;margin-bottom:12px;padding:0 10px;height:32px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-tertiary);}",
			".dsh-mobile-search svg{flex:none;}",
			".dsh-mobile-search input{pointer-events:auto;flex:1;min-width:0;border:none;outline:none;background:transparent;color:var(--dsw-alias-label-primary);font-size:13px;}",
			".dsh-mobile-search input::placeholder{color:var(--dsw-alias-label-tertiary);}",
			".dsh-mobile-ws{margin-bottom:14px;}",
			".dsh-mobile-ws-head{display:flex;align-items:center;gap:6px;font-weight:600;font-size:13px;padding:6px 4px;color:var(--dsw-alias-label-primary);}",
			".dsh-mobile-ws-head svg{flex:none;color:var(--dsw-alias-label-secondary);}",
			".dsh-mobile-ws-title{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}",
			".dsh-mobile-ws-new{pointer-events:auto;display:grid;place-items:center;flex:none;width:26px;height:26px;border:none;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;padding:0;}",
			".dsh-mobile-ws-new:active{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);}",
			".dsh-mobile-session{display:flex;align-items:center;gap:8px;width:100%;text-align:left;border:none;background:transparent;color:var(--dsw-alias-label-secondary);padding:8px;border-radius:8px;font-size:14px;-webkit-touch-callout:none;user-select:none;touch-action:manipulation;}",
			".dsh-mobile-session .dsh-mobile-session-title{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}",
			".dsh-mobile-session:active{background:var(--dsw-alias-interactive-bg-hover);}",
			".dsh-mobile-time{flex:none;font-size:12px;color:var(--dsw-alias-label-tertiary);}",
			".dsh-mobile-empty{padding:16px 8px;font-size:13px;color:var(--dsw-alias-label-tertiary);}",
			"/* Long-press session action sheet (bottom sheet over the drawer). */",
			".dsh-mobile-sheet-backdrop{pointer-events:auto;position:fixed;inset:0;z-index:1010;background:var(--dsw-alias-bg-mask-1);display:flex;align-items:flex-end;justify-content:center;}",
			".dsh-mobile-sheet{pointer-events:auto;box-sizing:border-box;width:100%;max-width:560px;background:var(--dsw-alias-bg-layer-3);border-top-left-radius:16px;border-top-right-radius:16px;padding:14px 16px calc(18px + env(safe-area-inset-bottom));box-shadow:var(--dsw-shadow-lv2);display:flex;flex-direction:column;gap:4px;}",
			".dsh-mobile-sheet-title{font-weight:600;font-size:14px;color:var(--dsw-alias-label-primary);padding:6px 4px 10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}",
			".dsh-mobile-sheet-action{display:flex;align-items:center;gap:10px;width:100%;border:none;background:transparent;color:var(--dsw-alias-label-primary);font-size:15px;padding:12px 8px;border-radius:8px;cursor:pointer;text-align:left;}",
			".dsh-mobile-sheet-action:active{background:var(--dsw-alias-interactive-bg-hover);}",
			".dsh-mobile-sheet-action svg{flex:none;color:var(--dsw-alias-label-secondary);}",
			".dsh-mobile-sheet-cancel{margin-top:6px;width:100%;border:none;background:transparent;color:var(--dsw-alias-label-secondary);font-size:15px;padding:12px;border-radius:8px;cursor:pointer;text-align:center;}",
			".dsh-mobile-sheet-cancel:active{background:var(--dsw-alias-interactive-bg-hover);}",
			".dsh-mobile-sheet-input{box-sizing:border-box;pointer-events:auto;width:100%;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:15px;padding:10px 12px;margin-bottom:8px;outline:none;}",
			".dsh-mobile-sheet-error{color:var(--dsw-alias-state-error-primary);font-size:13px;margin-bottom:8px;}",
			".dsh-mobile-sheet-actions{display:flex;gap:8px;justify-content:flex-end;}",
			".dsh-mobile-sheet-btn{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border-radius:10px;font-size:15px;padding:10px 18px;cursor:pointer;}",
			".dsh-mobile-sheet-btn:active{background:var(--dsw-alias-interactive-bg-hover);}",
			".dsh-mobile-sheet-btn:disabled{opacity:.5;cursor:default;}",
			".dsh-mobile-sheet-btn-primary{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary);}",
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

		/* Icons come from the shared UI primitives (`@deepseek-ai/dsh-client-ui-primitives`,
		 * a seed module always available to out-of-tree bundles): IconPanelLeftOutline16
		 * for the drawer toggle, IconPlusOutline16 for the New Session actions,
		 * IconSearchOutline16 for the drawer filter, IconFolderOpen16 for the
		 * workspace header rows, and IconEditOutline16 / IconBranchOutline16 /
		 * IconArchiveOutline20 for the session action sheet. */

		/* Long-press detection: a stationary hold (>550ms, <~12px drift) opens the
		 * session action sheet; a shorter touch or a scroll (pointercancel / move
		 * past the drift threshold) is cleared so the row's plain tap still opens
		 * the session. `suppress` guards the synthesized click that follows a
		 * completed hold so it never also navigates. */
		var LONG_PRESS_MS = 550;
		var LONG_PRESS_DRIFT = 12;

		/**
		 * One drawer session row with hold-to-open support.
		 * @param props.session - session summary (id, displayTitle/title, blank, updatedAt).
		 * @param props.now - epoch ms for the relative-time label.
		 * @param props.onOpen - open the session by id.
		 * @param props.onLongPress - open the action sheet for this session.
		 * @returns the row button.
		 */
		function SessionRowItem(props) {
			var session = props.session;
			var now = props.now;
			var onOpen = props.onOpen;
			var onLongPress = props.onLongPress;

			var timerRef = React.useRef(null);
			var startRef = React.useRef(null);
			var suppressRef = React.useRef(false);

			function clearPress() {
				if (timerRef.current !== null) { window.clearTimeout(timerRef.current); timerRef.current = null; }
			}

			function handlePointerDown(e) {
				/* Only a primary press / single touch arms the long-press timer. */
				if (e.button !== undefined && e.button !== 0) return;
				suppressRef.current = false;
				startRef.current = { x: e.clientX, y: e.clientY };
				clearPress();
				timerRef.current = window.setTimeout(function () {
					timerRef.current = null;
					suppressRef.current = true;
					onLongPress(session);
				}, LONG_PRESS_MS);
			}

			function handlePointerMove(e) {
				if (timerRef.current === null) return;
				var s = startRef.current;
				if (s && (Math.abs(e.clientX - s.x) > LONG_PRESS_DRIFT || Math.abs(e.clientY - s.y) > LONG_PRESS_DRIFT)) clearPress();
			}

			function handleClick(e) {
				/* A completed hold synthesizes a click; swallow it so it does not open the session. */
				if (suppressRef.current) {
					suppressRef.current = false;
					e.preventDefault();
					return;
				}
				onOpen(session.id);
			}

			var rowChildren = [
				React.createElement("span", { className: "dsh-mobile-session-title" }, session.displayTitle || session.id)
			];
			if (!session.blank) rowChildren.push(React.createElement("span", { className: "dsh-mobile-time" }, relativeTimeLabel(session.updatedAt, now)));

			return React.createElement("button", {
				key: session.id,
				className: "dsh-mobile-session",
				onPointerDown: handlePointerDown,
				onPointerMove: handlePointerMove,
				onPointerUp: clearPress,
				onPointerCancel: clearPress,
				onPointerLeave: clearPress,
				onClick: handleClick
			}, rowChildren);
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
			var actionSessionState = React.useState(null);
			var actionSession = actionSessionState[0];
			var setActionSession = actionSessionState[1];
			var renameModeState = React.useState(false);
			var renameMode = renameModeState[0];
			var setRenameMode = renameModeState[1];
			var renameDraftState = React.useState("");
			var renameDraft = renameDraftState[0];
			var setRenameDraft = renameDraftState[1];
			var renameErrorState = React.useState(null);
			var renameError = renameErrorState[0];
			var setRenameError = renameErrorState[1];
			/* When the sheet opens from a hold, the finger is still down; the click the
			 * browser synthesizes on release lands on the backdrop and would close the
			 * sheet instantly. Ignore backdrop taps for a short window after opening. */
			var sheetOpenedAtRef = React.useRef(0);

			/* All hooks run unconditionally, before any conditional return, so the
			 * hook order is stable across the mobile<->narrow render transition
			 * (React error #310 otherwise: fewer hooks on the first render, more
			 * once the matchMedia flip re-renders). */
			var items = useWorkspaces(function (s) { return s.items; }) || [];
			var byId = useSessions(function (s) { return s.byId; }) || {};
			var current = useSessions(function (s) { return s.current; });
			var recent = useWorkspaces(function (s) { return s.recentWorkspaceId; });
			var archivedIds = new Set(useWorkspaces(function (s) { return s.archivedSessionIds; }) || []);

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

			/* Session action-sheet handlers (all closeless reads of the live store). */
			function closeSheet() {
				setActionSession(null);
				setRenameMode(false);
				setRenameDraft("");
				setRenameError(null);
			}
			function openRename() {
				setRenameDraft(actionSession.displayTitle || actionSession.id);
				setRenameError(null);
				setRenameMode(true);
			}
			function confirmRename() {
				var title = renameDraft.trim();
				if (!title) return;
				var binding = sessions ? sessions.binding(actionSession.id) : undefined;
				var session = binding ? binding.session : undefined;
				if (!session) { setRenameError("Session not found"); return; }
				session.rename(title).then(function (r) {
					if (r && r.ok) closeSheet();
					else setRenameError(r && r.error && r.error.message ? r.error.message : "Rename failed");
				}).catch(function (err) {
					setRenameError(err && err.message ? err.message : "Rename failed");
				});
			}
			function doFork() {
				if (!sessions) return;
				sessions.fork({ sessionId: actionSession.id, increaseTitle: true }).then(function (childId) {
					closeSheet();
					setOpen(false);
					sessions.open(childId);
				}).catch(function () {});
			}
			function doArchive() {
				if (!workspaces) return;
				workspaces.archiveSession(actionSession.id).then(function () {
					closeSheet();
				}).catch(function () {});
			}

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
			var nodes = [];
			nodes.push(React.createElement("div", { className: "dsh-mobile-topbar" },
				React.createElement("button", {
					className: "dsh-mobile-btn",
					"aria-label": "Menu",
					onClick: function () { setOpen(true); }
				}, React.createElement(primitives.IconPanelLeftOutline16, { size: 18 })),
				React.createElement("span", { className: "dsh-mobile-label" }, label),
				React.createElement("button", {
					className: "dsh-mobile-btn",
					"aria-label": "New Session",
					onClick: function () { if (workspaces) workspaces.startSession(); }
				}, React.createElement(primitives.IconPlusOutline16, { size: 18 }))
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
					/* Client-side title filter, mirroring the desktop sidebar's search.
					 * Archived sessions are hidden, so Archive visibly removes a row. */
					var visible = [];
					for (var p = 0; p < wsSessions.length; p++) {
						var cand = wsSessions[p];
						if (archivedIds.has(cand.id)) continue;
						if (!q) { visible.push(cand); continue; }
						var hay = ((cand.displayTitle || cand.title || cand.id) || "").toLowerCase();
						if (hay.indexOf(q) !== -1) visible.push(cand);
					}
					if (q && visible.length === 0) continue;
					(function (workspace) {
						/* Workspace header row: folder icon, workspace title, and a
						 * trailing New Session plus button at the right-most end. */
						var sec = [React.createElement("div", { className: "dsh-mobile-ws-head" },
							React.createElement(primitives.IconFolderOpen16, { size: 16 }),
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
							}, React.createElement(primitives.IconPlusOutline16, { size: 16 })))];
						for (var n = 0; n < visible.length; n++) {
							(function (session) {
								sec.push(React.createElement(SessionRowItem, {
									key: session.id,
									session: session,
									now: now,
									onOpen: function (id) {
										if (sessions) sessions.open(id);
										setOpen(false);
									},
									onLongPress: function (s) {
										sheetOpenedAtRef.current = Date.now();
										setActionSession(s);
									}
								}));
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
							React.createElement(primitives.IconSearchOutline16, { size: 14 }),
							React.createElement("input", { type: "text", placeholder: "Search sessions", value: query, onChange: function (e) { setQuery(e.target.value); } })
						),
						wsNodes.length ? wsNodes : React.createElement("div", { className: "dsh-mobile-empty" }, "No matching sessions")
					)
				));
			}

			/* Long-press session action sheet (bottom sheet over the drawer). */
			if (actionSession) {
				var sheet = [];
				if (renameMode) {
					sheet.push(React.createElement("div", { className: "dsh-mobile-sheet-title" }, "Rename session"));
					sheet.push(React.createElement("input", {
						className: "dsh-mobile-sheet-input",
						type: "text",
						value: renameDraft,
						placeholder: "Session title",
						autoFocus: true,
						onChange: function (e) {
							setRenameDraft(e.target.value);
							if (renameError) setRenameError(null);
						},
						onKeyDown: function (e) {
							if (e.key === "Enter" && renameDraft.trim()) confirmRename();
							else if (e.key === "Escape") { setRenameMode(false); setRenameError(null); }
						}
					}));
					if (renameError) sheet.push(React.createElement("div", { className: "dsh-mobile-sheet-error" }, renameError));
					sheet.push(React.createElement("div", { className: "dsh-mobile-sheet-actions" },
						React.createElement("button", {
							type: "button",
							className: "dsh-mobile-sheet-btn",
							onClick: function () { setRenameMode(false); setRenameError(null); }
						}, "Cancel"),
						React.createElement("button", {
							type: "button",
							className: "dsh-mobile-sheet-btn dsh-mobile-sheet-btn-primary",
							disabled: !renameDraft.trim(),
							onClick: confirmRename
						}, "Rename")
					));
				} else {
					sheet.push(React.createElement("div", { className: "dsh-mobile-sheet-title" }, actionSession.displayTitle || actionSession.id));
					sheet.push(React.createElement("button", {
						type: "button",
						className: "dsh-mobile-sheet-action",
						onClick: openRename
					}, React.createElement(primitives.IconEditOutline16, { size: 16 }), React.createElement("span", {}, "Rename")));
					sheet.push(React.createElement("button", {
						type: "button",
						className: "dsh-mobile-sheet-action",
						onClick: doFork
					}, React.createElement(primitives.IconBranchOutline16, { size: 16 }), React.createElement("span", {}, "Fork")));
					sheet.push(React.createElement("button", {
						type: "button",
						className: "dsh-mobile-sheet-action",
						onClick: doArchive
					}, React.createElement(primitives.IconArchiveOutline20, { size: 16 }), React.createElement("span", {}, "Archive")));
					sheet.push(React.createElement("button", {
						type: "button",
						className: "dsh-mobile-sheet-cancel",
						onClick: closeSheet
					}, "Cancel"));
				}
				/* The action sheet overlays the drawer; tapping the backdrop closes it. */
				nodes.push(React.createElement("div", {
					className: "dsh-mobile-sheet-backdrop",
					onClick: function (e) {
						if (e.target !== e.currentTarget) return;
						if (Date.now() - sheetOpenedAtRef.current < 400) return;
						closeSheet();
					}
				}, React.createElement("div", { className: "dsh-mobile-sheet" }, sheet)));
			}

			return React.createElement("div", { className: "dsh-mobile-root" }, nodes);
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
