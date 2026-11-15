import type { Socket } from "node:net";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

/**
 * MCP transport over a unix-domain socket. The wire format is identical to the
 * SDK's stdio transport (newline-delimited JSON), so each connection the daemon
 * accepts is a complete MCP session it can hand to its own Server.
 */
export class SocketTransport implements Transport {
	private readonly socket: Socket;
	private chunks: Buffer[] = [];
	private bufferedBytes = 0;
	private skipBytes = 0;
	private started = false;
	private closed = false;

	onclose?: () => void;
	onerror?: (error: Error) => void;
	onmessage?: (message: JSONRPCMessage) => void;
	sessionId?: string;

	constructor(socket: Socket) {
		this.socket = socket;
	}

	async start(): Promise<void> {
		if (this.started) {
			throw new Error("SocketTransport already started");
		}
		this.started = true;

		this.socket.on("data", (chunk: Buffer) => this.onData(chunk));
		this.socket.on("error", (err: Error) => this.onerror?.(err));
		this.socket.on("close", () => {
			this.closed = true;
			this.onclose?.();
		});
	}

	async send(message: JSONRPCMessage): Promise<void> {
		await new Promise<void>((resolve, reject) => {
			this.socket.write(`${JSON.stringify(message)}\n`, (err) => {
				if (err) {
					reject(err);
					return;
				}
				resolve();
			});
		});
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.socket.destroy();
		this.closed = true;
		this.onclose?.();
	}

	private onData(chunk: Buffer): void {
		if (chunk.length === 0) return;
		this.chunks.push(chunk);
		this.bufferedBytes += chunk.length;

		for (;;) {
			const newlineAt = this.indexOfNewline();
			if (newlineAt === -1) {
				this.skipBytes = this.bufferedBytes;
				return;
			}

			const line = this.takeBytes(newlineAt).toString("utf8");
			this.dropBytes(newlineAt + 1);
			this.skipBytes = 0;

			if (line.trim().length > 0) {
				try {
					this.onmessage?.(JSON.parse(line) as JSONRPCMessage);
				} catch (err) {
					this.onerror?.(err instanceof Error ? err : new Error(String(err)));
				}
			}
		}
	}

	private indexOfNewline(): number {
		let logical = 0;
		for (const chunk of this.chunks) {
			const from = Math.max(0, this.skipBytes - logical);
			const found = chunk.indexOf(0x0a, from);
			if (found !== -1) return logical + found;
			logical += chunk.length;
		}
		return -1;
	}

	private takeBytes(length: number): Buffer {
		const parts: Buffer[] = [];
		let remaining = length;
		for (const chunk of this.chunks) {
			if (remaining <= 0) break;
			const end = Math.min(remaining, chunk.length);
			parts.push(chunk.subarray(0, end));
			remaining -= end;
		}
		return Buffer.concat(parts, length);
	}

	private dropBytes(count: number): void {
		let remaining = count;
		while (remaining > 0 && this.chunks.length > 0) {
			const head = this.chunks[0];
			if (head.length <= remaining) {
				this.chunks.shift();
				remaining -= head.length;
				this.bufferedBytes -= head.length;
			} else {
				this.chunks[0] = head.subarray(remaining);
				this.bufferedBytes -= remaining;
				remaining = 0;
			}
		}
	}
}
