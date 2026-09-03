# dsh-github

An out-of-tree DeepSeek Harness plugin (dual-face: host + browser) that turns the
workspace "Add workspace…" flow into a two-option chooser and registers a
collapsible settings card under **Settings → Plugins → Plugin configuration**
for the PAT (a write-only status/token control), the clone root, and the
shallow-clone flag — staged behind a Save/Discard footer like the shipped
plugin cards.

- **Add local workspace** — a self-contained compact directory dialog (navigate
  the host filesystem, create a folder) over this plugin's own host handlers.
- **Import from GitHub** — a modal listing the signed-in user's repositories
  (live search filter + pagination); clicking **Import** clones the repo into
  `cloneRoot` and registers it as a workspace. The clone path is handed to the
  workspace-flow owner's normal adoption, so registration/selection works exactly
  like a local pick.

**Option B:** the plugin owns the local pick too, so it is fully self-contained —
it does not depend on the harness directory-picker backend, and its bundle patch
(`cordis.patch.yml`) disables the `directory-picker` row so that client flow does
not collide with this plugin's chooser in the two `single`-kind directory-flow
holes.

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

The handlers are registered on the generic Connection RPC channel
(`ctx.connection.rpc` with `authority: 'trusted-host'`) and invoked from the
browser with `rpc.call('/github', method, args)` — the durable transport that
works over the tailnet, unlike the loopback-only settings RPCs. A generated
Remote is an alternative but requires the harness typert/cordis codegen step,
which is not runnable from this thin-wrapper repo; the generic RPC channel
avoids that.

The channel is namespaced to this plugin (`/github`): each `connection.rpc`
channel registers a distinct physical prefix route, so two plugins must not
share a channel name. dsh-notify owns `/notify`; a per-plugin channel is what
prevents the `duplicate prefix route` plugin-load failure.

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
(`sidebar.workspaces.directoryFlow`, `conversation.hero.workspace.directoryFlow`),
and the plugin owns the local pick (Option B). It is registered as a **bundle**
(`dsh.bundle.patch`), so its `cordis.patch.yml` is composed automatically:
it inserts the `github` row and disables the harness `directory-picker` row so
that client flow does not collide in those holes. Directory selection is
provided entirely by the plugin (`github/local-list` / `github/local-create`).

## Installation

The package declares `dsh.bundle.patch`, so `dsh plugin --profile web add <pkg>`
installs it **and** appends it to `dsh.profile.bundles`; the bundle patch then
registers the row. `entrypoint.sh` runs the idempotent installer:

```sh
node /opt/dsh-github/install.mjs
```

It (1) repairs a profile `cordis.patch.yml` left invalid by an earlier installer
bug, then (2) runs `dsh plugin --profile web add /opt/dsh-github`, gated by a
version marker so a rebuild with a newer version refreshes the plugin and an
unchanged boot is a no-op. It does not hand-edit the profile's
`cordis.patch.yml`.

## Verification status

The host logic (`lib/github.js`) is smoke-tested (stubbed `fetch`: listing,
metadata, error mapping). All files pass `node --check`. Because this is an
out-of-tree plugin with a browser half, the following need a live harness run
and cannot be fully confirmed by static inspection:

- peer-dependency resolution of the `@deepseek-ai/dsh-*` framework packages from
  the profile install;
- the **client→host channel**: the generic Connection RPC (`rpc.call('/github', …)`)
  must be reachable from the browser (authority `trusted-host`); confirm on a
  live server, since remote browsers keep the settings plane loopback-only;
- the directory-flow owner-props contract (the chooser receives `open`/`busy`/
  `onPicked`/`onCancel`/`onError` plus the injected action props).
