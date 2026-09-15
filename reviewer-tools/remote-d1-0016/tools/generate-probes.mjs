// Generates probes/*.sql and probes/plan.json for the scratch remote-D1 proof of
// migration 0016. Run from anywhere: node tools/generate-probes.mjs
// On the S1-S4 fix head, set FIX_HEAD = true, regenerate, and re-run the local
// validation in LOCAL-VALIDATION.md before handing the runbook to Sid.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const FIX_HEAD = false;

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const probeDir = join(root, "probes");
rmSync(probeDir, { recursive: true, force: true });
mkdirSync(probeDir, { recursive: true });

const P = "principal:proof:0016";
const id = (letter, n) => {
  const value = `01k3wp${letter}${String(n).padStart(19, "0")}`;
  if (value.length !== 26 || /[^0-9a-hjkmnp-tv-z]/u.test(value)) throw new Error(`bad id ${value}`);
  return value;
};
const hash = (category, n) => `${category}${n.toString(16).padStart(62, "0")}`;
const raw = (text) => ({ sql: text });
const NOW = raw("strftime('%Y-%m-%dT%H:%M:%fZ', 'now')");
const NOW_PLUS_10 = raw("strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+10 minutes')");
const NOW_MINUS_10 = raw("strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-10 minutes')");
const lit = (value) => {
  if (value === null) return "NULL";
  if (typeof value === "number") return String(value);
  if (typeof value === "object" && "sql" in value) return value.sql;
  return `'${String(value).replaceAll("'", "''")}'`;
};
const insert = (table, row, { orReplace = false } = {}) => {
  const columns = Object.keys(row).filter((column) => row[column] !== undefined);
  return `${orReplace ? "INSERT OR REPLACE" : "INSERT"} INTO ${table} (${columns.join(", ")})\n`
    + `VALUES (${columns.map((column) => lit(row[column])).join(", ")});`;
};
const sequenceOf = (eventId) => raw(`(SELECT sequence FROM events WHERE event_id = ${lit(eventId)})`);

const E = (n) => id("e", n);
const C = (n) => id("c", n);
const M = (n) => id("m", n);
const N = (n) => id("n", n);
const S = (n) => id("s", n);
const R = (n) => id("r", n);
const A = (n) => id("a", n);
const B = (n) => id("b", n);
const D = (n) => id("d", n);
const F = (n) => id("f", n);
const G = (n) => id("g", n);
const V = (n) => id("v", n);
const K = (n) => id("k", n);
const Y = (n) => id("y", n);
const X = (n) => id("x", n);
const Z = (n) => id("z", n);
const PLACEMENT = id("p", 1);
const PLACEMENT_EVENT = id("q", 1);
const MODEL = "deepseek:deepseek-v4-pro";
const TOPIC_AT = "2026-09-14T00:10:00.000Z";
const MOVE_AT = "2026-09-14T00:20:00.000Z";
const pad2 = (n) => String(n).padStart(2, "0");

