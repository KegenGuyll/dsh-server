# dsh-github

An out-of-tree DeepSeek Harness plugin (dual-face: host + browser) that turns the
workspace "Add workspace…" flow into a two-option chooser and registers a
token/status card under **Settings → Plugins → Plugin configuration**.

- **Add local workspace** — a self-contained compact directory dialog (navigate
  the host filesystem, create a folder) over this plugin's own host handlers.
- **Import from GitHub** — a modal listing the signed-in user's repositories
  (live search filter + pagination); clicking **Import** clones the repo into
  `cloneRoot` and registers it as a workspace. The clone path is handed to the
  workspace-flow owner's normal adoption, so registration/selection works exactly
  like a local pick.

**Option B:** the plugin owns the local pick too, so it is fully self-contained —
it does not depend on the harness directory-picker backend, and the installer
disables the `directory-picker` row so its client flow does not collide with this
plugin's chooser in the two `single`-kind directory-flow holes.

The token is a fine-grained GitHub PAT. It is stored through the DSH credentials
domain (default ref `GITHUB_TOKEN`) and resolved **per operation** on the host,
so it never reaches the browser and edits take effect without a restart.

## Layout

```
package.json    manifest + dsh.client declaration
lib/index.js    host plugin: settings namespace + client→host handlers
lib/github.js   GitHub REST client, PAT resolution, repo listing, clone+register
lib/client.js   browser half (lazy-CJS factory): chooser, GitHub modal, settings card
install.mjs     idempotent auto-install (called by the container entrypoint)
```

The browser half is written directly in the harness's lazy-CJS factory format
(`window.__ModuleLoader__.load({ id, factory })`) so it needs no bespoke bundler;
dependencies (`react`, the `dsh-client-*` roster) resolve through the client
module system.

## Configuration

| Setting | Default | Meaning |
|---|---|---|
| `tokenEnv` | `GITHUB_TOKEN` | credential-ref name holding the PAT |
| `cloneRoot` | `process.cwd()` | directory imported repos are cloned under (`/workspaces` in Docker) |
| `shallow` | `true` | `git clone --depth 1` |

## Client → host channel

All GitHub work runs on the host; the browser reaches it through the host
service methods below. `lib/index.js` declares the handlers; `lib/client.js`
invokes them and receives serializable results. Because the browser must never
hold the PAT, this is the one unavoidable host round trip.

The handlers are registered with `harness.handle` and called with `host.call` —
the **dynamic-Cordis** client→host mechanism, which is mounted in the web
profile via `cordis-host-runner`/`cordis-client-runner`. **Note:** durable plugins
normally expose a service to the browser through a **generated Remote** (e.g.
`ctx.workspaces`), which needs the harness typert/cordis codegen step. That
codegen is not runnable from this thin-wrapper repo, so this plugin currently
uses the `harness`/`host` RPC instead. Confirm on a live server that the mounted
cordis-runner makes `harness.handle`/`host.call` available to a durable (non-dynamic)
plugin; if not, switch these to a generated `github` Remote (add the typert/cordis
build to the Docker stage).

Methods:
- `github/list-user-repos` `{ page, perPage }` → `{ items, hasMore }`
- `github/import` `{ repo, branch?, shallow? }` → `{ path, title, workspaceId }`
- `github/local-list` `{ path? }` → `{ path, entries, hasParent }`
- `github/local-create` `{ path, name }` → `{ path }`
- `github/status` → `{ configured }`
- `github/set-token` `{ value }` → writes the credential ref
- `github/clear-token` → removes the credential ref

## Composition

The chooser occupies the two `single`-kind directory-flow holes
(`sidebar.workspaces.directoryFlow`, `conversation.hero.workspace.directoryFlow`).
Because the plugin owns the local pick (Option B), the harness directory-picker
row is **disabled** by the installer so its client flow does not collide with the
stopper chooser in those holes. Directory selection is then provided entirely by
this plugin (`github/local-list` / `github/local-create`).

## Installation

Auto-installed from the image by `entrypoint.sh`:

```sh
node /opt/dsh-github/install.mjs
```

This initializes the `web` profile if needed, runs
`dsh plugin --profile web add /opt/dsh-github`, and idempotently appends the
`github` loader row and the `directory-picker` disable to
`profiles/web/cordis.patch.yml`. A version marker in the profile makes it refresh
the plugin on an image version change and skip on an unchanged boot.

## Verification status

The host logic (`lib/github.js`) is smoke-tested (stubbed `fetch`: listing,
metadata, error mapping). All files pass `node --check`. Because this is an
out-of-tree plugin with a browser half, the following need a live harness run
and cannot be fully confirmed by static inspection:

- peer-dependency resolution of the `@deepseek-ai/dsh-*` framework packages from
  the profile install;
- the **client→host channel**: durable plugins normally expose a generated
  Remote (typert codegen). This plugin uses `harness.handle`/`host.call` (the
  dynamic-Cordis mechanism); confirm it is available to a durable plugin, or
  add a generated `github` Remote to the build;
- the directory-flow owner-props contract (the chooser receives `open`/`busy`/
  `onPicked`/`onCancel`/`onError` plus the injected action props).
