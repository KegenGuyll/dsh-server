# dsh-server

Runs [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) as an
always-on web server on the home Docker server. This repo is a thin, version-
pinned wrapper around the published `@deepseek-ai/dsh` npm package — **no
upstream fork, no source modifications**.

Access is private, over the tailnet: `https://dsh.<tailnet>.ts.net` from any
device (phone at work, computer at home). All state lives server-side in
persistent volumes, so sessions started on one device are resumable from
another.

See [`docs/dsh.md`](https://github.com/KegenGuyll/personal-pipeline/blob/main/docs/dsh.md)
for the full design, the shared-network-namespace rationale, and the
`--trusted-host` trust-fence requirement.

## Layout

```
Dockerfile                     node:22-slim + npm i -g @deepseek-ai/dsh@<pinned> + pnpm
entrypoint.sh                  node /opt/dsh-github/install.mjs (idempotent), then
                               node /opt/dsh-git-changes/install.mjs (idempotent), then
                               dsh web --host 127.0.0.1 --port 3080 --no-open --trusted-host "$DSH_TRUSTED_HOST"
plugins/dsh-github/            out-of-tree GitHub workspace-import plugin (host + client bundle + installer)
plugins/dsh-git-changes/       out-of-tree Git changes panel (host + client bundle + installer)
.github/workflows/deploy.yml   calls personal-pipeline's reusable deploy-service.yml
```

## dsh-github plugin

The image ships an out-of-tree plugin, `dsh-github`, that turns the workspace
"Add workspace…" control into a two-option chooser:

- **Add local workspace** — delegates to the directory-picker backend, exactly
  as before.
- **Import from GitHub** — a modal that lists your repositories (with a search
  filter and pagination); clicking **Import** on a repo clones it into the
  workspace root and registers it as a real workspace.

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

### Local picking

The chooser is fully self-contained: "Add local workspace" uses a compact local
directory dialog provided by the plugin (`github/local-list` / `github/local-create`),
and "Import from GitHub" clones and registers a repo. Because the plugin owns the
two `single`-kind directory-flow holes, the harness directory-picker row is
disabled by the installer (its client flow would otherwise collide) — local
directory selection is provided entirely by the plugin.

## dsh-git-changes plugin

The image ships an out-of-tree plugin, `dsh-git-changes`, that adds a **"Changes"**
button to the session header utilities and opens a **docked right-column panel**
that lists every file changed on the currently checked-out branch of the session
workspace (vs its base, `main`/`master`), plus uncommitted and untracked work. A
filterable files list sits on the left; the selected file's diff on the right, with
S/M/L width presets.

All git data is produced **host-side** via `git` over the durable Connection RPC
channel, so the browser never runs shell commands. See
[`plugins/dsh-git-changes/README.md`](plugins/dsh-git-changes/README.md) for setup.
Same bundle install flow (`dsh.bundle.patch` → `cordis.patch.yml` inserts the
`git-changes` row) and an idempotent, version-marker-gated `install.mjs`.

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

## Rolling back

Every build leaves its `sha-…` tag in GHCR. On the server:

```sh
cd <personal-pipeline checkout>
# put the previous sha in services/dsh/.env (TAG=sha-xxxxxxx) — or revert the
# repo and push — then:
docker compose -f services/dsh/docker-compose.yml up -d
```

Updates are deliberate (a version bump in a commit); there is no auto-update.
