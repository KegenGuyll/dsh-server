# GitHub CLI (gh) for the harness agent

This image bakes the GitHub CLI so the **agent** (and you) can push commits and
open pull requests without per-session setup. This doc explains how it's wired
and how to use or re-authenticate it.

## What's baked in

| Piece | Where | Why |
|---|---|---|
| `gh` binary | `/usr/local/bin/gh` (baked in the Dockerfile) | always present — no per-session download |
| `GH_CONFIG_DIR` | `/data/gh` (image `ENV`) | points `gh` at the persistent volume so auth survives container recreation |
| Auth token | `/data/gh/hosts.yml` (on the `dsh-data` volume) | stored once; survives redeploys that recreate the container |
| Git credential helper | configured at boot by `entrypoint.sh` (`gh auth setup-git`) | makes `git push` use the token automatically |

There is deliberately **no secret in the image**. Only the `gh` binary is baked;
the credential lives on the persistent volume, next to `settings.yaml` and
`.credentials.yaml`.

## Using it in a session

```sh
# Confirm you're authenticated (no interactive step):
gh auth status            # -> "Logged in to github.com account KegenGuyll (/data/gh/hosts.yml)"

# Authenticated API calls and PR/issue operations work:
gh api /user --jq .login
gh pr list --repo KegenGuyll/dsh-server --state open
gh pr create --base main --head feature-branch --title "..." --body "..."
```

`git` is already wired to `gh` for credentials, so a normal `git push` works too.

The account is the deployment owner (`KegenGuyll`) with scopes `repo` and
`workflow`.

## Re-authenticating (only if the token is revoked/expired)

Run the device-flow login once; it prints a one-time code and a URL:

```sh
gh auth login --hostname github.com --git-protocol https --web --skip-ssh-key --scopes repo,workflow
```

- It prints something like `! First copy your one-time code: XXXX-XXXX` and
  `Open this URL to continue in your web browser: https://github.com/login/device`.
- Open the URL in a browser signed into the account, enter the code, click
  **Authorize**.
- Because `GH_CONFIG_DIR=/data/gh`, the new token is written to
  `/data/gh/hosts.yml` on the persistent volume.

> The one-time code appears in the **stdout/stderr of the process running**
> `gh auth login`. If the agent runs it, it relays the code into the chat. If
> you run it yourself in a terminal, it appears there.
>
> **Do not** put an interactive `gh auth login` in `entrypoint.sh` — it blocks
> startup and buries the code in `docker logs`. The entrypoint only *consumes*
> a token that's already persisted.

## Why this used to be painful

Historically `gh` was installed per-session into the container's **ephemeral
layer** (`/home/node/.local/bin/gh`) and its token stored in `~/.config/gh` —
both wiped every time a redeploy recreated the container. That forced a
re-download and a fresh authorization each session. Baking the binary into the
image and pointing `GH_CONFIG_DIR` at the `/data` volume fixes both.

## If the token is missing (fresh volume / rotation)

A brand-new named volume has no token, so `gh auth status` reports "not logged
in". Do the one-time `gh auth login` above; the token then persists.

## Security notes

- Never commit `/data/gh/hosts.yml` or any token.
- The token is readable only by the `node` user (`/data` is `drwx------ node node`).
- The token grants GitHub write access (repo, workflow) to the account — keep it
  scoped and treat the volume as secret-bearing (same as `settings.yaml`).
