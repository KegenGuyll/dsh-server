#!/usr/bin/env node
/**
 * Idempotent auto-install for the dsh-github plugin. Run from the container
 * entrypoint (before `dsh web`) so the plugin is registered into the `web`
 * profile with no manual step. The profile lives in the persistent $DSH_HOME
 * volume, so the plugin and its dependencies survive image rebuilds.
 *
 * Steps (each guarded so a fresh container after a partial install re-runs and
 * a rebuild refreshes the plugin only when the version changes):
 *   1. Ensure the `web` profile exists (packaged by the shipped web template).
 *   2. Install the plugin package into the profile node_modules via
 *      `dsh plugin --profile web add <pkg>`, which also resolves its
 *      dependencies (requires `pnpm` on PATH, added in the image).
 *   3. Idempotently add the `github` loader `insert` row to cordis.patch.yml.
 *   4. Record a version marker; re-run install when the marker version differs.
 *
 * The directory-picker client-flow/composition adjustment is intentionally left
 * OUT here and documented in the README: the plugin's chooser occupies the two
 * single-kind directory-flow holes, so the directory-picker BACKEND must stay
 * mounted while its own client-flow contribution must not be. Seeing both
 * requires a small profile composition edit (or a forked backend), which is a
 * deployment decision rather than a silent script action — see README §"directory
 * picker composition".
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import os from "node:os";

const SELF_DIR = dirname(fileURLToPath(import.meta.url));
const DSH_HOME = process.env.DSH_HOME || join(os.homedir(), ".dsh");
const PROFILE = "web";
const PROFILE_DIR = join(DSH_HOME, "profiles", PROFILE);
const NODE_MODULES = join(PROFILE_DIR, "node_modules");
const PACKAGE = "dsh-github";
const MARKER = join(PROFILE_DIR, `.${PACKAGE}.installed`);
const MINI = { e: (m) => { process.stderr.write(`dsh-github: ${m}\n`); } };

/** Shipped web profile template (mirrors dsh-app-boot's web template). */
const BUNDLES = ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"];

function ensureProfile() {
	if (existsSync(join(PROFILE_DIR, "package.json"))) return;
	mkdirSync(PROFILE_DIR, { recursive: true });
	mkdirSync(NODE_MODULES, { recursive: true });
	writeFileSync(join(PROFILE_DIR, "package.json"), JSON.stringify({
		name: "dsh-profile-web",
		private: true,
		dependencies: {},
		dsh: { profile: { bundles: BUNDLES } }
	}, null, 2) + "\n");
	writeFileSync(join(PROFILE_DIR, "cordis.yml"), "# dsh profile root — compose via cordis.patch.yml\n[]\n");
	writeFileSync(join(PROFILE_DIR, "cordis.patch.yml"), "# patch layer (see dsh profiles)\n[]\n");
	writeFileSync(join(PROFILE_DIR, "pnpm-workspace.yaml"), "packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n");
	MINI.e(`initialized ${PROFILE} profile at ${PROFILE_DIR}`);
}

/** The patch block: the `github` insert row plus the directory-picker disable. */
function patchBlock() {
	return `# dsh-github: GitHub + local workspace import (token via Settings → Plugins → GitHub).\n`
		+ `- insert:\n    - id: github\n      name: '${PACKAGE}'\n`
		+ `\n# dsh-github owns the two single-kind directory-flow holes, so disable the\n# harness directory-picker row (its client flow would otherwise collide).\n`
		+ `- id: directory-picker\n  disabled: true\n`;
}

/** Add the `github` loader insert row (+ dir-picker disable) idempotently. */
function patchCordis() {
	const patch = join(PROFILE_DIR, "cordis.patch.yml");
	const raw = existsSync(patch) ? readFileSync(patch, "utf8") : "";
	if (raw.includes("id: github")) return false;
	const text = raw.trim();
	// Empty document or a bare `[]` must become a real sequence before appending.
	if (text === "" || text === "[]") {
		writeFileSync(patch, patchBlock());
		return true;
	}
	// Existing sequence: append as another item.
	writeFileSync(patch, text + "\n\n" + patchBlock());
	return true;
}

/** Install/refresh the plugin into the profile via the dsh CLI (uses pnpm). */
function installPlugin() {
	const beforeVer = existsSync(MARKER) ? readFileSync(MARKER, "utf8").trim() : "";
	const pkgJson = JSON.parse(readFileSync(join(SELF_DIR, "package.json"), "utf8"));
	const ver = pkgJson.version;
	if (beforeVer === ver) return false; // up to date
	const result = spawnSync("dsh", ["plugin", "--profile", PROFILE, "add", SELF_DIR], {
		stdio: "inherit",
		shell: process.platform === "win32"
	});
	if (result.error?.code === "ENOENT") {
		throw new Error("dsh not found on PATH — install @deepseek-ai/dsh globally");
	}
	if (result.status !== 0) throw new Error(`dsh plugin add failed (${result.status})`);
	writeFileSync(MARKER, ver + "\n");
	return true;
}

function main() {
	ensureProfile();
	let changed = false;
	if (installPlugin()) changed = true;
	if (patchCordis()) changed = true;
	if (changed) MINI.e(`registered ${PACKAGE} in profile ${PROFILE}`);
	else MINI.e(`${PACKAGE} already installed (version up to date)`);
}

main();
