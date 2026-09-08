/**
 * dsh-preview gateway — a loopback reverse proxy that routes tailnet requests
 * for `/dev/<slug>/...` to the matching dev server on `127.0.0.1:<port>`.
 *
 * Contract:
 *   - `/`            -> HTML index of live previews
 *   - `/dev/`        -> HTML index (alias of `/`)
 *   - `/dev/<slug>`  -> 301 to `/dev/<slug>/`
 *   - `/dev/<slug>/<rest>` -> proxy `http://127.0.0.1:<port>/<rest>`
 *   - `/dev/<slug>/` -> proxy `http://127.0.0.1:<port>/`
 *   - unknown slug   -> 404
 *
 * Binds `127.0.0.1` only: it is reachable through the Tailscale sidecar's
 * static `serve` entry (the sidecar shares this container's network namespace),
 * so TLS is terminated by Tailscale and this proxy speaks plain HTTP on
 * loopback. WebSocket upgrades (HMR) are routed by slug too.
 */

import http from "node:http";
import httpProxy from "http-proxy";

/** Minimal HTML-escape (keeps the gateway dependency-free beyond http-proxy). */
function escapeHtml(s) {
	return String(s)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

/** Parse a request pathname into a routing decision. */
function route(pathname) {
	// `dev/<slug>/<rest...>` after dropping empty segments.
	const parts = pathname.split("/").filter((p) => p.length > 0);
	if (parts[0] !== "dev") return { kind: "root" };
	if (parts.length === 1) return { kind: "index" };
	return { kind: "preview", slug: parts[1], rest: parts.slice(2).join("/") };
}

function send404(res) {
	res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
	res.end("dsh-preview: no such preview");
}

function sentence(s) {
	return String(s ?? "");
}

/**
 * Create and start the reverse-proxy gateway.
 *
 * @param {object} opts
 * @param {number} opts.port     loopback port to bind
 * @param {string} opts.host     bind host (default 127.0.0.1)
 * @param {import('./registry.js').PreviewRegistry} opts.registry
 * @param {function(string):string} opts.baseUrl  slug -> preview base URL (e.g. https://host:port/dev/slug/)
 * @returns {{ server: import('node:http').Server, close: () => Promise<void> }}
 */
export function createGateway({ port, host = "127.0.0.1", registry, baseUrl }) {
	const proxy = httpProxy.createProxyServer({ ws: true });
	proxy.on("error", (err, req, res) => {
		if (res && typeof res.writeHead === "function") {
			if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
			res.end(`dsh-preview: proxy error — ${escapeHtml(String(err?.message ?? err))}`);
		}
	});

	const forward = (req, rest, query, entry, method) => {
		req.url = "/" + rest + (query ? "?" + query : "");
		const target = `http://127.0.0.1:${entry.port}`;
		if (method === "ws") proxy.ws(req, req.socket, req.head, { target, changeOrigin: true });
		else proxy.web(req, req._res, { target, changeOrigin: true });
	};

	const server = http.createServer((req, res) => {
		if (!req.url) return send404(res);
		const q = req.url.indexOf("?");
		const pathname = q === -1 ? req.url : req.url.slice(0, q);
		const query = q === -1 ? "" : req.url.slice(q + 1);
		const r = route(pathname);

		if (r.kind === "root" || r.kind === "index") return serveIndex(res, registry, baseUrl);
		if (r.kind !== "preview" || !r.slug) return send404(res);

		const entry = registry.bySlug(r.slug);
		if (!entry || !entry.port) return send404(res);

		// `/dev/<slug>` (no trailing slash, no rest) -> redirect for a stable URL.
		if (r.rest === "" && !pathname.endsWith("/")) {
			res.writeHead(301, { location: `/dev/${r.slug}/` });
			return res.end();
		}

		req._res = res;
		forward(req, r.rest, query, entry, "web");
	});

	server.on("upgrade", (req, socket, head) => {
		if (!req.url) return socket.destroy();
		const q = req.url.indexOf("?");
		const pathname = q === -1 ? req.url : req.url.slice(0, q);
		const query = q === -1 ? "" : req.url.slice(q + 1);
		const r = route(pathname);
		if (r.kind !== "preview" || !r.slug) return socket.destroy();
		const entry = registry.bySlug(r.slug);
		if (!entry || !entry.port) return socket.destroy();
		req.socket = socket;
		req.head = head;
		forward(req, r.rest, query, entry, "ws");
	});

	const listen = new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, host, () => {
			server.off("error", reject);
			resolve();
		});
	});

	const close = () =>
		new Promise((resolve) => {
			proxy.close();
			server.close(() => resolve());
		});

	return { server, close, listen };
}

/** A minimal, comment-free HTML index of live previews. */
function serveIndex(res, registry, baseUrl) {
	const rows = registry
		.list()
		.map((p) => {
			const url = baseUrl ? escapeHtml(baseUrl(p.slug)) : "#";
			return `<li><a href="${url}">/dev/${escapeHtml(p.slug)}/</a> — ${escapeHtml(p.port)} (pid ${escapeHtml(p.pid ?? "-")}), ${escapeHtml(sentence(p.command))}</li>`;
		})
		.join("\n");
	const body = `<!doctype html><html><head><meta charset="utf-8"><title>dsh-preview</title></head><body><h1>dsh-preview</h1><p>Live previews:</p><ul>${rows || "<li>none running</li>"}</ul></body></html>`;
	res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
	res.end(body);
}
