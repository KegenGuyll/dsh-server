/**
 * dsh-preview registry — the in-memory set of running dev-server previews.
 *
 * Each preview maps a URL slug to a spawned dev process and its loopback port.
 * The registry owns slug allocation/uniqueness and the max-servers cap; it does
 * NOT own process lifecycle (that is process.js) or the gateway (gateway.js).
 *
 * This is intentionally in-memory (v1): a dsh restart empties it and the agent
 * re-starts previews. Persistence is a documented follow-up.
 */

/** Normalize an arbitrary name into a route slug: `[a-z0-9][a-z0-9-]*`. */
export function slugify(name) {
	if (name === undefined || name === null) return "preview";
	let s = String(name)
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.replace(/-{2,}/g, "-");
	if (s.length === 0) return "preview";
	// Leading digit is fine for a path segment; keep it but avoid a slug that is
	// only separators (already collapsed above).
	return s;
}

/** One live preview. `child`/`port` are set once the dev server is up. */
export class PreviewRegistry {
	/** @param {number} maxServers */
	constructor(maxServers = 8) {
		this.maxServers = maxServers;
		/** @type {Map<string, object>} slug -> preview entry */
		this.bySlugMap = new Map();
		/** @type {Map<number, string>} port -> slug (for O(1) lookup by port) */
		this.byPortMap = new Map();
	}

	/** @returns {{ok:true, slug:string} | {ok:false, error:string}} */
	add(seedSlug, entry) {
		if (this.bySlugMap.size >= this.maxServers) {
			return { ok: false, error: `preview limit reached (${this.maxServers}); stop one first` };
		}
		const slug = this.uniquify(slugify(seedSlug));
		return this.set(slug, entry);
	}

	/**
	 * Insert an entry under an exact, already-unique slug (no re-slugification).
	 * Used by start_dev_server after it predicted the slug for the base path.
	 */
	set(slug, entry) {
		if (!slug || !/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
			return { ok: false, error: `invalid slug "${slug}"` };
		}
		if (this.bySlugMap.has(slug)) {
			return { ok: false, error: `slug "${slug}" is already in use` };
		}
		if (this.bySlugMap.size >= this.maxServers) {
			return { ok: false, error: `preview limit reached (${this.maxServers}); stop one first` };
		}
		const record = { ...entry, slug };
		this.bySlugMap.set(slug, record);
		if (record.port) this.byPortMap.set(record.port, slug);
		return { ok: true, slug };
	}

	/** Make a slug unique by appending `-2`, `-3`, … when it collides. */
	uniquify(slug) {
		if (!this.bySlugMap.has(slug)) return slug;
		let n = 2;
		while (this.bySlugMap.has(`${slug}-${n}`)) n += 1;
		return `${slug}-${n}`;
	}

	/** @returns {object|undefined} */
	bySlug(slug) {
		return this.bySlugMap.get(slug);
	}

	/** @returns {object|undefined} */
	byPort(port) {
		const slug = this.byPortMap.get(Number(port));
		return slug ? this.bySlugMap.get(slug) : undefined;
	}

	/** Remove a preview by slug (and its port index). */
	remove(slug) {
		const rec = this.bySlugMap.get(slug);
		if (!rec) return false;
		if (rec.port) this.byPortMap.delete(rec.port);
		this.bySlugMap.delete(slug);
		return true;
	}

	/** @returns {object[]} live preview records (copy; safe to serialize). */
	list() {
		return [...this.bySlugMap.values()].map((r) => ({ ...r }));
	}
}
