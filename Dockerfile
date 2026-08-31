# DeepSeek Harness web server — a thin, version-pinned wrapper around the
# published @deepseek-ai/dsh npm package. No upstream source is used or forked.
#
# Update = bump the version below, commit, push. The pipeline rebuilds and
# redeploys; the persistent volumes (dsh-data, dsh-workspaces) keep all
# sessions, settings, credentials, and workspace files across updates.

FROM node:22-slim

# node:zlib's Zstandard API (used for session logs) requires Node >= 22.11;
# node:22-slim tracks the latest 22.x.
RUN npm install -g @deepseek-ai/dsh@0.1.1-rc.2

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
