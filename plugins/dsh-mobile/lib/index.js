/**
 * dsh-mobile host plugin.
 *
 * This package is client-only: the Gemini-style mobile skin has no host logic.
 * The `mobile` loader row exists only so the client module system scans the
 * package and serves its `lib/client.js` bundle (the client scan keys off the
 * host Loader's entries for packages declaring `dsh.client`). The host half is
 * therefore a no-op Cordis plugin that provides nothing and consumes nothing.
 *
 * The client half registers the top bar + drawer into the frame-wide
 * `shell.overlay` seat and uses existing Client services
 * (`workspaces.startSession`, `sessions.open`), so nothing here touches the
 * session, workspace, or RPC layers.
 */

/** Cordis plugin name used by loader diagnostics. */
export const name = "mobile";

/** No host services required. */
export const inject = [];

/** No-op: the browser half does all the work. */
export function apply() {}
