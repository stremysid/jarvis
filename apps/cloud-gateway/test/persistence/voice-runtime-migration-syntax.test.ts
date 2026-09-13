import { describe, expect, it } from "vitest";
import voiceRuntimeSql from "../../src/persistence/migrations/0015_voice_runtime.sql?raw";

const ADMISSION_GUARDS = [
  "outbound_admission_disabled",
  "outbound_admission_destination",
  "outbound_admission_quiet",
  "outbound_admission_expired",
  "outbound_admission_nonce_expired",
  "outbound_admission_clock_invalid",
  "outbound_admission_concurrency",
  "outbound_admission_daily",
] as const;

describe("voice runtime migration syntax", () => {
  it("uses remote-D1-safe WHERE guards for every outbound admission refusal", () => {
    const trigger = voiceRuntimeSql.match(
      /CREATE TRIGGER outbound_attempts_admission\b[\s\S]*?\nEND;/u,
    )?.[0];
    expect(trigger).toBeDefined();
    expect(trigger).not.toMatch(/\bSELECT\s+CASE\b/iu);
    expect(Array.from(trigger?.matchAll(
      /SELECT\s+RAISE\(ABORT,\s*'([^']+)'\)\s+WHERE\b/giu,
    ) ?? [], (match) => match[1])).toEqual(ADMISSION_GUARDS);
  });
});
