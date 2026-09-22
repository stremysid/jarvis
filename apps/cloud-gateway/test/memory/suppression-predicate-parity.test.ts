/**
 * The item-level suppression predicate is one definition, and every arm that can
 * return a memory composes it.
 *
 * Why this file exists. The predicate -- "invisible if the ledger suppressed the
 * event that created this item, or any event recorded as one of its turns" -- was
 * written out by hand in each SQL arm. Twice a fix landed in one copy and missed
 * the others, and both times the suite stayed green:
 *
 *   - #135 corrected an operation guard that listed five of the seven operations
 *     the finder accepts, so `memory_pin`/`memory_unpin` threw in production;
 *   - #144: `selectControlTargets` carried neither clause while its sibling
 *     `readCandidates` carried both, so a memory whose originating event the
 *     ledger had suppressed was still reachable as a control target.
 *
 * The defect is not "a clause is missing somewhere" -- it is that two pieces of
 * SQL that must agree are compared by nothing. So this file compares them.
 *
 * Four guards, and what each one can and cannot establish:
 *
 *   1. the item-level comparison appears ONCE in the retriever source, so a copy
 *      pasted back into an arm fails here;
 *   2. every SQL template in that source which reads memory candidates composes
 *      a `*SUPPRESSION_CLAUSES` constant, so an arm that simply stops applying
 *      the predicate fails here -- including one added after this file was
 *      written, which is the case no behaviour test would reach;
 *   3. every arm, actually driven through the public API against a recording D1,
 *      hands the database SQL that contains the shared clauses verbatim;
 *   4. the shared clauses still name all four comparisons, so 1-3 are guarding
 *      the whole predicate rather than a gutted one.
 *
 * What none of them establish is that the predicate is *semantically* right:
 * guards 1-3 compare arms to each other and to one definition, so editing that
 * one definition moves every arm together and passes all three. The meaning is
 * pinned by behaviour elsewhere -- `telegram-memory.test.ts` for the keyword
 * candidate arm (both clauses, one test each), `living-notes.test.ts` for the
 * note arm, and PR #144's `control-target-suppression.test.ts` for the
 * control-target arm. The named-area candidate arm has no behaviour test for
 * suppression, and nothing here closes that: guard 3 shows it is composed and
 * sent, not that it excludes what it should.
 */

import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { newUlid } from "../../../../packages/contracts/src/index.js";
import { MemoryRepository } from "../../src/memory/memory-repository.js";
import {
  CANDIDATE_SUPPRESSION_CLAUSES,
  NOTE_SOURCE_SUPPRESSION_CLAUSES,
  TelegramMemoryRetriever,
} from "../../src/memory/telegram-memory-retriever.js";
import retrieverSource from "../../src/memory/telegram-memory-retriever.js?raw";
import { applyNewestRuntimeMigration } from "../persistence/migration.js";

/**
 * Every SQL statement the wrapped database was asked to prepare, in order.
 *
 * A recording proxy rather than a mock: the arms under test are the ones the
 * retriever really builds, and a mock that answers instead of recording would be
 * asserting on a copy of the query instead of the query.
 */
