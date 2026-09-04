/**
 * dsh-notify host plugin.
 *
 * Pushes ntfy notifications to the user's phone when:
 *   - a task completes (agent transitions `running -> idle`), or
 *   - the agent hands back a plan that is pending review (plan mode), or
 *   - the agent explicitly calls the `ping_user` tool because it needs input.
 *
 * It is additive: no shipped rows are disabled, no model/agent semantics change.
 * The user configures the ntfy topic and access token in Settings -> Plugins ->
 * Notify (whose card lives in the browser half, `lib/client.js`).
 *
 * Note on "needs input" coverage: the harness's own approval answerer
 * (`@deepseek-ai/dsh-host-apiproxy`) terminates the `approval/request` waterfall
 * for a real approval without calling `next()`, so an out-of-tree listener
 * cannot observe the pending-approval state without interfering. Approvals and
 * clarifying questions are therefore surfaced through the agent-driven
 * `ping_user` tool (the agent knows when it is blocked on a human), while plan
 * review is detected automatically from `planMode` during the idle transition.
 */

import z from "@deepseek-ai/schemastery";
import { sendNtfy } from "./ntfy.js";

/** Cordis plugin name used by loader diagnostics. */
const name = "notify";

/** Services the host half requires. */
const inject = ["settings", "credentials"];

/** Credential reference that holds the ntfy access token (sent as Bearer). */
const TOKEN_REF = "NTFY_TOKEN";

/** Error-free short session label, or the short id when no title is readable. */
function sessionLabel(agent) {
	try {
		const session = agent?.session;
		const title = session?.header?.title ?? session?.title;
		if (title && String(title).trim().length > 0) return String(title).trim();
	} catch (e) { /* ignore */ }
	const sid = agent?.sessionId ?? agent?.id ?? sessionIdOf(agent);
	if (sid !== undefined && sid !== null) return String(sid).slice(0, 8);
	return "session";
}

/** Fallback session id reader across the shapes the payloads expose. */
function sessionIdOf(agent) {
	if (!agent) return undefined;
	return agent.sessionId ?? agent.id ?? agent.session?.id;
}

/** Brand a raw string as a credential reference name (POSIX shell identifier). */
function credentialRef(value) {
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
		throw new TypeError(`credential ref "${value}" must match a POSIX shell identifier`);
	}
	return value;
}

/** Deployment/user configuration (the `notify` settings namespace). */
const Config = z.object({
	/** Master switch; all sends short-circuit when false. */
	enabled: z.boolean().default(true),
	/** Full ntfy publish URL (the topic is the path). Empty = not configured. */
	topicUrl: z.string().default(""),
	/** Send a push when a task finishes. */
	notifyDone: z.boolean().default(true),
	/** Send a push when the agent needs input (plan-review + ping_user). */
	notifyInput: z.boolean().default(true),
	/** Only "done" pings for runs lasting at least this many seconds. */
	minDoneSeconds: z.number().default(60),
	/** Minimum gap between pings of the same session+kind. */
	cooldownSeconds: z.number().default(30),
	/** Skip a "done" ping while a DSH page is visibly in the foreground. */
	suppressWhenVisible: z.boolean().default(true),
	/** Short banner prefix; the title becomes `<prefix> — <kind>`. */
	titlePrefix: z.string().default("DSH")
});

/** Per-session transient state. */
const runStartedAt = new Map(); // sessionId -> epoch ms of last `running`
const lastSentAt = new Map(); // `${sessionId}:${kind}` -> epoch ms of last push

/** Epoch ms of the most recent "this browser tab is visible" report. */
let lastVisibleAt = 0;

/** Human-readable notify kind -> ntfy title/tags/priority. */
function kindMeta(kind, prefix) {
	if (kind === "input") return { title: `${prefix} — Needs input`, tags: "🛑", priority: "urgent" };
	if (kind === "done") return { title: `${prefix} — Task complete`, tags: "✅", priority: "default" };
	return { title: `${prefix} — Notify`, tags: "", priority: "default" };
}

/**
 * Build the plugin body.
 * @param ctx - host composition context.
 * @param config - entry config, composed over the bundle/settings layers.
 */
