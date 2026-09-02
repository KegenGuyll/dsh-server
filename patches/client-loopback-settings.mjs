#!/usr/bin/env node
// Patch the installed @deepseek-ai/dsh client so the settings configuration
// plane is host-backed even when the page is served over a non-loopback
// (trusted) host.
//
// The DSH client deliberately keeps the settings plane loopback-only: the
// client's settings mirror and per-namespace scope are created with
// `connection.isLoopback ? "host" : "memory"`. Over a tailnet FQDN the page
// host is not loopback, so the mirror is "memory" and stays "unavailable" —
// the browser never reads settings and the Models/Settings UI fails with
// "settings are unavailable in this browser", even though the server fence
// (already relaxed by patches/trusted-config-plane.mjs) accepts the request.
//
// We pin both to "host" so the browser reads/writes settings over the wire.
// The server /api fence is the authoritative gate (relaxed only for the
// declared trusted host), so making the client host-backed on a non-loopback
// page is safe: an untrusted host the server rejects just gets a server error.
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

const file =
  explicit !== void 0
    ? explicit
    : join(
        globalRoot,
        "@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-settings/lib/client.js"
      );

if (!existsSync(file)) {
  console.error(`client-loopback-settings: target not found: ${file}`);
  process.exit(1);
}

const before = readFileSync(file, "utf8");

const needle = 'connection.isLoopback ? "host" : "memory"';
const replacement = '"host"';

// Distinctive marker of the fully-patched file (mirror+scope both "host").
const patchedMarker = 'new SettingsDescribeMirror(connection.api, "host")';

if (!before.includes(needle)) {
  if (before.includes(patchedMarker)) {
    console.log("client-loopback-settings: already patched — no change.");
    process.exit(0);
  }
  console.error("client-loopback-settings: the loopback-vs-memory marker was not found in");
  console.error(`  ${file}`);
  console.error(
    "client-loopback-settings: the upstream dsh client layout likely changed; review this patch before building."
  );
  process.exit(1);
}

const after = before.split(needle).join(replacement);

if (!after.includes(patchedMarker)) {
  console.error("client-loopback-settings: patch applied but the expected marker is absent.");
  process.exit(1);
}

writeFileSync(file, after, "utf8");
console.log(`client-loopback-settings: patched ${file}`);
console.log("client-loopback-settings: the settings mirror and scope now use host persistence.");
