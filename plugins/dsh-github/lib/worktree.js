/**
 * dsh-github worktree logic: git worktree helpers over Node's child_process.
 * This module is plain ESM and has no Cordis dependency of its own; the plugin
 * in index.js wires it to ctx.workspaceRegistry / ctx.settings.
 *
 * A "managed worktree" is a linked worktree created by this plugin: its `.git`
 * is a FILE (pointing back into the owning repository), not a directory. That
 * marker is what lets cleanup remove worktrees we created without ever touching
 * an unrelated nested directory or a plain checkout.
 *
 * Git commands are run with native `execFile` (Node 22) and never through a
 * shell, so a repo/branch/path can never be split into extra argv.
 */

import { execFile } from "node:child_process";
import { stat, readFile, rm } from "node:fs/promises";
import { join, dirname, relative, isAbsolute, basename } from "node:path";

/** Run `git` with `args` in `repoPath`, bounded output and a timeout. */
function runGit({ repoPath, args, timeoutMs = 120000 }) {
	return new Promise((resolve, reject) => {
		const child = execFile("git", args, {
			cwd: repoPath,
			maxBuffer: 8 * 1024 * 1024,
			env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }
		}, (error, stdout, stderr) => {
			if (error) {
				const detail = error.code === "ENOENT"
					? "git is not installed in this container"
					: (String(stderr || "").trim() || String(stdout || "").trim() || String(error.message || error)).split("\n").slice(-10).join("\n");
				reject(new Error(`git ${args[0]} failed for ${repoPath}${detail ? ` — ${detail}` : ""}`));
				return;
			}
			resolve(String(stdout));
		});
		if (timeoutMs > 0) {
			const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
			child.on("close", () => clearTimeout(timer));
		}
	});
}

/** Sanitize a name segment into a filesystem-safe slug (mirrors github.js). */
function slug(value) {
	return String(value)
		.replace(/[^A-Za-z0-9._-]+/g, "-")
		.replace(/(^[-._]+|[-._]+$)/g, "")
		.toLowerCase();
}

/** Whether `.git` exists at `path` — a directory (main checkout) or a file (linked worktree). */
async function isGitRepo(path) {
	try {
		const s = await stat(join(path, ".git"));
		return s.isDirectory() || s.isFile();
	} catch {
		return false;
	}
}

/** Whether `path` is a linked worktree: its `.git` is a FILE, not a directory. */
async function isLinkedWorktree(path) {
	try {
		const s = await stat(join(path, ".git"));
		return s.isFile();
	} catch {
		return false;
	}
}

