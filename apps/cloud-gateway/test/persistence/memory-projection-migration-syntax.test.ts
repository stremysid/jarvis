import { describe, expect, it } from "vitest";
import memoryProjectionSql from "../../src/persistence/migrations/0014_memory_projection.sql?raw";

const COMMIT_GUARDS = [
  "memory_projection_device_state_changed",
  "memory_projection_state_changed",
  "memory_projection_head_changed",
] as const;

describe("memory projection migration syntax", () => {
  it("uses remote-D1-safe WHERE guards for every commit refusal", () => {
    const trigger = memoryProjectionSql.match(
      /CREATE TRIGGER memory_fact_projection_commit_publish\b[\s\S]*?\nEND;/u,
    )?.[0];
    expect(trigger).toBeDefined();
    expect(trigger).not.toMatch(/\bSELECT\s+CASE\b/iu);
    expect(Array.from(trigger?.matchAll(
      /SELECT\s+RAISE\(ABORT,\s*'([^']+)'\)\s+WHERE\b/giu,
    ) ?? [], (match) => match[1])).toEqual(COMMIT_GUARDS);
  });
});
