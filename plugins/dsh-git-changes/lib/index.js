/**
 * dsh-git-changes host plugin.
 *
 * Registers the client→host handlers the browser half of the Git changes panel
 * invokes: a summary of every file changed on the currently checked-out branch
 * (relative to its base) and a per-file unified diff. Everything runs on the
 * host via `git`, so the browser never needs shell access.
 *
 * The client half addresses these methods through the generic Connection RPC
 * channel (`ctx.connection.rpc`, authority `trusted-host`), which is the
 * durable transport — `harness.handle`/`host.call` is the dynamic-Cordis
 * mechanism and is not available to a durable plugin.
 *
 * The target repository is the current session's workspace (its `header.cwd`),
 * resolved from the `sessionId` the browser passes on every call, and hardened
 * with `git rev-parse --show-toplevel` so a session cwd that is a repo
 * subdirectory still resolves to the repo root.
 */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** Cordis plugin name used by loader diagnostics. */
export const name = "git-changes";

/** No required host services — everything is read via `ctx.get(...)`. */
export const inject = [];

const OUT_BYTES = 8 * 1024 * 1024;

/** Resolve the session's working directory from the id the browser supplied. */
function sessionCwd(ctx, sessionId) {
	const sessions = ctx.get("sessions");
	const sandboxPolicy = ctx.get("sandboxPolicy");
	let session;
	if (sessionId && sessions) session = sessions.get(sessionId);
	if (!session) {
		const agents = ctx.get("agents");
		if (agents && typeof agents.currentInitiator === "function") {
			const agent = agents.currentInitiator();
			if (agent) session = agent.session;
		}
	}
	let cwd = "";
	if (sandboxPolicy && session) {
		try {
			const policy = sandboxPolicy.resolve({ session });
			cwd = (policy && policy.workspaceRoot) || "";
		} catch {
			cwd = "";
		}
	}
	if (!cwd && session && session.header && session.header.cwd) cwd = session.header.cwd;
	return cwd;
}

/** Run one git command; rejects on a non-zero exit. */
function runGit(args, cwd) {
	return new Promise((resolve, reject) => {
		execFile("git", args, { cwd, maxBuffer: OUT_BYTES }, (err, stdout, stderr) => {
			if (err) reject(new Error((stderr && stderr.trim()) || err.message));
			else resolve(stdout);
		});
	});
}

/** Run one git command, resolving "" on a non-zero exit (probe). */
function tryGit(args, cwd) {
	return new Promise((resolve) => {
		execFile("git", args, { cwd, maxBuffer: OUT_BYTES }, (err, stdout) => {
			resolve(err ? "" : stdout);
		});
	});
}

/** Resolve the actual repo root, falling back to the given cwd. */
async function resolveRepoRoot(cwd) {
	if (!cwd) return "";
	try {
		const out = await runGit(["rev-parse", "--show-toplevel"], cwd);
		return out.trim() || cwd;
	} catch {
		return cwd;
	}
}

let cachedBase = null;
/** Resolve the base branch (merge-base with the current HEAD) once. */
async function resolveBase(repoRoot) {
	if (cachedBase) return cachedBase;
	let base = null;
	for (const cand of ["main", "origin/main", "master", "origin/master"]) {
		const out = await tryGit(["rev-parse", "--verify", "--quiet", cand], repoRoot);
		if (out.trim()) { base = cand; break; }
	}
	if (!base) throw new Error("No base branch found (tried main, origin/main, master, origin/master).");
	let baseSha = "";
	try {
		baseSha = (await runGit(["merge-base", base, "HEAD"], repoRoot)).trim();
	} catch {
		baseSha = (await runGit(["rev-parse", base], repoRoot)).trim();
	}
	cachedBase = { base, baseSha };
	return cachedBase;
}

function statusLabel(st) {
	if (st === "A") return "added";
	if (st === "D") return "deleted";
	if (st === "C") return "copied";
	return "modified";
}

