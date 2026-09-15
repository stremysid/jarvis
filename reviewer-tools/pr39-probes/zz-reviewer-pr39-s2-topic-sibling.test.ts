import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { applyCloudMemoryMigration } from "./migration.js";

// Reviewer probe for PR #39 S2 (NF2, Medium): an INSERT OR REPLACE INTO
// memory_topic_events rename whose apply-UPDATE collides with the
// memory_topics_sibling_name partial unique index (0016:304-306) deletes the
// empty same-named sibling topic, with no delete guard firing (recursive
// triggers are off). The rename branch of the topic-event insert guard checks
// no sibling name; only create does (0016:2154-2157).
//
// PASS on 8b62e80 (sibling B silently deleted). On a fix that adds a
// sibling-name collision check to the rename branch, the INSERT OR REPLACE is
// refused with `memory_topic_event_invalid` and B survives, flipping the test.

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
  return `01k5s2t4${suffix}`;
}
const iso = (offsetMs: number): string => new Date(Date.now() + offsetMs).toISOString();

async function insertTopicEvent(input: {
  principalId: string; topicId: string;
  operation: "create" | "rename";
  previousParentTopicId?: string | null; newParentTopicId?: string | null;
  previousDisplayName?: string | null; previousNormalizedName?: string | null;
  newDisplayName?: string | null; newNormalizedName?: string | null;
  addedAliases?: readonly Readonly<Record<string, string>>[];
  occurredAt: string; orReplace?: boolean;
}): Promise<void> {
  const verb = input.orReplace === true ? "INSERT OR REPLACE INTO" : "INSERT INTO";
  await env.DB.prepare(`${verb} memory_topic_events (
    topic_event_id, principal_id, topic_id, operation, previous_parent_topic_id,
    new_parent_topic_id, previous_display_name, previous_normalized_name,
    new_display_name, new_normalized_name, merge_target_topic_id,
    reparented_child_ids_json, moved_placement_ids_json, added_aliases_json,
    reason, actor, owner_authorizing_event_id, occurred_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, '[]', '[]', ?, 'topic probe', 'rules', NULL, ?)`)
    .bind(
      nextUlid(), input.principalId, input.topicId, input.operation,
      input.previousParentTopicId ?? null, input.newParentTopicId ?? null,
      input.previousDisplayName ?? null, input.previousNormalizedName ?? null,
      input.newDisplayName ?? null, input.newNormalizedName ?? null,
      JSON.stringify(input.addedAliases ?? []), input.occurredAt,
    ).run();
}

describe.sequential("reviewer probe PR #39 S2 topic sibling", () => {
  let principalId = "";
  let leftId = "";
  let rightId = "";
  let renameThrew = "";

  beforeAll(async () => {
    await applyCloudMemoryMigration();
    principalId = `principal:s2:${nextUlid()}`;
    const ts = iso(0);
    await env.DB.prepare(`INSERT INTO principals (
      principal_id, principal_type, status, display_name, created_at, updated_at
    ) VALUES (?, 'human', 'active', 's2', ?, ?)`).bind(principalId, ts, ts).run();

    const rootId = nextUlid();
    leftId = nextUlid();
    rightId = nextUlid();
    await insertTopicEvent({
      principalId, topicId: rootId, operation: "create",
      newDisplayName: "Root", newNormalizedName: "root", occurredAt: iso(1000),
    });
    await insertTopicEvent({
      principalId, topicId: leftId, operation: "create",
      newParentTopicId: rootId, newDisplayName: "Alpha", newNormalizedName: "alpha",
      occurredAt: iso(2000),
    });
    // Sibling B: an empty active leaf named "beta" under the same parent.
    await insertTopicEvent({
      principalId, topicId: rightId, operation: "create",
      newParentTopicId: rootId, newDisplayName: "Beta", newNormalizedName: "beta",
      occurredAt: iso(3000),
    });

    // INSERT OR REPLACE a rename of A "alpha" -> "beta": the apply UPDATE now
    // collides with B on memory_topics_sibling_name; REPLACE deletes B.
    try {
      await insertTopicEvent({
        principalId, topicId: leftId, operation: "rename",
        previousDisplayName: "Alpha", previousNormalizedName: "alpha",
        newDisplayName: "Beta", newNormalizedName: "beta",
        addedAliases: [{
          aliasId: nextUlid(), topicId: leftId, displayName: "Alpha",
          normalizedName: "alpha", pathAlias: "Root/Alpha",
        }],
        occurredAt: iso(4000), orReplace: true,
      });
    } catch (error) {
      renameThrew = String(error);
    }
  });

  it("the INSERT OR REPLACE rename deletes the empty same-named sibling topic", async () => {
    const siblingCount = await env.DB.prepare(
      "SELECT count(*) AS n FROM memory_topics WHERE principal_id = ? AND topic_id = ?",
    ).bind(principalId, rightId).first<{ n: number }>();
    const renamed = await env.DB.prepare(
      "SELECT normalized_name FROM memory_topics WHERE principal_id = ? AND topic_id = ?",
    ).bind(principalId, leftId).first<{ normalized_name: string }>();
    console.log("S2_RENAME_THREW", renameThrew === "" ? "(no error)" : renameThrew);
    console.log("S2_SIBLING_COUNT", siblingCount?.n, "S2_LEFT_NAME", renamed?.normalized_name);
    expect(renameThrew).toBe("");
    expect(siblingCount).toEqual({ n: 0 });
    expect(renamed).toEqual({ normalized_name: "beta" });
  });
});
