#!/usr/bin/env node
/**
 * Idempotent auto-install for the dsh-github plugin. Run from the container
 * entrypoint (before `dsh web`) so the plugin is registered into the `web`
 * profile with no manual step. The profile lives in the persistent $DSH_HOME
 * volume, so the plugin and its dependencies survive image rebuilds.
 *
 * Registration is handled by the harness's own bundle mechanism: this package
 * declares `dsh.bundle.patch`, so `dsh plugin --profile web add <pkg>` installs
 * it AND appends it to `dsh.profile.bundles`. The bundle's `cordis.patch.yml`
 * then inserts the `github` row and disables the directory-picker row. The
 * installer therefore does NOT hand-edit the profile's cordis.patch.yml.
 *
 * Steps:
 *   1. Repair a cordis.patch.yml left invalid by an earlier installer bug
 *      (a flow `[]` followed by block items is not valid YAML).
 *   2. Install/refresh the plugin via `dsh plugin --profile web add <pkg>`,
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
const PATCH_FILE = join(PROFILE_DIR, "cordis.patch.yml");
const PACKAGE = "dsh-github";
const MARKER = join(PROFILE_DIR, `.${PACKAGE}.installed`);
/** A valid empty patch document — the plugin's own bundle patch supplies the row. */
const EMPTY_PATCH = "# patch layer (see dsh profiles)\n[]\n";

const e = (m) => process.stderr.write(`dsh-github: ${m}\n`);

/**
 * Repair a profile patch that an earlier installer bug left invalid: a flow
 * empty sequence (`[]`) followed by block-sequence items is not valid YAML.
 * Detect that (or the plugin's own previously-injected rows) and rewrite the
 * file to a valid empty sequence with no user content loss (a real,
 * block-sequence profile — e.g. with an MCP client — is left untouched).
 */
function repairCordisPatch() {
	if (!existsSync(PATCH_FILE)) return false;
	const raw = readFileSync(PATCH_FILE, "utf8");
	const hasBareFlow = /(^|\n)\s*\[\]\s*(\n|$)/.test(raw);
	const hasBlockItem = /(^|\n)\s*-\s+\S/.test(raw);
	const hasGithubRow = raw.includes("id: github");
	if (hasGithubRow || (hasBareFlow && hasBlockItem)) {
		writeFileSync(PATCH_FILE, EMPTY_PATCH);
		return true;
	}
	return false;
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
	let changed = repairCordisPatch();
	if (changed) e(`repaired ${PROFILE} profile cordis.patch.yml`);
	if (installPlugin()) changed = true;
	e(changed ? `registered ${PACKAGE} in profile ${PROFILE}` : `${PACKAGE} already installed (version up to date)`);
}

main();
