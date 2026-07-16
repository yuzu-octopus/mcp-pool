import { describe, expect, test } from "bun:test";
import { RoundRobinStrategy, DepleteFirstStrategy } from "./strategies.js";
import type { UpstreamState } from "./types.js";

function makeUpstream(keyIndex: number, status: "available" | "rate_limited" | "dead" = "available"): UpstreamState {
  return {
    keyIndex,
    status,
    consecutiveErrors: 0,
    client: null as unknown as UpstreamState["client"],
    tools: [],
  };
}

describe("RoundRobinStrategy", () => {
  test("cycles through upstreams", () => {
    const s = new RoundRobinStrategy();
    const u = [makeUpstream(0), makeUpstream(1), makeUpstream(2)];

    expect(s.select(u).keyIndex).toBe(0);
    s.record(u[0], "success");
    expect(s.select(u).keyIndex).toBe(1);
    s.record(u[1], "success");
    expect(s.select(u).keyIndex).toBe(2);
    s.record(u[2], "success");
    expect(s.select(u).keyIndex).toBe(0); // wraps around
  });

  test("skips rate-limited upstreams from available list", () => {
    const s = new RoundRobinStrategy();
    const available = [makeUpstream(0), makeUpstream(2)]; // index 1 is excluded

    expect(s.select(available).keyIndex).toBe(0);
    s.record(available[0], "success");
    expect(s.select(available).keyIndex).toBe(2);
    s.record(available[1], "success");
    expect(s.select(available).keyIndex).toBe(0);
  });

  test("error does not advance cursor", () => {
    const s = new RoundRobinStrategy();
    const u = [makeUpstream(0), makeUpstream(1)];

    expect(s.select(u).keyIndex).toBe(0);
    s.record(u[0], "error"); // cursor unchanged
    expect(s.select(u).keyIndex).toBe(0); // still 0
  });

  test("rate_limited advances cursor", () => {
    const s = new RoundRobinStrategy();
    const u = [makeUpstream(0), makeUpstream(1)];

    expect(s.select(u).keyIndex).toBe(0);
    s.record(u[0], "rate_limited");
    expect(s.select(u).keyIndex).toBe(1);
  });

  test("throws on empty available list", () => {
    const s = new RoundRobinStrategy();
    expect(() => s.select([])).toThrow("no available upstreams");
  });
});

describe("DepleteFirstStrategy", () => {
  test("always picks first available", () => {
    const s = new DepleteFirstStrategy();
    const u = [makeUpstream(0), makeUpstream(1), makeUpstream(2)];

    expect(s.select(u).keyIndex).toBe(0);
    s.record(u[0], "success");
    expect(s.select(u).keyIndex).toBe(0);
    s.record(u[0], "rate_limited");
    expect(s.select(u).keyIndex).toBe(0);
  });

  test("picks index 1 when index 0 is rate-limited", () => {
    const s = new DepleteFirstStrategy();
    const available = [makeUpstream(1, "available"), makeUpstream(2, "available")]; // 0 excluded

    expect(s.select(available).keyIndex).toBe(1);
  });

  test("throws on empty available list", () => {
    const s = new DepleteFirstStrategy();
    expect(() => s.select([])).toThrow("no available upstreams");
  });
});