/** Whether `child` is strictly inside `parent` (path-lexical; both absolute). */
function isWithin(parent, child) {
	const rel = relative(parent, child);
	return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * Resolve the repository's default branch: `origin/HEAD`, then the current
 * HEAD, then `main`. Returns a bare branch name (e.g. `main`).
 */
async function resolveDefaultBranch(repoPath) {
	try {
		const out = (await runGit({ repoPath, args: ["symbolic-ref", "refs/remotes/origin/HEAD", "--short"] })).trim();
		if (out) return out.replace(/^origin\//, "");
	} catch {
		// fall through
	}
	try {
		const head = (await runGit({ repoPath, args: ["rev-parse", "--abbrev-ref", "HEAD"] })).trim();
		if (head && head !== "HEAD") return head;
	} catch {
		// fall through
	}
	return "main";
}

/**
 * Resolve the owning repository of a linked worktree by reading its `.git`
 * file (`gitdir: /repo/.git/worktrees/<name>`). Returns the main checkout path.
 */
async function baseRepoOf(worktreePath) {
	let content;
	try {
		content = await readFile(join(worktreePath, ".git"), "utf8");
	} catch {
		return undefined;
	}
	const matched = /^gitdir:\s*(.+)$/m.exec(content);
	if (!matched) return undefined;
	let gitdir = matched[1].trim();
	// A relative gitdir is relative to the worktree path.
	if (!isAbsolute(gitdir)) gitdir = join(worktreePath, gitdir);
	// gitdir = <root>/.git/worktrees/<name>  → strip the worktrees/<name> tail.
	const stripped = gitdir.replace(/[\\/]worktrees[\\/][^\\/]+$/, "");
	if (/[\\/]\.git$/.test(stripped)) return dirname(stripped);
	return gitdir;
}

/**
 * Create one worktree under `dest`. Default is a detached HEAD at `ref`
 * (e.g. `origin/main`); pass `detach: false` with `newBranch` to create a fresh
 * named branch instead. When `ref` is omitted the repository's default branch
 * is used if `detach` is false? No — with no `ref`, git checks out HEAD; callers
 * should normally pass `ref`.
 */
async function createWorktree({ repoPath, dest, ref, detach = true, newBranch }) {
	const args = ["worktree", "add"];
	if (detach) args.push("--detach");
	else if (newBranch) args.push("-b", newBranch);
	args.push(dest);
	if (ref) args.push(ref);
	await runGit({ repoPath, args, timeoutMs: 180000 });
	return dest;
}

/** List a repository's worktrees (including its own main checkout) as objects. */
async function listWorktrees(repoPath) {
	const out = await runGit({ repoPath, args: ["worktree", "list", "--porcelain"], timeoutMs: 30000 });
	const worktrees = [];
	let current = null;
	const flush = () => {
		if (current && current.path) worktrees.push(current);
		current = null;
	};
	for (const line of out.split("\n")) {
		if (line.trim() === "") { flush(); continue; }
		if (current === null) current = {};
		const space = line.indexOf(" ");
		const key = space === -1 ? line : line.slice(0, space);
		// Porcelain value-less keys (`detached`, `bare`, `locked`) carry no ` ` value.
		const value = space === -1 ? "" : line.slice(space + 1);
		if (key === "worktree") current.path = value;
		else if (key === "HEAD") current.head = value;
		else if (key === "branch") current.branch = value.replace(/^refs\/heads\//, "");
		else if (key === "bare") current.bare = value !== "false";
		else if (key === "detached") current.detached = value !== "false";
		else if (key === "locked") current.locked = value || true;
		else if (key === "prunable") current.prunable = value || true;
	}
	flush();
	return worktrees;
}

/** Prune stale worktree metadata from a repository's admin dir. */
async function prune(repoPath) {
	try {
		await runGit({ repoPath, args: ["worktree", "prune"], timeoutMs: 30000 });
	} catch {
		// pruning is best-effort
	}
}

/**
 * Remove a worktree durably. Prefers `git worktree remove --force`; if git
 * refuses (e.g. the tree is locked and the force flag was overridden by config)
 * it falls back to a recursive filesystem remove, then prunes metadata.
 * @returns the method used ("git" | "fs" | "pruned-only").
 */
async function removeWorktree({ worktreePath, repoPath }) {
	const source = repoPath ?? await baseRepoOf(worktreePath);
	let method = "pruned-only";
	if (source) {
		try {
			await runGit({ repoPath: source, args: ["worktree", "remove", "--force", worktreePath], timeoutMs: 60000 });
			method = "git";
		} catch (error) {
			// Fall back to a filesystem remove (best-effort, still logs the git error upstream if it matters).
			await rm(worktreePath, { recursive: true, force: true }).catch(() => {});
			method = "fs";
		}
		await prune(source);
	} else if (worktreePath) {
		await rm(worktreePath, { recursive: true, force: true }).catch(() => {});
		method = "fs";
	}
	return method;
}

export {
	slug,
	isGitRepo,
	isLinkedWorktree,
	isWithin,
	resolveDefaultBranch,
	baseRepoOf,
	createWorktree,
	listWorktrees,
	prune,
	removeWorktree,
	runGit
};
