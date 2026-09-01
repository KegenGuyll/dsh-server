/*!
 * dsh-github browser half — a lazy-CJS bundle served by the harness client
 * module system. It occupies ui-workspace's two directory-flow holes with a
 * chooser ("Add local workspace" / "Import from GitHub"), renders the GitHub
 * import modal, and registers a Settings → Plugins card for the token.
 *
 * All GitHub work runs on the host (the PAT never crosses the wire): the client
 * calls the host through the generic Connection RPC channel
 * (`ctx.connection.rpc.call('/rpc', method, args)`), with the host handlers
 * declared in index.js.
 */
window.__ModuleLoader__.load({
	id: "dsh-github",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		var React = require("react");

		/* Styles for the workspace-add chooser / import modal / settings card.
		 * Sized and colored with the harness theme tokens (--dsw-alias-*) so the
		 * surfaces match the in-app "View options" menu and dialogs. */
		var STYLES = [
			".dsh-github-overlay{position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;padding:16px;}",
			".dsh-github-dialog{background:#242429;color:#e6e6e8;border:1px solid rgba(255,255,255,.09);border-radius:12px;box-shadow:0 16px 44px rgba(0,0,0,.45);min-width:340px;max-width:min(560px,92vw);min-height:240px;max-height:80vh;display:flex;flex-direction:column;overflow:hidden;}",
			".dsh-github-card{background:#242429;color:#e6e6e8;border:1px solid rgba(255,255,255,.09);border-radius:10px;min-width:224px;padding:6px;display:flex;flex-direction:column;gap:2px;font:inherit;}",
			".dsh-github-chooser,.dsh-github-modal,.dsh-github-local{display:flex;flex-direction:column;gap:2px;padding:6px;min-height:0;flex:1;}",
			".dsh-github-chooser-title,.dsh-github-modal-head,.dsh-github-card-status{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#8f8f98;padding:8px 10px 6px;}",
			".dsh-github-choice,.dsh-github-dir{display:flex;align-items:center;gap:8px;width:100%;padding:10px 12px;border:0;border-radius:7px;background:transparent;color:#e6e6e8;cursor:pointer;text-align:left;font:inherit;font-size:13px;}",
			".dsh-github-choice:hover,.dsh-github-dir:hover,.dsh-github-row:hover{background:rgba(255,255,255,.07);}",
			".dsh-github-choice:disabled,.dsh-github-dir:disabled{opacity:.5;cursor:default;}",
			".dsh-github-cancel{color:#9a9aa2;}",
			".dsh-github-modal-head{display:flex;align-items:center;justify-content:space-between;gap:8px;border-bottom:1px solid rgba(255,255,255,.08);padding-bottom:8px;margin-bottom:6px;}",
			".dsh-github-search{flex:1;min-width:0;padding:7px 9px;border:1px solid rgba(255,255,255,.14);border-radius:7px;background:#1c1c21;color:#e6e6e8;font:inherit;font-size:12px;}",
			".dsh-github-list{flex:1;min-height:220px;max-height:300px;overflow:auto;display:flex;flex-direction:column;gap:2px;padding:4px;}",
			".dsh-github-row{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 10px;border-radius:7px;}",
			".dsh-github-row-main{display:flex;flex-direction:column;gap:2px;min-width:0;}",
			".dsh-github-row-title{font-weight:600;font-size:13px;color:#e6e6e8;}",
			".dsh-github-row-desc{color:#8f8f98;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}",
			".dsh-github-row-meta{display:flex;gap:6px;flex-wrap:wrap;align-items:center;font-size:11px;color:#8f8f98;}",
			".dsh-github-badge{background:rgba(255,255,255,.08);padding:1px 6px;border-radius:999px;color:#b8b8be;}",
			".dsh-github-private{color:#8f8f98;}",
			".dsh-github-empty,.dsh-github-loading,.dsh-github-error{color:#9a9aa2;font-size:12px;padding:12px;text-align:center;}",
			".dsh-github-error{color:#ff6b6b;}",
			".dsh-github-import,.dsh-github-save{background:#3b82f6;color:#fff;border:0;border-radius:7px;padding:7px 12px;font:inherit;font-size:12px;cursor:pointer;}",
			".dsh-github-import:disabled,.dsh-github-save:disabled{opacity:.6;cursor:default;}",
			".dsh-github-load-more,.dsh-github-back,.dsh-github-close,.dsh-github-mkdir,.dsh-github-up,.dsh-github-clear,.dsh-github-cancel{background:transparent;border:1px solid rgba(255,255,255,.14);border-radius:7px;padding:7px 12px;color:#e6e6e8;font:inherit;font-size:12px;cursor:pointer;}",
			".dsh-github-load-more{display:block;margin:6px auto;}",
			".dsh-github-modal-foot{display:flex;justify-content:flex-end;gap:8px;padding:8px 6px 4px;}",
			".dsh-github-local-controls{display:flex;gap:8px;padding:8px 10px;align-items:center;}",
			".dsh-github-new-name{flex:1;padding:7px 9px;border:1px solid rgba(255,255,255,.14);border-radius:7px;background:#1c1c21;color:#e6e6e8;font:inherit;font-size:12px;}",
			".dsh-github-path{font-size:11px;font-weight:400;color:#8f8f98;}",
			".dsh-github-field{display:flex;flex-direction:column;gap:4px;padding:6px 10px;font-size:12px;color:#8f8f98;}",
			".dsh-github-field input[type=text],.dsh-github-field input[type=password],.dsh-github-field input:not([type=checkbox]){padding:6px 8px;border:1px solid rgba(255,255,255,.14);border-radius:7px;background:#1c1c21;color:#e6e6e8;font:inherit;}",
			".dsh-github-card-status{display:flex;align-items:center;gap:6px;font-weight:600;color:#e6e6e8;}",
			".dsh-github-card-detail{font-weight:400;text-transform:none;}",
			".dsh-github-card-actions{display:flex;gap:8px;padding:8px 10px 4px;}"
		].join("\n");
		function injectStyles() {
			if (typeof document === "undefined" || document.getElementById("dsh-github-style")) return;
			var el = document.createElement("style");
			el.id = "dsh-github-style";
			el.textContent = STYLES;
			document.head.appendChild(el);
		}
		injectStyles();

		/** Required client services (Cordis fibre inject). */
		const inject = ["slots"];

		/** Bound client→host caller over the generic Connection RPC channel. */
		function hostCall(ctx, method, args) {
			const rpc = ctx.get("connection")?.rpc;
			if (!rpc || typeof rpc.call !== "function") {
				return Promise.reject(new Error("GitHub host channel is unavailable"));
			}
			return rpc.call("/rpc", method, args).then((result) => {
				if (result && result.ok) return result.value;
				const message = (result && result.error && result.error.message) || "GitHub request failed";
				throw new Error(message);
			});
		}

		class RepoImportError extends Error {
			constructor(message) {
				super(message);
				this.name = "RepoImportError";
			}
		}

		/**
		 * The GitHub import modal: a searchable, paginated list of the user's
		 * repositories; each row has an Import button that clones + registers.
		 */
		function GithubImportModal({ listRepos, importRepo, onPicked, onError, onBack, onCancel }) {
			const [query, setQuery] = React.useState("");
			const [items, setItems] = React.useState([]);
			const [hasMore, setHasMore] = React.useState(false);
			const [page, setPage] = React.useState(1);
			const [loading, setLoading] = React.useState(false);
			const [importing, setImporting] = React.useState("");
			const [error, setError] = React.useState("");

			const load = (nextPage, reset) => {
				setLoading(true);
				setError("");
				listRepos({ page: nextPage, perPage: 25 }).then((res) => {
					setItems((prev) => (reset ? res.items : [...prev, ...res.items]));
					setHasMore(!!res.hasMore);
					setPage(nextPage);
				}).catch((err) => setError(String((err && err.message) || err))).then(() => setLoading(false));
			};

			React.useEffect(() => { load(1, true); /* eslint-disable-line react-hooks/exhaustive-deps */ }, []);

			const q = query.trim().toLowerCase();
			const filtered = q
				? items.filter((it) => it.fullName.toLowerCase().includes(q) || it.description.toLowerCase().includes(q))
				: items;

			const importRepoRow = (repo) => {
				setImporting(repo.fullName);
				setError("");
				importRepo({ repo: repo.fullName, branch: repo.defaultBranch, shallow: true })
					.then((res) => { if (!res || !res.path) throw new RepoImportError("No workspace path returned"); onPicked(res.path); })
					.catch((err) => setError(String((err && err.message) || err)))
					.then(() => setImporting(""));
			};

			return React.createElement("div", { className: "dsh-github-modal" },
				React.createElement("div", { className: "dsh-github-modal-head" },
					React.createElement("span", null, "Import from GitHub"),
					React.createElement("input", {
						className: "dsh-github-search",
						type: "search",
						placeholder: "Search repos…",
						value: query,
						onChange: (e) => setQuery(e.target.value)
					})),
				error
					? React.createElement("div", { className: "dsh-github-error" }, error)
					: null,
				React.createElement("div", { className: "dsh-github-list" },
					loading && items.length === 0
						? React.createElement("div", { className: "dsh-github-loading" }, "Loading repositories…")
						: filtered.length === 0 && !loading
							? React.createElement("div", { className: "dsh-github-empty" }, "No repositories")
							: filtered.map((it) => React.createElement("div", { className: "dsh-github-row", key: it.fullName },
							React.createElement("div", { className: "dsh-github-row-main" },
								React.createElement("div", { className: "dsh-github-row-title" }, it.fullName),
								it.description
									? React.createElement("div", { className: "dsh-github-row-desc" }, it.description)
									: null,
								React.createElement("div", { className: "dsh-github-row-meta" },
									it.language ? React.createElement("span", { className: "dsh-github-badge" }, it.language) : null,
									React.createElement("span", { className: "dsh-github-badge" }, String(it.stars) + " stars"),
									it.private ? React.createElement("span", { className: "dsh-github-badge dsh-github-private" }, "private") : null
								)),
							React.createElement("button", {
								className: "dsh-github-import",
								disabled: importing !== "",
								onClick: () => importRepoRow(it)
							}, importing === it.fullName ? "Importing…" : "Import")))),
				hasMore
					? React.createElement("button", {
						className: "dsh-github-load-more",
						disabled: loading,
						onClick: () => load(page + 1, false)
					}, loading ? "Loading…" : "Load more")
					: null,
				React.createElement("div", { className: "dsh-github-modal-foot" },
					React.createElement("button", { className: "dsh-github-back", onClick: onBack }, "Back"),
					React.createElement("button", { className: "dsh-github-close", onClick: onCancel }, "Close")));
		}

		/**
		 * Self-contained local directory picker (Option B): navigate the host
		 * filesystem, create a folder, and report the chosen path. Drives the
		 * host `github/local-list` / `github/local-create` handlers, so no
		 * harness directory-picker backend is required.
		 */
		function LocalDirDialog({ localList, localCreate, onPicked, onCancel, onError }) {
			const [path, setPath] = React.useState("");
			const [entries, setEntries] = React.useState([]);
			const [hasParent, setHasParent] = React.useState(false);
			const [loading, setLoading] = React.useState(false);
			const [error, setError] = React.useState("");
			const [newName, setNewName] = React.useState("");

			const load = (p) => {
				setLoading(true); setError("");
				localList(p).then((r) => {
					setPath(r.path); setEntries(r.entries || []); setHasParent(!!r.hasParent);
				}).catch((err) => setError(String((err && err.message) || err))).then(() => setLoading(false));
			};

			React.useEffect(() => { load(""); /* eslint-disable-line react-hooks/exhaustive-deps */ }, []);

			const makeDir = () => {
				if (!newName.trim()) return;
				setError(""); setLoading(true);
				localCreate(path, newName.trim())
					.then((r) => { setNewName(""); load(r.path); })
					.catch((err) => setError(String((err && err.message) || err)))
					.then(() => setLoading(false));
			};

			return React.createElement("div", { className: "dsh-github-local" },
				React.createElement("div", { className: "dsh-github-modal-head" },
					React.createElement("span", null, "Add local workspace"),
					React.createElement("span", { className: "dsh-github-path" }, path || "…")),
				error ? React.createElement("div", { className: "dsh-github-error" }, error) : null,
				React.createElement("div", { className: "dsh-github-local-controls" },
					React.createElement("button", { className: "dsh-github-up", disabled: !hasParent || loading, onClick: () => load(path.replace(/\/[^/]*\/?$/, "") || "/") }, "Up"),
					React.createElement("input", { className: "dsh-github-new-name", placeholder: "New folder name", value: newName, onChange: (e) => setNewName(e.target.value) }),
					React.createElement("button", { className: "dsh-github-mkdir", disabled: !newName.trim() || loading, onClick: makeDir }, "Create")),
				React.createElement("div", { className: "dsh-github-list dsh-github-list-local" },
					loading && path === ""
						? React.createElement("div", { className: "dsh-github-loading" }, "Loading…")
						: (entries.length === 0 && !loading)
							? React.createElement("div", { className: "dsh-github-empty" }, "No subfolders")
							: entries.map((name) => React.createElement("button", {
							className: "dsh-github-dir",
							key: name,
							disabled: loading,
							onClick: () => load(path.replace(/\/$/, "") + "/" + name)
						}, name))),
				React.createElement("div", { className: "dsh-github-modal-foot" },
					React.createElement("button", { className: "dsh-github-back", disabled: loading, onClick: onCancel }, "Cancel"),
					React.createElement("button", { className: "dsh-github-import", disabled: loading, onClick: () => onPicked(path) }, "Use this folder")));
		}

		/**
		 * The workspace-add chooser occupant. Renders a small menu when the owner
		 * opens the flow (open=true): "Add local workspace" opens the compact
		 * local dialog; "Import from GitHub" opens the import modal.
		 */
		function WorkspaceAddChooser({ open, busy, onPicked, onCancel, onError, localList, localCreate, listRepos, importRepo }) {
			const [view, setView] = React.useState("menu");

			React.useEffect(() => { if (!open) { setView("menu"); } }, [open]);

			if (!open) return null;

			let content;
			if (view === "github") {
				content = React.createElement(GithubImportModal, {
					listRepos, importRepo,
					onPicked: (path) => onPicked(path),
					onError: (msg) => onError(msg),
					onBack: () => setView("menu"),
					onCancel: () => onCancel()
				});
			} else if (view === "local") {
				content = React.createElement(LocalDirDialog, {
					localList, localCreate,
					onPicked: (path) => onPicked(path),
					onError: (msg) => onError(msg),
					onCancel: () => onCancel()
				});
			} else {
				content = React.createElement("div", { className: "dsh-github-chooser" },
					React.createElement("div", { className: "dsh-github-chooser-title" }, "Add workspace"),
					React.createElement("button", { className: "dsh-github-choice", disabled: busy, onClick: () => setView("local") }, "Add local workspace"),
					React.createElement("button", { className: "dsh-github-choice", disabled: busy, onClick: () => setView("github") }, "Import from GitHub"),
					React.createElement("button", { className: "dsh-github-choice dsh-github-cancel", onClick: onCancel }, "Cancel"));
			}

			// Render as a modal overlay (a new stacking/event context) rather than
			// inline in the owner's popover row. The fixed backdrop isolates our
			// clicks from the owner's close/outside-click handler and centers the
			// dialog like the in-app browse dialog.
			return React.createElement("div", {
				className: "dsh-github-overlay",
				onMouseDown: (e) => { if (e.target === e.currentTarget) onCancel(); }
			}, React.createElement("div", { className: "dsh-github-dialog" }, content));
		}

		/**
		 * Settings → Plugins → GitHub card: shows token status, lets the user set
		 * the PAT (written host-side to the credentials domain) and edit
		 * cloneRoot / shallow through the `github` settings namespace.
		 */
		function GithubSettingsCard({ getStatus, setToken, clearToken, settingsScope }) {
			const [snapshot, setSnapshot] = React.useState(null);
			const [configured, setConfigured] = React.useState(null);
			const [cloneRoot, setCloneRoot] = React.useState("");
			const [shallow, setShallow] = React.useState(true);
			const [token, setTokenInput] = React.useState("");
			const [status, setStatus] = React.useState("");
			const [busy, setBusy] = React.useState(false);

			const scope = settingsScope && settingsScope.bind ? settingsScope.bind({ ns: "github" }) : null;

			const refresh = () => {
				const snap = scope ? scope.getSnapshot() : null;
				setSnapshot(snap);
				const section = snap && typeof snap.getSnapshot === "function" ? snap : snap;
				setCloneRoot((section && section.cloneRoot) || "");
				setShallow((section && section.shallow) === false ? false : true);
				getStatus().then((s) => setConfigured(!!s.configured)).catch(() => setConfigured(false));
			};

			React.useEffect(() => {
				if (!scope) { setStatus("Settings channel unavailable"); return; }
				refresh();
				const unsub = scope.subscribe && scope.subscribe(() => refresh());
				return () => { if (unsub) unsub(); };
				/* eslint-disable-line react-hooks/exhaustive-deps */
			}, []);

			const saveConfig = () => {
				setBusy(true); setStatus("");
				const writes = [];
				if (scope && typeof scope.set === "function") {
					if (cloneRoot !== snapshot.cloneRoot) writes.push(scope.set("cloneRoot", cloneRoot));
					if (shallow !== snapshot.shallow) writes.push(scope.set("shallow", shallow));
				}
				Promise.all(writes).then(() => {
					if (token) return setToken({ value: token }).then(() => { setTokenInput(""); setStatus("Saved"); });
					setStatus("Saved");
				}).catch((err) => setStatus(String((err && err.message) || err))).then(() => setBusy(false));
			};

			return React.createElement("div", { className: "dsh-github-card" },
				React.createElement("div", { className: "dsh-github-card-status" },
					configured === true ? "Token configured" : configured === false ? "Token not configured" : "Checking…",
					status ? React.createElement("span", { className: "dsh-github-card-detail" }, " (" + status + ")") : null),
				React.createElement("label", { className: "dsh-github-field" },
					"Personal access token",
					React.createElement("input", {
						type: "password", value: token, placeholder: configured ? "•••••••• (leave blank to keep)" : "ghp_…",
						onChange: (e) => setTokenInput(e.target.value)
					})),
				React.createElement("label", { className: "dsh-github-field" },
					"Clone root",
					React.createElement("input", { value: cloneRoot, onChange: (e) => setCloneRoot(e.target.value) })),
				React.createElement("label", { className: "dsh-github-field" },
					React.createElement("input", { type: "checkbox", checked: shallow, onChange: (e) => setShallow(e.target.checked) }),
					" Shallow clone"),
				React.createElement("div", { className: "dsh-github-card-actions" },
					React.createElement("button", { className: "dsh-github-save", disabled: busy, onClick: saveConfig }, busy ? "Saving…" : "Save"),
					configured
						? React.createElement("button", { className: "dsh-github-clear", disabled: busy, onClick: () => { setBusy(true); clearToken().catch((e) => setStatus(String(e.message || e))).then(() => { setConfigured(false); setBusy(false); }); } }, "Clear token")
						: null));
		}

		/**
		 * Plugin body: register the chooser into both directory-flow holes (the
		 * native occupant's two-hole pattern) and the settings card.
		 */
		function apply(ctx) {
			const injected = () => ({
				localList: (args) => hostCall(ctx, "github/local-list", args),
				localCreate: (args) => hostCall(ctx, "github/local-create", args),
				listRepos: (args) => hostCall(ctx, "github/list-user-repos", args),
				importRepo: (args) => hostCall(ctx, "github/import", args),
				getStatus: () => hostCall(ctx, "github/status", {}),
				setToken: (args) => hostCall(ctx, "github/set-token", args),
				clearToken: () => hostCall(ctx, "github/clear-token", {}),
				settingsScope: ctx.get("settingsScope")
			});

			ctx.slots.inject("conversation.hero.workspace.directoryFlow", () => ctx.slots.inject("sidebar.workspaces.directoryFlow", function* () {
				yield ctx.slots.register({
					name: "conversation.hero.workspace.directoryFlow",
					inject: injected
				}, WorkspaceAddChooser);
				yield ctx.slots.register({
					name: "sidebar.workspaces.directoryFlow",
					inject: injected
				}, WorkspaceAddChooser);
			}));

			ctx.slots.inject("settings.plugin.item", () => ctx.slots.register({
				name: "settings.plugin.item",
				key: "github",
				locale: "github",
				inject: injected
			}, GithubSettingsCard));
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
