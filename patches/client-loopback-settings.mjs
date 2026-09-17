#!/usr/bin/env node
// Patch the installed @deepseek-ai/dsh client so the settings configuration
// plane is host-backed even when the page is served over a non-loopback
// (trusted) host.
//
// Upstream keeps the settings plane loopback-only on the *client*: the client's
// describe mirror and per-namespace scope bind to
// `ctx.remote.$host.isLoopback ? "host" : "memory"`. Over a tailnet FQDN the
// page authority is not loopback, so persistence is "memory", the scope
// controller reports status "unavailable", and the browser never reads or
// writes settings even though the server would accept the request.
//
// We pin that one decision to "host" so the browser reads and writes settings
// over the wire. A single constant feeds both consumers (the describe mirror
// and the scope binder), so this is the entire client-side deviation.
//
// Safety: the server /api fence stays the authoritative gate. Since dsh 0.1.5
// that fence is `trustedHosts` (the --trusted-host authorities) *plus* a signed,
// authority-bound browser session cookie minted from the launch URL (upstream
// BrowserAuth). A page on an untrusted authority, or one carrying no valid
// session, is rejected server-side no matter what the client believes, so
// forcing "host" persistence cannot widen access by itself. This patch replaces
// the old trusted-config-plane patch, which relaxed a privileged-methods gate
// that no longer exists: 0.1.5 deleted PRIVILEGED_METHODS and fences the whole
// plane uniformly, so the tailnet host is now accepted natively.
//
// Layout note (dsh 0.1.5-rc.2): the decision moved out of the constructor call
// and into a hoisted constant.
//   0.1.1:   new SettingsDescribeMirror(connection.api,
//              connection.isLoopback ? "host" : "memory")
//   0.1.5:   const persistence = ctx.remote.$host.isLoopback ? "host" : "memory";
//            const mirror = new SettingsDescribeMirror(ctx, persistence);
// so the patched marker is that constant, not a constructor argument.
//
// Usage:  node client-loopback-settings.mjs [TARGET_FILE]
//   TARGET_FILE optional explicit path (for tests). Defaults to the
//   dsh-client-ui-settings lib under `npm root -g`.
//
// Idempotent: re-running on an already-patched file is a no-op.
// Fail-loud: if the marker is missing (upstream changed the layout) the build
// fails so the deviation is never silently dropped on a dsh upgrade.
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
// a future install flattens the tree, so an npm layout change cannot fail the
// build on its own.
const candidates =
  explicit !== void 0
    ? [explicit]
    : [
        join(
          globalRoot,
          "@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-settings/lib/client.js"
        ),
        join(
          globalRoot,
          "@deepseek-ai/dsh-client-ui-settings/lib/client.js"
        )
      ];

const file = candidates.find((candidate) => existsSync(candidate));

if (file === void 0) {
  console.error("client-loopback-settings: target not found. Looked for:");
  for (const candidate of candidates) console.error(`  ${candidate}`);
  console.error(
    "client-loopback-settings: expected the installed @deepseek-ai/dsh to bundle @deepseek-ai/dsh-client-ui-settings under its own node_modules."
  );
  process.exit(1);
}

const before = readFileSync(file, "utf8");

// The unique client-side decision: one constant feeds both the describe mirror
// and the settings scope binder.
const needle =
  'const persistence = ctx.remote.$host.isLoopback ? "host" : "memory";';
const replacement = 'const persistence = "host";';

// Distinctive marker of the fully-patched file.
const patchedMarker = replacement;

if (!before.includes(needle)) {
  if (before.includes(patchedMarker)) {
    console.log(
      `client-loopback-settings: already patched — no change (${file}).`
    );
    process.exit(0);
  }
  console.error(
    "client-loopback-settings: the loopback-vs-memory marker was not found in"
  );
  console.error(`  ${file}`);
  console.error(
    "client-loopback-settings: the upstream dsh client layout likely changed; review this patch before building."
  );
  process.exit(1);
}

// A second occurrence would be patched only partially by the first-only
// replace below, leaving persistence "memory" somewhere and no error; refuse.
const occurrences = before.split(needle).length - 1;
if (occurrences !== 1) {
  console.error(
    `client-loopback-settings: expected exactly one persistence decision, found ${String(occurrences)} in`
  );
  console.error(`  ${file}`);
  console.error(
    "client-loopback-settings: review this patch — each site must be pinned to \"host\"."
  );
  process.exit(1);
}

const after = before.replace(needle, replacement);

if (!after.includes(patchedMarker)) {
  console.error(
    "client-loopback-settings: patch applied but the expected marker is absent."
  );
  process.exit(1);
}

writeFileSync(file, after, "utf8");
console.log(`client-loopback-settings: patched ${file}`);
console.log(
  "client-loopback-settings: the settings mirror and scope now use host persistence."
);
