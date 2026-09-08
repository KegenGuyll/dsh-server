/**
 * dsh-preview host plugin.
 *
 * Lets the agent start a long-running dev server in a workspace and expose it to
 * the tailnet as a private HTTPS preview link. It is host-only and additive:
 *
 *   - The plugin runs a loopback reverse-proxy "gateway" on 127.0.0.1:<gatewayPort>
 *     (default 8443). A single static `tailscale serve` entry on the shared
 *     Tailscale sidecar maps `https://<host>.<tailnet>.ts.net:<gatewayPort>` to
 *     that loopback port (the container shares the sidecar's network namespace),
 *     so the tailnet can reach it without a `tailscale` CLI or socket in the
 *     container. DSH's own `443` serve config is never touched.
 *   - The agent calls `start_dev_server` to spawn a command (bound to
 *     `127.0.0.1`, `HOST=127.0.0.1`) and the plugin registers it under
 *     `/dev/<slug>/`; the tool returns the full HTTPS URL to hand to the user.
 *   - `stop_dev_server` kills the process group and unregisters the route;
 *     `list_dev_servers` lists live previews.
 *
 * The tailnet is the auth boundary (same model as the DSH web app): the gateway
 * binds loopback only and is reached solely through the tailnet-served TLS
 * proxy, so previews are private and not exposed to the internet (no funnel).
 */

import z from "@deepseek-ai/schemastery";
import { basename } from "node:path";
import { createGateway } from "./gateway.js";
import { startDevServer, stopDevServer } from "./process.js";
import { PreviewRegistry, slugify } from "./registry.js";

/** Cordis plugin name used by loader diagnostics. */
const name = "preview";

/** Services the host half requires. */
const inject = ["settings"];

/** Deployment/user configuration (the `preview` settings namespace). */
const Config = z.object({
	/** Master switch; all tools are inert when false. */
	enabled: z.boolean().default(true),
	/** Loopback port the gateway binds; must equal the static tailscale serve port. */
	gatewayPort: z.number().default(8443),
	/**
	 * Public host[:port] the user reaches the server on (e.g. `dsh.<tailnet>.ts.net`).
	 * Empty = derive from DSH_TRUSTED_HOST.
	 */
	baseHost: z.string().default(""),
	/** Max concurrently-running previews. */
	maxServers: z.number().default(8),
	/** Default cwd for dev commands when the tool omits `cwd`. */
	devRoot: z.string().default(process.cwd()),
	/** Readiness window (ms) for a spawned dev server to bind its port. */
	defaultCommandTimeoutMs: z.number().default(45000)
});

