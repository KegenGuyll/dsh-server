/**
 * dsh-github host plugin: contributes a `github` settings namespace (token env
 * ref, clone root, shallow flag, worktree options) plus the client→host handlers
 * the browser half invokes to list the user's repositories, import a repo as a
 * workspace, and run per-session worktrees. It also registers three agent-facing
 * worktree tools and wraps `workspaceRegistry.archiveSession` so archiving a
 * worktree-backed session removes the worktree.
 *
 * The client half addresses these methods through the generic Connection RPC
 * channel (`ctx.connection.rpc`, authority `trusted-host`), which works over the
 * tailnet. Everything runs on the host so the PAT never reaches the browser;
 * each handler re-resolves the token per call.
 */

import { randomUUID } from "node:crypto";
import z from "@deepseek-ai/schemastery";
import { join, dirname, isAbsolute, basename } from "node:path";
import { readdir, mkdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { listUserRepos, getRepo, gitClone, slug } from "./github.js";
import {
	isGitRepo,
	isLinkedWorktree,
	isWithin,
	resolveDefaultBranch,
	createWorktree,
	listWorktrees,
	prune,
	removeWorktree
} from "./worktree.js";

/** Build a typed directory-picker failure ({@link DirectoryPickerError})-shaped error. */
function dirError(code, path, message) {
	const error = new Error(message);
	error.code = code;
	error.path = path;
	return error;
}

/**
 * Browse-capability `list`: one directory level plus its ancestry, matching the
 * harness's `DirectoryListing` contract. Reused by the api gateway, which
 * injects `directoryPicker`; the client module system then serves it to any
 * consumer that still uses the directory-picker remote.
 */
async function listDir(path) {
	const target = path && isAbsolute(path) ? path : homedir();
	let dirents;
	try {
		dirents = await readdir(target, { withFileTypes: true });
	} catch {
		throw dirError("directory-unreadable", target, `cannot list directory '${target}'`);
	}
	const entries = dirents
		.filter((d) => d.isDirectory())
		.map((d) => ({ name: d.name, path: join(target, d.name), hidden: d.name.startsWith(".") }))
		.sort((a, b) => a.name.localeCompare(b.name));
	const crumbs = [];
	let cursor = join(target);
	for (;;) {
		crumbs.unshift({ name: dirname(cursor) === cursor ? cursor : basename(cursor) || cursor, path: cursor, hidden: false });
		if (dirname(cursor) === cursor) break;
		cursor = dirname(cursor);
	}
	return { path: join(target), home: homedir(), crumbs, entries, truncated: false };
}

/** Browse-capability `createDirectory`: one child directory, non-recursive. */
async function createDir(path, name) {
	if (!name || typeof name !== "string" || /[\\/]/.test(name) || name === "." || name === "..") {
		throw dirError("directory-create-failed", path, "directory name must be a single non-blank path segment");
	}
	const target = join(path, name);
	try {
		await mkdir(target, { recursive: false });
	} catch (error) {
		if (error?.code === "EEXIST") throw dirError("directory-exists", target, `'${name}' already exists`);
		throw dirError("directory-create-failed", target, String(error?.message ?? error));
	}
	return target;
}

/**
 * Brand a raw string as a credential reference name (a POSIX shell identifier).
 * Inlined to avoid importing @deepseek-ai/dsh-credentials, whose own entry
 * imports @deepseek-ai/cordis (a harness peer not resolvable from this
 * out-of-tree plugin's real path). The seam treats the branded string as a
 * plain identifier at runtime; this validates the same grammar it would.
 */
function credentialRef(value) {
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
		throw new TypeError(`credential ref "${value}" must match a POSIX shell identifier`);
	}
	return value;
}

/** Resolve the configured reference name (for the token write/clear handlers). */
function resolveRefName(scope) {
	const refName = scope.get().tokenEnv || "GITHUB_TOKEN";
	try {
		return credentialRef(refName);
	} catch {
		throw new Error(`github: tokenEnv "${refName}" is not a valid credential reference`);
	}
}

/** Default clone root = the process working directory (`/workspaces` in Docker). */
const DEFAULT_CLONE_ROOT = process.cwd();

/** Default worktree root: a `.dsh-worktrees` sibling under the process cwd (`/workspaces/.dsh-worktrees` in Docker). */
const DEFAULT_WORKTREE_ROOT = join(process.cwd(), ".dsh-worktrees");

/** Cordis plugin name used by loader diagnostics. */
const name = "github";

