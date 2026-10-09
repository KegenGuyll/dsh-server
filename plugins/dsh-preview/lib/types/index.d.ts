/**
 * dsh-preview public types (host half). Mirrors the runtime surface of
 * ./index.js for consumers that want a typed import; the plugin is host-only.
 */

import type z from "@deepseek-ai/schemastery";

export interface PreviewConfig {
	enabled: boolean;
	gatewayPort: number;
	baseHost: string;
	maxServers: number;
	devRoot: string;
	defaultCommandTimeoutMs: number;
}

export const Config: z.ZodType<PreviewConfig>;

export const name: "preview";
export const inject: string[];

/** Strip scheme/port/path so a tailnet URL can be built from it. */
export function hostOf(raw: string): string;

/** Normalize an arbitrary name into a route slug. */
export function slugify(name: string | null | undefined): string;

export class PreviewRegistry {
	constructor(maxServers?: number);
	add(seedSlug: string, entry: Record<string, unknown>): { ok: true; slug: string } | { ok: false; error: string };
	set(slug: string, entry: Record<string, unknown>): { ok: true; slug: string } | { ok: false; error: string };
	uniquify(slug: string): string;
	bySlug(slug: string): Record<string, unknown> | undefined;
	byPort(port: number): Record<string, unknown> | undefined;
	remove(slug: string): boolean;
	list(): Record<string, unknown>[];
}

/** The Cordis plugin factory, exported for the loader. */
export function apply(ctx: unknown, config: unknown): void;