const event = (eventId, type, source, at, envelope, contentHash) => insert("events", {
  event_id: eventId, event_type: type, source, subject_id: P, occurred_at: at,
  received_at: at, content_hash: contentHash, envelope_json: envelope, created_at: at,
});
const conversation = (n, at) => event(
  E(n), "conversation.user_committed", "jarvis.conversation", at, "{}", hash("e0", n),
);
const command = (n, at, payload) => {
  const eventId = C(n);
  const contentHash = hash("c0", n);
  const envelope = JSON.stringify({
    eventId, correlationId: eventId, eventType: "memory.owner_command",
    source: "memory-control", subjectId: P, occurredAt: at, receivedAt: at,
    contentHash, producerVersion: "memory-control-v1", payload,
  });
  return event(eventId, "memory.owner_command", "memory-control", at, envelope, contentHash);
};
const topicEvent = (o, options) => insert("memory_topic_events", {
  topic_event_id: o.eventId,
  principal_id: P,
  topic_id: o.topicId,
  operation: o.operation,
  previous_parent_topic_id: o.previousParent,
  new_parent_topic_id: o.newParent,
  previous_display_name: o.previousName,
  previous_normalized_name: o.previousName?.toLowerCase(),
  new_display_name: o.newName,
  new_normalized_name: o.newName?.toLowerCase(),
  merge_target_topic_id: o.mergeTarget,
  reparented_child_ids_json: JSON.stringify(o.children ?? []),
  moved_placement_ids_json: JSON.stringify(o.placements ?? []),
  added_aliases_json: JSON.stringify(o.aliases ?? []),
  reason: "proof topic event",
  actor: o.actor ?? "rules",
  owner_authorizing_event_id: o.command,
  occurred_at: o.at ?? TOPIC_AT,
}, options);
const alias = (n, topicId, name, path) => ({
  aliasId: K(n), topicId, displayName: name, normalizedName: name.toLowerCase(), pathAlias: path,
});
const item = ({ m, n, s, r, e, at, validTo, state = "proposed" }) => [
  insert("memory_items", {
    item_id: M(m), principal_id: P, kind: "preference", creation_event_id: E(e),
    creation_event_sequence: sequenceOf(E(e)), created_at: at,
  }),
  insert("memory_item_versions", {
    version_id: N(n), principal_id: P, item_id: M(m), version_number: 1,
    text: "I prefer short reports.", text_normalization: "NFC", text_hash: hash("a0", n),
    basis: "stated", origin: "authenticated_first_person", uncertain: 0, sensitivity: "normal",
    valid_from: null, valid_to: validTo ?? null, extractor_version: "policy-v1",
    extractor_model_id: null, created_at: at,
  }),
  insert("memory_item_sources", {
    source_id: S(s), principal_id: P, item_id: M(m), version_id: N(n), source_position: 0,
    event_id: E(e), event_sequence: sequenceOf(E(e)), source_location: "live", r2_segment_id: null,
    excerpt: "I prefer short reports.", excerpt_hash: hash("b0", s), channel: "telegram",
    occurred_at: at, created_at: at,
  }),
  insert("memory_item_transitions", {
    transition_id: R(r), principal_id: P, item_id: M(m), transition_number: 1, version_id: N(n),
    lifecycle_state: state, reason: "proof proposal", actor: "rules", policy_version: "policy-v1",
    owner_authorizing_event_id: null, occurred_at: at,
  }),
];
const transition = ({ r, m, n, number, state, actor, commandId, at }) => insert("memory_item_transitions", {
  transition_id: R(r), principal_id: P, item_id: M(m), transition_number: number, version_id: N(n),
  lifecycle_state: state, reason: `proof ${actor} ${state}`, actor, policy_version: "policy-v1",
  owner_authorizing_event_id: commandId ?? null, occurred_at: at,
});
const price = (n, effectiveAt, options) => insert("memory_model_prices", {
  price_id: Y(n), principal_id: P, provider: "deepseek", model_id: MODEL, effective_at: effectiveAt,
  input_micros_per_million: 1, output_micros_per_million: 1, cache_read_micros_per_million: 0,
  currency: "USD", source_receipt: "proof price", created_at: effectiveAt,
}, options);
const run = (n, startedAt) => insert("memory_runs", {
  run_id: X(n), principal_id: P, run_key: `proof:run:${n}`, job: "distillation",
  provider_model_id: MODEL, price_id: Y(1), outcome: "running", started_at: startedAt,
});
const reservation = (n, occurredAt) => insert("memory_cost_ledger", {
  cost_entry_id: Z(n), principal_id: P, run_id: X(1), entry_type: "reservation",
  provider: "deepseek", model_id: MODEL, budget_class: "normal_monthly", amount_micros: 1,
  price_id: Y(1), occurred_at: occurredAt,
});
const check = (conditions, extra = []) => `SELECT (\n  ${conditions.join("\n  AND ")}\n) AS ok${
  extra.length === 0 ? "" : `,\n  ${extra.join(",\n  ")}`};`;
const topicCount = `(SELECT count(*) FROM memory_topics WHERE principal_id = ${lit(P)})`;
const topicEventCount = `(SELECT count(*) FROM memory_topic_events WHERE principal_id = ${lit(P)})`;
const topicField = (topicId, expression) => `(SELECT ${expression} FROM memory_topics WHERE principal_id = ${lit(P)} AND topic_id = ${lit(topicId)})`;
const stateOf = (m) => `(SELECT lifecycle_state || '|' || last_transition_number FROM memory_item_state WHERE principal_id = ${lit(P)} AND item_id = ${lit(M(m))})`;

const plan = [];
const add = (name, statements, entry) => {
  const text = `${Array.isArray(statements) ? statements.join("\n\n") : statements}\n`;
  if (Buffer.byteLength(text) > 16000) throw new Error(`${name} is too large for one command line`);
  if (/--[^\n]*;/u.test(text)) throw new Error(`${name} has a semicolon in a comment`);
  writeFileSync(join(probeDir, `${name}.sql`), text);
  plan.push({ name, phase: "main", ...entry });
};
const addFix = (name, statements, now, afterFix, entry) => add(name, statements, {
  ...entry, phase: FIX_HEAD ? "main" : "fix-dependent", expect: FIX_HEAD ? afterFix : now,
  expectAtReviewedHead: now, expectAfterFix: afterFix,
});

writeFileSync(join(probeDir, "00-inventory.sql"),
  "SELECT type, name, tbl_name, length(replace(COALESCE(sql, ''), char(13), '')) AS sql_len\n"
  + "FROM sqlite_master\n"
  + "WHERE name NOT LIKE '!_cf!_%' ESCAPE '!' AND name NOT LIKE 'sqlite!_stat%' ESCAPE '!'\n"
  + "ORDER BY type, name;\n");

add("01-pragma-recursive-triggers", "PRAGMA recursive_triggers;", {
  expect: "regex:\"recursive_triggers\":\\s*0\\b",
  purpose: "REPLACE deletes must not fire delete triggers; the guards assume recursive_triggers = 0",
});

