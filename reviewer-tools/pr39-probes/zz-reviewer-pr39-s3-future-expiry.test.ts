import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { applyCloudMemoryMigration } from "./migration.js";

// Reviewer probe for PR #39 S3 (NF3, Medium): the owner-lock exception
// (0016:1381-1386) compares the current version's valid_to against the
// caller-supplied NEW.occurred_at, which no guard bounds against real time.
// A rules actor can therefore stamp `expired` with a FUTURE occurred_at that is
// >= valid_to, satisfy the exception, move the current actor to `rules`, and
// then re-activate a rules version over the owner's confirmed fact months early.
//
// PASS on 8b62e80 (the future-dated expiry and the follow-on rules activation
// are both accepted while real now << valid_to). On a fix that rejects
// occurred_at > now + 5 minutes (or requires valid_to <= now in the exception),
// the expiry insert is refused with `memory_item_transition_invalid`.

const crockford = "0123456789abcdefghjkmnpqrstvwxyz";
let serial = 1;
function nextUlid(): string {
  let value = serial;
  serial += 1;
  let suffix = "";
  for (let index = 0; index < 18; index += 1) {
    const digit = crockford[value % crockford.length];
    if (digit === undefined) throw new Error("ulid_digit_missing");
    suffix = `${digit}${suffix}`;
    value = Math.floor(value / crockford.length);
  }
  return `01k5s3t4${suffix}`;
}
function nextHash(): string { return serial.toString(16).padStart(64, "0"); }
const iso = (offsetMs: number): string => new Date(Date.now() + offsetMs).toISOString();

let principalId = "";
async function seedEvent(): Promise<{ eventId: string; sequence: number }> {
  const eventId = nextUlid();
  const ts = iso(0);
  await env.DB.prepare(`INSERT INTO events (
    event_id, event_type, source, subject_id, occurred_at, received_at,
    content_hash, envelope_json, created_at
  ) VALUES (?, 'conversation.user_committed', 'jarvis.conversation', ?, ?, ?, ?, '{}', ?)`)
    .bind(eventId, principalId, ts, ts, nextHash(), ts).run();
  const row = await env.DB.prepare("SELECT sequence FROM events WHERE event_id = ?")
    .bind(eventId).first<{ sequence: number }>();
  if (row === null) throw new Error("event_missing");
  return { eventId, sequence: row.sequence };
}
async function ownerCommand(targetId: string, fields: Readonly<Record<string, unknown>>): Promise<string> {
  const eventId = nextUlid();
  const ts = iso(0);
  const contentHash = nextHash();
  const envelope = {
    eventId, correlationId: eventId, eventType: "memory.owner_command",
    source: "memory-control", subjectId: principalId, occurredAt: ts, receivedAt: ts,
    contentHash, producerVersion: "memory-control-v1",
    payload: { operation: "item.transition", targetId, ...fields },
  };
  await env.DB.prepare(`INSERT INTO events (
    event_id, event_type, source, subject_id, occurred_at, received_at,
    content_hash, envelope_json, created_at
  ) VALUES (?, 'memory.owner_command', 'memory-control', ?, ?, ?, ?, ?, ?)`)
    .bind(eventId, principalId, ts, ts, contentHash, JSON.stringify(envelope), ts).run();
  return eventId;
}

