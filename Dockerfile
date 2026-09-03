# DeepSeek Harness web server — a thin, version-pinned wrapper around the
# published @deepseek-ai/dsh npm package. No upstream source is used or forked.
#
# Update = bump the version below, commit, push. The pipeline rebuilds and
# redeploys; the persistent volumes (dsh-data, dsh-workspaces) keep all
# sessions, settings, credentials, and workspace files across updates.

FROM node:22-slim

# node:zlib's Zstandard API (used for session logs) requires Node >= 22.11;
# node:22-slim tracks the latest 22.x. git and ca-certificates are required by
# the dsh-github plugin to clone repositories into workspaces (node:22-slim ships
# neither; without ca-certificates git fails TLS verification: "CAfile: none").
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && npm install -g @deepseek-ai/dsh@0.1.1-rc.2 \
  && npm install -g pnpm

# The out-of-tree dsh-github plugin (host + client bundle + idempotent installer)
# is baked into the image; entrypoint.sh auto-installs it into the web profile
# on first boot. The plugin is resolved at its real path (/opt/dsh-github), so its
# own runtime imports (@deepseek-ai/schemastery, @deepseek-ai/dsh-credentials) are
# installed here rather than resolved from the profile. Peers are not
# auto-installed (the harness provides them), matching pnpm's autoInstallPeers:false.
COPY --chown=node:node plugins/dsh-github /opt/dsh-github
RUN cd /opt/dsh-github \
  && npm install --omit=dev --no-audit --no-fund --ignore-scripts --legacy-peer-deps \
  && rm -rf node_modules/.cache

# The out-of-tree dsh-git-changes plugin (docked 'Git changes' panel that lists
# every file changed on the current branch vs its base + idempotent installer)
# is baked into the image; entrypoint.sh auto-installs it into the web profile on
# first boot. It is host-only plus a client bundle, and runs git read commands
# over the workspace, so git (installed above) is its only runtime requirement.
COPY --chown=node:node plugins/dsh-git-changes /opt/dsh-git-changes
RUN cd /opt/dsh-git-changes \
  && npm install --omit=dev --no-audit --no-fund --ignore-scripts --legacy-peer-deps \
  && rm -rf node_modules/.cache

# /data     = $DSH_HOME (sessions, settings.yaml, credentials, web profile)
# /workspaces = the agent's cwd (project checkouts)
# Ownership is baked into the image so freshly created named volumes inherit
# the node user instead of root.
RUN mkdir -p /data /workspaces && chown -R node:node /data /workspaces

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENV DSH_HOME=/data \
    DSH_TELEMETRY_DISABLED=1

USER node
WORKDIR /workspaces

EXPOSE 3080

ENTRYPOINT ["/entrypoint.sh"]