// Seed: owner, turns, commands, one item, the topic tree, a cursor and a price.
add("10-seed-owner-events-commands", [
  insert("principals", {
    principal_id: P, principal_type: "human", status: "active", display_name: "scratch 0016 proof",
    created_at: "2026-09-14T00:00:00.000Z", updated_at: "2026-09-14T00:00:00.000Z",
  }),
  conversation(1, "2026-09-14T00:00:01.000Z"),
  conversation(2, "2026-09-14T00:00:02.000Z"),
  command(0, "2026-09-14T00:00:03.000Z", {
    operation: "item.transition", targetId: R(3), itemId: M(1), versionId: N(1), lifecycleState: "superseded",
  }),
  command(1, "2026-09-14T00:00:04.000Z", {
    operation: "item.transition", targetId: R(2), itemId: M(1), versionId: N(1), lifecycleState: "active",
  }),
  command(2, "2026-09-14T00:00:05.000Z", {
    operation: "item.transition", targetId: R(3), itemId: M(1), versionId: N(1), lifecycleState: "superseded",
  }),
  command(3, "2026-09-14T00:00:06.000Z", {
    operation: "topic.move", targetId: V(501), topicId: B(2), newParentTopicId: A(45),
    newDisplayName: null, newNormalizedName: null, mergeTargetTopicId: null,
  }),
], { expect: "success", purpose: "seed the owner, two turns and four owner commands (C0 is deliberately older than C1)" });

add("11-seed-item", item({ m: 1, n: 1, s: 1, r: 1, e: 1, at: "2026-09-14T00:01:00.000Z" }), {
  expect: "success", purpose: "seed item M1 with a rules 'proposed' transition",
});

const depthCreate = (n) => topicEvent({
  eventId: V(n), topicId: A(n), operation: "create", newParent: n === 1 ? undefined : A(n - 1),
  newName: `Depth ${pad2(n)}`,
});
add("12-seed-topics-depth-01-32", Array.from({ length: 32 }, (_, index) => depthCreate(index + 1)), {
  expect: "success", purpose: "chain A01..A32; every create runs the create-branch recursive CTE",
  triggers: "memory_topic_events_insert_guard (create CTE), memory_topic_events_apply, memory_topics_insert_guard",
});
add("13-seed-topics-depth-33-64", Array.from({ length: 32 }, (_, index) => depthCreate(index + 33)), {
  expect: "success", purpose: "chain A33..A64 (depth 64 is the maximum valid depth)",
  triggers: "memory_topic_events_insert_guard (create CTE at depth 63)",
});
add("14-seed-topics-branch", Array.from({ length: 19 }, (_, index) => {
  const n = index + 2;
  return topicEvent({
    eventId: V(100 + n), topicId: B(n), operation: "create",
    newParent: n === 2 ? A(1) : B(n - 1), newName: `Branch ${pad2(n)}`,
  });
}), { expect: "success", purpose: "branch B02..B20 under A01 (a subtree 19 deep)" });
add("15-seed-topics-merge-replay-placement-cursor-price", [
  topicEvent({ eventId: V(202), topicId: D(2), operation: "create", newParent: A(1), newName: "Merge source" }),
  topicEvent({ eventId: V(203), topicId: D(3), operation: "create", newParent: D(2), newName: "Merge child one" }),
  topicEvent({ eventId: V(204), topicId: D(4), operation: "create", newParent: D(2), newName: "Merge child two" }),
  topicEvent({ eventId: V(205), topicId: D(5), operation: "create", newParent: D(3), newName: "Merge grandchild" }),
  topicEvent({ eventId: V(301), topicId: F(1), operation: "create", newParent: A(1), newName: "Replay zero" }),
  topicEvent({ eventId: V(302), topicId: F(2), operation: "create", newParent: A(1), newName: "Replay one" }),
  topicEvent({ eventId: V(303), topicId: F(3), operation: "create", newParent: F(1), newName: "Replay topic" }),
  topicEvent({ eventId: V(311), topicId: F(3), operation: "move", previousParent: F(1), newParent: F(2) }),
  topicEvent({ eventId: V(312), topicId: F(3), operation: "move", previousParent: F(2), newParent: F(1) }),
  topicEvent({ eventId: V(313), topicId: F(2), operation: "move", previousParent: A(1), newParent: F(3) }),
  insert("memory_item_placement_events", {
    placement_event_id: PLACEMENT_EVENT, principal_id: P, placement_id: PLACEMENT,
    placement_event_number: 1, item_id: M(1), operation: "place", previous_topic_id: null,
    new_topic_id: D(2), relation: "related", filing_source: "rule", confidence: 1,
    reason: "proof placement", owner_authorizing_event_id: null, occurred_at: TOPIC_AT,
  }),
  insert("memory_cursors", {
    principal_id: P, cursor_name: "fts_items", current_event_sequence: 5,
    updated_at: "2026-09-14T00:00:05.000Z",
  }),
  price(1, "2026-09-14T00:00:00.000Z"),
], {
  expect: "success",
  purpose: "merge source D02 with children, replay tree F01/F02/F03 with three moves, a placement on D02, a cursor and a price",
  triggers: "memory_topic_events_insert_guard (move CTE), memory_topics_update_guard, memory_item_placement_events_insert_guard/apply_state",
});
add("19-check-seed", `WITH RECURSIVE chain(topic_id, depth) AS (
  SELECT topic_id, 1 FROM memory_topics WHERE principal_id = ${lit(P)} AND parent_topic_id IS NULL
  UNION ALL
  SELECT child.topic_id, chain.depth + 1 FROM memory_topics child
  JOIN chain ON child.parent_topic_id = chain.topic_id
  WHERE child.principal_id = ${lit(P)} AND chain.depth < 100
)
${check([
  `${topicCount} = 90`,
  `${topicEventCount} = 93`,
  "(SELECT max(depth) FROM chain) = 64",
  `${stateOf(1)} = 'proposed|1'`,
  `${topicField(F(2), "parent_topic_id")} = ${lit(F(3))}`,
  `${topicField(F(3), "parent_topic_id || '|' || last_topic_event_id")} = ${lit(`${F(1)}|${V(312)}`)}`,
  `(SELECT count(*) FROM memory_item_placement_state WHERE principal_id = ${lit(P)} AND topic_id = ${lit(D(2))} AND status = 'active') = 1`,
  `(SELECT current_event_sequence FROM memory_cursors WHERE principal_id = ${lit(P)} AND cursor_name = 'fts_items') = 5`,
  `(SELECT count(*) FROM memory_model_prices WHERE principal_id = ${lit(P)}) = 1`,
], [`${topicCount} AS topics`, "(SELECT max(depth) FROM chain) AS max_depth"])}`, {
  expect: "ok", purpose: "seed projected exactly once: 90 topics, 93 topic events, depth 64",
});

