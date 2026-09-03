# dsh-cost

A DeepSeek Harness plugin (dual-face: host + browser) that shows a **live
per-session dollar cost** in the session header's status/utilities strip, priced
at the **current model** and honoring DeepSeek's **peak/off-peak** rate tiers. The
chip **glows red (pulsing 🔥)** while the current time is inside a peak window.

Cost is an **estimate** from the published tier rates — the DeepSeek API (and DSH)
report **token usage per response**, not a dollar amount, so this plugin multiplies
each request's token buckets by the configured per-1M rates. It is
**current-session-only**.

## What it does

- **Cost chip** in `conversation.session.header.utilities` — shows `$0.0421`
  (running cost) plus a hover/click breakdown: peak/valley token split, the model,
  and the per-1M peak/valley rates.
- **Peak glow** — while the current time is inside a peak window the chip glows
  red with a pulsing `@keyframes` fire animation and a 🔥/“peak” marker.
- **Current-model pricing** — every session token is priced at the session's
  current model (`session.requestContext().model`); no per-model attribution. When
  there is no request context yet it falls back to the last
  `assistant/message.source.model`.
- **Per-request peak/valley** — each usage-bearing `assistant/message` event is
  tiered by its own timestamp, so a session that spans peak+valley is priced
  correctly. The glow reflects *now* only.

## Layout

```
package.json      manifest + dsh.client declaration
cordis.patch.yml  bundle patch (inserts the `cost` row)
install.mjs       idempotent auto-install (called by the container entrypoint)
lib/cost.js       pure ESM pricing core (schedule + price table + event fold) — no harness imports
lib/index.js      host plugin: settings namespace + client→host RPC handlers
lib/client.js     browser half (lazy-CJS factory): cost chip + settings card
lib/types/*.d.ts  TS declarations
test/cost.test.mjs
```

The browser half is written in the harness's lazy-CJS factory format
(`window.__ModuleLoader__.load({ id, factory })`), so it needs no bespoke
bundler; `react` and the `dsh-client-*` roster resolve through the client module
system.

## Configuration

Editable under **Settings → Plugins → Cost**:

| Setting | Default | Meaning |
|---|---|---|
| `enabled` | `true` | master switch for the chip |
| `currency` | `$` | prefix before the amount |
| `precision` | `4` | decimal places |
| `weekdaysOnly` | `true` | peak windows apply Mon–Fri only; weekends are all valley |
| `peakWindows` | `[["01:00","04:00"],["06:00","10:00"]]` | half-open `[start, end)` windows, `"HH:MM"` in **UTC** |
| `prices` | see `DEFAULT_PRICES` | per-model, per-tier per-1M rates `{ peak:{input,cacheRead,cacheWrite,output}, valley:{...} }` |
| `pricingUrl` | – | optional JSON pricing doc that refreshes `peakWindows`/`prices`; always falls back to built-ins on failure |
| `pricingRefetchMs` | `3600000` | how long a fetched pricing doc stays trusted |

Built-in 2026-08-16 DeepSeek V4 defaults (USD per 1M tokens):

| Model | peak `{input,cacheRead,cacheWrite,output}` | valley (half) |
|---|---|---|
| `deepseek-v4-flash` | `{0.44,0.014,0,1.32}` | `{0.22,0.007,0,0.66}` |
| `deepseek-v4-pro` | `{1.32,0.044,0,3.96}` | `{0.66,0.022,0,1.98}` |
| `deepseek-v4-flash-vision*` | Flash rates | Flash rates |

Any **unknown model** is unpriced: the chip shows the token count plus `—`.

## Client → host channel

All pricing runs on the host; the browser reaches it over the generic Connection
RPC channel (`ctx.connection.rpc.call('/rpc', …)`, authority `trusted-host`). The
host registers the handlers in `lib/index.js`:

- `cost/session` `{ sessionId }` → `{ cost, currency, precision, model, priced,
  nowIsPeak, peakWindows, weekdaysOnly, tokens:{peak,valley,total}, totalTokens,
  rates, count, enabled }`
- `cost/prices` `{}` → the effective price table + schedule

The chip drives refreshes off the `tokenUsage` projection (`useProjection`), with
a ~250 ms debounce, and re-prices per session switch. On RPC failure it shows `—`
and never breaks the header.

## Composition

Registered as a **bundle** (`dsh.bundle.patch`), so its `cordis.patch.yml` is
composed automatically: it inserts the `cost` row. Additive — nothing shipped is
disabled.

## Installation

The package declares `dsh.bundle.patch`, so `dsh plugin --profile web add <pkg>`
installs it **and** appends it to `dsh.profile.bundles`; the bundle patch then
registers the row. `entrypoint.sh` runs the idempotent installer:

```sh
node /opt/dsh-cost/install.mjs
```

It runs `dsh plugin --profile web add /opt/dsh-cost`, gated by a version marker so
a rebuild with a newer version refreshes the plugin and an unchanged boot is a no-op.

## Verification status

The pricing core (`lib/cost.js`) is unit-tested with `node --test`
(`test/cost.test.mjs`): `isInPeak` (weekday vs weekend, boundaries, UTC), the
model matcher (exact, family prefix, vision mapping), `priced` flag, and the exact
peak/valley cost fold. All files pass `node --check`. Because this is an
out-of-tree plugin with a browser half, the following need a live harness run and
cannot be fully confirmed by static inspection:

- peer-dependency resolution of the `@deepseek-ai/dsh-*` framework packages from
  the profile install;
- the slot injection of the chip into the header utilities strip and the settings
  card into **Settings → Plugins**, plus the chip’s live refresh and peak glow.
