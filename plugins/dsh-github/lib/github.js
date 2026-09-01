/**
 * dsh-github host logic: GitHub REST client over Node's native fetch, PAT
 * credential handling, repo listing, and the clone + workspace-register step.
 * This module is plain ESM and has no Cordis dependency of its own; the plugin
 * in index.js wires it to ctx.credentials / ctx.workspaceRegistry / ctx.settings.
 *
 * The GitHub API is called with native fetch (Node 22) because the harness web
 * seam (ctx.web) only carries a `url` on its fetch request and cannot send an
 * `Authorization` header.
 */

import { execFile } from "node:child_process";

const API_BASE = "https://api.github.com";
const API_VERSION = "2022-11-28";
const DEFAULT_PER_PAGE = 50;
const MAX_PER_PAGE = 100;

/** Map an HTTP status to a readable, model-friendly error message. */
function githubError(status, path, body) {
	let detail = "";
	try {
		const parsed = JSON.parse(body);
		if (parsed && typeof parsed.message === "string") detail = parsed.message;
	} catch {
		detail = "";
	}
	if (!detail) detail = body.slice(0, 300);
	const reason = {
		400: "bad request",
		401: "authentication failed (check the token)",
		403: "rate limit or permission denied",
		404: "not found",
		422: "request was rejected",
		429: "rate limit exceeded"
	}[status] ?? `HTTP ${status}`;
	return new Error(`GitHub ${reason}${detail ? `: ${detail}` : ""}`);
}

/**
 * One GitHub REST call with JSON-encoded body where present.
 * @param {string|undefined} token - personal access token, if any.
 * @param {string} path - API path beginning with `/`.
 * @param {{ method?: string, body?: unknown, signal?: AbortSignal }} [options]
 */
async function githubFetch(token, path, { method = "GET", body, signal } = {}) {
	const headers = {
		Accept: "application/vnd.github+json",
		"X-GitHub-Api-Version": API_VERSION,
		"User-Agent": "dsh-github"
	};
	if (token) headers.Authorization = `Bearer ${token}`;
	if (body !== undefined) headers["Content-Type"] = "application/json";
	const response = await fetch(`${API_BASE}${path}`, {
		method,
		headers,
		...body !== undefined ? { body: JSON.stringify(body) } : {},
		...signal ? { signal } : {}
	});
	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw githubError(response.status, path, text);
	}
	if (response.status === 204) return null;
	return await response.json();
}

/** Project a GitHub repo object to the leaf scalars the UI needs. */
function projectRepo(repo) {
	return {
		fullName: repo.full_name,
		description: repo.description ?? "",
		language: repo.language ?? "",
		stars: repo.stargazers_count ?? 0,
		private: !!repo.private,
		defaultBranch: repo.default_branch ?? "main",
		updatedAt: repo.updated_at ?? "",
		cloneUrl: repo.clone_url ?? "",
		htmlUrl: repo.html_url ?? ""
	};
}

async function getAuthenticatedUser(token, signal) {
	return await githubFetch(token, "/user", { signal });
}

/**
 * List the authenticated user's repositories, newest-updated first, one page.
 * @returns {{ items: unknown[], hasMore: boolean }}
 */
async function listUserRepos(token, { page = 1, perPage = DEFAULT_PER_PAGE, signal } = {}) {
	const size = Math.min(Math.max(1, perPage), MAX_PER_PAGE);
	const items = await githubFetch(token, `/user/repos?sort=updated&per_page=${size}&page=${page}`, { signal });
	const list = Array.isArray(items) ? items : [];
	return {
		items: list.map(projectRepo),
		hasMore: list.length === size
	};
}

/** Resolve one repo's metadata by `owner/name` (or full_name). */
async function getRepo(token, repo, signal) {
	const segments = String(repo).split("/").filter(Boolean);
	const owner = segments.at(-2);
	const name = segments.at(-1);
	if (!owner || !name) throw new Error(`github: repo must be "owner/name", got "${repo}"`);
	const data = await githubFetch(token, `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`, { signal });
	return projectRepo(data);
}

/** Sanitize a repo/owner segment into a filesystem-safe slug. */
function slug(value) {
	return value
		.replace(/[^A-Za-z0-9._-]+/g, "-")
		.replace(/(^[-._]+|[-._]+$)/g, "")
		.toLowerCase();
}

/**
 * Run `git clone --depth 1 [--branch b] <cloneUrl> <dest>` via a git subprocess
 * with a bounded output and a timeout. Private repos authenticate by passing the
 * token through git's env config (GIT_CONFIG_*) so the PAT never appears in
 * argv.
 *
 * @param {{ cloneUrl: string, dest: string, token?: string, branch?: string,
 *           shallow?: boolean, timeoutMs?: number }} options
 */
function gitClone({ cloneUrl, dest, token, branch, shallow, timeoutMs = 120000 }) {
	const args = ["clone", "--depth", shallow === false ? "0" : "1", ...branch ? ["--branch", branch] : [], cloneUrl, dest];
	const env = { ...process.env };
	if (token) {
		// http.extraheader is a memory-only config for this one invocation; the
		// value rides the environment, never argv.
		env.GIT_CONFIG_COUNT = "1";
		env.GIT_CONFIG_KEY_0 = "http.extraheader";
		env.GIT_CONFIG_VALUE_0 = `Authorization: Bearer ${token}`;
		env.GIT_TERMINAL_PROMPT = "0";
	}
	return new Promise((resolve, reject) => {
		const child = execFile("git", args, { env, cwd: process.cwd(), maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
			if (error) {
				// git writes diagnostics to stderr; surface a concise tail.
				const tail = String(stderr).trim().split("\n").slice(-6).join("\n") || String(stdout).trim().split("\n").slice(-6).join("\n");
				reject(new Error(`git clone failed${tail ? `: ${tail}` : ""}`));
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

export {
	API_BASE,
	githubFetch,
	githubError,
	listUserRepos,
	getRepo,
	getAuthenticatedUser,
	projectRepo,
	slug,
	gitClone
};