/** Services the host half requires. */
const inject = ["workspaceRegistry", "credentials", "settings"];

/** Deployment/user configuration: a credential reference, a clone root, shallow. */
const Config = z.object({
	/** Env-variable (credential ref) name that holds the GitHub PAT. */
	tokenEnv: z.string().default("GITHUB_TOKEN"),
	/** Directory (absolute) under which imported repos are cloned. */
	cloneRoot: z.string().default(DEFAULT_CLONE_ROOT),
	/** Clone with --depth 1 (full clone when false). */
	shallow: z.boolean().default(true),
	/** Master toggle: on New Session in a git-backed workspace, auto-create a per-session worktree. */
	worktreeEnabled: z.boolean().default(true),
	/** Absolute directory worktrees are created under. */
	worktreeRoot: z.string().default(DEFAULT_WORKTREE_ROOT),
	/** Base ref new worktrees start from, unless a tool call overrides. */
	worktreeBranch: z.string().default("origin/main"),
	/** Create worktrees at a detached HEAD (true) vs a fresh branch `dsh/…` (false). */
	worktreeDetached: z.boolean().default(true),
	/** Remove the worktree (and its workspace row) when its session is archived. */
	worktreeCleanupOnArchive: z.boolean().default(true),
	/** Cap concurrent worktrees per repo; refuse creating beyond it. */
	worktreeMaxPerRepo: z.number().default(50),
	/** Preserve the worktree if session creation fails afterward (debugging) vs auto-remove. */
	worktreeKeepOnFailure: z.boolean().default(false),
	/** On plugin start, `git worktree prune` and drop orphaned worktree workspace rows. */
	worktreePruneOnStartup: z.boolean().default(true)
});

/**
 * Resolve the effective worktree config, applying defaults at read time so a
 * settings document that omits a worktree key still yields every option.
 */
function wtConfig(scope) {
	const value = scope.get();
	const root = typeof value.worktreeRoot === "string" && isAbsolute(value.worktreeRoot)
		? value.worktreeRoot
		: DEFAULT_WORKTREE_ROOT;
	return {
		enabled: value.worktreeEnabled !== false,
		root,
		branch: (typeof value.worktreeBranch === "string" && value.worktreeBranch.trim()) || "origin/main",
		detached: value.worktreeDetached !== false,
		cleanupOnArchive: value.worktreeCleanupOnArchive !== false,
		maxPerRepo: Number.isFinite(value.worktreeMaxPerRepo) ? value.worktreeMaxPerRepo : 50,
		keepOnFailure: value.worktreeKeepOnFailure === true,
		pruneOnStartup: value.worktreePruneOnStartup !== false
	};
}

/**
 * Resolve the configured lookup name, then the value behind it, per operation.
 * @returns the PAT string, or `undefined` when absent.
 */
async function resolveToken(ctx, scope) {
	const hit = await ctx.credentials.resolve(resolveRefName(scope));
	return hit?.value;
}

/**
 * Import a GitHub repo as a workspace: clone into cloneRoot then register.
 * @returns {{ path: string, title: string, workspaceId: string }}
 */
async function createWorkspaceFromRepo(ctx, scope, args) {
	const token = await resolveToken(ctx, scope);
	const config = scope.get();
	const branch = args.branch?.trim() || undefined;
	const shallow = args.shallow === undefined ? config.shallow : !!args.shallow;

	// Resolve repo metadata (clone URL, default branch, private flag).
	const meta = await getRepo(token, args.repo);

	// owner-repo slug avoids collisions between same-named repos from different owners.
	const [owner, repoName] = meta.fullName.split("/");
	const dest = join(config.cloneRoot, `${slug(owner)}-${slug(repoName)}`);

	// Clone. Public repos need no credential; private repos authenticate via
	// git env-config (token never in argv).
	await gitClone({
		cloneUrl: meta.cloneUrl,
		dest,
		token: meta.private ? token : undefined,
		branch,
		shallow
	});

	const workspace = await ctx.workspaceRegistry.create(dest, meta.fullName);
	return { path: dest, title: meta.fullName, workspaceId: workspace.id };
}

/**
 * List direct subdirectories for the self-contained local pick (Option B). The
 * dialog drives these to navigate the host filesystem without depending on the
 * harness directory-picker backend. Defaults to the working directory
 * (`/workspaces` in Docker).
 */
async function localList(path) {
	const target = path && isAbsolute(path) ? path : process.cwd();
	const dirents = await readdir(target, { withFileTypes: true });
	const entries = dirents.filter((d) => d.isDirectory()).map((d) => d.name).sort((a, b) => a.localeCompare(b));
	const resolved = join(target);
	return { path: resolved, entries, hasParent: dirname(resolved) !== resolved };
}

