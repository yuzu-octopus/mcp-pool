/** Minimal response surface needed to report a JSON-RPC error. */
export interface ErrorReplySink {
	headersSent: boolean;
	writableEnded: boolean;
	writeHead(status: number, headers: Record<string, string>): void;
	end(body: string): void;
	destroy(): void;
}

/**
 * Reply 500 JSON-RPC error unless headers already went out (client abort,
 * SSE partial), in which case writing would throw ERR_HTTP_HEADERS_SENT.
 */
export function replyJsonError(res: ErrorReplySink, err: unknown): void {
	if (res.headersSent || res.writableEnded) {
		res.destroy();
		return;
	}
	res.writeHead(500, { "content-type": "application/json" });
	res.end(
		JSON.stringify({
			jsonrpc: "2.0",
			error: { code: -32000, message: String(err) },
			id: null,
		}),
	);
}
