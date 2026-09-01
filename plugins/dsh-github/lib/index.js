/**
 * dsh-github host plugin: contributes a `github` settings namespace (token env
 * ref, clone root, shallow flag) and the client→host handlers the browser half
 * invokes to list the user's repositories and to import a repo as a workspace.
 *
 * It deliberately registers NO model-facing tools and NO prompts: the GitHub
 * capability is UI-only, driven by the workspace "Add workspace" chooser.
 *
 * The client half addresses these methods through the generic Connection RPC
 * channel (`ctx.connection.rpc`, authority `trusted-host`), which works over the
 * tailnet. Everything runs on the host so the PAT never reaches the browser;
 * each handler re-resolves the token per call.
 */

import z from "@deepseek-ai/schemastery";
import { join, dirname, isAbsolute, basename } from "node:path";
import { readdir, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { listUserRepos, getRepo, gitClone, slug } from "./github.js";

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
	shallow: z.boolean().default(true)
});

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

/**
 * Register the client→host RPC handlers on the generic Connection RPC channel
 * (`ctx.connection.rpc`), the durable transport that works over the tailnet
 * with `authority: 'trusted-host'` (unlike the loopback-only settings RPCs that
 * 403 on a remote browser). `harness.handle`/`host.call` is the dynamic-Cordis
 * mechanism and is not available to a durable plugin, so it is not used here.
 */
/**
 * Register the client→host handlers on the generic Connection RPC channel
 * (`ctx.connection.rpc`), the durable transport that works over the tailnet
 * with `authority: 'trusted-host'` (unlike the loopback-only settings RPCs that
 * 403 on a remote browser). `harness.handle`/`host.call` is the dynamic-Cordis
 * mechanism and is not available to a durable plugin, so it is not used here.
 */
function registerHandlers(ctx, scope) {
	const conn = ctx.get("connection");
	const rpc = conn?.rpc;
	if (!rpc || typeof rpc.handle !== "function") {
		ctx.logger?.warn("github: connection RPC unavailable — the browser UI cannot reach the host");
		return;
	}

	rpc.handle("/rpc", async (endpoint, payload) => {
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
	// Provide the directoryPicker service (a browse capability backed by our fs
	// helpers) because the api gateway (`@deepseek-ai/dsh-host-apiproxy`)
	// injects it. The harness directory-picker row is disabled in the bundle
	// patch, so this replaces it: no duplicate service, and its client flow does
	// not collide with our chooser in the two single-kind directory-flow holes.
	const capability = { kind: "browse", list: listDir, createDirectory: createDir };
	ctx.provide("directoryPicker", { capability: () => capability });
}

export { Config, name, inject, apply, DEFAULT_CLONE_ROOT, resolveToken, createWorkspaceFromRepo };
