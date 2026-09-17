/**
 * Smoke tests for lib/worktree.js. These exercise the git helpers against a real
 * temporary repository (a linked worktree is created, listed, detected, then
 * removed), plus the pure path helpers. Requires `git` on PATH; each test skips
 * cleanly when git is unavailable.
 *
 * Run: node --test plugins/dsh-github/test/worktree.test.mjs
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile, readFile, stat, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	slug,
	isGitRepo,
	isLinkedWorktree,
	isSessionDirName,
	isWorktreeUnder,
	isWithin,
	resolveDefaultBranch,
	createWorktree,
	listWorktrees,
	ensureExcluded,
	removeWorktree
} from "../lib/worktree.js";

function gitAvailable() {
	return new Promise((resolve) => {
		execFile("git", ["--version"], (error) => resolve(!error));
	});
}

async function runGit(cwd, args) {
	return new Promise((resolve, reject) => {
		execFile("git", args, { cwd }, (error, stdout, stderr) => {
			if (error) reject(new Error(String(stderr || error.message)));
			else resolve(String(stdout));
		});
	});
}

let repo;
let hasGit;
let worktree;

before(async () => {
	hasGit = await gitAvailable();
	if (!hasGit) return;
	repo = await mkdtemp(join(tmpdir(), "dsh-worktree-"));
	await runGit(repo, ["init", "-b", "main", "-q"]);
	await runGit(repo, ["config", "user.email", "a@b.c"]);
	await runGit(repo, ["config", "user.name", "Test"]);
	await writeFile(join(repo, "file.txt"), "hi\n");
	await runGit(repo, ["add", "."]);
	await runGit(repo, ["commit", "-q", "-m", "init"]);
});

after(async () => {
	if (repo) await rm(repo, { recursive: true, force: true }).catch(() => {});
});

test("slug sanitizes and lowercases", () => {
	assert.equal(slug("Acme Core-API"), "acme-core-api");
	assert.equal(slug("  spaced  name /"), "spaced-name");
});

test("isWithin is lexically strict", () => {
	assert.equal(isWithin("/a/b", "/a/b/c"), true);
	assert.equal(isWithin("/a/b", "/a/bc"), false);
	assert.equal(isWithin("/a/b", "/a/b"), false);
	assert.equal(isWithin("/a/b", "/x"), false);
});

test("session directory naming is the ownership signal", () => {
	assert.equal(isSessionDirName("session-7a3f0c1e-9b2d-4f1a"), true);
	assert.equal(isSessionDirName("session-abc"), true);
	assert.equal(isSessionDirName("my-checkout"), false);
	assert.equal(isSessionDirName("session-"), false);
	assert.equal(isSessionDirName("session-abc/../evil"), false);
});

test("git repo detection", async (t) => {
	if (!hasGit) return t.skip("git unavailable");
	assert.equal(await isGitRepo(repo), true);
	const plain = await mkdtemp(join(tmpdir(), "dsh-plain-"));
	assert.equal(await isGitRepo(plain), false);
	await rm(plain, { recursive: true, force: true });
	// A main checkout has a .git DIRECTORY, so it is not a linked worktree.
	assert.equal(await isLinkedWorktree(repo), false);
});

test("resolve default branch", async (t) => {
	if (!hasGit) return t.skip("git unavailable");
	const branch = await resolveDefaultBranch(repo);
	assert.equal(typeof branch, "string");
	assert.ok(branch.length > 0, "expected a resolved branch name");
});

test("worktree create / list / detect / remove round-trip", async (t) => {
	if (!hasGit) return t.skip("git unavailable");
	// A session's worktrees live in its own container: <workspace>/<dir>/<sessionId>/<name>.
	const sessionId = "session-" + Date.now();
	const container = join(repo, ".dsh-worktrees", sessionId);
	worktree = join(container, "issue-123");
	await createWorktree({ repoPath: repo, dest: worktree, ref: "main", detach: true });

	// The linked worktree is a git repo with a .git FILE, not a directory.
	assert.equal(await isGitRepo(worktree), true);
	assert.equal(await isLinkedWorktree(worktree), true);

	// Ownership: a linked worktree inside its own container, and nothing else.
	assert.equal(await isWorktreeUnder(container, worktree), true);
	assert.equal(await isWorktreeUnder(repo, worktree), true);
	assert.equal(await isWorktreeUnder(join(repo, ".dsh-worktrees", "session-other"), worktree), false);
	// The main checkout is not a linked worktree.
	assert.equal(await isWorktreeUnder(repo, repo), false);

	// The container can be kept out of `git status` locally, idempotently.
	const excludePath = await ensureExcluded(repo, ".dsh-worktrees/");
	await ensureExcluded(repo, ".dsh-worktrees/");
	const excluded = await readFile(excludePath, "utf8");
	assert.equal(excluded.split("\n").filter((line) => line.trim() === ".dsh-worktrees/").length, 1);
	assert.equal(excludePath.includes(join(".git", "info", "exclude")), true);

	// It appears in the repository's worktree list (detached HEAD).
	const list = await listWorktrees(repo);
	const hit = list.find((w) => w.path === worktree);
	assert.ok(hit, "worktree listed after create");
	assert.equal(hit.detached, true);

	// Removing it cleans the directory and drops it from the list.
	await removeWorktree({ worktreePath: worktree, repoPath: repo });
	await assert.rejects(stat(worktree), /ENOENT/);
	const afterList = await listWorktrees(repo);
	assert.equal(afterList.find((w) => w.path === worktree), undefined);
});

test("removeWorktree requires a path", async () => {
	await assert.rejects(removeWorktree({}), /worktreePath is required/);
});