function apply(ctx, config) {
	const scope = ctx.settings.register("notify", Config, { base: config });

	/**
	 * Resolve the current config + token and send one ntfy push, applying the
	 * cooldown and master switches. `title`/`priority`/`tags` (when provided)
	 * override the kind-based defaults so a general tool can send a bespoke
	 * notification while still sharing one send path. Never throws into a caller.
	 * @returns {Promise<{ ok: boolean, skipped?: boolean, error?: { code: string, message: string } }>}
	 */
	async function notify({ kind, sessionId, message, title, priority, tags }) {
		const cfg = scope.get();
		if (!cfg.enabled) return { ok: false, error: { code: "disabled", message: "notify is disabled" } };
		if (!cfg.topicUrl) return { ok: false, error: { code: "no-topic", message: "ntfy topic is not configured" } };

		const key = `${String(sessionId ?? "")}:${kind}`;
		const now = Date.now();
		if (cfg.cooldownSeconds > 0) {
			const last = lastSentAt.get(key);
			if (last !== undefined && now - last < cfg.cooldownSeconds * 1000) {
				return { ok: true, skipped: true };
			}
		}

		let token;
		try {
			const resolved = await ctx.credentials.resolve(credentialRef(TOKEN_REF));
			token = resolved?.value;
		} catch (error) {
			ctx.logger?.error(`notify: token resolve failed: ${String(error?.message ?? error)}`);
			token = undefined;
		}

		const meta = kindMeta(kind, cfg.titlePrefix || "DSH");
		const sendTitle = (title && String(title).trim().length > 0) ? String(title).trim() : meta.title;
		const sendPriority = (priority && String(priority).trim().length > 0) ? String(priority).trim() : meta.priority;
		const sendTags = (tags && String(tags).trim().length > 0) ? String(tags).trim() : meta.tags;
		const body = message || sendTitle;
		try {
			await sendNtfy({
				topicUrl: cfg.topicUrl,
				token,
				title: sendTitle,
				message: body,
				priority: sendPriority,
				tags: sendTags
			});
			lastSentAt.set(key, now);
			return { ok: true };
		} catch (error) {
			ctx.logger?.error(`notify: send failed: ${String(error?.message ?? error)}`);
			return { ok: false, error: { code: "send-failed", message: String(error?.message ?? error) } };
		}
	}

	// Automatic "task complete" / "plan pending review" detection.
	// Registered globally (like the shipped agent invariant) so a root listener
	// receives the child-scope `agent/status` event with the agent subject.
	ctx.on("agent/status", ({ agent, status }) => {
		const sid = sessionIdOf(agent);
		if (!sid) return;

		// Only top-level (root) sessions ping; subagent transitions are noise.
		const agents = ctx.get("agents");
		let isRoot = true;
		try {
			if (agents && typeof agents.roots === "function") {
				isRoot = agents.roots().some((a) => sessionIdOf(a) === sid);
			}
		} catch (e) { /* ignore */ }
		if (!isRoot) return;

		if (status === "running") {
			runStartedAt.set(sid, Date.now());
			return;
		}
		if (status !== "idle") return;

		const cfg = scope.get();
		if (!cfg.enabled) return;

		// Plan mode active + pending -> the user must review the plan.
		const planMode = ctx.get("planMode");
		let pendingPlan = false;
		try {
			pendingPlan = !!planMode?.get?.(agent)?.pending;
		} catch (e) { /* ignore */ }
		if (pendingPlan) {
			if (cfg.notifyInput) {
				notify({ kind: "input", sessionId: sid, message: `Plan ready for review — ${sessionLabel(agent)}` });
			}
			return;
		}

		// Done, gated by duration + focus suppression.
		if (!cfg.notifyDone) return;
		const started = runStartedAt.get(sid) ?? Date.now();
		const seconds = (Date.now() - started) / 1000;
		runStartedAt.delete(sid);
		if (seconds < cfg.minDoneSeconds) return;
		if (cfg.suppressWhenVisible && Date.now() - lastVisibleAt < 5000) return;
		notify({ kind: "done", sessionId: sid, message: `Finished — ${sessionLabel(agent)}` });
	}, { global: true });

	// Agent-facing tool: explicit "I need the user now" / "done" ping. Covers
	// approvals, clarifying questions, and any other wait the agent knows about.
	const tools = ctx.get("tools");
	if (tools && typeof tools.register === "function") {
		tools.register({
			name: "ping_user",
			description:
				"Send a push notification to the user's phone (via ntfy) so they know to come back. " +
				"Use kind=input right before you need the user to decide, approve, answer, or review something they will not notice immediately " +
				"(a pending approval, an ask_user_question, handing back a plan). " +
				"Use kind=done after a long, multi-step task completes or a long background job settles. " +
				"kind=info is a generic notice. You may include a short message; a sensible default is used otherwise.",
			parameters: {
				type: "object",
				properties: {
					kind: {
						type: "string",
						enum: ["input", "done", "info"],
						description: "What this ping is for: input (need the user) | done (task finished) | info (notice)."
					},
					message: {
						type: "string",
						description: "Optional short message for the notification body."
					}
				},
				required: ["kind"]
			},
			output: {
				schema: { type: "string" },
				render(_args, value) {
					return [{ type: "text", text: String(value) }];
				}
			},
			async execute(args) {
				const agents = ctx.get("agents");
				let agent;
				try {
					agent = agents?.currentInitiator?.();
				} catch (e) { /* ignore */ }
				const sid = sessionIdOf(agent);
				const label = sessionLabel(agent);
				const msg = args.message && String(args.message).trim().length > 0
					? String(args.message).trim()
					: args.kind === "input"
						? `Needs your input — ${label}`
						: args.kind === "done"
							? `Task complete — ${label}`
							: `Notification — ${label}`;
				const result = await notify({ kind: args.kind, sessionId: sid, message: msg });
				if (result.ok) {
					return args.kind === "input"
						? "Sent a push notification to the user: they need your input. Proceed when they respond."
						: "Sent a push notification to the user.";
				}
				return `Could not send the notification: ${result.error?.message ?? "unknown error"}`;
			}
		});
	}

	// General-purpose agent-facing notification tool: the agent can actively push
	// a bespoke notification (custom title / message / priority / tag). Where the
	// user must ACT (approve, answer, review), prefer `ping_user` with kind=input
	// (it also marks the push urgent). This tool is for proactive, informational
	// sends and still validates + reports failures so the agent knows whether the
	// push actually went out.
	const toolsSend = ctx.get("tools");
	if (toolsSend && typeof toolsSend.register === "function") {
		toolsSend.register({
			name: "send_notification",
			description:
				"Send a push notification to the user's phone (via ntfy). Use this to proactively let the user know something they can't see — " +
				"an external status change, a long operation finishing, an error worth their attention, or a result they asked to be notified about. " +
				"Provide a short specific `message`; optionally a custom `title`, `priority`, and emoji `tags`. " +
				"If the user must act (approve/answer/review), prefer `ping_user` with kind=input, which sends an urgent push.",
			parameters: {
				type: "object",
				properties: {
					message: {
						type: "string",
						description: "The notification body text. Short and specific (e.g. 'Backup complete — 12.4 GB written')."
					},
					title: {
						type: "string",
						description: "Optional short banner title. Defaults to '<prefix> — Notification'."
					},
					priority: {
						type: "string",
						enum: ["min", "low", "default", "high", "urgent"],
						description: "Optional ntfy priority (default 'default'). Use 'urgent' to ensure delivery / override quiet hours."
					},
					tags: {
						type: "string",
						description: "Optional emoji tag(s), comma-separated (e.g. '✅', '🔥', or '🚨,🔥')."
					}
				},
				required: ["message"]
			},
			output: {
				schema: { type: "string" },
				render(_args, value) {
					return [{ type: "text", text: String(value) }];
				}
			},
			async execute(args) {
				const agents = ctx.get("agents");
				let agent;
				try {
					agent = agents?.currentInitiator?.();
				} catch (e) { /* ignore */ }
				const sid = sessionIdOf(agent);
				const msg = String(args.message ?? "").trim();
				if (msg.length === 0) return "send_notification requires a non-empty `message`.";
				const result = await notify({
					kind: "notify",
					sessionId: sid,
					message: msg,
					title: args.title,
					priority: args.priority,
					tags: args.tags
				});
				if (result.ok) {
					if (result.skipped) {
						return "Notification skipped: a notification was sent to this session too recently (cooldown). Try again in a moment.";
					}
					return `Sent a push notification to the user${(args.title && String(args.title).trim()) ? ` — ${String(args.title).trim()}` : ""}.`;
				}
				return `Could not send the notification: ${result.error?.message ?? "unknown error"}`;
			}
		});
	}

	// Client -> host RPC on the generic Connection channel (works over the
	// tailnet with `authority: 'trusted-host'`, like dsh-github). The channel
	// must be unique per plugin: dsh-github owns `/github`, so this one is
	// namespaced to `/notify` (two plugins cannot share a channel prefix).
	const connection = ctx.get("connection");
	const rpc = connection?.rpc;
	if (rpc && typeof rpc.handle === "function") {
		rpc.handle("/notify", async (endpoint, payload) => {
			try {
				let value;
				switch (endpoint) {
					case "notify/status": {
						const cfg = scope.get();
						const resolved = await ctx.credentials.resolve(credentialRef(TOKEN_REF)).catch(() => undefined);
						value = {
							configured: !!cfg.topicUrl,
							enabled: cfg.enabled,
							tokenSet: !!resolved?.value
						};
						break;
					}
					case "notify/set-token": {
						const v = payload?.value === undefined ? "" : String(payload.value).trim();
						if (v.length === 0) throw new Error("notify/set-token: a non-empty token value is required");
						await ctx.credentials.set(credentialRef(TOKEN_REF), v);
						value = { configured: true };
						break;
					}
					case "notify/clear-token": {
						await ctx.credentials.unset(credentialRef(TOKEN_REF));
						value = { configured: false };
						break;
					}
					case "notify/test": {
						const r = await notify({
							kind: "info",
							sessionId: "test",
							message: "Test push from dsh-notify — your ping path is working."
						});
						if (r.ok) value = { ok: true };
						else throw new Error(r.error?.message ?? "send failed");
						break;
					}
					case "notify/visible": {
						if (payload?.visible) lastVisibleAt = Date.now();
						value = { ok: true };
						break;
					}
					case "notify/get-config": {
						value = scope.get();
						break;
					}
					case "notify/set-config": {
						// Persist notify config through the host settings scope (NOT the
						// browser settingsScope, whose writes don't reach the host over
						// the tailnet). This Connection RPC is trusted-host, so it works
						// like notify/set-token and notify/test.
						const patch = payload ?? {};
						const fields = ["topicUrl", "titlePrefix", "enabled", "notifyDone", "notifyInput", "minDoneSeconds", "cooldownSeconds", "suppressWhenVisible"];
						const clean = {};
						for (const f of fields) if (f in patch) clean[f] = patch[f];
						if ("enabled" in clean) clean.enabled = !!clean.enabled;
						if ("notifyDone" in clean) clean.notifyDone = !!clean.notifyDone;
						if ("notifyInput" in clean) clean.notifyInput = !!clean.notifyInput;
						if ("suppressWhenVisible" in clean) clean.suppressWhenVisible = !!clean.suppressWhenVisible;
						if ("minDoneSeconds" in clean) clean.minDoneSeconds = Number(clean.minDoneSeconds);
						if ("cooldownSeconds" in clean) clean.cooldownSeconds = Number(clean.cooldownSeconds);
						if ("topicUrl" in clean) clean.topicUrl = String(clean.topicUrl ?? "").trim();
						if ("titlePrefix" in clean) clean.titlePrefix = String(clean.titlePrefix ?? "").trim() || "DSH";
						await scope.update(clean);
						value = scope.get();
						break;
					}
					default:
						throw new Error(`notify: unknown endpoint '${endpoint}'`);
				}
				return { ok: true, value };
			} catch (error) {
				ctx.logger?.error(`notify RPC ${endpoint} failed: ${String(error?.message ?? error)}`);
				return { ok: false, error: { code: "internal", message: String(error?.message ?? error), details: {} } };
			}
		}, { authority: "trusted-host" });
	} else {
		ctx.logger?.warn("notify: connection RPC unavailable — the browser configuration card cannot reach the host");
	}
}

export { Config, name, inject, apply, sessionLabel, sessionIdOf, TOKEN_REF };
