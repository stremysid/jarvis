import { describe, expect, it } from "vitest";
import { SafeLogger, type SafeLogRecord } from "../../src/observability/safe-log.js";

const baseRecord = {
  eventId: "01k3s6k8000000000000000001",
  correlationId: "01k3s6k8000000000000000002",
  component: "sync",
  operation: "pull",
  durationMs: 12,
  outcome: "ok",
} as const;

describe("SafeLogger", () => {
  it("writes only the validated structured record to its sink", () => {
    const written: SafeLogRecord[] = [];
    const logger = new SafeLogger((record) => written.push(record));

    logger.info({ ...baseRecord });

    expect(written).toEqual([baseRecord]);
    expect(Object.isFrozen(written[0])).toBe(true);
  });

  it.each([
    "text",
    "transcript",
    "channelId",
    "providerBody",
    "headers",
    "extra",
  ])("rejects the unsafe %s field at runtime", (field) => {
    const logger = new SafeLogger(() => undefined);

    expect(() => logger.info({ ...baseRecord, [field]: "raw secret" } as never)).toThrow("unsafe_log_field");
  });

  it("rejects symbols, custom prototypes, and non-enumerable fields", () => {
    const logger = new SafeLogger(() => undefined);
    const symbolRecord = { ...baseRecord, [Symbol("raw")]: "secret" };
    const inheritedRecord = Object.assign(Object.create({ text: "secret" }) as object, baseRecord);
    const hiddenRecord = { ...baseRecord };
    Object.defineProperty(hiddenRecord, "headers", { value: "secret", enumerable: false });

    expect(() => logger.info(symbolRecord as never)).toThrow("unsafe_log_field");
    expect(() => logger.info(inheritedRecord as never)).toThrow("unsafe_log_field");
    expect(() => logger.info(hiddenRecord as never)).toThrow("unsafe_log_field");
  });

  it("rejects accessors before reading any record value", () => {
    const logger = new SafeLogger(() => undefined);
    const record = { ...baseRecord } as Record<string, unknown>;
    let reads = 0;
    Object.defineProperty(record, "operation", {
      enumerable: true,
      get() {
        reads += 1;
        return "pull";
      },
    });

    expect(() => logger.info(record as never)).toThrow("unsafe_log_field");
    expect(reads).toBe(0);
  });

  it("rejects free-form values in structured fields and unknown error categories", () => {
    const logger = new SafeLogger(() => undefined);

    expect(() => logger.info({ ...baseRecord, operation: "raw transcript here" } as never)).toThrow("unsafe_log_field");
    expect(() => logger.info({ ...baseRecord, component: "password_secret" } as never)).toThrow("unsafe_log_field");
    expect(() => logger.info({ ...baseRecord, operation: "x14165550123" } as never)).toThrow("unsafe_log_field");
    expect(() => logger.info({ ...baseRecord, outcome: "error", errorCategory: "provider said password=secret" } as never)).toThrow("unsafe_log_field");
  });
});
