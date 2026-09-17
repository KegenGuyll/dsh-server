# dsh-github

An out-of-tree DeepSeek Harness plugin (dual-face: host + browser) that turns the
workspace "Add workspace…" flow into a two-option chooser, registers a
collapsible settings card under **Settings → Plugins → Plugin configuration**
for the PAT (a write-only status/token control), the clone root, the
shallow-clone flag, and **in-session worktrees** — staged behind a Save/Discard
footer like the shipped plugin cards.

- **Add local workspace** — a self-contained compact directory dialog (navigate
  the host filesystem, create a folder) over this plugin's own host handlers.
- **Import from GitHub** — a modal listing the signed-in user's repositories
  (live search filter + pagination); clicking **Import** clones the repo into
  `cloneRoot` and registers it as a workspace. The clone path is handed to the
  workspace-flow owner's normal adoption, so registration/selection works exactly
  like a local pick.
- **In-session worktrees** — the agent can create git worktrees **inside the
  session's own workspace** via `github_create_worktree` /
  `github_list_worktrees` / `github_remove_worktree`, so one session can work
  several issues on the same repository in parallel (sequentially, or via
  subagents each pointed at its own tree) **without starting a new session**.
  Worktrees are removed when the session is archived.

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
lib/index.js    host plugin: settings namespace, client→host handlers, worktree tools + archive cleanup
lib/github.js   GitHub REST client, PAT resolution, repo listing, clone+register
lib/worktree.js git worktree helpers (create/list/remove/prune, branch + .git detection, git exclude)
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
| `worktreeEnabled` | `true` | allow the agent to create worktrees in a session |
| `worktreeDir` | `.dsh-worktrees` | subdirectory of the session workspace that holds its worktrees |
| `worktreeBranch` | `origin/main` | base ref new worktrees start from (tool calls may override) |
| `worktreeDetached` | `true` | create worktrees at a detached HEAD; `false` starts a fresh `dsh/…` branch |
| `worktreeCleanupOnArchive` | `true` | remove the session's worktrees when it is archived |
| `worktreeRequireForEdits` | `true` | **enforce** it: deny `write`/`edit` calls targeting the main checkout until a worktree exists |
| `worktreeMaxPerSession` | `8` | cap concurrent worktrees in one session (`0` = unlimited) |
| `worktreePruneOnStartup` | `true` | on startup, drop worktree containers whose session no longer exists |

All worktree options are read live per operation (no restart).

### Why worktrees live inside the session workspace

The file sandbox's writable root is derived from the session `cwd`
(`sandboxPolicy.resolve()` → `resolveWorkspaceRoot(session.header.cwd)`), so a
worktree placed anywhere else could not be read or written by the agent's own
tools. Worktrees are therefore created at:

```
<session workspace>/<worktreeDir>/<sessionId>/<name>
```

for example `/workspaces/core-api/.dsh-worktrees/session-7a3f0c1e-…/issue-123`.

Because they are ordinary subdirectories of the session workspace, the agent
reaches them with normal relative paths or by passing the returned path as
`bash`'s `workdir`. The container is added to the repository's **local** exclude
(`.git/info/exclude`) so it never shows up as untracked — nothing is written to a
committed `.gitignore`.

Worktrees are deliberately **not** registered as DSH workspaces: that is what
previously turned each one into a separate session and sidebar entry.

### Ownership and cleanup

The `<sessionId>` directory name is the ownership signal: a path is only removed
when it is a **linked worktree** (its `.git` is a file) *inside the archiving
session's own container*. Cleanup never consults the live settings, so changing
`worktreeDir` cannot strand an existing tree, and no other session's worktree can
match. Containers are removed when their session is archived
(`worktreeCleanupOnArchive`), removing the last worktree by tool drops the
now-empty container, and `worktreePruneOnStartup` removes containers whose
session no longer exists (younger than two minutes are left alone, and the pass is
skipped entirely if the session list is unreadable).

Creates are serialized per session container (so the `worktreeMaxPerSession`
count and the create cannot race), and `removeWorktree` verifies the directory is
actually gone before reporting success.

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

Worktree operations are agent-facing tools only (below) — the browser has no
worktree RPC, because worktree creation is never client-driven.

## Model tools

The host registers three agent-facing tools via `ctx.tools.register`. All three
run in the calling session's own workspace, so one session can carry several
issues at once:

