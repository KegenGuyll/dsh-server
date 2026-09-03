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

# Loosen the settings/credentials configuration plane so it honors --trusted-host
# instead of being pinned to loopback. Upstream keeps these privileged methods
# (settings.describe/update/mutate, credentials.*, agentPreset.*,
# llm.discoverModels) loopback-only until a real auth layer exists; this
# deployment's auth boundary is the tailnet (docs/dsh.md). The patch script is
# idempotent and fails the build loudly if the upstream layout changes so the
# deviation is never silently dropped on a dsh upgrade.
COPY patches/trusted-config-plane.mjs /patches/trusted-config-plane.mjs
RUN node /patches/trusted-config-plane.mjs

# The DSH *client* also pins the settings plane to loopback: the settings mirror
# and per-namespace scope are created with `connection.isLoopback ? "host" :
# "memory"`, so a page served over the trusted tailnet FQDN leaves the mirror
# "memory" (unavailable) and the UI fails with "settings are unavailable in this
# browser" even though the server fence above accepts the request. Pin both to
# "host" so the browser reads/writes settings over the wire; the server fence is
# the authoritative gate. Same idempotent + fail-loud contract as above.
COPY patches/client-loopback-settings.mjs /patches/client-loopback-settings.mjs
RUN node /patches/client-loopback-settings.mjs

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

# The dsh-mobile plugin is client-only (its client bundle is served by the harness
# client module system, and it declares `dsh.bundle.patch`), so the only reason to
# npm-install here is to make it resolvable at its real path (/opt/dsh-mobile) for
# the auto-installer. It has no runtime deps beyond the harness-provided peer.
COPY --chown=node:node plugins/dsh-mobile /opt/dsh-mobile
RUN cd /opt/dsh-mobile \
  && npm install --omit=dev --no-audit --no-fund --ignore-scripts --legacy-peer-deps \
  && rm -rf node_modules/.cache

# The out-of-tree dsh-stt plugin (browser-only speech-to-text composer mic +
# idempotent installer) is baked into the image; entrypoint.sh auto-installs it
# into the web profile on first boot. It has no runtime imports of its own (all
# work runs in the browser), so the install step is a no-op placeholder kept for
# symmetry with the other plugins in case a host half is added later.
COPY --chown=node:node plugins/dsh-stt /opt/dsh-stt
RUN cd /opt/dsh-stt \
  && npm install --omit=dev --no-audit --no-fund --ignore-scripts --legacy-peer-deps \
  && rm -rf node_modules/.cache

# The out-of-tree dsh-notify plugin (ntfy push on task-complete / needs-input +
# idempotent installer) is baked into the image; entrypoint.sh auto-installs it
# into the web profile on first boot. Its host half imports @deepseek-ai/schemastery
# (a leaf; Cordis-free) for the settings schema, resolved at its real path here.
# It deliberately does NOT import @deepseek-ai/dsh-tools or other harness peers,
# as those do not resolve from an out-of-tree plugin's real path.
COPY --chown=node:node plugins/dsh-notify /opt/dsh-notify
RUN cd /opt/dsh-notify \
  && npm install --omit=dev --no-audit --no-fund --ignore-scripts --legacy-peer-deps \
  && rm -rf node_modules/.cache

# /data     = $DSH_HOME (sessions, settings.yaml, credentials, web profile)
# /workspaces = the agent's cwd (project checkouts)
# Ownership is baked into the image so freshly created named volumes inherit
# the node user instead of root.
RUN mkdir -p /data /data/gh /workspaces && chown -R node:node /data /workspaces

# gh CLI for the harness agent: lets the agent git-push and open PRs without a
# per-session download. The auth token lives on the persistent dsh-data volume
# via GH_CONFIG_DIR below, so once a device-flow login is done the token
# survives container recreation and gh is authenticated on every boot.
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl \
  && rm -rf /var/lib/apt/lists/* \
  && GH_ARCH=$(uname -m | sed -E 's/x86_64/amd64/; s/aarch64|arm64/arm64/') \
  && curl -fsSL "https://github.com/cli/cli/releases/download/v2.99.0/gh_2.99.0_linux_${GH_ARCH}.tar.gz" -o /tmp/gh.tgz \
  && tar -C /tmp -xzf /tmp/gh.tgz \
  && install -m 0755 "/tmp/gh_2.99.0_linux_${GH_ARCH}/bin/gh" /usr/local/bin/gh \
  && rm -rf "/tmp/gh_2.99.0_linux_${GH_ARCH}" /tmp/gh.tgz

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENV DSH_HOME=/data \
    DSH_TELEMETRY_DISABLED=1 \
    GH_CONFIG_DIR=/data/gh

USER node
WORKDIR /workspaces

EXPOSE 3080

ENTRYPOINT ["/entrypoint.sh"]
