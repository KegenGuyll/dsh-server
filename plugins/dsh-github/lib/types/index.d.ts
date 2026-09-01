export declare const name: string;
export declare const inject: string[];
export declare function apply(ctx: unknown, config?: unknown): void;
export declare const Config: unknown;
export declare const DEFAULT_CLONE_ROOT: string;
export declare function resolveToken(ctx: any, scope: any): Promise<string | undefined>;
export declare function createWorkspaceFromRepo(ctx: any, scope: any, args: { repo: string; branch?: string; shallow?: boolean }): Promise<{ path: string; title: string; workspaceId: string }>;
