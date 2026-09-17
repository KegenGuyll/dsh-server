/**
 * dsh-github host plugin: contributes a `github` settings namespace (token env
 * ref, clone root, shallow flag, worktree options) plus the client→host handlers
 * the browser half invokes to list the user's repositories and import a repo as
 * a workspace. It also registers three agent-facing worktree tools that create
 * worktrees INSIDE the current session's workspace (so one session can work
 * several issues in parallel) and wraps `workspaceRegistry.archiveSession` so
 * archiving a session removes the worktrees it created.
 *
 * The client half addresses these methods through the generic Connection RPC
 * channel (`ctx.connection.rpc`, authority `trusted-host`), which works over the
 * tailnet. Everything runs on the host so the PAT never reaches the browser;
 * each handler re-resolves the token per call.
 */

import z from "@deepseek-ai/schemastery";
import { join, dirname, isAbsolute, basename } from "node:path";
import { readdir, mkdir, stat, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { listUserRepos, getRepo, gitClone, slug } from "./github.js";
import {
	isGitRepo,
	isSessionDirName,
	isWithin,
	isWorktreeUnder,
	createWorktree,
	listWorktrees,
	prune,
	ensureExcluded,
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

/**
 * Default worktree container: a subdirectory of the SESSION's own workspace.
 * Worktrees must live inside the session workspace because the file sandbox's
 * writable root is the session `cwd` — anything outside it is unusable by the
 * agent's own tools.
 */
const DEFAULT_WORKTREE_DIR = ".dsh-worktrees";

/** Cordis plugin name used by loader diagnostics. */
const name = "github";

/** Services the host half requires. */
const inject = ["workspaceRegistry", "credentials", "settings"];

/** Deployment/user configuration: a credential reference, a clone root, shallow, worktrees. */
const Config = z.object({
	/** Env-variable (credential ref) name that holds the GitHub PAT. */
	tokenEnv: z.string().default("GITHUB_TOKEN"),
	/** Directory (absolute) under which imported repos are cloned. */
	cloneRoot: z.string().default(DEFAULT_CLONE_ROOT),
	/** Clone with --depth 1 (full clone when false). */
	shallow: z.boolean().default(true),
	/** Master toggle: allow the agent to create worktrees in this session. */
	worktreeEnabled: z.boolean().default(true),
	/** Subdirectory of the session workspace that holds its worktrees. */
	worktreeDir: z.string().default(DEFAULT_WORKTREE_DIR),
	/** Base ref new worktrees start from, unless a tool call overrides. */
	worktreeBranch: z.string().default("origin/main"),
	/** Create worktrees at a detached HEAD (true) vs a fresh branch `dsh/…` (false). */
	worktreeDetached: z.boolean().default(true),
	/** Remove the session's worktrees (and their container) when it is archived. */
	worktreeCleanupOnArchive: z.boolean().default(true),
	/** Cap concurrent worktrees per session; refuse creating beyond it. */
	worktreeMaxPerSession: z.number().default(8),
	/** On plugin start, prune worktrees whose session no longer exists. */
	worktreePruneOnStartup: z.boolean().default(true)
});

/**
 * Resolve the effective worktree config, applying defaults at read time so a
 * settings document that omits a worktree key still yields every option. The
 * directory is forced to a single safe path segment so it can never escape the
 * session workspace.
 */
function wtConfig(scope) {
	const value = scope.get();
	const dir = typeof value.worktreeDir === "string" && value.worktreeDir.trim()
		? value.worktreeDir.trim().replace(/^[/\\]+|[/\\]+$/g, "")
		: DEFAULT_WORKTREE_DIR;
	const safeDir = dir && !dir.split(/[/\\]/).includes("..") ? dir : DEFAULT_WORKTREE_DIR;
	return {
		enabled: value.worktreeEnabled !== false,
		dir: safeDir,
		branch: (typeof value.worktreeBranch === "string" && value.worktreeBranch.trim()) || "origin/main",
		detached: value.worktreeDetached !== false,
		cleanupOnArchive: value.worktreeCleanupOnArchive !== false,
		maxPerSession: Number.isFinite(value.worktreeMaxPerSession) ? value.worktreeMaxPerSession : 8,
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
//
// Worktrees live INSIDE the session's own workspace, at
// `<session cwd>/<worktreeDir>/<sessionId>/<name>`. That location is not a
// preference: the file sandbox's writable root is the session `cwd`
// (`sandboxPolicy.resolve()` derives it from `session.header.cwd`), so a
// worktree anywhere else could not be read or written by the agent's own tools.
// Worktrees are never registered as DSH workspaces — that is what previously
// turned every one of them into a separate session and sidebar entry.

/** Resolve a `repo` argument (a workspace id or a filesystem path) to a git repo path. */
async function resolveRepoPath(ctx, repo, fallback) {
	const workspace = typeof repo === "string" ? ctx.get("workspaceRegistry")?.get(repo) : undefined;
	if (workspace) return workspace.path;
	const candidate = typeof repo === "string" && isAbsolute(repo) ? repo
		: typeof repo === "string" && repo.trim() ? join(fallback ?? process.cwd(), repo.trim())
			: fallback;
	if (!candidate) throw new Error("a repository path or workspace id is required");
	if (!(await isGitRepo(candidate))) throw new Error(`'${candidate}' is not a git repository`);
	return candidate;
}

/**
 * Resolve the session context a worktree tool runs in: its workspace (which is
 * the repo), its id, and its own worktree container.
 */
function worktreeSession(exec, scope) {
	const session = exec?.agent?.session;
	const sessionCwd = session?.header?.cwd;
	const sessionId = session?.header?.id ?? session?.id;
	if (typeof sessionCwd !== "string" || sessionCwd === "") {
		throw new Error("this session has no workspace directory to create a worktree in");
	}
	if (typeof sessionId !== "string" || sessionId === "") {
		throw new Error("this session has no id to scope its worktrees");
	}
	const wt = wtConfig(scope);
	return { wt, sessionCwd, sessionId, container: join(sessionCwd, wt.dir, sessionId) };
}

/** Turn an agent-supplied worktree name into one safe path segment. */
function worktreeLeaf(name) {
	const leaf = slug(String(name ?? "")).slice(0, 64);
	if (!leaf) throw new Error("a worktree `name` is required (letters, digits, '.', '_' or '-')");
	return leaf;
}

/**
 * Per-container serialization for the count-then-create sequence, so two
 * concurrent creates cannot both pass the cap check.
 */
const worktreeLocks = new Map();
function withWorktreeLock(key, operation) {
	const previous = worktreeLocks.get(key) ?? Promise.resolve();
	const run = previous.then(operation, operation);
	const tail = run.then(() => {}, () => {});
	worktreeLocks.set(key, tail);
	tail.then(() => { if (worktreeLocks.get(key) === tail) worktreeLocks.delete(key); });
	return run;
}

/**
 * Create one worktree inside this session's container. The default base ref is
 * the configured branch (`origin/main`); the caller may name another. The
 * container is added to the repository's local exclude so it never appears as
 * untracked in `git status`.
 */
async function createWorktreeForSession(ctx, scope, exec, args) {
	const { wt, sessionCwd, container } = worktreeSession(exec, scope);
	if (!wt.enabled) throw new Error("worktrees are disabled (enable in the GitHub plugin settings)");
	const repoPath = await resolveRepoPath(ctx, args?.repo, sessionCwd);
	const leaf = worktreeLeaf(args?.name);
	const ref = (typeof args?.branch === "string" && args.branch.trim()) || wt.branch;
	const dest = join(container, leaf);
	if (!isWithin(sessionCwd, dest)) throw new Error(`worktree path '${dest}' escapes the session workspace`);

	return await withWorktreeLock(container, async () => {
		const mine = (await listWorktrees(repoPath)).filter((w) => isWithin(container, w.path));
		if (wt.maxPerSession > 0 && mine.length >= wt.maxPerSession) {
			throw new Error(`this session already has ${mine.length} worktrees (max ${wt.maxPerSession}); remove one first`);
		}
		if (mine.some((w) => w.path === dest)) throw new Error(`a worktree named '${leaf}' already exists in this session`);
		await mkdir(container, { recursive: true });
		await createWorktree({
			repoPath,
			dest,
			ref,
			detach: wt.detached,
			newBranch: wt.detached ? undefined : `dsh/${leaf}`
		});
		await ensureExcluded(repoPath, `${wt.dir}/`).catch(() => {});
		return { worktreePath: dest, branch: ref, repoPath, name: leaf };
	});
}

/** List this session's worktrees. */
async function listWorktreesForSession(ctx, scope, exec, args) {
	const { sessionCwd, container } = worktreeSession(exec, scope);
	const repoPath = await resolveRepoPath(ctx, args?.repo, sessionCwd);
	const all = await listWorktrees(repoPath).catch(() => []);
	const worktrees = [];
	for (const w of all) {
		if (!isWithin(container, w.path)) continue;
		worktrees.push({
			name: basename(w.path),
			path: w.path,
			branch: w.branch ?? null,
			detached: !!w.detached,
			head: w.head ?? null
		});
	}
	return { repoPath, container, worktrees };
}

/** Remove one worktree from this session's container (by `name` or absolute `path`). */
async function removeWorktreeForSession(exec, scope, args) {
	const { container } = worktreeSession(exec, scope);
	const given = typeof args?.path === "string" && args.path.trim() ? args.path.trim() : undefined;
	const worktreePath = given ?? (args?.name ? join(container, worktreeLeaf(args.name)) : undefined);
	if (!worktreePath) throw new Error("a worktree `name` or `path` is required");
	// Ownership: a linked worktree inside THIS session's own container.
	if (!(await isWorktreeUnder(container, worktreePath))) {
		throw new Error(`github: refusing to remove '${worktreePath}' — not a worktree in this session's container`);
	}
	await removeWorktree({ worktreePath });
	// Drop the container once its last worktree is gone, so removing every
	// worktree by hand leaves nothing behind (archive cleanup does the same).
	try {
		const rest = await readdir(container);
		if (rest.length === 0) await rm(container, { recursive: true, force: true });
	} catch {
		// The container was already gone.
	}
	return { removed: true, worktreePath };
}

/** Resolve a session's workspace cwd, preferring the live session over persistence. */
async function sessionCwd(ctx, sessionId) {
	const live = ctx.get("sessions")?.get(sessionId);
	if (live?.header?.cwd !== undefined) return live.header.cwd;
	const persistence = ctx.get("sessionPersistence");
	if (typeof persistence?.list === "function") {
		const headers = await persistence.list();
		return headers.find((h) => h.id === sessionId)?.cwd;
	}
	return undefined;
}

/** Remove every worktree in one session's container, plus the container itself. */
async function removeSessionContainer(ctx, container) {
	let entries;
	try {
		entries = await readdir(container, { withFileTypes: true });
	} catch {
		return 0;
	}
	let removed = 0;
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const child = join(container, entry.name);
		if (!(await isWorktreeUnder(container, child))) continue;
		await removeWorktree({ worktreePath: child })
			.then(() => { removed += 1; })
			.catch((error) => ctx.logger?.warn(`github: failed to remove worktree '${child}': ${String(error?.message ?? error)}`));
	}
	await rm(container, { recursive: true, force: true }).catch(() => {});
	return removed;
}

/** Remove the worktrees created by an archived session. */
async function cleanupWorktreesForSession(ctx, scope, sessionId) {
	const wt = wtConfig(scope);
	if (!wt.cleanupOnArchive) return;
	const cwd = await sessionCwd(ctx, sessionId);
	if (!cwd) return;
	const container = join(cwd, wt.dir, sessionId);
	// The container is derived from the archived session's own id, so it is
	// exactly this session's worktrees — no other session's tree can match.
	if (!isWithin(cwd, container)) return;
	await removeSessionContainer(ctx, container);
}

/**
 * Wrap `workspaceRegistry.archiveSession` so archiving a session also removes
 * the worktrees it created. There is no dedicated "session archived" event and
 * the UI archive path funnels through this method, so this is the single
 * reliable seam. The wrapper is installed and uninstalled through the plugin
 * fiber, so a stop/update restores the original implementation.
 */
function wrapArchiveSession(ctx, scope) {
	const registry = ctx.get("workspaceRegistry");
	if (!registry || typeof registry.archiveSession !== "function") return;
	const original = registry.archiveSession.bind(registry);
	registry.archiveSession = async (sessionId) => {
		const result = await original(sessionId);
		await cleanupWorktreesForSession(ctx, scope, sessionId)
			.catch((error) => ctx.logger?.warn(`github: worktree cleanup on archive failed: ${String(error?.message ?? error)}`));
		return result;
	};
	const restore = () => { registry.archiveSession = original; };
	if (typeof ctx.effect === "function") ctx.effect(restore);
	else ctx.on?.("dispose", restore);
}

/**
 * On plugin start, drop worktree containers whose session no longer exists —
 * a session removed without passing through archive, or a cleanup that failed.
 * Containers younger than two minutes are left alone (a create may be in flight).
 */
async function startupPrune(ctx, scope) {
	const wt = wtConfig(scope);
	if (!wt.pruneOnStartup) return;
	const registry = ctx.get("workspaceRegistry");
	if (!registry) return;
	// Known sessions. If persistence cannot be read we skip the destructive pass
	// entirely rather than risk removing a live session's worktrees.
	let known;
	try {
		const persistence = ctx.get("sessionPersistence");
		if (typeof persistence?.list !== "function") return;
		known = new Set((await persistence.list()).map((header) => header.id));
		for (const session of ctx.get("sessions")?.list() ?? []) known.add(session.id);
	} catch (error) {
		ctx.logger?.warn(`github: skipping orphaned-worktree prune (session list unreadable): ${String(error?.message ?? error)}`);
		return;
	}
	const now = Date.now();
	for (const workspace of registry.list()) {
		if (!(await isGitRepo(workspace.path))) continue;
		await prune(workspace.path).catch(() => {});
		const root = join(workspace.path, wt.dir);
		let entries;
		try {
			entries = await readdir(root, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (!entry.isDirectory() || !isSessionDirName(entry.name) || known.has(entry.name)) continue;
			const container = join(root, entry.name);
			try {
				const info = await stat(container);
				if (now - info.mtimeMs < 2 * 60 * 1000) continue;
			} catch {
				continue;
			}
			await removeSessionContainer(ctx, container);
			ctx.logger?.info(`github: pruned orphaned worktrees for absent session ${entry.name}`);
		}
	}
}

/**
 * The worktree workflow, contributed to the GLOBAL system prompt so every
 * session knows to give each issue its own worktree without being asked. The
 * tools alone only say what they do; this says WHEN to reach for them.
 */
const WORKTREE_GUIDANCE = [
	"## Git worktrees for multi-issue work",
	"",
	"You can work several issues on one repository in parallel using git worktrees — inside this session, without starting a new session.",
	"",
	"When a task covers more than one independent piece of work on the same repository (several issues, or a group of parallel changes), give each piece its own worktree:",
	"",
	"- `github_create_worktree` with `name` (e.g. the issue id) creates a tree inside this session's workspace and returns its path. It starts from `origin/main` unless you pass `branch`.",
	"- Do that issue's work only in that path: pass it as `workdir` to bash, and use absolute paths under it for file edits.",
	"- To work issues concurrently, delegate each to a subagent and give it that worktree path as its `workdir`.",
	"- `github_list_worktrees` lists this session's worktrees; `github_remove_worktree` removes one and discards its uncommitted changes.",
	"- Keep the main checkout clean — do not commit issue work there. This session's worktrees are removed when the session is archived."
].join("\n");

/**
 * Contribute the worktree workflow as a global prompt section. Registered from
 * the plugin's (host-composition) scope, so it is a GLOBAL section that shadows
 * nothing and applies to every session of every preset. The text is a provider
 * so the section follows the live `worktreeEnabled` setting; an empty string
 * contributes nothing (assembly drops empty sections).
 */
function registerWorktreeGuidance(ctx, scope) {
	const systemPrompt = ctx.get("systemPrompt");
	if (!systemPrompt || typeof systemPrompt.section !== "function") {
		ctx.logger?.warn("github: systemPrompt unavailable — worktree guidance not contributed");
		return;
	}
	// Order 100–199 is the harness convention for tool guidance.
	ctx.effect(() => systemPrompt.section({
		name: "github.worktrees",
		order: 150,
		text: () => (wtConfig(scope).enabled ? WORKTREE_GUIDANCE : "")
	}));
}

/**
 * Register the worktree model tools. Worktrees are created inside the CURRENT
 * session's own workspace, so several issues can be worked in parallel without
 * leaving the session. The session's workspace is the default repository.
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
			"Create a Git worktree INSIDE this session's workspace so several issues on the same repository can be worked in parallel without leaving this session. " +
			"The worktree is created at <session workspace>/<worktreeDir>/<sessionId>/<name> (git-excluded, so `git status` stays clean) " +
			"on the configured base ref (default origin/main) unless `branch` is given. Returns the worktree path — pass it as `workdir` to bash, " +
			"or use absolute paths under it, to work on that issue. Worktrees are NOT separate sessions.",
		parameters: {
			type: "object",
			properties: {
				name: { type: "string", description: "Short name for the worktree, e.g. the issue id or a slug. One path segment." },
				branch: { type: "string", description: "Base branch or ref to start the worktree at (default origin/main)." },
				repo: { type: "string", description: "Repository to branch from: a workspace id or an absolute path. Defaults to this session's workspace." }
			},
			required: ["name"]
		},
		output: {
			schema: { type: "string" },
			render(_args, value) { return [{ type: "text", text: String(value) }]; }
		},
		async execute(args, exec) {
			try {
				const result = await createWorktreeForSession(ctx, scope, exec, args);
				return `Created worktree '${result.name}' at ${result.worktreePath} (base ${result.branch}, repo ${result.repoPath}). Pass that path as \`workdir\` to bash to work on this issue.`;
			} catch (error) {
				return `github_create_worktree: ${String(error?.message ?? error)}`;
			}
		}
	});

	tools.register({
		name: "github_list_worktrees",
		description:
			"List the worktrees this session has created in its workspace (name, path, branch/HEAD), so you can pick the one for an issue.",
		parameters: {
			type: "object",
			properties: {
				repo: { type: "string", description: "Repository to inspect: a workspace id or an absolute path. Defaults to this session's workspace." }
			}
		},
		output: {
			schema: { type: "string" },
			render(_args, value) { return [{ type: "text", text: String(value) }]; }
		},
		async execute(args, exec) {
			try {
				const result = await listWorktreesForSession(ctx, scope, exec, args);
				if (result.worktrees.length === 0) {
					return `No worktrees in this session yet (container ${result.container}). Use github_create_worktree to make one.`;
				}
				const rows = result.worktrees.map((w) => `- ${w.name}: ${w.path}${w.branch ? ` (branch ${w.branch})` : ""}${w.detached ? " [detached]" : ""}`);
				return `Worktrees for this session (repo ${result.repoPath}):\n${rows.join("\n")}`;
			} catch (error) {
				return `github_list_worktrees: ${String(error?.message ?? error)}`;
			}
		}
	});

	tools.register({
		name: "github_remove_worktree",
		description:
			"Remove one of this session's worktrees (by `name` or absolute `path`). Only worktrees inside this session's own " +
			"worktree container can be removed. Uncommitted changes in the worktree are discarded.",
		parameters: {
			type: "object",
			properties: {
				name: { type: "string", description: "Worktree name, as passed to github_create_worktree." },
				path: { type: "string", description: "Or the absolute path of the worktree to remove." }
			}
		},
		output: {
			schema: { type: "string" },
			render(_args, value) { return [{ type: "text", text: String(value) }]; }
		},
		async execute(args, exec) {
			try {
				const result = await removeWorktreeForSession(exec, scope, args);
				return `Removed worktree ${result.worktreePath}.`;
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
	registerWorktreeGuidance(ctx, scope);
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

export { Config, name, inject, apply, DEFAULT_CLONE_ROOT, DEFAULT_WORKTREE_DIR, resolveToken, createWorkspaceFromRepo };