/** Create one child directory (non-recursive) for the local pick. */
async function localCreate(path, name) {
	if (!name || typeof name !== "string" || name.trim().length === 0) throw new Error("a directory name is required");
	const target = join(path, name.trim());
	await mkdir(target, { recursive: false });
	return { path: target };
}

// ── Worktree helpers ───────────────────────────────────────────────────────

/** Resolve a `repo` argument (a workspace id or a filesystem path) to a git repo path. */
async function resolveRepoPath(ctx, repo) {
	const workspace = typeof repo === "string" ? ctx.get("workspaceRegistry")?.get(repo) : undefined;
	if (workspace) return workspace.path;
	const candidate = typeof repo === "string" && isAbsolute(repo) ? repo : join(process.cwd(), String(repo ?? ""));
	if (!(await isGitRepo(candidate))) throw new Error(`'${repo}' is not a git repository`);
	return candidate;
}

/** Read-only info a client needs to decide whether to route a New Session through worktrees. */
async function workspaceInfo(ctx, scope, workspaceId) {
	const ws = ctx.get("workspaceRegistry")?.get(workspaceId);
	const wt = wtConfig(scope);
	if (!ws) return { isGitRepo: false, worktreeEnabled: false, repoPath: null, defaultBranch: null };
	const git = await isGitRepo(ws.path);
	return {
		isGitRepo: git,
		worktreeEnabled: wt.enabled && git,
		repoPath: git ? ws.path : null,
		defaultBranch: git ? await resolveDefaultBranch(ws.path) : null,
		keepOnFailure: wt.keepOnFailure
	};
}

/**
 * Create one worktree for a repo and register it as a workspace. The directory
 * is `<root>/<repo-slug>/<sessionId>` so the path is human-readable and
 * exactly determinable from the session id for cleanup. The caller (client or
 * tool) passes the returned `sessionId` into the subsequent session create so
 * the session lands in this worktree workspace.
 */
async function createWorktreeFromRepo(ctx, scope, { repo, branch, name, sessionId }) {
	const wt = wtConfig(scope);
	if (!wt.enabled) throw new Error("worktrees are disabled (enable in the GitHub plugin settings)");
	const repoPath = await resolveRepoPath(ctx, repo);
	if (!(await isGitRepo(repoPath))) throw new Error(`'${repoPath}' is not a git repository`);
	const session = sessionId && /^session-[A-Za-z0-9-]+$/.test(sessionId) ? sessionId : `session-${randomUUID()}`;
	const ref = (typeof branch === "string" && branch.trim()) || wt.branch;

	// Cap concurrent worktrees per repo (the main checkout is never counted).
	const existing = (await listWorktrees(repoPath)).filter((w) => w.path !== repoPath);
	if (wt.maxPerRepo > 0 && existing.length >= wt.maxPerRepo) {
		throw new Error(`repo '${repoPath}' already has ${existing.length} worktrees (max ${wt.maxPerRepo}); remove some first`);
	}

	const dest = join(wt.root, slug(basename(repoPath)), session);
	if (!isWithin(wt.root, dest)) throw new Error(`worktree path '${dest}' escapes the worktree root '${wt.root}'`);
	await createWorktree({
		repoPath,
		dest,
		ref,
		detach: wt.detached,
		newBranch: wt.detached ? undefined : `dsh/${session.replace(/^session-/, "").slice(0, 12)}`
	});
	const workspace = await ctx.get("workspaceRegistry").create(dest, `${basename(repoPath)} (${session.slice(0, 12)})`);
	return { worktreePath: dest, worktreeWorkspaceId: workspace.id, sessionId: session, branch: ref, repoPath };
}

/** Remove a worktree and its workspace registration, guarded to the worktree root. */
async function removeWorktreeOp(ctx, scope, args) {
	const wt = wtConfig(scope);
	let worktreePath;
	let workspaceId;
	if (args?.worktreeWorkspaceId) {
		const ws = ctx.get("workspaceRegistry")?.get(args.worktreeWorkspaceId);
		if (!ws) throw new Error(`github: unknown worktree workspace '${args.worktreeWorkspaceId}'`);
		worktreePath = ws.path;
		workspaceId = ws.id;
	} else if (args?.worktreePath) {
		worktreePath = args.worktreePath;
		workspaceId = (await ctx.get("workspaceRegistry").resolveByPath(worktreePath))?.id;
	} else {
		throw new Error("github/remove-worktree: `worktreePath` or `worktreeWorkspaceId` is required");
	}
	if (!(isWithin(wt.root, worktreePath) && await isLinkedWorktree(worktreePath))) {
		throw new Error(`github: refusing to remove '${worktreePath}' — not a worktree under the configured worktree root`);
	}
	await removeWorktree({ worktreePath, repoPath: undefined });
	if (workspaceId) await ctx.get("workspaceRegistry").delete(workspaceId);
	return { removed: true, worktreePath };
}

