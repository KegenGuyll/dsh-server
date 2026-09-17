# dsh-server

Runs [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) as an
always-on web server on the home Docker server. This repo is a thin, version-
pinned wrapper around the published `@deepseek-ai/dsh` npm package — **no
upstream fork, no source modifications**.

Access is private, over the tailnet: `https://dsh.<tailnet>.ts.net` from any
device (phone at work, computer at home). All state lives server-side in
persistent volumes, so sessions started on one device are resumable from
another. No login step: reaching that authority is the authorization — see
[Access control](#access-control).

See [`docs/dsh.md`](https://github.com/KegenGuyll/personal-pipeline/blob/main/docs/dsh.md)
for the full design, the shared-network-namespace rationale, and the
`--trusted-host` trust-fence requirement.

The image bakes the GitHub CLI for the harness agent so it can push commits and
open PRs without per-session setup. Read
[`docs/gh-agent-auth.md`](docs/gh-agent-auth.md) for how `gh` is authenticated,
where its token lives (persistent `/data/gh`), and how to re-authenticate if
needed.

## Layout

```
Dockerfile                     node:22-slim + npm i -g @deepseek-ai/dsh@<pinned> + pnpm
entrypoint.sh                  node /opt/dsh-github/install.mjs (idempotent), then
                               node /opt/dsh-mobile/install.mjs (idempotent), then
                               node /opt/dsh-stt/install.mjs (idempotent), then
                               node /opt/dsh-notify/install.mjs (idempotent), then
                               dsh web --host 127.0.0.1 --port 3080 --no-open --trusted-host "$DSH_TRUSTED_HOST"
plugins/dsh-github/            out-of-tree GitHub workspace-import plugin (host + client bundle + installer)
plugins/dsh-mobile/            Gemini-style mobile skin (client bundle + installer; hides the menu, adds New Session)
plugins/dsh-stt/               out-of-tree speech-to-text composer mic plugin (browser-only + installer)
plugins/dsh-notify/            out-of-tree ntfy push on task-complete / needs-input plugin (host + client bundle + installer)
.github/workflows/deploy.yml   calls personal-pipeline's reusable deploy-service.yml
```

## dsh-github plugin

The image ships an out-of-tree plugin, `dsh-github`, that turns the workspace
"Add workspace…" control into a two-option chooser and adds **in-session
worktrees**:

- **Add local workspace** — delegates to the directory-picker backend, exactly
  as before.
- **Import from GitHub** — a modal that lists your repositories (with a search
  filter and pagination); clicking **Import** on a repo clones it into the
  workspace root and registers it as a real workspace.
- **In-session worktrees** — the agent creates git worktrees *inside the session's
  own workspace* with `github_create_worktree` / `github_list_worktrees` /
  `github_remove_worktree`, so one session can work several issues on the same
  repo in parallel (sequentially or via subagents) without starting a new
  session. Worktrees are git-excluded, and a session's worktrees are removed when
  it is archived. Everything is configurable under the GitHub settings card
  (enable/disable, worktree directory, base branch, cleanup on archive, per-session
  cap, and more).

A **GitHub** card appears under **Settings → Plugins → Plugin configuration**
where you paste a personal access token (written to the credentials domain, so
the value never leaves the host), set the clone root, and see connection status.
The `GITHUB_TOKEN` env var (or the Settings card) supplies the token; the
card's token write is the usual way, so `.env` usually stays unset.

The plugin is a **bundle** (`dsh.bundle.patch`), so `dsh plugin --profile web add`
installs it **and** appends it to `dsh.profile.bundles`; its `cordis.patch.yml`
then registers the `github` row and disables the directory-picker row. The
auto-installer `entrypoint.sh` runs is idempotent and version-marker-gated — it
repairs a profile `cordis.patch.yml` left invalid by an earlier bug, then
installs the plugin via the `dsh` CLI. Installation is guarded by a version
marker in the profile, so a rebuilt image with a newer plugin version refreshes
it while the persistent `/data` volume survives; it does not hand-edit the
profile's `cordis.patch.yml`.

**A dsh upgrade alone does not refresh them.** The marker records only the
*plugin's* version (`plugins/dsh-*/install.mjs`: `beforeVer === ver`), so after a
dsh bump the installer reports "already installed" and the plugins keep the
client bundles they registered against the previous dsh. Force a re-registration
by clearing the markers and restarting, which is idempotent and safe to repeat:

```sh
cd <personal-pipeline checkout>
docker compose -f services/dsh-server/docker-compose.yml exec dsh-server \
  rm -f /data/profiles/web/.dsh-*.installed
docker compose -f services/dsh-server/docker-compose.yml restart dsh-server
```

### Local picking

The chooser is fully self-contained: "Add local workspace" uses a compact local
directory dialog provided by the plugin (`github/local-list` / `github/local-create`),
and "Import from GitHub" clones and registers a repo. Because the plugin owns the
two `single`-kind directory-flow holes, the harness directory-picker row is
disabled by the installer (its client flow would otherwise collide) — local
directory selection is provided entirely by the plugin.

## dsh-mobile plugin

The image also ships an out-of-tree **client-only** plugin, `dsh-mobile`, that adds
a Gemini-style mobile skin to the web UI. At mobile widths it:

- Hides the left workspace/session menu and the session header (the shipped
  sidebar and header are collapsed away), so the conversation + prompt bar fill
  the screen.
- Adds a floating **top bar**: a hamburger (top-left), the **current session
  name** (center, falling back to the workspace title), and a **New Session**
  button (top-right) that creates a new session in the current workspace.
- Opens a lightweight **drawer** when the hamburger is tapped, matching the
  desktop sidebar: a **search bar** at the top filters sessions by title, each
  workspace is a **folder-icon header row** with a **plus button at the right**
  that starts a new session there, and each session row shows its **relative
  last-used time** (e.g. `5min`, `1h`, `5d`). Tapping a session opens it; a
  translucent backdrop dismisses the drawer.
- Leaves the **prompt bar** untouched.

The drawer is the plugin's own workspace → session list built from the
`useWorkspaces` / `useSessions` slot props — it does not replace the full
shipped sidebar browser (Add-workspace, archive/rename live on desktop).
Desktop widths (>= 769px) are unaffected via a media query.

It has **no host logic** — the `mobile` loader row exists only so the client
module scan serves its bundle. Like dsh-github it is a bundle
(`dsh.bundle.patch`) auto-installed by `entrypoint.sh` via an idempotent,
version-marker-gated `install.mjs`; nothing ships in the prompt path. See
[`plugins/dsh-mobile/README.md`](plugins/dsh-mobile/README.md).

## dsh-stt plugin

The image also ships an out-of-tree browser-only plugin, `dsh-stt`, that adds
speech-to-text to the composer: a **microphone button** in the prompt's tool
row (right of the model selector, before the send button).

- Click the mic to start recording; the browser's Web Speech API transcribes
  **continuously until you click the mic again to stop** (silence does not stop
  it). Interim text streams into the prompt live; the final transcript is
  committed on stop.
- Works in **Chrome/Edge/Safari**; in Firefox the button disables with a
  tooltip (no Web Speech API).
- Everything runs in the browser — no host half, no API keys, no networking.
  Text already in the prompt is preserved (only the recording region is
  replaced, via the composer's `inputActions.setDraft`).

Same bundle install flow as `dsh-github`: `dsh.bundle.patch` →
`cordis.patch.yml` inserts the `stt` row, and `entrypoint.sh` runs its
idempotent, version-marker-gated `install.mjs`.

## dsh-notify plugin

The image ships an out-of-tree plugin, `dsh-notify`, that pushes **ntfy**
notifications to your phone when the agent finishes a task or needs your input.
Because you reach DSH from an iPhone via a home-screen shortcut (and the page
may not be in the foreground), delivery goes through an ntfy topic rather than a
browser banner:

- **Task complete** — `agent/status` → `idle`, after a run ≥ `minDoneSeconds`,
  and not while a DSH page is visibly in the foreground.
- **Plan needs review** — `agent/status` → `idle` while `planMode` is pending.
- **Needs your input** — the agent calls the **`ping_user`** tool
  (`kind: input`) when it is blocked on a human (an approval, a clarifying
  question, handing back a plan).

You configure the topic (and optional access token) under **Settings → Plugins →
Notify** and hit **Send test**; the token is written to the credentials domain
and never leaves the host. See
[`plugins/dsh-notify/README.md`](plugins/dsh-notify/README.md) for setup and the
config reference. Same bundle install flow (`dsh.bundle.patch` →
`cordis.patch.yml` inserts the `notify` row) and an idempotent,
version-marker-gated `install.mjs`.

## Runtime contract

The deploy agent writes these into `services/dsh-server/.env` on the server
(from the repo's `SERVICE_ENV` secret, plus `TAG`). See
[`.env.example`](.env.example) for a complete, commented template:

| Variable          | Meaning                                                        |
|-------------------|----------------------------------------------------------------|
| `TAG`             | Image tag (`sha-<commit>`), written by the deploy agent        |
| `TS_HOSTNAME`     | Optional; MagicDNS hostname (default `dsh`)                    |
| `DEEPSEEK_API_KEY`| DeepSeek API key (or configure in the web UI Models page)      |
| `DSH_TRUSTED_HOST`| Must equal the hostname browsers use, e.g. `dsh.<tailnet>.ts.net` |

Volumes (declared in `services/dsh-server/docker-compose.yml`):

- `dsh-data` → `/data` = `$DSH_HOME`: sessions (JSONL), `settings.yaml`,
  `.credentials.yaml`, the auto-initialized web profile, `storages/`
- `dsh-workspaces` → `/workspaces` = the agent's working directory

## Updating

1. Bump the pinned `@deepseek-ai/dsh` version in the `Dockerfile`.
2. Commit and push to `main`.
3. The workflow builds `ghcr.io/kegenguyll/dsh:<sha>` + `:latest`
   (amd64 + arm64), notifies the deploy agent, which pulls and restarts.

Sessions/settings/credentials survive because they live in volumes, not the
image. Session logs are forward-compatible by design (versioned headers +
read-compat path), and the web profile resolves bundles from the installed dsh
first, so an old profile boots against a new install.

### Knowing when the pin is stale

Deploy only runs on a push to `main`, so nothing here would otherwise notice that
upstream published a new dsh — a stale pin is invisible. `.github/workflows/dsh-version-check.yml`
closes that gap: every Monday it reads the pin out of the `Dockerfile`, asks the
npm registry for the current `latest` dist-tag, and when they differ opens a PR
bumping the pin *and* the `@deepseek-ai/dsh-*` peer ranges in
`plugins/*/package.json` (those must move together — a caret on a prerelease does
not match a different patch, so `^0.1.1-rc.2` never satisfies `0.1.5-rc.2`).

It never merges and never deploys: pushing the bump branch does not trigger
Deploy, which only listens to pushes on `main`. Run it on demand from the Actions
tab to track a different dist-tag (`next`, `alpha`). Each PR body carries the
verification checklist that an actual bump requires — both `patches/` scripts
matching upstream (each fails the image build loudly when it does not), and the
plugin client bundles being re-patched (the `plugins/dsh-*/install.mjs` markers
key on the *plugin's* version, so a dsh bump alone skips re-applying
`dsh.bundle.patch`).

### Access control

dsh 0.1.5 added a browser-auth layer: `/api` requests must come from a declared
`--trusted-host` authority **and** carry a signed, authority-bound session
cookie, which the index page mints when it is opened with a one-time
`?token=<per-process secret>`.

That token is `randomBytes()` at startup — no env override, no CLI flag, no
config field — and dsh writes it only to its own log. The PWA manifest dsh serves
also pins `"start_url": "/"` with `"display": "fullscreen"`, so an installed app
always launches at `/` and can never carry a token; an installed PWA keeps its
own cookie jar too, so authenticating in a browser tab does not transfer.

`patches/trusted-host-session-bypass.mjs` therefore treats a request that already
passed the Host/Origin fence as authenticated. `/api` and the index page accept
loopback and the declared trusted host without a session cookie; nothing else
changes:

| request | result |
|---|---|
| `Host` = `DSH_TRUSTED_HOST` (the tailnet FQDN) | allowed, no cookie |
| loopback, including the compose healthcheck on `/` | allowed, no cookie |
| any other authority | `403` |
| cross-site (`Sec-Fetch-Site: cross-site`) or cross-origin `Origin` | `403` |

**The posture, stated plainly:** anyone who can reach that authority gets full
access, including settings and credentials. The tailnet ACL is the auth boundary,
not a cookie — which is what this deployment ran before 0.1.5, and what
[`docs/dsh.md`](https://github.com/KegenGuyll/personal-pipeline/blob/main/docs/dsh.md)
already declares. If a tailnet device is ever lost or shared, remove it from the
tailnet; there is no second factor behind this.

The patch is idempotent and fails the image build loudly if upstream moves either
gate, so this posture cannot silently revert to "token required" without a red
build. If it ever does fail, re-derive the two markers in `HostConnectionService`
(`requestRejection`, `authorizeIndex`) — do not loosen the checks.

## Rolling back

Every build leaves its `sha-…` tag in GHCR. On the server:

```sh
cd <personal-pipeline checkout>
# put the previous sha in services/dsh-server/.env (TAG=sha-xxxxxxx) — or revert
# the repo and push — then:
docker compose -f services/dsh-server/docker-compose.yml up -d
```

Detecting a stale pin is automatic; merging the bump is deliberate. Nothing here
upgrades or deploys itself — the scheduled job only proposes a PR.