// Owner-command binding.
add("20-owner-transition-activate", transition({
  r: 2, m: 1, n: 1, number: 2, state: "active", actor: "owner", commandId: C(1), at: "2026-09-14T00:02:00.000Z",
}), {
  expect: "success", purpose: "valid owner activation through memory_valid_owner_commands (CASE in the WHEN clause evaluates remotely)",
  triggers: "memory_item_transitions_insert_guard, memory_item_transitions_apply_state, memory_item_state_insert_guard/update_guard",
});
add("21-check-owner-activate", check([
  `${stateOf(1)} = 'active|2'`,
  `(SELECT count(*) FROM memory_item_state WHERE principal_id = ${lit(P)} AND item_id = ${lit(M(1))}) = 1`,
  `(SELECT count(*) FROM memory_retrievable_item_versions WHERE version_id = ${lit(N(1))}) = 1`,
]), { expect: "ok", purpose: "owner activation projected once and is retrievable" });
add("22-owner-transition-not-a-command", transition({
  r: 3, m: 1, n: 1, number: 3, state: "superseded", actor: "owner", commandId: E(1), at: "2026-09-14T00:03:00.000Z",
}), { expect: "raise:memory_item_transition_invalid", purpose: "a conversation turn cannot authorize an owner transition" });
add("23-owner-transition-stale-command", transition({
  r: 3, m: 1, n: 1, number: 3, state: "superseded", actor: "owner", commandId: C(0), at: "2026-09-14T00:03:00.000Z",
}), { expect: "raise:memory_item_transition_invalid", purpose: "command C0 matches every operand but is older than the current transition's command" });
add("24-owner-transition-fresh-command", transition({
  r: 3, m: 1, n: 1, number: 3, state: "superseded", actor: "owner", commandId: C(2), at: "2026-09-14T00:03:00.000Z",
}), { expect: "success", purpose: "control for 23: the identical row with the newer command C2 is accepted" });
add("25-check-owner-superseded", check([
  `${stateOf(1)} = 'superseded|3'`,
  `(SELECT count(*) FROM memory_item_transitions WHERE principal_id = ${lit(P)} AND item_id = ${lit(M(1))}) = 3`,
]), { expect: "ok", purpose: "exactly one accepted transition per command" });

// INSERT OR REPLACE / UPDATE OR REPLACE.
add("30-replace-cursor-rewind", insert("memory_cursors", {
  principal_id: P, cursor_name: "fts_items", current_event_sequence: 0, updated_at: "2026-09-14T00:00:00.000Z",
}, { orReplace: true }), { expect: "raise:memory_cursor_duplicate", purpose: "H2: REPLACE on the natural key cannot rewind a cursor" });
add("31-replace-price-natural-key", price(2, "2026-09-14T00:00:00.000Z", { orReplace: true }), {
  expect: "raise:memory_model_price_duplicate", purpose: "REPLACE with a new price_id on the (principal, model, effective_at) key",
});
add("32-replace-version-rowid-alias", insert("memory_item_versions", {
  version_rowid: raw(`(SELECT version_rowid FROM memory_item_versions WHERE version_id = ${lit(N(1))})`),
  version_id: N(2), principal_id: P, item_id: M(1), version_number: 2, text: "Replacement text.",
  text_normalization: "NFC", text_hash: hash("a0", 2), basis: "stated", origin: "authenticated_first_person",
  uncertain: 0, sensitivity: "normal", valid_from: null, valid_to: null, extractor_version: "policy-v1",
  extractor_model_id: null, created_at: "2026-09-14T00:03:00.000Z",
}, { orReplace: true }), {
  expect: "raise:memory_item_version_lineage_invalid", purpose: "REPLACE through the FTS content rowid alias (explicit rowid)",
});
add("33-replace-item-state-copy",
  `INSERT OR REPLACE INTO memory_item_state SELECT * FROM memory_item_state WHERE principal_id = ${lit(P)} AND item_id = ${lit(M(1))};`,
  { expect: "raise:memory_item_state_requires_transition", purpose: "REPLACE of a projection row by its own key" });