/** List a repo's worktrees, tagged with whether each is a managed (plugin-created) one. */
async function listWorktreesOp(ctx, scope, args) {
	const wt = wtConfig(scope);
	const repoPath = await resolveRepoPath(ctx, args?.repo ?? args?.repoPath ?? process.cwd());
	const list = await listWorktrees(repoPath);
	const out = [];
	for (const w of list) {
		out.push({
			path: w.path,
			branch: w.branch ?? null,
			head: w.head ?? null,
			detached: !!w.detached,
			managed: isWithin(wt.root, w.path) && await isLinkedWorktree(w.path)
		});
	}
	return { repoPath, worktrees: out };
}

/** Remove the worktree backing a session (used on archive). */
async function cleanupWorktreeForSession(ctx, scope, sessionId) {
	const wt = wtConfig(scope);
	if (!wt.cleanupOnArchive) return;
	let cwd;
	const live = ctx.get("sessions")?.get(sessionId);
	if (live) cwd = live.header?.cwd;
	if (cwd === undefined) {
		const persistence = ctx.get("sessionPersistence");
		if (typeof persistence?.list === "function") {
			const headers = await persistence.list();
			cwd = headers.find((h) => h.id === sessionId)?.cwd;
		}
	}
	if (!cwd || !isWithin(wt.root, cwd) || !(await isLinkedWorktree(cwd))) return;
	const registry = ctx.get("workspaceRegistry");
	const existing = await registry.resolveByPath(cwd);
	await removeWorktree({ worktreePath: cwd, repoPath: undefined });
	if (existing) await registry.delete(existing.id).catch(() => {});
}

/**
 * Wrap `workspaceRegistry.archiveSession` so that archiving a worktree-backed
 * session also removes its worktree. There is no dedicated "session archived"
 * event, and the UI archive path funnels through this method, so this is the
 * single reliable seam. The wrapper is installed and uninstalled through the
 * plugin fiber, so a stop/update restores the original implementation.
 */
function wrapArchiveSession(ctx, scope) {
	const registry = ctx.get("workspaceRegistry");
	if (!registry || typeof registry.archiveSession !== "function") return;
	const original = registry.archiveSession.bind(registry);
	registry.archiveSession = async (sessionId) => {
		const result = await original(sessionId);
		await cleanupWorktreeForSession(ctx, scope, sessionId)
			.catch((error) => ctx.logger?.warn(`github: worktree cleanup on archive failed: ${String(error?.message ?? error)}`));
		return result;
	};
	const restore = () => { registry.archiveSession = original; };
	if (typeof ctx.effect === "function") ctx.effect(restore);
	else ctx.on?.("dispose", restore);
}

/** On plugin start, prune stale worktree metadata and drop orphaned rows. */
async function startupPrune(ctx, scope) {
	const wt = wtConfig(scope);
	if (!wt.pruneOnStartup) return;
	const registry = ctx.get("workspaceRegistry");
	if (!registry) return;
	const ids = registry.list().map((w) => w.id);
	for (const id of ids) {
		const ws = registry.get(id);
		if (!ws || !(await isGitRepo(ws.path))) continue;
		await prune(ws.path).catch(() => {});
	}
	// Drop registrations whose directory disappeared (crashed/removed worktrees).
	for (const id of ids) {
		const ws = registry.get(id);
		if (!ws || !isWithin(wt.root, ws.path)) continue;
		try {
			await stat(ws.path);
		} catch {
			await registry.delete(id).catch(() => {});
		}
	}
}

/**
 * Register the worktree model tools. The current session's workspace (`cwd`)
 * is the default repo when none is named, so within a worktree session the
 * agent can branch another worktree off the same repository without naming it.
 */
