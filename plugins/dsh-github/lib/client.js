/*!
 * dsh-github browser half — a lazy-CJS bundle served by the harness client
 * module system. It occupies ui-workspace's two directory-flow holes with a
 * chooser ("Add local workspace" / "Import from GitHub"), renders the GitHub
 * import modal, and registers a Settings → Plugins card for the token.
 *
 * All GitHub work runs on the host (the PAT never crosses the wire): the client
 * calls the host through the generic Connection RPC channel
 * (`ctx.connection.rpc.call('/github', method, args)`), with the host handlers
 * declared in index.js. The channel is namespaced to this plugin so it never
 * collides with another plugin's RPC channel (dsh-notify owns `/notify`).
 */
window.__ModuleLoader__.load({
	id: "dsh-github",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		var React = require("react");
		var primitives = require("@deepseek-ai/dsh-client-ui-primitives");

		/* Styles for the import/local dialogs and the settings card.
		 *
		 * The dialogs use the native `Modal`/`Menu`/`Button` primitives, so their
		 * surfaces, backdrops, focus handling, and buttons come from the harness
		 * theme; these rules only size the dialog and style the repo/dir rows the
		 * primitives don't provide. The settings card chrome and field rules mirror
		 * the shipped `PluginCard` / `fields` CSS from
		 * @deepseek-ai/dsh-client-ui-settings-plugins — the card sits in the same
		 * `<ul>` as the Shell / Agent loop / Web search cards, which it must match.
		 */
		var STYLES = [
			// Dialog surface (sized only; the Modal primitive supplies the rest).
			".dsh-github-dialog{gap:0;padding:0;width:min(560px,100%);height:min(520px,100dvh - 32px);}",
			".dsh-github-modal,.dsh-github-local{display:flex;flex-direction:column;gap:2px;padding:6px;min-height:0;flex:1;}",
			".dsh-github-modal-head{display:flex;align-items:center;justify-content:space-between;gap:8px;border-bottom:1px solid var(--dsw-alias-border-l2);padding-bottom:8px;margin-bottom:6px;}",
			".dsh-github-search{flex:1;min-width:0;padding:7px 9px;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;}",
			".dsh-github-list{height:280px;overflow:auto;display:flex;flex-direction:column;gap:2px;padding:4px;}",
			".dsh-github-row{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 10px;border-radius:7px;}",
			".dsh-github-row:hover{background:var(--dsw-alias-bg-module-platform);}",
			".dsh-github-row-main{display:flex;flex-direction:column;gap:2px;min-width:0;}",
			".dsh-github-row-title{font-weight:600;font-size:13px;color:var(--dsw-alias-label-primary);}",
			".dsh-github-row-desc{color:var(--dsw-alias-label-tertiary);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}",
			".dsh-github-row-meta{display:flex;gap:6px;flex-wrap:wrap;align-items:center;font-size:11px;color:var(--dsw-alias-label-tertiary);}",
			".dsh-github-badge{background:var(--dsw-alias-bg-module-platform);padding:1px 6px;border-radius:999px;color:var(--dsw-alias-label-secondary);}",
			".dsh-github-private{color:var(--dsw-alias-label-tertiary);}",
			".dsh-github-empty,.dsh-github-loading,.dsh-github-error{color:var(--dsw-alias-label-secondary);font-size:12px;padding:12px;text-align:center;}",
			".dsh-github-error{color:var(--dsw-alias-state-error-primary);}",
			".dsh-github-dir{display:flex;align-items:center;gap:8px;width:100%;padding:10px 12px;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-primary);cursor:pointer;text-align:left;font:inherit;font-size:13px;}",
			".dsh-github-dir:hover{background:var(--dsw-alias-bg-module-platform);}",
			".dsh-github-dir:disabled{opacity:.5;cursor:default;}",
			".dsh-github-modal-foot{display:flex;justify-content:flex-end;gap:8px;padding:8px 6px 4px;}",
			".dsh-github-local-controls{display:flex;gap:8px;padding:8px 10px;align-items:center;}",
			".dsh-github-new-name{flex:1;padding:7px 9px;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;}",
			".dsh-github-path{font-size:11px;font-weight:400;color:var(--dsw-alias-label-tertiary);}",
			// Settings card chrome — matches the shipped PluginCard.
			".dsh-github-card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;list-style:none;transition:border-color .16s,background .16s;}",
			".dsh-github-card:hover{border-color:var(--dsw-alias-label-dimmed);}",
			".dsh-github-cardOpen{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed);}",
			".dsh-github-card-head{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:0 0;border:0;border-radius:12px;align-items:center;gap:12px;padding:14px 16px;display:flex;}",
			".dsh-github-card-head:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px;}",
			".dsh-github-card-headText{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex;}",
			".dsh-github-card-name{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4;}",
			".dsh-github-card-description{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5;}",
			".dsh-github-card-chevron{color:var(--dsw-alias-label-tertiary);flex:none;transition:transform .16s;}",
			".dsh-github-card-chevronOpen{transform:rotate(180deg);}",
			".dsh-github-card-body{border-top:1px solid var(--dsw-alias-border-l2);margin:0 16px;padding-bottom:8px;}",
			".dsh-github-card-readOnly{color:var(--dsw-alias-label-tertiary);margin:12px 0 0;font-size:12px;line-height:1.5;}",
			".dsh-github-card-pending{white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;flex:none;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px;}",
			".dsh-github-card-footer{border-top:1px solid var(--dsw-alias-border-l2);justify-content:flex-end;align-items:center;gap:8px;padding:12px 0 4px;display:flex;}",
			".dsh-github-card-failed{min-width:0;color:var(--dsw-alias-label-error);flex:1;margin:0;font-size:12px;line-height:1.5;}",
			".dsh-github-card-discard,.dsh-github-card-save{appearance:none;font:inherit;cursor:pointer;border:1px solid #0000;border-radius:8px;padding:5px 14px;font-size:13px;line-height:1.5;}",
			".dsh-github-card-discard{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:0 0;}",
			".dsh-github-card-discard:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed);}",
			".dsh-github-card-save{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3);}",
			".dsh-github-card-discard:disabled,.dsh-github-card-save:disabled{opacity:.4;cursor:default;}",
			".dsh-github-card-discard:focus-visible,.dsh-github-card-save:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px;}",
			// Card fields (ValueField / SecretField chrome).
			".dsh-github-field{flex-direction:column;gap:6px;padding:12px 0;display:flex;}",
			".dsh-github-field+.dsh-github-field{border-top:1px solid var(--dsw-alias-border-l2);}",
			".dsh-github-field-head{align-items:center;gap:8px;display:flex;}",
			".dsh-github-field-control{align-items:center;gap:8px;display:flex;color:var(--dsw-alias-label-primary);font-size:13px;}",
			".dsh-github-field-label{min-width:0;color:var(--dsw-alias-label-primary);flex:1;font-size:13px;font-weight:500;line-height:1.5;}",
			".dsh-github-field-badges{align-items:center;gap:8px;display:inline-flex;}",
			".dsh-github-field-badge{white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px;}",
			".dsh-github-field-badgeMuted{white-space:nowrap;color:var(--dsw-alias-label-tertiary);border-radius:999px;padding:1px 8px;font-size:11px;line-height:17px;}",
			".dsh-github-field-reset{font:inherit;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;padding:0;font-size:12px;line-height:1.5;}",
			".dsh-github-field-reset:hover:not(:disabled){color:var(--dsw-alias-label-primary);}",
			".dsh-github-field-reset:disabled{cursor:default;}",
			".dsh-github-field-input{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);height:34px;font:inherit;color:var(--dsw-alias-label-primary);border-radius:8px;padding:0 12px;font-size:13px;line-height:1.5;}",
			".dsh-github-field-input:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none;}",
			".dsh-github-field-input:disabled{color:var(--dsw-alias-label-tertiary);cursor:default;}",
			".dsh-github-field-input[type=checkbox]{height:auto;width:auto;padding:0;}",
			".dsh-github-field-hint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:1.5;}"
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
			return rpc.call("/github", method, args).then((result) => {
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
				? items.filter((it) => it.fullName.toLowerCase().includes(q) || (it.description || "").toLowerCase().includes(q))
				: items;

			const importRepoRow = (repo) => {
				setImporting(repo.fullName);
				setError("");
				importRepo({ repo: repo.fullName, branch: repo.defaultBranch, shallow: true })
					.then((res) => { if (!res || !res.path) throw new RepoImportError("No workspace path returned"); onPicked(res.path); })
					.catch((err) => setError(String((err && err.message) || err)))
					.then(() => setImporting(""));
			};

			const rows = filtered.map((it) => {
				const meta = React.createElement("div", { className: "dsh-github-row-meta" },
					it.language ? React.createElement("span", { className: "dsh-github-badge" }, it.language) : null,
					React.createElement("span", { className: "dsh-github-badge" }, String(it.stars) + " stars"),
					it.private ? React.createElement("span", { className: "dsh-github-badge dsh-github-private" }, "private") : null);
				const main = React.createElement("div", { className: "dsh-github-row-main" },
					React.createElement("div", { className: "dsh-github-row-title" }, it.fullName),
					it.description ? React.createElement("div", { className: "dsh-github-row-desc" }, it.description) : null,
					meta);
				const action = React.createElement(primitives.Button, {
					variant: "primary",
					disabled: importing !== "",
					onClick: () => importRepoRow(it)
				}, importing === it.fullName ? "Importing…" : "Import");
				return React.createElement("div", { className: "dsh-github-row", key: it.fullName }, main, action);
			});

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
				error ? React.createElement("div", { className: "dsh-github-error" }, error) : null,
				React.createElement("div", { className: "dsh-github-list" },
					loading && items.length === 0
						? React.createElement("div", { className: "dsh-github-loading" }, "Loading repositories…")
						: filtered.length === 0 && !loading
							? React.createElement("div", { className: "dsh-github-empty" }, "No repositories")
							: rows),
				hasMore
					? React.createElement(primitives.Button, { variant: "outline", disabled: loading, onClick: () => load(page + 1, false) }, loading ? "Loading…" : "Load more")
					: null,
				React.createElement("div", { className: "dsh-github-modal-foot" },
					React.createElement(primitives.Button, { variant: "outline", onClick: onBack }, "Back"),
					React.createElement(primitives.Button, { variant: "outline", onClick: onCancel }, "Close")));
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

			const dirRows = entries.map((name) => React.createElement("button", {
				className: "dsh-github-dir",
				key: name,
				disabled: loading,
				onClick: () => load(path.replace(/\/$/, "") + "/" + name)
			}, name));

			return React.createElement("div", { className: "dsh-github-local" },
				React.createElement("div", { className: "dsh-github-modal-head" },
					React.createElement("span", null, "Add local workspace"),
					React.createElement("span", { className: "dsh-github-path" }, path || "…")),
				error ? React.createElement("div", { className: "dsh-github-error" }, error) : null,
				React.createElement("div", { className: "dsh-github-local-controls" },
					React.createElement(primitives.Button, { variant: "outline", disabled: !hasParent || loading, onClick: () => load(path.replace(/\/[^/]*\/?$/, "") || "/") }, "Up"),
					React.createElement("input", { className: "dsh-github-new-name", placeholder: "New folder name", value: newName, onChange: (e) => setNewName(e.target.value) }),
					React.createElement(primitives.Button, { variant: "outline", disabled: !newName.trim() || loading, onClick: makeDir }, "Create")),
				React.createElement("div", { className: "dsh-github-list dsh-github-list-local" },
					loading && path === ""
						? React.createElement("div", { className: "dsh-github-loading" }, "Loading…")
						: (entries.length === 0 && !loading)
							? React.createElement("div", { className: "dsh-github-empty" }, "No subfolders")
							: dirRows),
				React.createElement("div", { className: "dsh-github-modal-foot" },
					React.createElement(primitives.Button, { variant: "outline", disabled: loading, onClick: onCancel }, "Cancel"),
					React.createElement(primitives.Button, { variant: "primary", disabled: loading, onClick: () => onPicked(path) }, "Use this folder")));
		}

		/**
		 * The workspace-add chooser occupant. The owner renders the flow occupant
		 * inline, so this renders a native `Menu` (anchored to the flow's own
		 * position via `getAnchorRect`) that lists where to add from; picking an
		 * option opens that flow as a dialog.
		 */
		function WorkspaceAddChooser({ open, busy, onPicked, onCancel, onError, localList, localCreate, listRepos, importRepo }) {
			const [view, setView] = React.useState("menu");
			const anchorRef = React.useRef(null);
			const selectingRef = React.useRef(false);

			React.useEffect(() => { if (!open) { setView("menu"); } }, [open]);

			if (!open) return null;

			if (view === "menu") {
				return React.createElement(React.Fragment, null,
					React.createElement("span", { ref: anchorRef, style: { display: "inline-block", width: 0, height: 0, visibility: "hidden" } }),
					React.createElement(primitives.Menu, {
						open: open,
						portal: true,
						side: "bottom",
						getAnchorRect: () => (anchorRef.current ? anchorRef.current.getBoundingClientRect() : null),
						onClose: () => { if (!selectingRef.current) onCancel(); selectingRef.current = false; },
						onSelect: (id) => { selectingRef.current = true; if (id === "local") setView("local"); else if (id === "github") setView("github"); },
						items: [
							{ id: "local", label: "Local workspace", icon: React.createElement(primitives.IconFolderOpen16, { size: 16 }) },
							{ id: "github", label: "Import from GitHub", icon: React.createElement(primitives.IconPlusOutline16, { size: 16 }) }
						]
					}));
			}

			let modal;
			if (view === "github") {
				modal = React.createElement(GithubImportModal, {
					listRepos, importRepo,
					onPicked: (path) => onPicked(path),
					onError: (msg) => onError(msg),
					onBack: () => setView("menu"),
					onCancel: () => onCancel()
				});
			} else {
				modal = React.createElement(LocalDirDialog, {
					localList, localCreate,
					onPicked: (path) => onPicked(path),
					onError: (msg) => onError(msg),
					onCancel: () => onCancel()
				});
			}

			// Chosen flow renders through the native Modal primitive
			// (`@deepseek-ai/dsh-client-ui-primitives`) rather than a hand-rolled
			// fixed overlay: it provides the backdrop, centering, focus handling,
			// escape-to-close, and the themed dialog surface. Each sub-view supplies
			// its own header/content/footer, matching the shipped directory-browser
			// dialog.
			return React.createElement(primitives.Modal, {
				open: open,
				onClose: () => { if (!busy) onCancel(); },
				title: view === "github" ? "Import from GitHub" : "Add local workspace",
				className: "dsh-github-dialog",
				headless: true
			}, modal);
		}

		/** Does the user layer carry an owned entry for this field (not value compare)? */
		function isOverridden(user, field) {
			return user != null && Object.prototype.hasOwnProperty.call(user, field);
		}

		/**
		 * The GitHub card's staged form over the `github` settings namespace.
		 *
		 * Mirrors the shipped `CardForm` model (available/writable/dirty/saving/
		 * failed + per-field overridden/reset) but adds a boolean `shallow` and a
		 * write-only PAT control written through the host RPC. Edits are staged
		 * and only written on save; the Host is the authority on acceptance.
		 *
		 * Reads the section through `snapshot.value?.field` (not the snapshot
		 * object itself) and binds the scope with `{ namespace }` — the
		 * `settingsScope.bind` spec key.
		 */
		class GithubSettingsCardController {
			constructor(injected) {
				this.getStatus = injected.getStatus;
				this.setToken = injected.setToken;
				this.clearToken = injected.clearToken;
				this.scope = injected.settingsScope && injected.settingsScope.bind
					? injected.settingsScope.bind({ namespace: "github" })
					: null;
				this.staged = new Map();
				this.saving = false;
				this.failed = false;
				this.tokenConfigured = null;
				this.listeners = new Set();
				this.offScope = null;
				if (this.scope && typeof this.scope.subscribe === "function") {
					this.offScope = this.scope.subscribe(() => this.publish());
				}
				this.refreshToken();
			}

			refreshToken() {
				if (!this.getStatus) return;
				this.getStatus().then((s) => {
					this.tokenConfigured = !!s.configured;
					this.publish();
				}).catch(() => {
					this.tokenConfigured = false;
					this.publish();
				});
			}

			snapshot() {
				return this.scope ? this.scope.getSnapshot() : null;
			}
			value() {
				const s = this.snapshot();
				return s && s.value ? s.value : {};
			}
			user() {
				const s = this.snapshot();
				return s && s.user ? s.user : {};
			}
			available() {
				const s = this.snapshot();
				return this.scope != null && s != null && s.status !== "unavailable";
			}
			writable() {
				const s = this.snapshot();
				return this.scope != null && s != null && !!s.writable;
			}

			/** One control's state: draft text/checked, and whether saving would leave an override. */
			field(field) {
				const staged = this.staged.get(field);
				if (field === "token") {
					return { text: staged ? staged.text : "", overridden: false, invalid: false };
				}
				if (field === "shallow") {
					const current = this.value().shallow !== false; // schema default true
					if (staged === undefined) return { checked: current, overridden: isOverridden(this.user(), "shallow"), invalid: false };
					if (staged.clear) return { checked: current, overridden: false, invalid: false };
					return { checked: staged.checked, overridden: true, invalid: false };
				}
				// cloneRoot (free text)
				const current = this.value().cloneRoot || "";
				if (staged === undefined) return { text: current, overridden: isOverridden(this.user(), "cloneRoot"), invalid: false };
				if (staged.clear) return { text: current, overridden: false, invalid: false };
				return { text: staged.text, overridden: true, invalid: false };
			}

			/** Whether a save would write anything (a non-blank token always counts). */
			dirty() {
				for (const [field, staged] of this.staged) {
					if (field === "token") { if (staged.text && staged.text.trim()) return true; continue; }
					if (field === "shallow") {
						const current = this.value().shallow !== false;
						if (staged.clear) { if (isOverridden(this.user(), "shallow")) return true; }
						else if (staged.checked !== current) return true;
					} else {
						const current = this.value().cloneRoot || "";
						if (staged.clear) { if (isOverridden(this.user(), "cloneRoot")) return true; }
						else if (staged.text !== current) return true;
					}
				}
				return false;
			}

			editCloneRoot(text) { this.stage("cloneRoot", { text, clear: false }); }
			resetCloneRoot() { this.stage("cloneRoot", { clear: true }); }
			toggleShallow(checked) { this.stage("shallow", { checked, clear: false }); }
			resetShallow() { this.stage("shallow", { clear: true }); }
			editToken(text) { this.stage("token", { text, clear: false }); }

			stage(field, edit) {
				this.staged.set(field, edit);
				this.failed = false;
				this.publish();
			}

			discard() {
				if (this.staged.size === 0 && !this.failed) return;
				this.staged.clear();
				this.failed = false;
				this.publish();
			}

			/** Write every staged edit, then re-seed from what the Host accepted. */
			async save() {
				if (!this.scope || this.saving) return;
				const writes = [];
				for (const [field, staged] of this.staged) {
					if (field === "token") {
						if (staged.text && staged.text.trim()) writes.push({ kind: "token", value: staged.text.trim() });
						continue;
					}
					if (field === "shallow") {
						if (staged.clear) { if (isOverridden(this.user(), "shallow")) writes.push({ kind: "set", field: "shallow", clear: true }); }
						else if (staged.checked !== (this.value().shallow !== false)) writes.push({ kind: "set", field: "shallow", value: staged.checked });
					} else {
						if (staged.clear) { if (isOverridden(this.user(), "cloneRoot")) writes.push({ kind: "set", field: "cloneRoot", clear: true }); }
						else if (staged.text !== (this.value().cloneRoot || "")) writes.push({ kind: "set", field: "cloneRoot", value: staged.text });
					}
				}
				this.saving = true; this.failed = false; this.publish();
				let landed = true;
				for (const write of writes) {
					try {
						if (write.kind === "token") await this.setToken({ value: write.value });
						else if (write.clear) await this.scope.unset(write.field);
						else await this.scope.set(write.field, write.value);
					} catch (error) {
						landed = false;
						break;
					}
				}
				if (landed) { this.staged.clear(); this.refreshToken(); }
				this.saving = false;
				this.failed = !landed;
				this.publish();
			}

			/** Write-only clear of the stored PAT (not a staged edit). */
			clearTokenAction() {
				if (!this.clearToken || this.tokenConfigured !== true) return Promise.resolve();
				this.tokenConfigured = false; this.publish();
				return this.clearToken().catch(() => {
					this.tokenConfigured = true;
					this.publish();
				});
			}

			projection() {
				return {
					available: this.available(),
					writable: this.writable(),
					dirty: this.dirty(),
					saving: this.saving,
					failed: this.failed,
					cloneRoot: this.field("cloneRoot"),
					shallow: this.field("shallow"),
					token: this.field("token"),
					tokenConfigured: this.tokenConfigured
				};
			}

			publish() { for (const listener of this.listeners) listener(); }
			subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
			dispose() { if (this.offScope) this.offScope(); this.listeners.clear(); }
		}

		/**
		 * Settings → Plugins → GitHub card: a collapsible plugin card matching the
		 * shipped `PluginCard` chrome. Shows the PAT status (write-only credential
		 * control) and lets the user edit cloneRoot / shallow through the `github`
		 * settings namespace with a staged save/discard model.
		 */
		function GithubSettingsCard(props) {
			const [controller] = React.useState(() => new GithubSettingsCardController(props));
			const [, force] = React.useState(0);
			const [open, setOpen] = React.useState(false);

			React.useEffect(() => {
				const off = controller.subscribe(() => force((n) => n + 1));
				return () => { off(); controller.dispose(); };
			}, [controller]);

			const state = controller.projection();
			if (!state.available) return null;

			const resettable = state.writable && !state.saving;
			const blocked = !state.dirty || state.saving;

			return React.createElement("li", { className: "dsh-github-card" + (open ? " dsh-github-cardOpen" : "") },
				React.createElement("button", {
					type: "button",
					className: "dsh-github-card-head",
					"aria-expanded": open,
					"aria-label": (open ? "Hide settings" : "Show settings") + ": GitHub",
					onClick: () => setOpen(!open)
				},
					React.createElement("span", { className: "dsh-github-card-headText" },
						React.createElement("span", { className: "dsh-github-card-name" }, "GitHub"),
						React.createElement("span", { className: "dsh-github-card-description" }, "Clone GitHub repos into this workspace and manage the access token.")),
					state.dirty ? React.createElement("span", { className: "dsh-github-card-pending" }, "Unsaved") : null,
					React.createElement(primitives.IconChevronDownOutline14, { size: 14, className: "dsh-github-card-chevron" + (open ? " dsh-github-card-chevronOpen" : "") })),
				open ? React.createElement("div", { className: "dsh-github-card-body" },
					!state.writable ? React.createElement("p", { className: "dsh-github-card-readOnly", role: "status" }, "This deployment stores settings read-only.") : null,
					React.createElement("div", { className: "dsh-github-field" },
						React.createElement("div", { className: "dsh-github-field-head" },
							React.createElement("label", { className: "dsh-github-field-label", htmlFor: "plugin-config-github-token" }, "Personal access token"),
							React.createElement("span", { className: "dsh-github-field-badges" },
								React.createElement("span", { className: state.tokenConfigured ? "dsh-github-field-badge" : "dsh-github-field-badgeMuted" },
									state.tokenConfigured === null ? "Checking…" : state.tokenConfigured ? "A key is configured." : "No key is configured; import is unavailable until one is."))),
						React.createElement("input", {
							id: "plugin-config-github-token",
							className: "dsh-github-field-input",
							type: "password",
							autoComplete: "off",
							value: state.token.text,
							disabled: !state.writable || state.saving,
							placeholder: state.tokenConfigured ? "•••••••• (leave blank to keep)" : "ghp_…",
							onChange: (e) => controller.editToken(e.target.value)
						}),
						React.createElement("p", { className: "dsh-github-field-hint" }, "Stored outside the settings file. Leave blank to keep the current key.")),
					React.createElement("div", { className: "dsh-github-field" },
						React.createElement("div", { className: "dsh-github-field-head" },
							React.createElement("label", { className: "dsh-github-field-label", htmlFor: "plugin-config-github-cloneRoot" }, "Clone root"),
							React.createElement("span", { className: "dsh-github-field-badges" },
								state.cloneRoot.overridden ? React.createElement("span", { className: "dsh-github-field-badge" }, "Overridden") : null,
								state.cloneRoot.overridden ? React.createElement("button", { type: "button", className: "dsh-github-field-reset", disabled: !resettable, onClick: () => controller.resetCloneRoot() }, "Reset to default") : null)),
						React.createElement("input", {
							id: "plugin-config-github-cloneRoot",
							className: "dsh-github-field-input",
							type: "text",
							value: state.cloneRoot.text,
							disabled: !state.writable || state.saving,
							onChange: (e) => controller.editCloneRoot(e.target.value)
						}),
						React.createElement("p", { className: "dsh-github-field-hint" }, "Directory imported repos are cloned under.")),
					React.createElement("div", { className: "dsh-github-field" },
						React.createElement("div", { className: "dsh-github-field-head" },
							React.createElement("label", { className: "dsh-github-field-label", htmlFor: "plugin-config-github-shallow" }, "Shallow clone"),
							React.createElement("span", { className: "dsh-github-field-badges" },
								state.shallow.overridden ? React.createElement("span", { className: "dsh-github-field-badge" }, "Overridden") : null,
								state.shallow.overridden ? React.createElement("button", { type: "button", className: "dsh-github-field-reset", disabled: !resettable, onClick: () => controller.resetShallow() }, "Reset to default") : null)),
						React.createElement("label", { className: "dsh-github-field-control" },
							React.createElement("input", {
								id: "plugin-config-github-shallow",
								className: "dsh-github-field-input",
								type: "checkbox",
								checked: state.shallow.checked,
								disabled: !state.writable || state.saving,
								onChange: (e) => controller.toggleShallow(e.target.checked)
							}),
							React.createElement("span", { className: "dsh-github-field-hint" }, "Clone with --depth 1 (full clone when off)"))),
					React.createElement("div", { className: "dsh-github-card-footer" },
						state.failed ? React.createElement("p", { className: "dsh-github-card-failed", role: "status" }, "The deployment did not accept these values; they were left for you to correct.") : null,
						state.tokenConfigured ? React.createElement("button", { type: "button", className: "dsh-github-card-discard", disabled: !resettable, onClick: () => controller.clearTokenAction() }, "Clear token") : null,
						React.createElement("button", { type: "button", className: "dsh-github-card-discard", disabled: !state.dirty || state.saving, onClick: () => controller.discard() }, "Discard"),
						React.createElement("button", { type: "button", className: "dsh-github-card-save", disabled: blocked, onClick: () => controller.save() }, state.saving ? "Saving…" : "Save")))
					: null);
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
				importRepo: (args) => hostCall(ctx, "github/import", args)
			});

			const settingsInjected = () => ({
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
				inject: settingsInjected
			}, GithubSettingsCard));
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
