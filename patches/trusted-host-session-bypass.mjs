#!/usr/bin/env node
// Patch the installed @deepseek-ai/dsh so the browser session gate accepts the
// deployment's declared trusted host outright, instead of demanding a
// per-process launch token.
//
// Why: dsh 0.1.5 added a real browser-auth layer. `HostConnectionService` now
// fences every /api request on the trusted-host check *and* a signed,
// authority-bound session cookie, and serves the index page only after a
// one-time exchange of a `?token=<per-process secret>` query parameter for that
// cookie. The token is `randomBytes()` at startup (no env override, no CLI
// flag, no config field), so it can only be read from the process log.
//
// That is unworkable for this deployment's only client — an installed PWA. The
// manifest served by dsh pins `"start_url": "/"` with `"display": "fullscreen"`,
// so an installed app always launches at `/` and can never carry a token; the
// cookie jar of an installed PWA is also separate from the browser's, so
// authenticating in a browser tab does not carry over. The only way to reach
// the UI from the home-screen icon would be to bake the token into the served
// manifest — which is world-readable before authentication, so it would leak
// the token to anyone who can reach the service anyway, at the cost of far more
// machinery.
//
// This patch instead treats "reached us over a declared trusted host" as
// authenticated. The Host/Origin fence is untouched, so requests from any
// authority that is not loopback and not in `trustedHosts` are still refused
// with 403, and cross-site requests are still rejected. What is dropped is only
// the second factor for requests that already arrived over the authority the
// operator explicitly declared — `--trusted-host`, i.e. the tailnet MagicDNS
// name, whose access control is the tailnet itself (docs/dsh.md).
//
// Consequence to be explicit about: anyone who can reach that authority gets
// full access, including the settings and credentials plane. That is the
// posture this deployment ran before 0.1.5 (0.1.1 had no session layer at all),
// and it makes the tailnet ACL the auth boundary rather than a cookie.
//
// Both edit sites are in HostConnectionService; every other session decision
// lives inside BrowserAuth and is reached only through `authorizeIndex`, so
// covering these two methods covers the whole gate:
//   requestRejection  — the /api fence (called from the shared fetch handlers)
//   authorizeIndex    — the index-page handshake that mints the cookie
//
// Usage:  node trusted-host-session-bypass.mjs [TARGET_FILE]
//   TARGET_FILE optional explicit path (for tests). Defaults to the
//   dsh-client-connection lib under `npm root -g`.
//
// Idempotent: re-running on an already-patched file is a no-op.
// Fail-loud: if either marker is missing (upstream changed the layout) the
// build fails so this posture is never silently dropped on a dsh upgrade.
import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const explicit = process.argv[2];
const globalRoot =
  explicit !== void 0
    ? undefined
    : execSync("npm root -g", { encoding: "utf8" }).trim().split(/\r?\n/)[0];

// Candidate target paths, most-specific first. Node resolves a package from the
// requiring package's own node_modules before walking up, so the copy nested
// under @deepseek-ai/dsh is the one the harness loads whenever both exist — and
// it is the layout `npm install -g` produces. The hoisted path is tried only if
// a future install flattens the tree.
const candidates =
  explicit !== void 0
    ? [explicit]
    : [
        join(
          globalRoot,
          "@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-connection/lib/index.js"
        ),
        join(
          globalRoot,
          "@deepseek-ai/dsh-client-connection/lib/index.js"
        )
      ];

const file = candidates.find((candidate) => existsSync(candidate));

if (file === void 0) {
  console.error("trusted-host-session-bypass: target not found. Looked for:");
  for (const candidate of candidates) console.error(`  ${candidate}`);
  console.error(
    "trusted-host-session-bypass: expected the installed @deepseek-ai/dsh to bundle @deepseek-ai/dsh-client-connection under its own node_modules."
  );
  process.exit(1);
}

// Stamped into each replacement so an already-patched file is recognizable and
// the deviation is self-documenting in the installed tree.
const STAMP = "/* dsh-server: trusted-host session bypass */";

const EDITS = [
  {
    label: "the /api session check in requestRejection",
    // `trustedHosts` is already in scope here (this.trustedHosts).
    needle: "return this.browserAuth.isAuthenticated(request) ? void 0 : 401;",
    replacement: `return void 0; ${STAMP}`
  },
  {
    label: "the index handshake in authorizeIndex",
    // Only requests that already pass the Host/Origin fence skip the token
    // exchange; everything else keeps upstream behaviour (401), including the
    // page shell.
    needle: "return this.browserAuth.authorizeIndex(request, response);",
    replacement: `return isTrustedApiRequest(request, this.trustedHosts) ? true : this.browserAuth.authorizeIndex(request, response); ${STAMP}`
  }
];

const before = readFileSync(file, "utf8");

// Already patched: every replacement present, so nothing to do.
if (EDITS.every((edit) => before.includes(edit.replacement))) {
  console.log(
    `trusted-host-session-bypass: already patched — no change (${file}).`
  );
  process.exit(0);
}

let after = before;
let changed = false;
for (const edit of EDITS) {
  // Idempotency is per site: a file that already carries this replacement is
  // done, whether or not the other site has been handled yet.
  if (after.includes(edit.replacement)) continue;

  if (!after.includes(edit.needle)) {
    console.error(
      `trusted-host-session-bypass: could not find ${edit.label} in`
    );
    console.error(`  ${file}`);
    console.error(
      "trusted-host-session-bypass: the upstream dsh layout likely changed; review this patch before building."
    );
    process.exit(1);
  }

  // A second occurrence would be patched only partially by the first-only
  // replace below, leaving part of the gate in place and failing open/closed
  // unpredictably; refuse instead.
  const occurrences = after.split(edit.needle).length - 1;
  if (occurrences !== 1) {
    console.error(
      `trusted-host-session-bypass: expected exactly one occurrence of ${edit.label}, found ${String(occurrences)} in`
    );
    console.error(`  ${file}`);
    console.error(
      "trusted-host-session-bypass: review this patch — every site must be handled."
    );
    process.exit(1);
  }

  after = after.replace(edit.needle, edit.replacement);
  changed = true;
}

if (!changed) {
  console.log(
    `trusted-host-session-bypass: already patched — no change (${file}).`
  );
  process.exit(0);
}

// Confirm the end state before writing anything: both stamps present exactly
// once, and neither original marker left behind.
for (const edit of EDITS) {
  if (after.split(edit.replacement).length - 1 !== 1) {
    console.error(
      `trusted-host-session-bypass: the replacement for ${edit.label} is not present exactly once after patching.`
    );
    process.exit(1);
  }
  if (after.includes(edit.needle)) {
    console.error(
      `trusted-host-session-bypass: ${edit.label} still matches after patching.`
    );
    process.exit(1);
  }
}

writeFileSync(file, after, "utf8");
console.log(`trusted-host-session-bypass: patched ${file}`);
console.log(
  "trusted-host-session-bypass: /api and the index now accept the declared trusted host (and loopback) without a session cookie."
);
