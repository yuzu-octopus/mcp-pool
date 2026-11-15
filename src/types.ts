export type UpstreamTransport = "stdio" | "http" | "sse";

export interface PoolConfig {
	transport?: UpstreamTransport;
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	cwd?: string;
	url?: string;
	headers?: Record<string, string>;
	keys: Record<string, string>[];
	cooldownSeconds?: number;
	rateLimitPatterns: string[];
	transientRetry?: {
		tools: string[];
		errorPatterns: string[];
		delaysMs: number[];
	};
}

export interface ConfigFile {
	pools: Record<string, PoolConfig>;
}

export type LogEvent =
	| {
			level: "warn";
			event: "transient_retry";
			pool: string;
			tool: string;
			upstream: number;
			attempt: number;
			delayMs: number;
	  }
	| { level: "info"; event: "upstream_start"; pool: string; keyIndex: number }
	| {
			level: "info";
			event: "upstream_tools_mismatch";
			pool: string;
			keyIndex: number;
			reason: string;
	  }
	| {
			level: "info";
			event: "route";
			pool: string;
			tool: string;
			upstream: number;
	  }
	| {
			level: "info";
			event: "route_prompt";
			pool: string;
			prompt: string;
			upstream: number;
	  }
	| {
			level: "info";
			event: "route_resource";
			pool: string;
			uri: string;
			upstream: number;
	  }
	| {
			level: "info";
			event: "route_complete";
			pool: string;
			ref: string;
			upstream: number;
	  }
	| {
			level: "warn";
			event: "resource_uri_collision";
			pool: string;
			uri: string;
	  }
	| {
			level: "warn";
			event: "rate_limited";
			pool: string;
			upstream: number;
			cooldownUntil: string;
	  }
	| {
			level: "error";
			event: "all_exhausted";
			pool: string;
			available: number;
			total: number;
	  }
	| {
			level: "error";
			event: "upstream_error";
			pool: string;
			upstream: number;
			error: string;
	  }
	| {
			level: "trace";
			event: "call_tool";
			pool: string;
			tool: string;
			upstream: number;
	  };