function registerTools(ctx, scope) {
	const tools = ctx.get("tools");
	if (!tools || typeof tools.register !== "function") {
		ctx.logger?.warn("github: tools service unavailable — worktree tools not registered");
		return;
	}

	tools.register({
		name: "github_create_worktree",
		description:
			"Create a fresh Git worktree of a repository and register it as a DSH workspace. " +
			"The worktree is created on the configured base ref (default origin/main) unless `branch` is given; " +
			"`repo` may be a workspace id or an absolute repo path and defaults to the current session's workspace. " +
			"Returns the worktree path, its branch, and its new workspace id — open a session in that workspace to work inside it.",
		parameters: {
			type: "object",
			properties: {
				repo: { type: "string", description: "Repo to branch from: a workspace id or an absolute path. Defaults to the current session workspace." },
				branch: { type: "string", description: "Branch or ref to start the worktree at (default origin/main)." },
				name: { type: "string", description: "Optional worktree name hint (used for the directory)." }
			}
		},
		output: {
			schema: { type: "string" },
			render(_args, value) { return [{ type: "text", text: String(value) }]; }
		},
		async execute(args, exec) {
			const wt = wtConfig(scope);
			if (!wt.enabled) return "github_create_worktree: worktrees are disabled (enable in the GitHub plugin settings).";
			const repo = (args.repo && String(args.repo).trim()) || exec?.agent?.session?.header?.cwd;
			if (!repo) return "github_create_worktree: a repo path or workspace id is required.";
			try {
				const result = await createWorktreeFromRepo(ctx, scope, { repo, branch: args.branch, name: args.name });
				return `Created worktree ${result.worktreePath} (branch ${result.branch}, workspace ${result.worktreeWorkspaceId}). Open a session in that workspace to work in it.`;
			} catch (error) {
				return `github_create_worktree: ${String(error?.message ?? error)}`;
			}
		}
	});

	tools.register({
		name: "github_list_worktrees",
		description:
			"List the Git worktrees of a repository (path, branch/HEAD, and whether each was created by this plugin). " +
			"`repo` may be a workspace id or an absolute repo path and defaults to the current session's workspace.",
		parameters: {
			type: "object",
			properties: {
				repo: { type: "string", description: "Repo to inspect: a workspace id or an absolute path. Defaults to the current session workspace." }
			}
		},
		output: {
			schema: { type: "string" },
			render(_args, value) { return [{ type: "text", text: String(value) }]; }
		},
		async execute(args, exec) {
			const repo = (args.repo && String(args.repo).trim()) || exec?.agent?.session?.header?.cwd;
			if (!repo) return "github_list_worktrees: a repo path or workspace id is required.";
			try {
				const result = await listWorktreesOp(ctx, scope, { repo });
				const rows = result.worktrees.map((w) => `- ${w.path}${w.branch ? ` (branch ${w.branch})` : ""}${w.detached ? " [detached]" : ""}${w.managed ? " [managed]" : ""}`);
				return rows.length ? `Worktrees of ${result.repoPath}:\n${rows.join("\n")}` : `No worktrees for ${result.repoPath}.`;
			} catch (error) {
				return `github_list_worktrees: ${String(error?.message ?? error)}`;
			}
		}
	});

	tools.register({
		name: "github_remove_worktree",
		description:
			"Remove a Git worktree created by this plugin and unregister its DSH workspace. " +
			"Pass its `worktreeWorkspaceId` (from github_create_worktree) or its absolute `worktreePath`. " +
			"Only worktrees under the configured worktree root can be removed.",
		parameters: {
			type: "object",
			properties: {
				worktreeWorkspaceId: { type: "string", description: "Workspace id of the worktree to remove." },
				worktreePath: { type: "string", description: "Or the absolute path of the worktree to remove." }
			}
		},
		output: {
			schema: { type: "string" },
			render(_args, value) { return [{ type: "text", text: String(value) }]; }
		},
		async execute(args) {
			if (!args.worktreeWorkspaceId && !args.worktreePath) return "github_remove_worktree: `worktreeWorkspaceId` or `worktreePath` is required.";
			try {
				const result = await removeWorktreeOp(ctx, scope, args);
				return `Removed worktree ${result.worktreePath} and unregistered its workspace.`;
			} catch (error) {
				return `github_remove_worktree: ${String(error?.message ?? error)}`;
			}
		}
	});
}

/**
 * Register the client→host handlers on the generic Connection RPC channel
 * (`ctx.connection.rpc`), the durable transport that works over the tailnet
 * with `authority: 'trusted-host'` (unlike the loopback-only settings RPCs that
 * 403 on a remote browser). `harness.handle`/`host.call` is the dynamic-Cordis
 * mechanism and is not available to a durable plugin, so it is not used here.
 *
 * The channel is namespaced to this plugin (`/github`): `connection.rpc`
 * registers one physical prefix route per channel, so two plugins must never
 * share a channel name. dsh-notify owns `/notify`; reserving a per-plugin
 * channel is what prevents the "duplicate prefix route" plugin-load failure.
 */