function recordingDatabase(): Readonly<{ database: D1Database; prepared: string[] }> {
  const prepared: string[] = [];
  const database = new Proxy(env.DB as unknown as object, {
    get(target, property) {
      if (property === "prepare") {
        return (sql: string) => {
          prepared.push(sql);
          return (target as D1Database).prepare(sql);
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? (value as (...args: never[]) => unknown).bind(target) : value;
    },
  }) as D1Database;
  return Object.freeze({ database, prepared });
}

/**
 * The one prepared statement containing `marker`.
 *
 * `toHaveLength(1)` is load-bearing: an arm that stopped running would otherwise
 * leave the assertions below satisfied by nothing at all, which is how a guard
 * ends up green while its subject is gone.
 */
function preparedOnce(database: Readonly<{ prepared: string[] }>, marker: string): string {
  const matches = database.prepared.filter((sql) => sql.includes(marker));
  expect(matches).toHaveLength(1);
  return matches[0]!;
}

async function seedPrincipal(): Promise<string> {
  const principalId = `principal:suppression-parity:${newUlid()}`;
  const now = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO principals (
    principal_id, principal_type, status, display_name, created_at, updated_at
  ) VALUES (?, 'human', 'active', 'suppression parity test', ?, ?)`)
    .bind(principalId, now, now).run();
  return principalId;
}

function retriever(database: D1Database): TelegramMemoryRetriever {
  return new TelegramMemoryRetriever({ database, archive: env.ARCHIVE });
}

beforeAll(async () => {
  await applyNewestRuntimeMigration();
});

describe("the item suppression predicate is written once, in the clauses every arm composes", () => {
  // Source-level, so it sees arms that no test drives. The scan is deliberately
  // narrow: it only recognises a template that reads memory candidates.
  const PREPARED_SQL = /\.prepare\(`([^`]*)`\)/gu;
  const READS_MEMORY_CANDIDATES = /memory_item_versions|memory_item_fts/u;
  const COMPOSES_CLAUSES = /\$\{[A-Za-z_$][\w$]*SUPPRESSION_CLAUSES\}/u;

  /**
   * Arms that legitimately hold no clause of their own.
   *
   * Both are recognised by SQL text rather than by method name, because the text
   * is what the reason is about. The cost of that choice: an arm that happened to
   * read forgotten items through this exact predicate would be exempted silently.
   */
  const PROTECTED_WITHOUT_COMPOSING = Object.freeze([
    {
      marker: "memory_retrievable_item_versions",
      why: "reads the current version through the `memory_retrievable_item_versions`"
        + " view, which already carries both clauses (0016_cloud_memory.sql)",
    },
    {
      marker: "state.lifecycle_state = 'forgotten'",
      why: "must see forgotten items: it reads them to detect a reply that restates"
        + " one, so an anti-join here would delete the evidence it exists to find",
    },
  ]);

  it("states the item-level suppression comparison exactly once in the retriever", () => {
    // The literal, not a count of the view: `withoutForgottenTurns` reads the view
    // for one event-level check of its own, which is not this predicate.
    const comparisons = retrieverSource
      .match(/creation_event_sequence BETWEEN suppression\.start_event_sequence/gu) ?? [];
    expect(comparisons).toHaveLength(1);
  });

  it("composes the shared suppression clauses in every SQL template that reads a memory candidate", () => {
    const templates = [...retrieverSource.matchAll(PREPARED_SQL)].map((match) => match[1] ?? "");
    // The scan finds nothing if the source stops using backtick templates, and
    // "no templates" must not read as "no offenders".
    expect(templates.length).toBeGreaterThanOrEqual(8);
    const candidateTemplates = templates.filter((sql) => READS_MEMORY_CANDIDATES.test(sql));
    expect(candidateTemplates.length).toBeGreaterThanOrEqual(5);

    const offenders = candidateTemplates.filter((sql) =>
      !COMPOSES_CLAUSES.test(sql)
      && !PROTECTED_WITHOUT_COMPOSING.some(({ marker }) => sql.includes(marker)));
    expect(offenders).toEqual([]);
  });
});

describe("every arm that returns a memory candidate sends the same suppression clauses", () => {
  it("sends them in the candidate arm a keyword query reaches", async () => {
    const principalId = await seedPrincipal();
    const database = recordingDatabase();
    await retriever(database.database).retrieve({
      principalId,
      channel: "telegram",
      purpose: "conversation",
      query: "concise reports",
      maxTokens: 32_000,
    });
    // `memory_item_fts` is the keyword arm's own entry point; the search service
    // is not part of this drive, so one statement matches it.
    expect(preparedOnce(database, "FROM memory_item_fts")).toContain(CANDIDATE_SUPPRESSION_CLAUSES);
  });

  it("sends them in the candidate arm a named-area question reaches", async () => {
    const principalId = await seedPrincipal();
    // The area arm only prepares its query once the topic path resolves, so the
    // fixture has to bootstrap the tree the question names.
    await new MemoryRepository(env.DB).bootstrapTopics(principalId);
    const database = recordingDatabase();
    await retriever(database.database).retrieve({
      principalId,
      channel: "telegram",
      purpose: "conversation",
      query: "What do you remember about Inbox / Needs filing?",
      maxTokens: 32_000,
    });
    // `WITH RECURSIVE subtree` is the area arm's own entry point. The marker is
    // not `memory_item_placement_state`, which the topic-path walk also names.
    const area = preparedOnce(database, "WITH RECURSIVE subtree(");
    expect(area).toContain(CANDIDATE_SUPPRESSION_CLAUSES);
  });

  it("sends them in the arm that chooses a control target", async () => {
    const principalId = await seedPrincipal();
    const database = recordingDatabase();
    await retriever(database.database).findControlTargets({
      principalId,
      operation: "forget",
      query: "kite",
    });
    expect(preparedOnce(database, "FROM memory_item_fts")).toContain(CANDIDATE_SUPPRESSION_CLAUSES);
  });

  it("sends the note-source form of them in the arm that reads a living note citing an item", async () => {
    const principalId = await seedPrincipal();
    const database = recordingDatabase();
    await retriever(database.database).retrieve({
      principalId,
      channel: "telegram",
      purpose: "conversation",
      query: "concise reports",
      maxTokens: 32_000,
    });
    expect(preparedOnce(database, "memory_topic_note_heads head"))
      .toContain(NOTE_SOURCE_SUPPRESSION_CLAUSES);
  });
});

describe("the shared clauses still name every comparison the predicate is made of", () => {
  // Guards 1-3 above compare arms to each other and to one definition, so they
  // pass if that one definition is gutted. This is what stops them being
  // tautological. It pins text, not SQL semantics -- behaviour is what establishes
  // the semantics, and the file header says which suites do that.
  it("names the item's own creation event and every event recorded as a source", () => {
    expect(CANDIDATE_SUPPRESSION_CLAUSES).toContain(
      "suppression.target_event_id = item.creation_event_id");
    expect(CANDIDATE_SUPPRESSION_CLAUSES).toContain(
      "item.creation_event_sequence BETWEEN suppression.start_event_sequence");
    expect(CANDIDATE_SUPPRESSION_CLAUSES).toContain(
      "suppression.target_event_id = source.event_id");
    expect(CANDIDATE_SUPPRESSION_CLAUSES).toContain(
      "source.event_sequence BETWEEN suppression.start_event_sequence");
  });

  it("names the same two comparisons for a note's cited item", () => {
    expect(NOTE_SOURCE_SUPPRESSION_CLAUSES).toContain(
      "suppression.target_event_id = item.creation_event_id");
    expect(NOTE_SOURCE_SUPPRESSION_CLAUSES).toContain(
      "item.creation_event_sequence BETWEEN suppression.start_event_sequence");
    expect(NOTE_SOURCE_SUPPRESSION_CLAUSES).toContain(
      "suppression.target_event_id = item_source.event_id");
    expect(NOTE_SOURCE_SUPPRESSION_CLAUSES).toContain(
      "item_source.event_sequence BETWEEN suppression.start_event_sequence");
  });
});
