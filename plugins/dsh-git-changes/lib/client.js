/*!
 * dsh-git-changes browser half — a lazy-CJS bundle served by the harness client
 * module system. It adds a "Changes" button to the session header utilities and
 * a docked "Git changes" panel into the right `details` column: a filterable
 * files list on the left, the selected file's diff on the right, with width
 * presets. Opening the panel widens the layout's third grid track (via #:has())
 * so the panel is readable and the conversation squashes aside (docked, not an
 * overlay).
 *
 * All git data comes from the host over the durable Connection RPC channel
 * (`ctx.connection.rpc.call('/rpc', ...)`), so the browser never runs git.
 * Unlike a dynamic closure, this is a durable page module, so `document` is a
 * real browser global here (used only for style injection).
 */
window.__ModuleLoader__.load({
	id: "dsh-git-changes",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		var React = require("react");

		/* Panel styles, keyed to the harness theme tokens. The leading #:has()
		 rules widen the app's layout details track only while this panel is open,
		 so it stays docked (pushes the conversation) instead of overlaying it.
		 Each preset sets both the panel and the pushed track. */
		var STYLES = [
			"[style*=\"grid-template-columns\"]:has(.dsh-gc-panel[data-width=\"narrow\"]){grid-template-columns:56px minmax(0, 1fr) min(600px,80vw)!important;}",
			"[style*=\"grid-template-columns\"]:has(.dsh-gc-panel[data-width=\"medium\"]){grid-template-columns:56px minmax(0, 1fr) min(920px,92vw)!important;}",
			"[style*=\"grid-template-columns\"]:has(.dsh-gc-panel[data-width=\"wide\"]){grid-template-columns:56px minmax(0, 1fr) min(1160px,95vw)!important;}",
			".dsh-gc-panel{height:100%;width:100%;min-width:0;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family);}",
			".dsh-gc-header{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px 12px;border-bottom:1px solid var(--dsw-alias-border-l2);}",
			".dsh-gc-title{min-width:0;display:flex;flex-direction:column;gap:2px;}",
			".dsh-gc-title-main{font-size:14px;font-weight:500;line-height:20px;color:var(--dsw-alias-label-primary);}",
			".dsh-gc-title-sub{font-size:12px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}",
			".dsh-gc-actions{display:flex;align-items:center;gap:6px;flex:none;}",
			".dsh-gc-width{display:flex;gap:2px;flex:none;}",
			".dsh-gc-wbtn{min-width:24px;height:24px;padding:0 6px;background:0 0;color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;cursor:pointer;font-size:11px;font-weight:600;line-height:1;}",
			".dsh-gc-wbtn:hover{background:var(--dsw-alias-interactive-bg-hover);}",
			".dsh-gc-wsel{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);}",
			".dsh-gc-total-add{color:#57c07a;font-weight:600;font-size:13px;}",
			".dsh-gc-total-del{color:#d9534f;font-weight:600;font-size:13px;margin-left:4px;}",
			".dsh-gc-btn{background:0 0;color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:4px 10px;cursor:pointer;font-size:12px;height:28px;}",
			".dsh-gc-btn:hover{background:var(--dsw-alias-interactive-bg-hover);}",
			".dsh-gc-close{width:28px;height:28px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;border-radius:999px;flex:none;display:grid;place-items:center;font-size:18px;line-height:1;}",
			".dsh-gc-close:hover{background:var(--dsw-alias-interactive-bg-hover);}",
			".dsh-gc-body{flex:1;display:flex;flex-direction:row;min-height:0;}",
			".dsh-gc-list{flex:0 0 26%;min-width:180px;max-width:320px;display:flex;flex-direction:column;border-right:1px solid var(--dsw-alias-border-l1);min-height:0;}",
			".dsh-gc-filter{padding:8px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);}",
			".dsh-gc-input{width:100%;box-sizing:border-box;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:5px 10px;font-size:12px;font-family:var(--dsw-font-family);}",
			".dsh-gc-input:focus{outline:none;border-color:var(--dsw-alias-border-l3);}",
			".dsh-gc-filelist{flex:1;overflow-y:auto;min-height:0;}",
			".dsh-gc-file{display:flex;align-items:center;gap:8px;width:100%;padding:7px 10px;background:transparent;border:none;border-bottom:1px solid var(--dsw-alias-border-l1);color:inherit;cursor:pointer;text-align:left;font-size:13px;}",
			".dsh-gc-file:hover{background:var(--dsw-alias-interactive-bg-hover);}",
			".dsh-gc-file-sel{background:rgba(80,140,255,0.18);}",
			".dsh-gc-file-path{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--ds-font-family-code);font-size:12px;color:var(--dsw-alias-label-secondary);}",
			".dsh-gc-file-counts{color:var(--dsw-alias-label-secondary);font-family:var(--ds-font-family-code);font-size:11px;white-space:nowrap;}",
			".dsh-gc-badge{flex:0 0 auto;width:18px;height:18px;line-height:18px;text-align:center;border-radius:4px;font-size:11px;font-weight:700;font-family:var(--ds-font-family-code);}",
			".dsh-gc-badge-add{background:rgba(64,180,100,0.22);color:#57c07a;}",
			".dsh-gc-badge-mod{background:rgba(220,170,60,0.22);color:#d6a839;}",
			".dsh-gc-badge-del{background:rgba(220,80,80,0.22);color:#d9534f;}",
			".dsh-gc-badge-cop{background:rgba(90,140,240,0.22);color:#5a8cf0;}",
			".dsh-gc-badge-unt{background:rgba(170,120,220,0.22);color:#aa78dc;}",
			".dsh-gc-dot{flex:0 0 auto;color:var(--dsw-alias-state-warn-primary);font-size:8px;}",
			".dsh-gc-diff{flex:1;display:flex;flex-direction:column;min-width:0;min-height:0;}",
			".dsh-gc-diff-inner{flex:1;display:flex;flex-direction:column;min-height:0;}",
			".dsh-gc-diff-head{padding:8px 12px;font-family:var(--ds-font-family-code);font-size:12px;border-bottom:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
			".dsh-gc-pre{flex:1;overflow:auto;margin:0;padding:10px 12px;font-family:var(--ds-font-family-code);font-size:13px;line-height:1.5;}",
			".dsh-gc-dl{white-space:pre;padding:0 4px;}",
			".dsh-gc-dl-add{background:rgba(64,180,100,0.15);color:#4fbf7e;}",
			".dsh-gc-dl-del{background:rgba(220,80,80,0.15);color:#e06c6c;}",
			".dsh-gc-dl-hunk{color:#7aa0e8;}",
			".dsh-gc-dl-meta{color:var(--dsw-alias-label-tertiary);}",
			".dsh-gc-dl-ctx{color:var(--dsw-alias-label-primary);}",
			".dsh-gc-empty{padding:16px;opacity:0.7;font-size:13px;color:var(--dsw-alias-label-tertiary);}",
			".dsh-gc-err{color:var(--dsw-alias-state-error-primary);}",
			".dsh-gc-trigger{border:1px solid var(--dsw-alias-border-l2);height:32px;color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family);cursor:pointer;background:0 0;border-radius:18px;justify-content:center;align-items:center;gap:4px;padding:6px 12px;font-size:13px;font-weight:400;line-height:20px;display:inline-flex;white-space:nowrap;}",
			".dsh-gc-trigger:hover{background:var(--dsw-alias-interactive-bg-hover);}",
			".dsh-gc-trigger[data-active=\"true\"]{background:var(--dsw-alias-interactive-bg-hover);}"
		].join("\n");

		function injectStyles() {
			if (typeof document === "undefined" || document.getElementById("dsh-git-changes-style")) return;
			var el = document.createElement("style");
			el.id = "dsh-git-changes-style";
			el.textContent = STYLES;
			document.head.appendChild(el);
		}
		injectStyles();

		/** Required client services (Cordis fibre inject). */
		const inject = ["slots"];

		function statusBadge(status) {
			if (status === "added") return { label: "A", cls: "add" };
			if (status === "modified") return { label: "M", cls: "mod" };
			if (status === "deleted") return { label: "D", cls: "del" };
			if (status === "copied") return { label: "C", cls: "cop" };
			if (status === "untracked") return { label: "?", cls: "unt" };
			return { label: "?", cls: "mod" };
		}

		function FileRow(props) {
			const f = props.file;
			const b = statusBadge(f.status);
			return React.createElement("button", {
				type: "button",
				className: "dsh-gc-file" + (props.selected ? " dsh-gc-file-sel" : ""),
				onClick: props.onSelect
			},
				React.createElement("span", { className: "dsh-gc-badge dsh-gc-badge-" + b.cls }, b.label),
				React.createElement("span", { className: "dsh-gc-file-path", title: f.path }, f.path),
				React.createElement("span", { className: "dsh-gc-file-counts" },
					(f.additions > 0 ? "+" + f.additions : "") + (f.deletions > 0 ? " \u2212" + f.deletions : "")),
				f.uncommitted ? React.createElement("span", { className: "dsh-gc-dot", title: "Uncommitted working-tree change" }, "\u25cf") : null
			);
		}

		function renderDiffLines(text) {
			const s = String(text || "");
			const lines = s.split("\n");
			if (lines.length && lines[lines.length - 1] === "") lines.pop();
			const out = [];
			for (let i = 0; i < lines.length; i++) {
				const line = lines[i];
				let cls = "ctx";
				const c0 = line.charAt(0);
				if (c0 === "+") cls = "add";
				else if (c0 === "-") cls = "del";
				else if (c0 === "@") cls = "hunk";
				else if (line.indexOf("diff --git ") === 0 || line.indexOf("index ") === 0 || line.indexOf("new file") === 0 || line.indexOf("deleted file") === 0 || line.indexOf("---") === 0 || line.indexOf("+++") === 0) cls = "meta";
				out.push(React.createElement("div", { key: i, className: "dsh-gc-dl dsh-gc-dl-" + cls }, line === "" ? " " : line));
			}
			return out;
		}

		/**
		 * Plugin body: register the header "Changes" toggle and the docked panel
		 * into the `details` column, and share one store between them.
		 */
		function apply(ctx) {
			const store = { open: false, preset: "medium", listeners: new Set() };
			store.subscribe = function (fn) {
				store.listeners.add(fn);
				return function () { store.listeners.delete(fn); };
			};
			store.set = function (patch) {
				Object.assign(store, patch);
				const fns = Array.from(store.listeners);
				for (let i = 0; i < fns.length; i++) fns[i]();
			};

			function useStore() {
				const tuple = React.useState(0);
				const force = tuple[1];
				React.useEffect(function () {
					return store.subscribe(function () { force(function (n) { return n + 1; }); });
				}, []);
				return store;
			}

			function hostCall(method, args) {
				const rpc = ctx.get("connection") && ctx.get("connection").rpc;
				if (!rpc || typeof rpc.call !== "function") {
					return Promise.reject(new Error("Git changes host channel is unavailable"));
				}
				return rpc.call("/rpc", method, args).then((result) => {
					if (result && result.ok) return result.value;
					const message = (result && result.error && result.error.message) || "Git changes request failed";
					throw new Error(message);
				});
			}

			/* Open/close is driven entirely by the :has() grid override: rendering
			 * the panel widens the layout's details track (and squashes the
			 * conversation); returning null drops it and the track collapses to the
			 * app default. No layout service is required. */
			function setOpen(next) {
				store.set({ open: next });
			}

			function ChangesPanel(props) {
				const s = useStore();
				const sessionId = props && props.sessionId;
				const summaryState = React.useState(null);
				const summary = summaryState[0];
				const setSummary = summaryState[1];
				const loadingState = React.useState(true);
				const loading = loadingState[0];
				const setLoading = loadingState[1];
				const summaryErrState = React.useState(null);
				const summaryErr = summaryErrState[0];
				const setSummaryErr = summaryErrState[1];
				const selectedState = React.useState(null);
				const selected = selectedState[0];
				const setSelected = selectedState[1];
				const diffState = React.useState(null);
				const diff = diffState[0];
				const setDiff = diffState[1];
				const diffLoadingState = React.useState(false);
				const diffLoading = diffLoadingState[0];
				const setDiffLoading = diffLoadingState[1];
				const diffErrState = React.useState(null);
				const diffErr = diffErrState[0];
				const setDiffErr = diffErrState[1];
				const filterState = React.useState("");
				const filter = filterState[0];
				const setFilter = filterState[1];

				function fetchSummary() {
					setLoading(true);
					setSummaryErr(null);
					hostCall("git-changes/summary", { sessionId: sessionId }).then(function (res) {
						setLoading(false);
						if (res && res.ok) {
							setSummary(res);
							if (selected === null && res.files && res.files.length > 0) selectFile(res.files[0].path);
						} else {
							setSummaryErr((res && res.error) || "Failed to load changes");
						}
					}).catch(function (e) {
						setLoading(false);
						setSummaryErr(String((e && e.message) || e));
					});
				}

				React.useEffect(function () {
					fetchSummary();
				}, []);

				function selectFile(path) {
					setSelected(path);
					setDiff(null);
					setDiffLoading(true);
					setDiffErr(null);
					hostCall("git-changes/diff", { path: path, sessionId: sessionId }).then(function (res) {
						setDiffLoading(false);
						if (res && res.ok) setDiff(res);
						else setDiffErr((res && res.error) || "Failed to load diff");
					}).catch(function (e) {
						setDiffLoading(false);
						setDiffErr(String((e && e.message) || e));
					});
				}

				function close() {
					setOpen(false);
				}

				const files = (summary && summary.files) || [];
				const q = filter.trim().toLowerCase();
				const visible = q === "" ? files : files.filter(function (f) { return f.path.toLowerCase().indexOf(q) >= 0; });

				let listContent;
				if (loading) listContent = React.createElement("div", { className: "dsh-gc-empty" }, "Loading\u2026");
				else if (summaryErr) listContent = React.createElement("div", { className: "dsh-gc-empty dsh-gc-err" }, summaryErr);
				else if (files.length === 0) listContent = React.createElement("div", { className: "dsh-gc-empty" }, "No changes");
				else if (visible.length === 0) listContent = React.createElement("div", { className: "dsh-gc-empty" }, "No matches");
				else listContent = visible.map(function (f) {
					return React.createElement(FileRow, { key: f.path, file: f, selected: selected === f.path, onSelect: function () { selectFile(f.path); } });
				});

				const diffContent = diffLoading
					? React.createElement("div", { className: "dsh-gc-empty" }, "Loading diff\u2026")
					: diffErr
						? React.createElement("div", { className: "dsh-gc-empty dsh-gc-err" }, diffErr)
						: !diff
							? React.createElement("div", { className: "dsh-gc-empty" }, "Select a file to view its diff")
							: React.createElement("div", { className: "dsh-gc-diff-inner" },
								React.createElement("div", { className: "dsh-gc-diff-head" }, diff.path),
								React.createElement("pre", { className: "dsh-gc-pre" }, renderDiffLines(diff.diff)));

				return React.createElement("div", { className: "dsh-gc-panel", "data-width": s.preset },
					React.createElement("div", { className: "dsh-gc-header" },
						React.createElement("div", { className: "dsh-gc-title" },
							React.createElement("div", { className: "dsh-gc-title-main" }, "Git changes"),
							summary && summary.ok
								? React.createElement("div", { className: "dsh-gc-title-sub" }, summary.branch + " \u2192 " + summary.base + " \u00b7 " + summary.totals.files + " files")
								: null),
						React.createElement("div", { className: "dsh-gc-actions" },
							summary && summary.ok ? React.createElement("span", { className: "dsh-gc-total-add" }, "+" + summary.totals.additions) : null,
							summary && summary.ok ? React.createElement("span", { className: "dsh-gc-total-del" }, "\u2212" + summary.totals.deletions) : null,
							React.createElement("div", { className: "dsh-gc-width" },
								React.createElement("button", { className: "dsh-gc-wbtn" + (s.preset === "narrow" ? " dsh-gc-wsel" : ""), type: "button", title: "Small panel", onClick: function () { store.set({ preset: "narrow" }); } }, "S"),
								React.createElement("button", { className: "dsh-gc-wbtn" + (s.preset === "medium" ? " dsh-gc-wsel" : ""), type: "button", title: "Medium panel", onClick: function () { store.set({ preset: "medium" }); } }, "M"),
								React.createElement("button", { className: "dsh-gc-wbtn" + (s.preset === "wide" ? " dsh-gc-wsel" : ""), type: "button", title: "Large panel", onClick: function () { store.set({ preset: "wide" }); } }, "L")),
							React.createElement("button", { className: "dsh-gc-btn", type: "button", onClick: fetchSummary, title: "Refresh" }, "Refresh"),
							React.createElement("button", { className: "dsh-gc-close", type: "button", onClick: close, title: "Collapse", "aria-label": "Collapse changes panel" }, "\u00d7"))),
					React.createElement("div", { className: "dsh-gc-body" },
						React.createElement("div", { className: "dsh-gc-list" },
							React.createElement("div", { className: "dsh-gc-filter" },
								React.createElement("input", { className: "dsh-gc-input", type: "text", placeholder: "Filter files", value: filter, onChange: function (e) { setFilter(e.target.value); } })),
							React.createElement("div", { className: "dsh-gc-filelist" }, listContent)),
						React.createElement("div", { className: "dsh-gc-diff" }, diffContent)));
			}

			ctx.slots.inject("conversation.session.header.utilities", function () {
				return ctx.slots.register(
					{ name: "conversation.session.header.utilities", id: "git-changes", order: 1, label: "Changes" },
					function () {
						const s = useStore();
						return React.createElement("button", {
							className: "dsh-gc-trigger",
							type: "button",
							title: "Toggle Git changes panel",
							"data-active": s.open ? "true" : "false",
							onClick: function () { setOpen(!store.open); }
						}, "Changes");
					}
				);
			});

			ctx.slots.inject("details", function () {
				return ctx.slots.register(
					{ name: "details" },
					function (props) {
						const s = useStore();
						if (!s.open) return null;
						return React.createElement(ChangesPanel, { sessionId: props && props.sessionId });
					}
				);
			});
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