add("34-replace-update-topic-key",
  `UPDATE OR REPLACE memory_topics SET topic_id = ${lit(F(2))}, parent_topic_id = ${lit(F(3))}, last_topic_event_id = ${lit(V(313))}, updated_at = ${lit(TOPIC_AT)}\nWHERE principal_id = ${lit(P)} AND topic_id = ${lit(F(1))};`,
  { expect: "raise:memory_topic_update_requires_event", purpose: "UPDATE OR REPLACE cannot rewrite a topic key onto another topic" });
add("35-replace-topic-event-copy",
  `INSERT OR REPLACE INTO memory_topic_events SELECT * FROM memory_topic_events WHERE principal_id = ${lit(P)} AND topic_event_id = ${lit(V(311))};`,
  { expect: "raise:memory_topic_event_invalid", purpose: "REPLACE of an appended topic event by its own id" });
add("39-check-replace-unchanged", check([
  `(SELECT current_event_sequence FROM memory_cursors WHERE principal_id = ${lit(P)} AND cursor_name = 'fts_items') = 5`,
  `(SELECT group_concat(price_id) FROM memory_model_prices WHERE principal_id = ${lit(P)}) = ${lit(Y(1))}`,
  `(SELECT count(*) FROM memory_item_versions WHERE principal_id = ${lit(P)} AND item_id = ${lit(M(1))}) = 1`,
  `${stateOf(1)} = 'superseded|3'`,
  `${topicCount} = 90`,
  `${topicEventCount} = 93`,
  `${topicField(F(1), "parent_topic_id")} = ${lit(A(1))}`,
  `${topicField(F(2), "parent_topic_id || '|' || last_topic_event_id")} = ${lit(`${F(3)}|${V(313)}`)}`,
]), { expect: "ok", purpose: "every rejected REPLACE left the rows untouched" });

// Deep valid move and merge.
const ownerMove = (parent) => topicEvent({
  eventId: V(501), topicId: B(2), operation: "move", previousParent: A(1), newParent: parent,
  actor: "owner", command: C(3), at: MOVE_AT,
});
add("40-owner-topic-move-wrong-operand", ownerMove(A(44)), {
  expect: "raise:memory_topic_event_invalid", purpose: "command C3 authorizes parent A45, not A44 (operand binding)",
});
add("41-owner-topic-move-deep", ownerMove(A(45)), {
  expect: "success", purpose: "valid owner move of the 19-deep branch under A45: ancestors 45 + subtree 19 = 64",
  triggers: "memory_topic_events_insert_guard (move: ancestors + subtree CTEs, owner command), memory_topics_update_guard",
});
add("42-merge-deep", topicEvent({
  eventId: V(502), topicId: D(2), operation: "merge", previousName: "Merge source", mergeTarget: A(60),
  children: [D(3), D(4)], placements: [PLACEMENT],
  aliases: [alias(1, A(60), "Merge source", "Depth 01/Merge source")], at: MOVE_AT,
}), {
  expect: "success", purpose: "valid merge of D02 into A60: ancestors 60 + descendants 2 = 62; reparents two children and moves one placement",
  triggers: "memory_topic_events_insert_guard (merge: ancestors + descendants CTEs), memory_topic_events_apply, memory_topic_aliases_insert_guard, memory_topics_update_guard, memory_item_placement_state_update_guard",
});
add("49-check-deep", `WITH RECURSIVE up(topic_id, parent_topic_id, depth) AS (
  SELECT topic_id, parent_topic_id, 1 FROM memory_topics WHERE principal_id = ${lit(P)} AND topic_id = ${lit(B(20))}
  UNION ALL
  SELECT t.topic_id, t.parent_topic_id, up.depth + 1 FROM memory_topics t
  JOIN up ON t.principal_id = ${lit(P)} AND t.topic_id = up.parent_topic_id
  WHERE up.depth < 100
)
${check([
  "(SELECT max(depth) FROM up) = 64",
  `${topicField(B(2), "parent_topic_id || '|' || last_topic_event_id")} = ${lit(`${A(45)}|${V(501)}`)}`,
  `${topicField(D(2), "status || '|' || redirect_to_topic_id || '|' || last_topic_event_id || '|' || parent_topic_id")} = ${lit(`merged|${A(60)}|${V(502)}|${A(1)}`)}`,
  `(SELECT count(*) FROM memory_topics WHERE principal_id = ${lit(P)} AND topic_id IN (${lit(D(3))}, ${lit(D(4))}) AND parent_topic_id = ${lit(A(60))} AND last_topic_event_id = ${lit(V(502))}) = 2`,
  `${topicField(D(5), "parent_topic_id || '|' || last_topic_event_id")} = ${lit(`${D(3)}|${V(205)}`)}`,
  `(SELECT count(*) FROM memory_topic_aliases WHERE principal_id = ${lit(P)}) = 1`,
  `(SELECT topic_id || '|' || created_by_topic_event_id FROM memory_topic_aliases WHERE alias_id = ${lit(K(1))}) = ${lit(`${A(60)}|${V(502)}`)}`,
  `(SELECT topic_id || '|' || last_event_kind || '|' || last_event_id || '|' || last_placement_event_number || '|' || status FROM memory_item_placement_state WHERE principal_id = ${lit(P)} AND placement_id = ${lit(PLACEMENT)}) = ${lit(`${A(60)}|topic|${V(502)}|1|active`)}`,
  `${topicCount} = 90`,
  `${topicEventCount} = 95`,
], ["(SELECT max(depth) FROM up) AS b20_depth", `${topicEventCount} AS topic_events`])}`, {
  expect: "ok", purpose: "deep move and merge each projected exactly once",
});

