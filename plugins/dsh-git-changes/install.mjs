#!/usr/bin/env node
/**
 * Idempotent auto-install for the dsh-git-changes plugin. Run from the container
 * entrypoint (before `dsh web`) so the plugin is registered into the `web`
 * profile with no manual step. The profile lives in the persistent $DSH_HOME
 * volume, so the plugin and its bundle survive image rebuilds.
 *
 * Registration is handled by the harness's own bundle mechanism: this package
 * declares `dsh.bundle.patch`, so `dsh plugin --profile web add <pkg>` installs
 * it AND appends it to `dsh.profile.bundles`. The bundle's `cordis.patch.yml`
 * then inserts the `git-changes` row. The installer therefore does NOT hand-edit
 * the profile's cordis.patch.yml.
 *
 * Steps:
 *   1. Install/refresh the plugin via `dsh plugin --profile web add <pkg>`,
 *      gated by a version marker so a rebuild with a newer version refreshes
 *      it and an unchanged boot is a no-op.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import os from "node:os";

const SELF_DIR = dirname(fileURLToPath(import.meta.url));
const DSH_HOME = process.env.DSH_HOME || join(os.homedir(), ".dsh");
const PROFILE = "web";
const PROFILE_DIR = join(DSH_HOME, "profiles", PROFILE);
const PACKAGE = "dsh-git-changes";
const MARKER = join(PROFILE_DIR, `.${PACKAGE}.installed`);

const e = (m) => process.stderr.write(`dsh-git-changes: ${m}\n`);

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
	const changed = installPlugin();
	e(changed ? `registered ${PACKAGE} in profile ${PROFILE}` : `${PACKAGE} already installed (version up to date)`);
}

main();
