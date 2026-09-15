import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { applyMemoryOwnerCommandIngressMigration } from "./migration.js";

const timestamp = "2026-09-15T02:30:00.000Z";
let serial = 1;

function nextEventId(): string {
  const suffix = serial.toString().padStart(18, "0");
  serial += 1;
  return `01k3w1t4${suffix}`;
}

async function insertEvent(
  principalId: string,
  eventType: string,
  source: string,
  producerVersion: string,
): Promise<void> {
  const eventId = nextEventId();
  await env.DB.prepare(`INSERT INTO events (
    event_id, event_type, source, subject_id, occurred_at, received_at,
    content_hash, envelope_json, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(
      eventId,
      eventType,
      source,
      principalId,
      timestamp,
      timestamp,
      serial.toString(16).padStart(64, "0"),
      JSON.stringify({ producerVersion }),
      timestamp,
    ).run();
}

describe("0018 memory owner-command ingress migration", () => {
  const principalId = "principal:memory:owner-command-ingress";

  beforeAll(async () => {
    await applyMemoryOwnerCommandIngressMigration();
    await env.DB.prepare(`INSERT INTO principals (
      principal_id, principal_type, status, display_name, created_at, updated_at
    ) VALUES (?, 'human', 'active', 'memory owner', ?, ?)`)
      .bind(principalId, timestamp, timestamp).run();
  });

  it("accepts only the reviewed owner-command ingress tuple", async () => {
    await insertEvent(
      principalId,
      "memory.owner_command",
      "memory-control",
      "memory-control-v1",
    );
  });

  it("rejects memory.owner_command from another source", async () => {
    await expect(insertEvent(
      principalId,
      "memory.owner_command",
      "jarvis.conversation",
      "memory-control-v1",
    )).rejects.toThrow(/memory_owner_command_ingress_invalid/u);
  });

  it("rejects another event type from the reserved memory-control source", async () => {
    await expect(insertEvent(
      principalId,
      "conversation.user_committed",
      "memory-control",
      "memory-control-v1",
    )).rejects.toThrow(/memory_owner_command_ingress_invalid/u);
  });

  it("rejects an unreviewed owner-command producer version", async () => {
    await expect(insertEvent(
      principalId,
      "memory.owner_command",
      "memory-control",
      "memory-control-v2",
    )).rejects.toThrow(/memory_owner_command_ingress_invalid/u);
  });
});
