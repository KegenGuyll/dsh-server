# dsh-preview

An out-of-tree, **host-only** DeepSeek Harness plugin that lets the agent start a
long-running dev server in a workspace and expose it to the **tailnet** as a
private HTTPS preview link — so you open the running dev environment in a
browser from another device.

```
user browser ── https ──> Tailscale sidecar (serve :443)      ... DSH (unchanged)
                         └── serve :8443 ──> 127.0.0.1:8443   [dsh-server]
                                                  │
                                    dsh-preview gateway router
                                    /dev/<slug>/...  ──►  http://127.0.0.1:<port>
                                    /  → live index of previews
                                                  │
                                    dev process spawned by start_dev_server
                                    (binds 127.0.0.1, HOST=127.0.0.1)
```

## Agent-facing tools

- **`start_dev_server`** — `{ command, cwd?, port?, name?, env? }`. Spawns the
  command (forced to `127.0.0.1`), detects the listening port (you may pass
  `port`), registers it under `/dev/<slug>/`, and returns the full URL
  `https://<host>:<port>/dev/<slug>/`. Example:
  `start_dev_server(command="npm run dev", cwd="/workspaces/my-app")`.
- **`stop_dev_server`** — `{ slug? | port? }`. Kills the process group
  (SIGTERM then SIGKILL) and unregisters the route.
- **`list_dev_servers`** — lists live previews.

Because the gateway serves each app under a sub-path, **the app must be started
with the matching base path** so its asset URLs resolve under the preview URL.
The tool sets `PUBLIC_BASE_PATH=/dev/<slug>/` in the child's env and returns the
slug so you can configure the framework:

- **Vite**: `npm run dev -- --base=/dev/<slug>/`
- **Next.js**: set `basePath: "/dev/<slug>/"` in `next.config.js`
- **Other SPAs**: configure the router's `basename`/`base` to the slug.

For any app you cannot mount at a sub-path, the gateway root `/` lists every live
preview with a clickable link, so you can still reach the first one there.

## Setup

### One-time: expose the gateway port on the tailnet

This plugin relies on a single static Tailscale Serve entry on the shared
Tailscale node (the same node that already serves DSH on `443`). The dsh-server
container shares that node's network namespace, so `127.0.0.1:8443` inside the
container is reachable by the sidecar. Add the entry (idempotent) where you can
run `tailscale` against the sidecar's `tailscaled` socket:

```sh
tailscale serve --https=8443 --set-path=/ 127.0.0.1:8443
```

That port must equal the plugin's `gatewayPort` (default `8443`). The DSH `443`
serve config is left untouched. **No `tailscale` CLI or socket is needed inside
the dsh-server container**, and no compose `network_mode` change is required
beyond the netns-sharing the container already uses.

> The exact `tailscale serve` flag behavior on your node's Tailscale version
> should be verified once (Does `:8443` conflict with an existing port? Does the
> entry survive a tailscaled restart?). This is the one step that cannot be
> tested inside the container.

### Auto-install

The image bakes the plugin into `/opt/dsh-preview` and `entrypoint.sh` runs its
idempotent `install.mjs` (same flow as the other bundled plugins), which calls
`dsh plugin --profile web add /opt/dsh-preview`. Restart `dsh web` to load it.

## Configuration

Read through the `preview` settings namespace (defaults shown):

| Key                       | Default            | Meaning                                                              |
|---------------------------|--------------------|----------------------------------------------------------------------|
| `enabled`                 | `true`             | Master switch for the gateway and tools.                             |
| `gatewayPort`             | `8443`             | Loopback port the gateway binds; must match the static `serve` port. |
| `baseHost`                | `""`               | Public `host[:port]`; empty = derive from `DSH_TRUSTED_HOST`.        |
| `maxServers`              | `8`                | Concurrent previews cap.                                             |
| `devRoot`                 | process cwd        | Default `cwd` for dev commands when the tool omits `cwd`.            |
| `defaultCommandTimeoutMs` | `45000`            | Readiness window for a spawned dev server to bind its port.          |

Set them via env (`PREVIEW_GATEWAY_PORT`, `PREVIEW_BASE_HOST`) or the settings
file in `/data`. `hostOf` strips any scheme/port from `baseHost`/`DSH_TRUSTED_HOST`
before building the URL.

## Security & limits

- The gateway binds `127.0.0.1` only; dev servers are forced to `HOST=127.0.0.1`.
  They are reachable **only** through the tailnet-served TLS gateway, and the
  tailnet is the auth boundary (same model as the DSH web app). Tailscale's
  `Tailscale-User-*` identity headers pass through to the dev server if it wants
  to authenticate further. Nothing is exposed publicly (no Funnel).
- Previews are **in-memory**: a `dsh web` restart clears the registry and stops
  the spawned processes (re-run `start_dev_server`). The gateway and children
  are cleaned up on plugin stop/update via the Cordis lifecycle.
- A crashed dev process unregisters itself (its URL returns `404`).
- Non-interactive, long-running dev commands only.
