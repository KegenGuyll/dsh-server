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
import { mkdtemp, writeFile, stat, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	slug,
	isGitRepo,
	isLinkedWorktree,
	isSessionDirName,
	isManagedWorktree,
	isWithin,
	resolveDefaultBranch,
	createWorktree,
	listWorktrees,
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
	// Plugin worktrees are named exactly after their session; ownership depends on it.
	const sessionId = "session-" + Date.now();
	worktree = join(tmpdir(), sessionId);
	await createWorktree({ repoPath: repo, dest: worktree, ref: "main", detach: true });

	// The linked worktree is a git repo with a .git FILE, not a directory.
	assert.equal(await isGitRepo(worktree), true);
	assert.equal(await isLinkedWorktree(worktree), true);

	// Ownership: exact session-name match, and the generic (unnamed) form.
	assert.equal(await isManagedWorktree(worktree, sessionId), true);
	assert.equal(await isManagedWorktree(worktree), true);
	assert.equal(await isManagedWorktree(worktree, "session-other"), false);
	// The main checkout is not a linked worktree, so it is never "managed".
	assert.equal(await isManagedWorktree(repo), false);

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
