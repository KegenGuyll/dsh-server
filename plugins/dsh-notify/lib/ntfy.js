/**
 * dsh-notify ntfy client.
 *
 * Publishes a push message to an ntfy topic (either the public ntfy.sh or a
 * self-hosted server). Everything here is plain Node — the durable host half
 * has full Node access, so it uses the platform global `fetch` (Node >= 22).
 *
 * ntfy uses simple POST headers; the request body is the message text. A token
 * (when configured) is sent as `Authorization: Bearer <token>`.
 */

/**
 * Send one notification to the configured ntfy topic.
 *
 * @param {object} opts
 * @param {string} opts.topicUrl - full ntfy publish URL, e.g. `https://ntfy.sh/dsh` or
 *   `https://ntfy.example.com/dsh`. The topic is the path.
 * @param {string|undefined} opts.token - optional access token (`Authorization: Bearer`).
 * @param {string} opts.title - notification title (becomes the banner). Kept short.
 * @param {string} opts.message - notification body text.
 * @param {string} [opts.priority] - ntfy priority: `urgent`, `high`, `default`, `low`, `min`.
 * @param {string|string[]} [opts.tags] - ntfy emoji tag(s), e.g. `✅` / `🛑`.
 * @returns {Promise<{ ok: true }>} resolves on a 2xx; rejects otherwise.
 */
export async function sendNtfy({ topicUrl, token, title, message, priority, tags }) {
	const headers = { Title: title };
	if (priority) headers.Priority = priority;
	if (tags && (Array.isArray(tags) ? tags.length : String(tags).length)) {
		headers.Tags = Array.isArray(tags) ? tags.join(",") : String(tags);
	}
	if (token) headers.Authorization = `Bearer ${token}`;

	let response;
	try {
		response = await fetch(topicUrl, { method: "POST", headers, body: message });
	} catch (error) {
		throw new Error(`ntfy transport failed: ${String(error?.message ?? error)}`);
	}
	if (!response.ok) {
		const detail = await response.text().catch(() => "");
		throw new Error(`ntfy responded ${response.status}${detail ? `: ${detail.trim()}` : ""}`);
	}
	return { ok: true };
}
