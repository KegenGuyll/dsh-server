# dsh-notify

Push **ntfy** notifications to your phone when the DeepSeek Harness agent

- finishes a task, or
- needs your input (a plan to review, an approval, a clarifying question).

It is the `dsh-notify` sibling of the `dsh-mobile` / `dsh-github` / `dsh-stt`
out-of-tree plugins: an additive bundle (`dsh.bundle.patch`) auto-installed by
`entrypoint.sh` via an idempotent `install.mjs`. No shipped row is disabled.

## Layout

```
lib/index.js      host half — settings namespace, ntfy sender, agent/status
                  (done + plan-review) detection, the `ping_user` tool, and the
                  client→host RPC handlers
lib/ntfy.js       tiny ntfy publish client (global fetch on the host)
lib/client.js     browser half — the Settings → Plugins → Notify card + page
                  visibility reporting (done-ping suppression)
cordis.patch.yml  registers the `notify` loader row
install.mjs       idempotent auto-installer run by entrypoint.sh
```

## Setup

1. **ntfy endpoint.** Run a self-hosted ntfy server on your Docker host (e.g.
   `binwiederhier/ntfy` with a persistent volume) reachable over the tailnet, **or**
   use the free public `https://ntfy.sh/<topic>`. HTTPS is required for the iOS app.
2. **Subscribe on your phone.** Install the **ntfy** iOS app (it supports
   self-hosted servers / adding a topic by URL) and subscribe to the topic.
3. **Configure DSH.** In **Settings → Plugins → Notify**, set the topic URL
   (e.g. `https://ntfy.sh/dsh-mytopic` or `https://ntfy.example.com/dsh`), tap
   **Send test**, and (only if the server uses access control) paste the access
   token. The token is written to the credentials domain and never leaves the host.

## How it pings

| Event | Trigger | Priority |
|-------|---------|----------|
| **Task complete** | `agent/status` → `idle`, after a run lasting ≥ `minDoneSeconds`, and not while a DSH page is visibly in the foreground | `default` |
| **Plan needs review** | `agent/status` → `idle` while `planMode` is pending | `urgent` |
| **Needs your input** | The agent calls the **`ping_user`** tool (`kind: input`) | `urgent` |

> **Approvals and clarifying questions.** The harness's own approval answerer
> terminates the `approval/request` waterfall for a real approval, so an
> out-of-tree listener cannot observe the pending state without interfering.
> Those cases are surfaced by the agent calling `ping_user` at the moment it is
> blocked on a human (right before a question, or when it knows an approval is
> coming). Plan review is detected automatically from `planMode`.

## The agent's notification tools

The agent has two tools to actively notify you:

### `ping_user`

For when the agent needs you to act, or a long task is done:

```
ping_user(kind: "input" | "done" | "info", message?: string)
```

- `input` — you need to decide/approve/answer/review something (sent urgent).
- `done` — a long task finished.
- `info`  — a generic notice.

### `send_notification`

For proactive, informational sends with full control over the banner:

```
send_notification(message: string, title?: string, priority?: "min"|"low"|"default"|"high"|"urgent", tags?: string)
```

- `message` — required body text (short and specific).
- `title` — optional banner title (defaults to `<prefix> — Notification`).
- `priority` — optional ntfy priority (default `default`); use `urgent` to ensure delivery.
- `tags` — optional emoji tag(s), comma-separated (e.g. `✅`, `🔥`).

Both tools validate the config and report back whether the push actually went out
(`sent` / `skipped` / an error), so the agent doesn't assume success when notify is
disabled, the topic is unconfigured, or a send fails.

## Config (`notify` settings namespace)

| Field | Default | Meaning |
|-------|---------|---------|
| `enabled` | `true` | Master switch. |
| `topicUrl` | `""` | Full ntfy publish URL; empty = not configured. |
| `notifyDone` | `true` | Send a push on task completion. |
| `notifyInput` | `true` | Send a push when input is needed. |
| `minDoneSeconds` | `60` | Only "done" pings for runs at least this long. |
| `cooldownSeconds` | `30` | Minimum gap between same-session pings. |
| `suppressWhenVisible` | `true` | Quiet "done" pings while a DSH page is in the foreground. |
| `titlePrefix` | `"DSH"` | Notification title prefix. |

The ntfy access token is stored under the credential ref `NTFY_TOKEN` (host-only).

## Installation

Same bundle flow as the other plugins: `dsh.bundle.patch → cordis.patch.yml`
inserts the `notify` row, and `entrypoint.sh` runs the idempotent, version-marker
`install.mjs`. It repairs a malformed profile `cordis.patch.yml`, then runs
`dsh plugin --profile web add /opt/dsh-notify`, gated by a version marker so a
rebuild with a newer version refreshes the plugin and an unchanged boot is a no-op.
It does not hand-edit the profile's `cordis.patch.yml`.
