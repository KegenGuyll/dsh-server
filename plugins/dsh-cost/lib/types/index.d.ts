export declare const name: string;
export declare const inject: string[];
export declare function apply(ctx: unknown, config?: unknown): void;
export declare const Config: unknown;
export declare const DEFAULT_PEAK_WINDOWS: readonly (readonly [string, string])[];
export declare const DEFAULT_PRICES: Record<string, { peak: { input: number; cacheRead: number; cacheWrite: number; output: number }; valley: { input: number; cacheRead: number; cacheWrite: number; output: number } }>;