// Stale replay, cycles and depth.
add("50-replay-stale-direct-update",
  `UPDATE memory_topics SET parent_topic_id = ${lit(F(2))}, last_topic_event_id = ${lit(V(311))}, updated_at = ${lit(TOPIC_AT)}\nWHERE principal_id = ${lit(P)} AND topic_id = ${lit(F(3))};`,
  { expect: "raise:memory_topic_update_requires_event", purpose: "re-projecting the older first move of F03 is refused" });
add("51-replay-older-event", topicEvent({
  eventId: V(503), topicId: F(3), operation: "move", previousParent: F(1), newParent: A(1),
  at: "2026-09-14T00:09:00.000Z",
}), { expect: "raise:memory_topic_event_invalid", purpose: "an otherwise valid move dated before F03's current event is refused by the insert guard (memory_topics_update_guard would also refuse it)" });
add("60-cycle-move", topicEvent({
  eventId: V(504), topicId: F(3), operation: "move", previousParent: F(1), newParent: F(2), at: MOVE_AT,
}), {
  expect: "raise:memory_topic_event_invalid", purpose: "F02 is now a child of F03, so moving F03 under F02 is a cycle (only the move CTE rejects it)",
});
add("61-cycle-merge", topicEvent({
  eventId: V(505), topicId: F(1), operation: "merge", previousName: "Replay zero", mergeTarget: F(2),
  children: [F(3)], aliases: [alias(2, F(2), "Replay zero", "Depth 01/Replay zero")], at: MOVE_AT,
}), {
  expect: "raise:memory_topic_event_invalid", purpose: "merging F01 into its own descendant F02 (only the merge CTE rejects it)",
});
add("62-depth-create-65", topicEvent({
  eventId: V(506), topicId: A(65), operation: "create", newParent: A(64), newName: "Depth 65", at: MOVE_AT,
}), { expect: "raise:memory_topic_event_invalid", purpose: "the create CTE caps depth at 64" });
add("63-depth-move-over-64", topicEvent({
  eventId: V(507), topicId: B(2), operation: "move", previousParent: A(45), newParent: A(50), at: MOVE_AT,
}), { expect: "raise:memory_topic_event_invalid", purpose: "ancestors 50 + subtree 19 = 69 (depth-sum clause only)" });
add("64-depth-merge-over-64", topicEvent({
  eventId: V(508), topicId: F(1), operation: "merge", previousName: "Replay zero", mergeTarget: A(63),
  children: [F(3)], aliases: [alias(3, A(63), "Replay zero", "Depth 01/Replay zero")], at: MOVE_AT,
}), { expect: "raise:memory_topic_event_invalid", purpose: "ancestors 63 + descendants 2 = 65 (merge depth-sum clause only)" });
add("69-check-topics-unchanged", check([
  `${topicCount} = 90`,
  `${topicEventCount} = 95`,
  `(SELECT count(*) FROM memory_topic_aliases WHERE principal_id = ${lit(P)}) = 1`,
  `${topicField(F(3), "parent_topic_id || '|' || last_topic_event_id")} = ${lit(`${F(1)}|${V(312)}`)}`,
  `${topicField(F(2), "parent_topic_id || '|' || last_topic_event_id")} = ${lit(`${F(3)}|${V(313)}`)}`,
  `${topicField(F(1), "parent_topic_id || '|' || status || '|' || last_topic_event_id")} = ${lit(`${A(1)}|active|${V(301)}`)}`,
  `${topicField(B(2), "parent_topic_id || '|' || last_topic_event_id")} = ${lit(`${A(45)}|${V(501)}`)}`,
  `(SELECT count(*) FROM memory_topics WHERE topic_id = ${lit(A(65))}) = 0`,
]), { expect: "ok", purpose: "no hostile topic probe changed anything" });