/** Every change on the branch: committed (base→worktree) + untracked. */
async function summary(ctx, sessionId) {
	cachedBase = null;
	const repoRoot = await resolveRepoRoot(sessionCwd(ctx, sessionId));
	if (!repoRoot) throw new Error("Could not resolve the session workspace root.");

	const branch = (await runGit(["rev-parse", "--abbrev-ref", "HEAD"], repoRoot)).trim();
	const baseInfo = await resolveBase(repoRoot);

	const nameStatusText = await runGit(["diff", "--name-status", "--no-renames", baseInfo.baseSha], repoRoot);
	const nameStatus = new Map();
	for (const line of nameStatusText.split("\n")) {
		if (!line) continue;
		const tab = line.indexOf("\t");
		if (tab < 0) continue;
		const st = line.slice(0, tab).trim();
		const path = line.slice(tab + 1);
		if (path) nameStatus.set(path, st);
	}

	const numstatText = await runGit(["diff", "--numstat", "--no-renames", baseInfo.baseSha], repoRoot);
	const numstat = new Map();
	for (const line of numstatText.split("\n")) {
		if (!line) continue;
		const parts = line.split("\t");
		if (parts.length < 3) continue;
		const add = parts[0] === "-" ? 0 : parseInt(parts[0], 10) || 0;
		const del = parts[1] === "-" ? 0 : parseInt(parts[1], 10) || 0;
		const path = parts.slice(2).join("\t");
		if (path) numstat.set(path, { additions: add, deletions: del });
	}

	const statusText = await runGit(["status", "--porcelain=v1", "--untracked-files=normal"], repoRoot);
	const workingSet = new Set();
	const untracked = [];
	for (const line of statusText.split("\n")) {
		if (!line) continue;
		const code = line.slice(0, 2);
		const rest = line.slice(3);
		if (code === "??") {
			untracked.push(rest);
			workingSet.add(rest);
		} else {
			let path = rest;
			const arrow = rest.indexOf(" -> ");
			if (arrow >= 0) path = rest.slice(arrow + 4);
			if (path) workingSet.add(path);
		}
	}

	const files = [];
	for (const [path, st] of nameStatus) {
		const ns = numstat.get(path) || { additions: 0, deletions: 0 };
		files.push({ path, status: statusLabel(st), additions: ns.additions, deletions: ns.deletions, uncommitted: workingSet.has(path) });
	}
	for (const path of untracked) {
		let additions = 0;
		try {
			const text = await readFile(join(repoRoot, path), "utf8");
			const nl = (text.match(/\n/g) || []).length;
			additions = nl + (text.length > 0 && text.charAt(text.length - 1) !== "\n" ? 1 : 0);
		} catch {
			additions = 0;
		}
		files.push({ path, status: "untracked", additions, deletions: 0, uncommitted: true });
	}
	files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

	let totalAdd = 0;
	let totalDel = 0;
	for (const f of files) { totalAdd += f.additions; totalDel += f.deletions; }

	return {
		ok: true,
		repoRoot,
		branch,
		base: baseInfo.base,
		baseSha: baseInfo.baseSha,
		files,
		totals: { files: files.length, additions: totalAdd, deletions: totalDel }
	};
}

/** One file's unified diff (synthesized for a brand-new untracked file). */
async function diff(ctx, sessionId, path) {
	if (!path) throw new Error("Missing path");
	const repoRoot = await resolveRepoRoot(sessionCwd(ctx, sessionId));
	if (!repoRoot) throw new Error("Could not resolve the session workspace root.");
	const baseInfo = await resolveBase(repoRoot);

	const tracked = await tryGit(["ls-files", "--error-unmatch", "--", path], repoRoot);
	if (tracked.trim() === "") {
		let text;
		try {
			text = await readFile(join(repoRoot, path), "utf8");
		} catch {
			throw new Error("Cannot read " + path);
		}
		const lines = text.split("\n");
		const body = lines.map((l) => "+" + l).join("\n");
		return {
			ok: true,
			path,
			diff: "diff --git a/" + path + " b/" + path + "\n" +
				"new file mode 100644\n" +
				"--- /dev/null\n" +
				"+++ b/" + path + "\n" +
				"@@ -0,0 +1," + lines.length + " @@\n" +
				body,
			truncated: false
		};
	}
	const diffText = await runGit(["diff", "--no-ext-diff", baseInfo.baseSha, "--", path], repoRoot);
	return { ok: true, path, diff: diffText, truncated: false };
}

/** Register client→host handlers on the generic Connection RPC channel. */
function registerHandlers(ctx) {
	const conn = ctx.get("connection");
	const rpc = conn && conn.rpc;
	if (!rpc || typeof rpc.handle !== "function") {
		ctx.logger?.warn("git-changes: connection RPC unavailable — the browser panel cannot reach the host");
		return;
	}
	rpc.handle("/rpc", async (endpoint, payload) => {
		try {
			let value;
			if (endpoint === "git-changes/summary") value = await summary(ctx, payload?.sessionId);
			else if (endpoint === "git-changes/diff") value = await diff(ctx, payload?.sessionId, payload?.path);
			else throw new Error(`git-changes: unknown endpoint '${endpoint}'`);
			return { ok: true, value };
		} catch (error) {
			ctx.logger?.error(`git-changes RPC ${endpoint} failed: ${String(error?.message ?? error)}${error?.stack ? `\n${error.stack}` : ""}`);
			return { ok: false, error: { code: "internal", message: String(error?.message ?? error), details: {} } };
		}
	}, { authority: "trusted-host" });
}

/**
 * Cordis plugin body: register the RPC handlers.
 * @param ctx - host composition context.
 */
export function apply(ctx, config) {
	registerHandlers(ctx);
}