describe.sequential("reviewer probe PR #39 S3 future-dated expiry", () => {
  let itemId = "";
  const validTo = iso(30 * 24 * 60 * 60 * 1000); // 30 days out
  const futureExpiry = iso(31 * 24 * 60 * 60 * 1000); // past valid_to, far in the future
  let expiryThrew = "";
  let reactivateThrew = "";

  beforeAll(async () => {
    await applyCloudMemoryMigration();
    principalId = `principal:s3:${nextUlid()}`;
    const ts = iso(0);
    await env.DB.prepare(`INSERT INTO principals (
      principal_id, principal_type, status, display_name, created_at, updated_at
    ) VALUES (?, 'human', 'active', 's3', ?, ?)`).bind(principalId, ts, ts).run();

    const creation = await seedEvent();
    itemId = nextUlid();
    const versionOne = nextUlid();
    await env.DB.prepare(`INSERT INTO memory_items (
      item_id, principal_id, kind, creation_event_id, creation_event_sequence, created_at
    ) VALUES (?, ?, 'plan', ?, ?, ?)`).bind(itemId, principalId, creation.eventId, creation.sequence, ts).run();
    // Owner-confirmed version with a real FUTURE valid_to.
    await env.DB.prepare(`INSERT INTO memory_item_versions (
      version_id, principal_id, item_id, version_number, text, text_normalization,
      text_hash, basis, origin, uncertain, sensitivity, valid_from, valid_to,
      extractor_version, extractor_model_id, created_at
    ) VALUES (?, ?, ?, 1, 'A confirmed plan valid for weeks.', 'NFC', ?, 'confirmed',
      'deterministic_observation', 0, 'normal', NULL, ?, 'policy-v1', NULL, ?)`)
      .bind(versionOne, principalId, itemId, nextHash(), validTo, ts).run();
    await env.DB.prepare(`INSERT INTO memory_item_sources (
      source_id, principal_id, item_id, version_id, source_position, event_id,
      event_sequence, source_location, r2_segment_id, excerpt, excerpt_hash,
      channel, occurred_at, created_at
    ) VALUES (?, ?, ?, ?, 0, ?, ?, 'live', NULL, 'A confirmed plan valid for weeks.', ?,
      'telegram', ?, ?)`)
      .bind(nextUlid(), principalId, itemId, versionOne, creation.eventId, creation.sequence, nextHash(), ts, ts).run();
    // T1 proposed (rules), T2 active (owner).
    await env.DB.prepare(`INSERT INTO memory_item_transitions (
      transition_id, principal_id, item_id, transition_number, version_id,
      lifecycle_state, reason, actor, policy_version, owner_authorizing_event_id, occurred_at
    ) VALUES (?, ?, ?, 1, ?, 'proposed', 'initial', 'rules', 'policy-v1', NULL, ?)`)
      .bind(nextUlid(), principalId, itemId, versionOne, ts).run();
    const activateId = nextUlid();
    const activateCommand = await ownerCommand(activateId, {
      itemId, versionId: versionOne, lifecycleState: "active",
    });
    await env.DB.prepare(`INSERT INTO memory_item_transitions (
      transition_id, principal_id, item_id, transition_number, version_id,
      lifecycle_state, reason, actor, policy_version, owner_authorizing_event_id, occurred_at
    ) VALUES (?, ?, ?, 2, ?, 'active', 'owner confirm', 'owner', 'policy-v1', ?, ?)`)
      .bind(activateId, principalId, itemId, versionOne, activateCommand, iso(500)).run();

    // T3: rules `expired`, occurred_at in the FUTURE and >= valid_to. The
    // owner-lock exception accepts it because valid_to <= NEW.occurred_at.
    try {
      await env.DB.prepare(`INSERT INTO memory_item_transitions (
        transition_id, principal_id, item_id, transition_number, version_id,
        lifecycle_state, reason, actor, policy_version, owner_authorizing_event_id, occurred_at
      ) VALUES (?, ?, ?, 3, ?, 'expired', 'future expiry', 'rules', 'policy-v1', NULL, ?)`)
        .bind(nextUlid(), principalId, itemId, versionOne, futureExpiry).run();
    } catch (error) {
      expiryThrew = String(error);
    }

    // T4: rules re-activate a new version over the (now rules-owned) item.
    if (expiryThrew === "") {
      const versionTwo = nextUlid();
      const replacementSource = await seedEvent();
      await env.DB.prepare(`INSERT INTO memory_item_versions (
        version_id, principal_id, item_id, version_number, text, text_normalization,
        text_hash, basis, origin, uncertain, sensitivity, valid_from, valid_to,
        extractor_version, extractor_model_id, created_at
      ) VALUES (?, ?, ?, 2, 'A rules replacement.', 'NFC', ?, 'observed',
        'deterministic_observation', 0, 'normal', NULL, NULL, 'policy-v1', NULL, ?)`)
        .bind(versionTwo, principalId, itemId, nextHash(), iso(0)).run();
      await env.DB.prepare(`INSERT INTO memory_item_sources (
        source_id, principal_id, item_id, version_id, source_position, event_id,
        event_sequence, source_location, r2_segment_id, excerpt, excerpt_hash,
        channel, occurred_at, created_at
      ) VALUES (?, ?, ?, ?, 0, ?, ?, 'live', NULL, 'A rules replacement.', ?,
        'system', ?, ?)`)
        .bind(nextUlid(), principalId, itemId, versionTwo, replacementSource.eventId,
          replacementSource.sequence, nextHash(), iso(0), iso(0)).run();
      try {
        await env.DB.prepare(`INSERT INTO memory_item_transitions (
          transition_id, principal_id, item_id, transition_number, version_id,
          lifecycle_state, reason, actor, policy_version, owner_authorizing_event_id, occurred_at
        ) VALUES (?, ?, ?, 4, ?, 'active', 'rules reactivate', 'rules', 'policy-v1', NULL, ?)`)
          .bind(nextUlid(), principalId, itemId, versionTwo, futureExpiry).run();
      } catch (error) {
        reactivateThrew = String(error);
      }
    }
  });

  it("accepts a rules `expired` transition future-dated past valid_to while it is not yet due", async () => {
    const state = await env.DB.prepare(
      "SELECT lifecycle_state FROM memory_item_state WHERE principal_id = ? AND item_id = ?",
    ).bind(principalId, itemId).first<{ lifecycle_state: string }>();
    console.log("S3_EXPIRY_THREW", expiryThrew === "" ? "(no error)" : expiryThrew);
    console.log("S3_REACTIVATE_THREW", reactivateThrew === "" ? "(no error)" : reactivateThrew);
    console.log("S3_STATE_AFTER", state?.lifecycle_state, "S3_VALID_TO", validTo, "S3_NOW", iso(0));
    // Sanity: valid_to is genuinely in the future, so this expiry is premature.
    expect(new Date(validTo).getTime()).toBeGreaterThan(Date.now());
    expect(expiryThrew).toBe("");
    expect(state?.lifecycle_state).toBe("active"); // re-activated over the owner's confirmation
    expect(reactivateThrew).toBe("");
  });
});
