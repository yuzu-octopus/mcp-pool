import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { SocketTransport } from "./socket-transport.js";

function fakeSocket(): EventEmitter & {
	write: (data: string, cb: (err?: Error) => void) => void;
	destroy: () => void;
	sent: string[];
} {
	const emitter = new EventEmitter() as EventEmitter & {
		write: (data: string, cb: (err?: Error) => void) => void;
		destroy: () => void;
		sent: string[];
	};
	emitter.sent = [];
	emitter.write = (data: string, cb: (err?: Error) => void) => {
		emitter.sent.push(data);
		cb();
	};
	emitter.destroy = () => {
		emitter.emit("close");
	};
	return emitter;
}

async function setup() {
	const socket = fakeSocket();
	const transport = new SocketTransport(socket as unknown as Socket);
	const messages: JSONRPCMessage[] = [];
	const errors: Error[] = [];
	transport.onmessage = (msg) => messages.push(msg);
	transport.onerror = (err) => errors.push(err);
	await transport.start();
	return { socket, transport, messages, errors };
}

function feed(socket: EventEmitter, chunks: (string | Buffer)[]): void {
	for (const chunk of chunks) {
		socket.emit(
			"data",
			typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk,
		);
	}
}

describe("SocketTransport framing", () => {
	test("reassembles a message split across chunks", async () => {
		const { socket, messages } = await setup();
		const msg = { jsonrpc: "2.0", id: 1, method: "ping" } as const;
		const raw = `${JSON.stringify(msg)}\n`;
		feed(socket, [raw.slice(0, 5), raw.slice(5, 12), raw.slice(12)]);
		expect(messages).toEqual([msg]);
	});

	test("handles multiple messages in one chunk and split boundaries", async () => {
		const { socket, messages } = await setup();
		const a = { jsonrpc: "2.0", id: 1, method: "a" } as const;
		const b = { jsonrpc: "2.0", id: 2, method: "b" } as const;
		const raw = `${JSON.stringify(a)}\n${JSON.stringify(b)}\n`;
		feed(socket, [raw.slice(0, raw.length - 3), raw.slice(raw.length - 3)]);
		expect(messages).toEqual([a, b]);
	});

	test("skips empty lines and reports invalid JSON via onerror", async () => {
		const { socket, messages, errors } = await setup();
		const msg = { jsonrpc: "2.0", id: 3, method: "ok" } as const;
		feed(socket, [`\n   \n${JSON.stringify(msg)}\n{nope}\n`]);
		expect(messages).toEqual([msg]);
		expect(errors).toHaveLength(1);
	});

	test("keeps multibyte characters split across chunks intact", async () => {
		const { socket, messages } = await setup();
		const msg = { jsonrpc: "2.0", id: 4, method: "emoji-😀-✓-测试" } as const;
		const raw = Buffer.from(`${JSON.stringify(msg)}\n`, "utf8");
		// 1-byte chunks force splits inside multibyte sequences.
		feed(
			socket,
			Array.from(raw, (_, i) => raw.subarray(i, i + 1)),
		);
		expect(messages).toEqual([msg]);
	});

	test("reassembles a 1MB+ payload delivered in many small chunks", async () => {
		const { socket, messages, errors } = await setup();
		const msg = {
			jsonrpc: "2.0",
			id: 5,
			method: "bulk",
			params: { blob: "x".repeat(1024 * 1024 + 123), tail: "😀".repeat(1000) },
		} as const;
		const raw = Buffer.from(`${JSON.stringify(msg)}\n`, "utf8");
		expect(raw.length).toBeGreaterThan(1024 * 1024);
		// Odd chunk size misaligns with message and multibyte boundaries.
		const chunks: Buffer[] = [];
		for (let i = 0; i < raw.length; i += 1000) {
			chunks.push(raw.subarray(i, Math.min(i + 1000, raw.length)));
		}
		expect(chunks.length).toBeGreaterThan(1000);
		feed(socket, chunks);
		expect(errors).toEqual([]);
		expect(messages).toHaveLength(1);
		expect(messages[0]).toEqual(msg);
		expect(JSON.stringify(messages[0])?.length).toBe(
			JSON.stringify(msg).length,
		);
	});
});
