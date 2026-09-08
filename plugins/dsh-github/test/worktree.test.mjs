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
	worktree = join(tmpdir(), "dsh-worktree-copy-" + Date.now());
	await createWorktree({ repoPath: repo, dest: worktree, ref: "main", detach: true });

	// The linked worktree is a git repo with a .git FILE, not a directory.
	assert.equal(await isGitRepo(worktree), true);
	assert.equal(await isLinkedWorktree(worktree), true);

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