// strftime('now') in trigger WHEN clauses.
const renameBranch20 = (eventNumber, aliasNumber, at) => topicEvent({
  eventId: V(eventNumber), topicId: B(20), operation: "rename", previousName: "Branch 20", newName: "Branch twenty",
  aliases: [alias(aliasNumber, B(20), "Branch 20", "Depth 01/Branch 20")], at,
});
add("70-clock-topic-future", renameBranch20(509, 4, NOW_PLUS_10), {
  expect: "raise:memory_topic_event_invalid", purpose: "topic event dated now + 10 minutes (strftime('now', '+5 minutes') bound)",
});
add("71-clock-topic-now", renameBranch20(510, 5, NOW), {
  expect: "success", purpose: "control for 70: the same rename dated now is accepted",
});
add("72-clock-run-now", run(1, NOW), {
  expect: "success", purpose: "run started now passes both strftime('now') bounds",
  triggers: "memory_runs_insert_guard",
});
add("73-clock-run-past", run(2, NOW_MINUS_10), {
  expect: "raise:memory_run_initial_state_invalid", purpose: "run backdated 10 minutes",
});
add("74-clock-run-future", run(3, NOW_PLUS_10), {
  expect: "raise:memory_run_initial_state_invalid", purpose: "run started 10 minutes in the future",
});
add("79-check-clock", check([
  `${topicField(B(20), "display_name || '|' || last_topic_event_id")} = ${lit(`Branch twenty|${V(510)}`)}`,
  `(SELECT count(*) FROM memory_topic_aliases WHERE principal_id = ${lit(P)}) = 2`,
  `(SELECT group_concat(run_id || '|' || outcome) FROM memory_runs WHERE principal_id = ${lit(P)}) = ${lit(`${X(1)}|running`)}`,
]), { expect: "ok", purpose: "exactly one clock-bounded row of each kind was accepted" });

// Fix-dependent probes (S1-S4). At the reviewed head 8b62e80 these document the holes.
add("80-s1-seed-unreferenced-price", price(4, "2026-09-14T02:00:00.000Z"), {
  phase: FIX_HEAD ? "main" : "fix-dependent", expect: "success", purpose: "S1 seed: a price no run references",
});
addFix("81-s1-replace-price-explicit-rowid", insert("memory_model_prices", {
  rowid: raw(`(SELECT rowid FROM memory_model_prices WHERE price_id = ${lit(Y(4))})`),
  price_id: Y(5), principal_id: P, provider: "deepseek", model_id: MODEL,
  effective_at: "2026-09-14T03:00:00.000Z", input_micros_per_million: 1, output_micros_per_million: 1,
  cache_read_micros_per_million: 0, currency: "USD", source_receipt: "proof replacement",
  created_at: "2026-09-14T03:00:00.000Z",
}, { orReplace: true }), "success", "errregex:rowid", {
  purpose: "S1: REPLACE by explicit rowid deletes the guarded price row at 8b62e80; WITHOUT ROWID removes the column",
});
addFix("82-s1-check-price-survives", check([
  `(SELECT count(*) FROM memory_model_prices WHERE price_id = ${lit(Y(4))}) = 1`,
  `(SELECT count(*) FROM memory_model_prices WHERE price_id = ${lit(Y(5))}) = 0`,
]), "regex:\"ok\":\\s*0\\b", "ok", { purpose: "S1: Y4 must survive (at 8b62e80 it is gone, ok = 0)" });

add("83-s2-seed-siblings", [
  topicEvent({ eventId: V(401), topicId: G(1), operation: "create", newParent: A(1), newName: "Sibling left" }),
  topicEvent({ eventId: V(402), topicId: G(2), operation: "create", newParent: A(1), newName: "Sibling right" }),
  topicEvent({ eventId: V(403), topicId: G(4), operation: "create", newParent: A(1), newName: "Sibling moved" }),
  topicEvent({ eventId: V(404), topicId: G(3), operation: "create", newParent: B(2), newName: "Sibling moved" }),
], { phase: FIX_HEAD ? "main" : "fix-dependent", expect: "success", purpose: "S2 seed: same-named topics under different parents" });
const renameOntoSibling = (eventNumber, aliasNumber, options) => topicEvent({
  eventId: V(eventNumber), topicId: G(1), operation: "rename", previousName: "Sibling left", newName: "Sibling right",
  aliases: [alias(aliasNumber, G(1), "Sibling left", "Depth 01/Sibling left")], at: MOVE_AT,
}, options);
addFix("84-s2-rename-onto-sibling-plain", renameOntoSibling(405, 6), "errregex:UNIQUE constraint failed",
  "raise:memory_topic_event_invalid", { purpose: "S2: plain rename onto a sibling name fails on the unique index today, on the named guard after the fix" });
