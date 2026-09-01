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
Dockerfile                     node:22-slim + npm i -g @deepseek-ai/dsh@<pinned>
entrypoint.sh                  dsh web --host 127.0.0.1 --port 3080 --no-open --trusted-host "$DSH_TRUSTED_HOST"
.github/workflows/deploy.yml   calls personal-pipeline's reusable deploy-service.yml
```

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
