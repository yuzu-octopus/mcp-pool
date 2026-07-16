import type { LogEvent } from "./types.js";

export function log(event: LogEvent): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...event });
  console.error(line);
}
