/** dsh-notify host plugin type surface. */

export const name: string;
export const inject: string[];

/** Bundle/config schema (the `notify` settings namespace). */
export const Config: {
	enabled: boolean;
	topicUrl: string;
	notifyDone: boolean;
	notifyInput: boolean;
	minDoneSeconds: number;
	cooldownSeconds: number;
	suppressWhenVisible: boolean;
	titlePrefix: string;
};

/** Credential reference that holds the ntfy access token. */
export const TOKEN_REF: string;

/** Best-effort human-readable session label. */
export function sessionLabel(agent: unknown): string;

/** Best-effort session id read across the payload shapes. */
export function sessionIdOf(agent: unknown): string | undefined;

export function apply(ctx: unknown, config?: unknown): void;
