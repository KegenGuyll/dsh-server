#!/usr/bin/env node
// Patch the installed @deepseek-ai/dsh so the settings/credentials
// configuration plane honors --trusted-host instead of being pinned to
// loopback.
//
// Upstream keeps the config plane loopback-only until a real authentication
// layer exists (dsh-client-connection: "the whole configuration plane stays
// loopback-same-origin until a real authentication layer exists"; and
// /api README: "The browser carrier restricts the whole configuration plane,
// reads and native actions included (settings.describe/openDocument/update/
// replace/mutate, credentials.describe/set/unset), to loopback same-origin
// requests"). This deployment serves DSH over a private tailnet, which is the
// auth boundary (docs/dsh.md), so we relax the privileged-methods gate to
// accept the same trusted hosts the outer /api fence already accepts.
//
// The change is surgical: in the /api fetch handler, the privileged-methods
// check uses an EMPTY trust list ("... and privileged methods additionally
// pass it with an empty trust list, which pins them to loopback"). We swap
// that empty list for the caller's configured trustedHosts.
//
// Usage:  node trusted-config-plane.mjs [TARGET_FILE]
//   TARGET_FILE optional explicit path (for tests). Defaults to the
//   dsh-client-connection lib under `npm root -g`.
//
// Idempotent: re-running on an already-patched file is a no-op.
// Fail-loud: if the guard's unique marker is missing (upstream changed the
// layout), the build fails so the deviation is never silently lost.
import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const explicit = process.argv[2];
const globalRoot =
  explicit !== void 0
    ? undefined
    : execSync("npm root -g", { encoding: "utf8" }).trim().split(/\r?\n/)[0];

const file =
  explicit !== void 0
    ? explicit
    : join(
        globalRoot,
        "@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-connection/lib/index.js"
      );

if (!existsSync(file)) {
  console.error(`trusted-config-plane: target not found: ${file}`);
  console.error(
    "trusted-config-plane: expected the installed @deepseek-ai/dsh to bundle @deepseek-ai/dsh-client-connection under its own node_modules."
  );
  process.exit(1);
}

const before = readFileSync(file, "utf8");

// The unique marker of the privileged-methods guard. `trustedHosts` is already
// in scope in apply(ctx, config) at that point (const trustedHosts =
// config?.trustedHosts ?? []).
const marker =
  "PRIVILEGED_METHODS.has(method) && !isTrustedApiRequest(request, [])";
const replacement =
  "PRIVILEGED_METHODS.has(method) && !isTrustedApiRequest(request, trustedHosts)";

if (before.includes(replacement)) {
  // Even if the marker is gone, an already-patched file is the desired end
  // state; the replace must target the marker, so we short-circuit here.
  console.log("trusted-config-plane: already patched — no change.");
  process.exit(0);
}

if (!before.includes(marker)) {
  console.error(
    "trusted-config-plane: the privileged-methods guard marker was not found in"
  );
  console.error(`  ${file}`);
  console.error(
    "trusted-config-plane: the upstream dsh layout likely changed; review this patch before building."
  );
  process.exit(1);
}

const after = before.replace(marker, replacement);

// Confirm exactly one change landed.
if (after.split(replacement).length - 1 !== 1) {
  console.error("trusted-config-plane: replacement did not apply exactly once.");
  process.exit(1);
}

writeFileSync(file, after, "utf8");
console.log(`trusted-config-plane: patched ${file}`);
console.log("trusted-config-plane: the privileged config-plane gate now honors trustedHosts.");
