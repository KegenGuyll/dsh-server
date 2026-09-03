# dsh-mobile

A Gemini-style mobile skin for the DeepSeek Harness web UI. It is **client-only**
— no host logic, no model tools, no RPC.

On mobile-width viewports it:

- Hides the left workspace/session menu entirely (the shipped sidebar and the
  details panel are collapsed away) and hides the shipped conversation session
  header (the breadcrumb/title row, the Chat/Details tabs, and the session-log
  action) so the conversation + prompt bar fill the screen.
- Adds a floating **top bar**: a hamburger (top-left), the **current session name**
  (center, falling back to the workspace title), and a **New Session** button
  (top-right). The top-right button creates a new session in the current workspace.
- Tapping the hamburger opens a **lightweight custom drawer** matching the
  desktop sidebar's structure: a **search bar** at the top that filters sessions
  by title, each workspace shown as a **folder-icon header row** with a **plus
  button at the right** that starts a new session in that workspace, and each
  session row showing its **relative last-used time** (e.g. `5min`, `1h`, `5d`).
  Tapping a session opens it. **Holding (long-press) a session row opens a bottom
  action sheet** with the per-session actions **Rename**, **Fork**, and
  **Archive** (the same three the desktop sidebar exposes). Archived sessions are
  hidden from the drawer list. A translucent backdrop dismisses the drawer.
- Leaves the **prompt bar** untouched.

The drawer is the plugin's own workspace → session list, built only from the
`useWorkspaces` / `useSessions` standard slot props (filtering is client-side over
the session titles, so no host search RPC). It intentionally does **not**
replace the shipped sidebar browser — it is not the full Add-workspace /
archive / rename surface. The menu button is top-left and the New Session button
top-right, matching the Gemini reference.

Desktop widths (>= 769px) are unaffected: the floating UI is hidden by a media
query and the normal sidebar / session header remain.

## Layout

```
lib/index.js     host half — a no-op Cordis plugin (this package is client-only)
lib/client.js    browser half (lazy-CJS factory): top bar, drawer, injected CSS
cordis.patch.yml registers the `mobile` loader row (the client-module scan key)
install.mjs      idempotent auto-installer run by entrypoint.sh
```

## Installation

The package declares `dsh.bundle.patch`, so `dsh plugin --profile web add <pkg>`
installs it **and** appends it to `dsh.profile.bundles`; the bundle patch then
inserts the `mobile` row. `entrypoint.sh` runs the idempotent installer:

```sh
node /opt/dsh-mobile/install.mjs
```

It (1) repairs a profile `cordis.patch.yml` left invalid only when it is
genuinely malformed YAML, then (2) runs
`dsh plugin --profile web add /opt/dsh-mobile`, gated by a version marker so a
rebuild with a newer version refreshes the plugin and an unchanged boot is a
no-op. It does not hand-edit the profile's `cordis.patch.yml`.

## Customizing

- **Breakpoint / colors:** edit the media query and the CSS variables in
  `lib/client.js` (uses the harness theme tokens `--dsw-alias-*`).
- **New Session behavior:** the top-right and per-workspace actions call
  `workspaces.startSession()` / `startSession(workspaceId)`, which is the
  harness's own New Session flow (current/recent workspace → reused or fresh
  blank session → navigate).
