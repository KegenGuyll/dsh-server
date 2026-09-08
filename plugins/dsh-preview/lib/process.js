/**
 * dsh-preview process manager — spawn a long-running dev command on loopback,
 * detect the port it binds, and stop the whole process group cleanly.
 *
 * Design notes:
 *  - Spawn with `detached: true` so the child is the leader of its own process
 *    group; killing `-pid` (negative) tears down `npm run dev` and everything it
 *    forked (vite, esbuild, …) in one shot.
 *  - Force `HOST=127.0.0.1` so the dev server only binds loopback. It is
 *    reachable solely through the tailnet-served gateway, preserving the
 *    tailnet-as-auth-boundary model.
 *  - Port detection: prefer the provided `port`, else collect candidate ports
 *    as the command prints URLs (e.g. `Local: http://localhost:5173`) and probe
 *    each until one accepts TCP. A timeout with no candidate is a hard error.
 */

import { spawn } from "node:child_process";
import net from "node:net";

/** Rolling, bounded textual capture of a child's stdout+stderr. */
class Capture {
	constructor(max = 8192) {
		this.max = max;
		this.buf = "";
	}
	write(chunk) {
		this.buf += chunk;
		if (this.buf.length > this.max) this.buf = this.buf.slice(-this.max);
	}
	get() {
		return this.buf;
	}
}

/** Try to connect to `host:port`; resolves true when a server accepts. */
function canConnect(port, host = "127.0.0.1") {
	return new Promise((resolve) => {
		const socket = net.createConnection({ host, port });
		socket.once("connect", () => {
			socket.destroy();
			resolve(true);
		});
		socket.once("error", () => {
			socket.destroy();
			resolve(false);
		});
		socket.setTimeout(500, () => {
			socket.destroy();
			resolve(false);
		});
	});
}

/** Pull every plausible `:PORT` mentioned in dev-server output. */
function candidatesFromOutput(text) {
	const found = new Set();
	const re = /(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d{2,5})|:\/(\d{2,5})\b|\b(?::)(\d{2,5})\//g;
	let m;
	while ((m = re.exec(text)) !== null) {
		for (const g of [m[1], m[2], m[3]]) {
			if (g) found.add(Number(g));
		}
	}
	return [...found];
}

/**
 * Spawn `command` in `cwd` with the given extra env; resolve when the dev server
 * accepts TCP on a detected port.
 *
 * @param {object} opts
 * @param {string} opts.command   shell command to run (e.g. `npm run dev`)
 * @param {string} opts.cwd       working directory
 * @param {number} [opts.port]     expected port
 * @param {object} [opts.env]      extra env vars merged over process.env
 * @param {number} [opts.timeoutMs] readiness window (default 45000)
 * @returns {Promise<{child:import('node:child_process').ChildProcess, port:number, capture:Capture}>}
 */
export function startDevServer(opts) {
	const { command, cwd, port, env = {}, timeoutMs = 45000 } = opts;

	// Sanity: the readiness window must be positive.
	const windowMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 45000;

	const capture = new Capture();
	const candidates = new Set();
	if (Number.isInteger(port) && port > 0) candidates.add(port);

	const child = spawn(command, {
		cwd,
		env: {
			...process.env,
			HOST: "127.0.0.1",
			...env
		},
		detached: true,
		shell: true,
		stdio: ["ignore", "pipe", "pipe"]
	});

	const onOutput = (chunk) => {
		const text = String(chunk);
		capture.write(text);
		for (const p of candidatesFromOutput(text)) candidates.add(p);
	};
	child.stdout.on("data", onOutput);
	child.stderr.on("data", onOutput);

	// Kill the whole process group (child leader + descendants).
	const stop = () => {
		try {
			process.kill(-child.pid, "SIGTERM");
		} catch (e) {
			/* already gone */
		}
		// Escalate after a grace period.
		const escalation = setTimeout(() => {
			try {
				process.kill(-child.pid, "SIGKILL");
			} catch (e) {
				/* already gone */
			}
		}, 5000);
		if (escalation.unref) escalation.unref();
	};

	const whenReady = (async () => {
		const poll = async () => {
			for (const p of candidates) {
				if (p < 1024 || p > 65535) continue;
				if (await canConnect(p)) return p;
			}
			return undefined;
		};

		const deadline = Date.now() + windowMs;
		while (Date.now() < deadline) {
			const found = await poll();
			if (found !== undefined) return found;
			await new Promise((r) => setTimeout(r, 250));
		}

		// Timeout: not ready. Fail loudly.
		stop();
		const log = capture.get().trim();
		throw new Error(
			`dev server did not bind a port within ${windowMs}ms` +
			(log ? ` (last output: ${log.slice(0, 400)})` : "")
		);
	})();

	// Surface a child that exits before being ready (e.g. compile error).
	const earlyExit = new Promise((_, reject) => {
		child.once("exit", (code, signal) => {
			reject(new Error(`dev process exited early (code ${code}, signal ${signal ?? "none"}) — ${capture.get().slice(0, 400)}`));
		});
	});
	// The race settles when the server is ready; a normal child exit afterwards
	// (e.g. stop) must not surface as an unhandled rejection.
	earlyExit.catch(() => {});

	return {
		ready: Promise.race([whenReady, earlyExit]),
		child,
		capture,
		stop
	};
}

/**
 * Stop a dev process group referenced by a child returned from startDevServer.
 * SIGTERM first, then SIGKILL after a grace period.
 */
export function stopDevServer(child) {
	if (!child) return;
	if (child.pid === undefined) return;
	if (child.exitCode !== null || child.signalCode !== null) return;
	try {
		process.kill(-child.pid, "SIGTERM");
	} catch (e) {
		/* already gone */
	}
	setTimeout(() => {
		try {
			process.kill(-child.pid, "SIGKILL");
		} catch (e) {
			/* already gone */
		}
	}, 5000).unref?.();
}