/** Strip scheme / port / path so we can build `https://<host>:<gw>/...`. */
function hostOf(raw) {
	let h = String(raw ?? "").trim();
	if (!h) return "";
	h = h.replace(/^https?:\/\//, "").split("/")[0].split("?")[0];
	if (h.includes(":")) h = h.slice(0, h.lastIndexOf(":"));
	return h;
}

/**
 * Build the plugin body.
 * @param ctx - host composition context.
 * @param config - entry config, composed over the bundle/settings layers.
 */
function apply(ctx, config) {
	const scope = ctx.settings.register("preview", Config, { base: config });

	const cfg = () => scope.get();
	const log = (level, msg) => {
		const l = ctx.logger;
		const fn = l && typeof l[level] === "function" ? l[level] : undefined;
		if (fn) fn.call(l, `preview: ${msg}`);
		else if (typeof console !== "undefined") console[level === "info" ? "log" : level](`preview: ${msg}`);
	};

	const registry = new PreviewRegistry(cfg().maxServers);
	let gateway = null;
	let gatewayReady = false;

	const baseHost = () => hostOf(cfg().baseHost || process.env.DSH_TRUSTED_HOST || "");
	const previewUrl = (slug) => `https://${baseHost()}:${cfg().gatewayPort}/dev/${slug}/`;

	// ── Start the loopback gateway (best-effort; never crash DSH) ────────────
	if (cfg().enabled) {
		gateway = createGateway({
			port: cfg().gatewayPort,
			host: "127.0.0.1",
			registry,
			baseUrl: previewUrl
		});
		gateway.listen
			.then(() => {
				gatewayReady = true;
				log("info", `gateway listening on 127.0.0.1:${cfg().gatewayPort}`);
			})
			.catch((err) => {
				gatewayReady = false;
				log("error", `gateway failed to bind 127.0.0.1:${cfg().gatewayPort}: ${String(err?.message ?? err)}`);
			});
	}

	// Registry-exit listener: a crashed dev process unregisters its route.
	const onProcessExit = (slug) => () => registry.remove(slug);

	// Clean up on plugin stop/update/undefine: close the gateway, kill children.
	const cleanup = () => {
		for (const p of registry.list()) {
			stopDevServer(p.child);
		}
		if (gateway) gateway.close();
	};
	if (typeof ctx.effect === "function") ctx.effect(cleanup);
	else {
		ctx.on?.("dispose", cleanup);
	}

	// ── Agent-facing tools ───────────────────────────────────────────────────
	const tools = ctx.get("tools");
	if (!tools || typeof tools.register !== "function") {
		log("warn", "tools service unavailable — dsh-preview tools not registered");
		return;
	}

	tools.register({
		name: "start_dev_server",
		description:
			"Start a long-running dev server in the workspace and expose it to the tailnet as a private HTTPS preview link. " +
			"Run your command (e.g. `npm run dev`) with `cwd` pointing at the project. The server is forced to bind 127.0.0.1 and is " +
			"reachable only through the returned `https://<host>:<port>/dev/<slug>/` URL. If you know the dev server's port pass `port`; " +
			"otherwise the plugin detects it from the command's output. If the app serves assets with root-relative URLs (SPA), start it with " +
			"the correct base path (e.g. Vite `--base=/dev/<slug>/`, Next `basePath`) — the slug is returned so you can do this. Returns the full URL.",
		parameters: {
			type: "object",
			properties: {
				command: {
					type: "string",
					description: "The dev command to run, e.g. `npm run dev` or `python -m http.server 5173`."
				},
				cwd: {
					type: "string",
					description: "Working directory for the command (the project root). Defaults to the configured devRoot."
				},
				port: {
					type: "number",
					description: "Optional expected port. If omitted it is detected from the command output."
				},
				name: {
					type: "string",
					description: "Optional preview name/slug (used in the URL). Defaults to the working-directory name."
				},
				env: {
					type: "object",
					description: "Optional extra environment variables for the command."
				}
			},
			required: ["command"]
		},
		output: {
			schema: { type: "string" },
			render(_args, value) {
				return [{ type: "text", text: String(value) }];
			}
		},
		async execute(args) {
			if (!cfg().enabled) return "start_dev_server: preview is disabled (set `enabled` in the preview settings).";
			if (!gatewayReady) {
				return `start_dev_server: gateway is not running on 127.0.0.1:${cfg().gatewayPort}. See the server log for why (likely a port conflict).`;
			}
			const command = String(args.command ?? "").trim();
			if (!command) return "start_dev_server: `command` is required.";
			if (!baseHost()) {
				return "start_dev_server: no public host is configured. Set `baseHost` (preview settings) or the DSH_TRUSTED_HOST env var.";
			}

			const cwd = args.cwd && String(args.cwd).trim() ? String(args.cwd).trim() : cfg().devRoot;
			const seed = args.name && String(args.name).trim() ? String(args.name).trim() : basename(cwd) || "preview";
			const slug = registry.uniquify(slugify(seed));
			const basePath = `/dev/${slug}/`;

			let started;
			try {
				started = startDevServer({
					command,
					cwd,
					port: args.port,
					env: { PUBLIC_BASE_PATH: basePath, ...(args.env ?? {}) },
					timeoutMs: cfg().defaultCommandTimeoutMs
				});
				const port = await started.ready;
				// Bind the child-exit cleanup to the specific slug before registering.
				started.child.once("exit", onProcessExit(slug));
				const res = registry.set(slug, { child: started.child, port, cwd, command, basePath, startedAt: Date.now(), pid: started.child.pid });
				if (!res.ok) {
					stopDevServer(started.child);
					return `start_dev_server: ${res.error}`;
				}
				return `Started ${command} at ${previewUrl(slug)} (slug "${slug}", port ${port}, pid ${started.child.pid}). Ensure the app is served with base path "${basePath}" so its assets resolve under the preview URL.`;
			} catch (error) {
				if (started) stopDevServer(started.child);
				return `start_dev_server: ${String(error?.message ?? error)}`;
			}
		}
	});

	tools.register({
		name: "stop_dev_server",
		description:
			"Stop a running dev-server preview: kill the process group and unregister its /dev/<slug>/ route so the URL no longer resolves.",
		parameters: {
			type: "object",
			properties: {
				slug: { type: "string", description: "The preview slug (from start_dev_server / list_dev_servers)." },
				port: { type: "number", description: "Or the dev server port to stop." }
			}
		},
		output: {
			schema: { type: "string" },
			render(_args, value) {
				return [{ type: "text", text: String(value) }];
			}
		},
		async execute(args) {
			let entry;
			if (args.slug) entry = registry.bySlug(String(args.slug));
			else if (args.port) entry = registry.byPort(Number(args.port));
			if (!entry) return "stop_dev_server: no matching preview running.";
			stopDevServer(entry.child);
			registry.remove(entry.slug);
			return `Stopped ${entry.command} (slug "${entry.slug}", port ${entry.port}). The preview URL ${entry.slug ? previewUrl(entry.slug) : ""} no longer resolves.`;
		}
	});

	tools.register({
		name: "list_dev_servers",
		description: "List the running dev-server previews (slug, port, pid, cwd, command, status).",
		parameters: { type: "object", properties: {} },
		output: {
			schema: { type: "string" },
			render(_args, value) {
				return [{ type: "text", text: String(value) }];
			}
		},
		async execute() {
			const host = baseHost();
			const rows = registry
				.list()
				.map((p) => {
					const url = host ? ` ${previewUrl(p.slug)}` : " (no public host configured)";
					return `- ${p.slug}${url} (port ${p.port}, pid ${p.pid}, ${p.command} in ${p.cwd}, started ${new Date(p.startedAt).toISOString()})`;
				});
			return rows.length ? `Running previews:\n${rows.join("\n")}` : "No previews running. Use start_dev_server to launch one.";
		}
	});
}

export { Config, name, inject, apply, hostOf, slugify, PreviewRegistry };
