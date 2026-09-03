# dsh-git-changes

A DeepSeek Harness plugin that shows every file changed on the **currently
checked-out branch** of the session workspace relative to its base (`main`,
falling back to `origin/main`/`master`), plus uncommitted and untracked work.

## What it does

- Adds a **"Changes"** button to the session header utilities (right of "Session log").
- Opens a **docked right-column panel** (the app's `details` column) titled **"Git changes"**:
  - a filterable **files list** on the left (status badge, path, `+N/−M`, an uncommitted dot),
  - the selected file's **diff** on the right (green `+` / red `−`),
  - **S / M / L** width presets in the header (the panel squeezes the conversation aside, not an overlay),
  - a totals line (`+N −M`), Refresh, and collapse.
- All git data is produced **host-side** via `git` and sent to the browser over the durable **Connection RPC** channel (`ctx.connection.rpc`), so the browser never runs shell commands.

## How it works

- **Host** (`lib/index.js`): registers the `git-changes/summary` and `git-changes/diff`
  handlers on `connection.rpc.handle("/rpc", ...)`. The target repo is the current
  session's workspace (`session.header.cwd`), resolved from the `sessionId` the
  browser passes, then hardened with `git rev-parse --show-toplevel`. It compares the
  branch to the merge-base with its base and includes the working tree (staged +
  unstaged + untracked).
- **Client** (`lib/client.js`): the durable `__ModuleLoader__` module. Registers the
  header button into `conversation.session.header.utilities` and the panel into the
  `details` column, and calls the host handlers via `connection.rpc.call("/rpc", ...)`.

## Install

Add the package to the `web` profile (or run `node install.mjs`, which the container
entrypoint does before `dsh web`):

```sh
dsh plugin --profile web add ./plugins/dsh-git-changes
```

## Notes

- The panel occupies the right `details` column, so the built-in tool-call "Details"
  panel is replaced while the plugin is active.
- Width is controlled by the S/M/L presets (the panel stays docked; free drag would
  need to resize the layout's grid live).
- Read-only: the host only runs `git diff`/`git status`/`git rev-parse`/`git merge-base`.