addFix("85-s2-move-onto-sibling-replace", topicEvent({
  eventId: V(406), topicId: G(3), operation: "move", previousParent: B(2), newParent: A(1), at: MOVE_AT,
}, { orReplace: true }), "success", "raise:memory_topic_event_invalid", {
  purpose: "S2: REPLACE carried into the move apply deletes sibling G04 at 8b62e80",
});
addFix("86-s2-rename-onto-sibling-replace", renameOntoSibling(407, 7, { orReplace: true }), "success",
  "raise:memory_topic_event_invalid", { purpose: "S2: REPLACE carried into the rename apply deletes sibling G02 at 8b62e80" });
addFix("87-s2-check-siblings-survive", check([
  `(SELECT count(*) FROM memory_topics WHERE principal_id = ${lit(P)} AND topic_id IN (${lit(G(1))}, ${lit(G(2))}, ${lit(G(3))}, ${lit(G(4))})) = 4`,
]), "regex:\"ok\":\\s*0\\b", "ok", { purpose: "S2: all four sibling topics must survive (at 8b62e80 two are deleted)" });

add("88-s3-seed-owner-locked-items", [
  conversation(3, "2026-09-14T00:00:07.000Z"),
  conversation(4, "2026-09-14T00:00:08.000Z"),
  ...item({ m: 2, n: 3, s: 2, r: 4, e: 2, at: "2026-09-14T00:04:00.000Z", validTo: "2026-10-01T00:00:00.000Z" }),
  ...item({ m: 3, n: 4, s: 3, r: 7, e: 3, at: "2026-09-14T00:04:00.000Z" }),
  ...item({ m: 4, n: 5, s: 4, r: 10, e: 4, at: "2026-09-14T00:04:00.000Z", validTo: "2026-09-14T00:30:00.000Z" }),
  command(5, "2026-09-14T00:00:09.000Z", { operation: "item.transition", targetId: R(5), itemId: M(2), versionId: N(3), lifecycleState: "active" }),
  command(6, "2026-09-14T00:00:10.000Z", { operation: "item.transition", targetId: R(8), itemId: M(3), versionId: N(4), lifecycleState: "active" }),
  command(7, "2026-09-14T00:00:11.000Z", { operation: "item.transition", targetId: R(9), itemId: M(3), versionId: N(4), lifecycleState: "expired" }),
  command(8, "2026-09-14T00:00:12.000Z", { operation: "item.transition", targetId: R(11), itemId: M(4), versionId: N(5), lifecycleState: "active" }),
  transition({ r: 5, m: 2, n: 3, number: 2, state: "active", actor: "owner", commandId: C(5), at: "2026-09-14T00:05:00.000Z" }),
  transition({ r: 8, m: 3, n: 4, number: 2, state: "active", actor: "owner", commandId: C(6), at: "2026-09-14T00:05:00.000Z" }),
  transition({ r: 11, m: 4, n: 5, number: 2, state: "active", actor: "owner", commandId: C(8), at: "2026-09-14T00:05:00.000Z" }),
], { phase: FIX_HEAD ? "main" : "fix-dependent", expect: "success", purpose: "S3 seed: three owner-activated items (M2 valid_to 2026-10-01, M4 valid_to already past)" });
addFix("89-s3-rules-expire-future-dated", transition({
  r: 6, m: 2, n: 3, number: 3, state: "expired", actor: "rules", at: "2026-11-01T00:00:00.000Z",
}), "success", "raise:memory_item_transition_invalid", {
  purpose: "S3: rules expire an owner-confirmed fact early by future-dating occurred_at past valid_to",
});
addFix("90-s3-owner-transition-backdated", transition({
  r: 9, m: 3, n: 4, number: 3, state: "expired", actor: "owner", commandId: C(7), at: "2026-09-14T00:04:30.000Z",
}), "success", "raise:memory_item_transition_invalid", {
  purpose: "S3: transition dated before the current state's updated_at",
});
addFix("91-s3-rules-expire-now-plus-10", transition({
  r: 12, m: 4, n: 5, number: 3, state: "expired", actor: "rules", at: NOW_PLUS_10,
}), "success", "raise:memory_item_transition_invalid", {
  purpose: "S3: rules expiry dated now + 10 minutes (new strftime('now') bound in the transition guard)",
});
addFix("92-s3-rules-expire-now", transition({
  r: 13, m: 4, n: 5, number: 3, state: "expired", actor: "rules", at: NOW,
}), "raise:memory_item_transition_invalid", "success", {
  purpose: "S3 control: rules expiry of M4 (valid_to past) dated now; at 8b62e80 it fails only because 91 already expired M4",
});

addFix("93-s4-ledger-reservation-now", reservation(2, NOW), "success", "success", {
  purpose: "S4 control: reservation dated now on run X1",
});
addFix("94-s4-ledger-reservation-future", reservation(1, NOW_PLUS_10), "success",
  "raise:memory_cost_entry_lineage_invalid", {
    purpose: "S4: reservation dated now + 10 minutes lands in a later month bucket",
  });

writeFileSync(join(probeDir, "plan.json"), `${JSON.stringify(plan, null, 2)}\n`);
console.log(`wrote ${plan.length} probes (FIX_HEAD=${FIX_HEAD})`);
