/*!
 * dsh-github browser half — a lazy-CJS bundle served by the harness client
 * module system. It occupies ui-workspace's two directory-flow holes with a
 * chooser ("Add local workspace" / "Import from GitHub"), renders the GitHub
 * import modal, and registers a Settings → Plugins card for the token.
 *
 * All GitHub work runs on the host (the PAT never crosses the wire): the client
 * calls the host through Package-private client→host JSON RPC
 * (`host.call(method, args)`), with the host handlers declared in index.js.
 */
window.__ModuleLoader__.load({
	id: "dsh-github",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		var React = require("react");

		/** Required client services (Cordis fibre inject). */
		const inject = ["slots"];

		/** Bound client→host caller, resolved defensively from the context. */
		function hostCall(ctx, method, args) {
			const host = ctx.get("host");
			if (!host || typeof host.call !== "function") {
				throw new Error("GitHub host channel is unavailable");
			}
			return host.call(method, args);
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
					(filtered.length === 0 && !loading)
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
					(entries.length === 0 && !loading)
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

			if (view === "github") {
				return React.createElement(GithubImportModal, {
					listRepos, importRepo,
					onPicked: (path) => onPicked(path),
					onError: (msg) => onError(msg),
					onBack: () => setView("menu"),
					onCancel: () => onCancel()
				});
			}

			if (view === "local") {
				return React.createElement(LocalDirDialog, {
					localList, localCreate,
					onPicked: (path) => onPicked(path),
					onError: (msg) => onError(msg),
					onCancel: () => onCancel()
				});
			}

			return React.createElement("div", { className: "dsh-github-chooser" },
				React.createElement("div", { className: "dsh-github-chooser-title" }, "Add workspace"),
				React.createElement("button", { className: "dsh-github-choice", disabled: busy, onClick: () => setView("local") }, "Add local workspace"),
				React.createElement("button", { className: "dsh-github-choice", disabled: busy, onClick: () => setView("github") }, "Import from GitHub"),
				React.createElement("button", { className: "dsh-github-choice dsh-github-cancel", onClick: onCancel }, "Cancel"));
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