- `github_create_worktree` `{ name, branch?, repo? }` — create a worktree at
  `<session workspace>/<worktreeDir>/<sessionId>/<name>` on the configured base
  ref (default `origin/main`) and return its path (pass it as `bash`'s `workdir`).
  `repo` may be a workspace id or a path and defaults to the session workspace.
- `github_list_worktrees` `{ repo? }` — list the worktrees **this session** has
  created (name, path, branch/HEAD).
- `github_remove_worktree` `{ name | path }` — remove one of this session's
  worktrees. Only worktrees inside the session's own container qualify;
  uncommitted changes are discarded.

Because a worktree is just a subdirectory of the session workspace, the same
agent (or several subagents, each given a different worktree path as `workdir`)
can work the issues concurrently without leaving the session. Worktrees are not
registered as DSH workspaces and never become separate sessions.

### Requirement and enforcement

The requirement has two layers, because a prompt alone asks rather than requires.

**1. The prompt states it as a precondition.** With `worktreeRequireForEdits` on
(default), the contributed section is the *required* variant: it tells the agent
that a worktree must exist before its first write or edit in the repository, that
the main checkout is shared, and that a denial names the worktree step. With the
setting off, the same section becomes the advisory variant ("when a task covers
more than one independent piece of work…").

**2. The host denies violating calls.** The plugin registers a
`tools/pre-execute` gate (`registerWorktreeEditGuard`) that rejects a `write` or
`edit` whose target is inside the calling session's main checkout but outside that
session's own worktree container:

```js
ctx.on("tools/pre-execute", async (exec, next) => {
  const reason = await worktreeEditDenial(scope, exec);
  if (reason !== undefined) return { kind: "deny", reason };
  return next();
});
```

The denial reason names the next step (call `github_create_worktree`, then edit
inside the returned path), so the model sees an instruction rather than an opaque
failure.

The gate is deliberately narrow:

- **Only `write` and `edit`.** These are the deterministic file-mutation tools.
  `bash` cannot be classified reliably, so it is covered by the prompt alone —
  a shell command that writes to the checkout is not blocked.
- **Only inside the calling session's own repository.** A target outside the repo
  (scratch files, `/tmp`, other trees) is never touched.
- **Never for an already-isolated session.** If the session's own workspace is a
  linked worktree (its `.git` is a file), nesting another worktree would be
  nonsense, so the gate stands down.
- **Never without a repository.** A non-git workspace has nothing to branch from,
  so the gate allows everything.
- **Fails open.** If the check itself throws, the call proceeds and the plugin
  logs `worktree edit gate failed open` — an enforcement bug must not brick a
  session.

### Prompt contribution

The tool schemas say what the worktree tools *do*; they do not say *when* to reach
for them. The host therefore contributes one **global** system-prompt section
(`ctx.systemPrompt.section`, name `github.worktrees`, order `150` — the harness's
100–199 band for tool guidance). Registering from the plugin's host-composition
scope makes it global, so it applies to every session of every agent preset
without any user file or per-workspace `AGENTS.md`.

The section's `text` is a provider, not a constant: it picks the required or
advisory variant from the live setting and returns an empty string when worktrees
are disabled (assembly drops empty sections), so turning worktrees off also stops
the prompt from advertising them. It is disposed with the plugin fiber.

## Composition

The chooser occupies the two `single`-kind directory-flow holes
(`sidebar.workspaces.directoryFlow`, `conversation.hero.workspace.directoryFlow`),
and the plugin owns the local pick (Option B). It is registered as a **bundle**
(`dsh.bundle.patch`), so its `cordis.patch.yml` is composed automatically:
it inserts the `github` row and disables the harness `directory-picker` row so
that client flow does not collide in those holes. Directory selection is
provided entirely by the plugin (`github/local-list` / `github/local-create`).

The client half takes no part in worktrees beyond the settings card: the harness
`startSession` action is deliberately **not** wrapped, so a New Session behaves
exactly as before and never spawns a worktree. The host wraps
`workspaceRegistry.archiveSession` so archiving a session removes the worktrees it
created.

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

The host logic (`lib/github.js`, `lib/worktree.js`) is smoke-tested (stubbed
`fetch` / `git` subprocess: listing, metadata, error mapping, worktree
create/list/remove, branch and `.git`-file detection, git exclude). All files
pass `node --check`. Because this is an out-of-tree plugin with a browser half,
the following need a live harness run and cannot be fully confirmed by static
inspection:

- peer-dependency resolution of the `@deepseek-ai/dsh-*` framework packages from
  the profile install;
- the **client→host channel**: the generic Connection RPC (`rpc.call('/github', …)`)
  must be reachable from the browser (authority `trusted-host`); confirm on a
  live server, since remote browsers keep the settings plane loopback-only;
- the directory-flow owner-props contract (the chooser receives `open`/`busy`/
  `onPicked`/`onCancel`/`onError` plus the injected action props);
- the worktree tools in a live session: that a created worktree is writable by
  the agent's own sandboxed tools, and that archive cleanup removes the
  session's container against a real repository.