function registerHandlers(ctx, scope) {
	const conn = ctx.get("connection");
	const rpc = conn?.rpc;
	if (!rpc || typeof rpc.handle !== "function") {
		ctx.logger?.warn("github: connection RPC unavailable — the browser UI cannot reach the host");
		return;
	}

	rpc.handle("/github", async (endpoint, payload) => {
		try {
			let value;
			switch (endpoint) {
				case "github/list-user-repos": {
					const token = await resolveToken(ctx, scope);
					if (!token) throw new Error("github: GitHub token is not configured (set the GITHUB_TOKEN env var)");
					value = await listUserRepos(token, { page: payload?.page ?? 1, perPage: payload?.perPage ?? 50 });
					break;
				}
				case "github/status": {
					value = { configured: !!(await resolveToken(ctx, scope)) };
					break;
				}
				case "github/set-token": {
					if (!payload?.value || String(payload.value).trim().length === 0) throw new Error("github/set-token: a non-empty token value is required");
					await ctx.credentials.set(resolveRefName(scope), String(payload.value).trim());
					value = { configured: true };
					break;
				}
				case "github/clear-token": {
					await ctx.credentials.unset(resolveRefName(scope));
					value = { configured: false };
					break;
				}
				case "github/import": {
					if (!payload?.repo) throw new Error("github/import: `repo` (owner/name) is required");
					value = await createWorkspaceFromRepo(ctx, scope, payload);
					break;
				}
				case "github/local-list": {
					value = await localList(payload?.path);
					break;
				}
				case "github/local-create": {
					value = await localCreate(payload?.path, payload?.name);
					break;
				}
				case "github/workspace-info": {
					value = await workspaceInfo(ctx, scope, payload?.workspaceId);
					break;
				}
				case "github/create-worktree": {
					if (!payload?.workspaceId) throw new Error("github/create-worktree: `workspaceId` is required");
					value = await createWorktreeFromRepo(ctx, scope, {
						repo: payload.workspaceId,
						branch: payload.branch,
						name: payload.name,
						sessionId: payload.sessionId
					});
					break;
				}
				case "github/remove-worktree": {
					value = await removeWorktreeOp(ctx, scope, payload);
					break;
				}
				case "github/list-worktrees": {
					value = await listWorktreesOp(ctx, scope, payload);
					break;
				}
				default:
					throw new Error(`github: unknown endpoint '${endpoint}'`);
			}
			return { ok: true, value };
		} catch (error) {
			// Log the full detail server-side so a client-side terse message can
			// still be debugged from the container log.
			ctx.logger?.error(`github RPC ${endpoint} failed: ${String(error?.message ?? error)}${error?.stack ? `\n${error.stack}` : ""}`);
			return { ok: false, error: { code: "internal", message: String(error?.message ?? error), details: {} } };
		}
	}, { authority: "trusted-host" });
}

/**
 * Cordis plugin body: register the `github` settings namespace (so the Settings
 * → Plugins card can edit it and per-operation reads see live values) and the
 * client→host handlers.
 * @param ctx - host composition context.
 * @param config - entry config, composed over the bundle/settings layers.
 */
function apply(ctx, config) {
	const scope = ctx.settings.register("github", Config, { base: config });
	registerHandlers(ctx, scope);
	registerTools(ctx, scope);
	wrapArchiveSession(ctx, scope);
	startupPrune(ctx, scope).catch((error) => ctx.logger?.warn(`github: startup worktree prune failed: ${String(error?.message ?? error)}`));
	// Provide the directoryPicker service (a browse capability backed by our fs
	// helpers) because the api gateway (`@deepseek-ai/dsh-host-apiproxy`)
	// injects it. The harness directory-picker row is disabled in the bundle
	// patch, so this replaces it: no duplicate service, and its client flow does
	// not collide with our chooser in the two single-kind directory-flow holes.
	const capability = { kind: "browse", list: listDir, createDirectory: createDir };
	ctx.provide("directoryPicker", { capability: () => capability });
}

export { Config, name, inject, apply, DEFAULT_CLONE_ROOT, DEFAULT_WORKTREE_ROOT, resolveToken, createWorkspaceFromRepo, wtConfig };
