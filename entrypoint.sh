#!/bin/sh
set -e

# dsh web binds 127.0.0.1 by design (it refuses --host 0.0.0.0 for safety).
# This container shares the Tailscale sidecar's network namespace, so the
# sidecar's serve config reaches us at 127.0.0.1:3080 on the shared loopback.
#
# --trusted-host must name the exact hostname browsers use: behind the sidecar
# the Host header is the tailnet FQDN (not a loopback address), and the /api
# browser-trust fence rejects every request whose Host is neither loopback nor
# a declared trusted host. Fail loud rather than boot an unusable server.
: "${DSH_TRUSTED_HOST:?DSH_TRUSTED_HOST must be set to the MagicDNS hostname browsers will use (e.g. dsh.<tailnet>.ts.net) — the /api trust fence rejects everything without it}"

# Auto-install the dsh-github plugin into the web profile (idempotent; skips
# when already installed/current, refreshes on an image version change). It
# registers the "Import from GitHub" workspace chooser and the GitHub settings
# card. Ignore the install only when the image predates the plugin.
if [ -e /opt/dsh-github/install.mjs ]; then
  node /opt/dsh-github/install.mjs
fi

# Auto-install the dsh-mobile skin plugin into the web profile (idempotent). It
# registers the Gemini-style mobile top bar + drawer. Ignore when the image
# predates the plugin.
if [ -e /opt/dsh-mobile/install.mjs ]; then
  node /opt/dsh-mobile/install.mjs
fi

# Auto-install the dsh-stt plugin (browser-only speech-to-text composer mic)
# into the web profile, same idempotent version-marker-gated flow.
if [ -e /opt/dsh-stt/install.mjs ]; then
  node /opt/dsh-stt/install.mjs
fi

# Auto-install the dsh-notify plugin (ntfy push on task-complete / needs-input)
# into the web profile, same idempotent version-marker-gated flow.
if [ -e /opt/dsh-notify/install.mjs ]; then
  node /opt/dsh-notify/install.mjs
fi

# Configure git to use gh as the credential helper, so the agent can git-push /
# open PRs using the token persisted on the persistent /data/gh volume
# (GH_CONFIG_DIR). Idempotent and harmless when gh isn't authenticated yet.
if command -v gh >/dev/null 2>&1 && [ -f "${GH_CONFIG_DIR:-/data/gh}/hosts.yml" ]; then
  gh auth setup-git || true
fi

exec dsh web \
  --host 127.0.0.1 \
  --port 3080 \
  --no-open \
  --trusted-host "${DSH_TRUSTED_HOST}" \
  "$@"
