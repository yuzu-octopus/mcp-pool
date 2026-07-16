import { type UpstreamState, type RoutingStrategy } from "./types.js";

/**
 * RoundRobinStrategy — cycles through available upstreams.
 * Cursor advances on every outcome except "error".
 */
export class RoundRobinStrategy implements RoutingStrategy {
  private cursor = 0;
  private name = "round-robin";

  select(available: UpstreamState[]): UpstreamState {
    if (available.length === 0) {
      throw new Error("no available upstreams");
    }
    const idx = this.cursor % available.length;
    return available[idx];
  }

  record(_upstream: UpstreamState, outcome: "success" | "rate_limited" | "error"): void {
    if (outcome !== "error") {
      this.cursor++;
    }
  }

  getName(): string {
    return this.name;
  }
}

/**
 * DepleteFirstStrategy — picks the first available upstream until it's exhausted,
 * then moves to the next. This preserves key order from the config.
 */
export class DepleteFirstStrategy implements RoutingStrategy {
  private name = "deplete-first";

  select(available: UpstreamState[]): UpstreamState {
    if (available.length === 0) {
      throw new Error("no available upstreams");
    }
    return available[0];
  }

  record(_upstream: UpstreamState, _outcome: "success" | "rate_limited" | "error"): void {
    // no-op: state changes (rate_limited/dead) handled by Pool
  }

  getName(): string {
    return this.name;
  }
}
