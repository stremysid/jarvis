/**
 * The one written copy of the item suppression predicate.
 *
 * It lives in its own module because two files compose it: the recall arms in
 * `telegram-memory-retriever.ts`, and the control-target arm, which #147 moved into
 * `memory-control-targets.ts`. The retriever imports that finder, so the finder
 * cannot import this from the retriever without a cycle.
 */

/**
 * The item-level suppression predicate: a memory is invisible once the ledger
 * has suppressed the event that created it, or any event recorded as one of the
 * turns it was read from.
 *
 * It is composed here rather than written into each arm, because hand-copying it
 * is what cost the defect this comment exists for: `selectControlTargets` carried
 * neither clause while its sibling `readCandidates` carried both, so a memory
 * whose originating event the ledger had suppressed was still reachable as a
 * control target. The history and the fix are in PR #144. The same shape recurs
 * nearby -- #135 was an operation guard that listed five of the seven operations
 * the finder accepts -- and the shared cause is two places that must agree,
 * compared by nothing.
 *
 * The clauses compare against three aliases that the composing arm must already
 * have in scope: the `memory_items` row, the `memory_item_sources` row, and the
 * version being read. The living-note arm reads a source row that is not the
 * candidate's own version, and it lists suppression among several reasons a
 * derived note is not eligible rather than as a standalone anti-join, so it
 * composes its own binding of the same text.
 *
 * `test/memory/suppression-predicate-parity.test.ts` fails, by name, if an arm in
 * either composing file stops composing one of these; it recognises the
 * composition by the constant's name, so renaming either constant without
 * updating that file fails it too. It also fails if the comparison is written out
 * anywhere but here.
 */
export function suppressionClauses(options: Readonly<{
  /** `AND NOT EXISTS` where suppression alone hides a candidate; `OR EXISTS` inside an arm's own list of reasons a derived row is stale. */
  connective: "AND NOT EXISTS" | "OR EXISTS";
  itemAlias: string;
  /** The principal the creation-event clause compares against; not always the item alias in scope. */
  itemPrincipal: string;
  sourceAlias: string;
  /** The equalities tying that source row to the row being read; the arm's own key, so it cannot be inferred here. */
  sourceKeying: string;
}>): string {
  return `${options.connective} (
    SELECT 1 FROM memory_active_event_suppressions suppression
    WHERE suppression.principal_id = ${options.itemPrincipal}
      AND (suppression.target_event_id = ${options.itemAlias}.creation_event_id
        OR ${options.itemAlias}.creation_event_sequence BETWEEN suppression.start_event_sequence
          AND suppression.end_event_sequence)
  )
  ${options.connective} (
    SELECT 1 FROM memory_item_sources ${options.sourceAlias}
    JOIN memory_active_event_suppressions suppression
      ON suppression.principal_id = ${options.sourceAlias}.principal_id
      AND (suppression.target_event_id = ${options.sourceAlias}.event_id
        OR ${options.sourceAlias}.event_sequence BETWEEN suppression.start_event_sequence
          AND suppression.end_event_sequence)
    WHERE ${options.sourceKeying}
  )`;
}

/**
 * The predicate bound to the aliases every candidate arm already has: `item`
 * (`memory_items`), `source` (`memory_item_sources`) and `version`.
 *
 * Exported so the parity test compares the arms against this one definition
 * rather than against a fifth copy of the same text.
 */
export const CANDIDATE_SUPPRESSION_CLAUSES = suppressionClauses({
  connective: "AND NOT EXISTS",
  itemAlias: "item",
  itemPrincipal: "item.principal_id",
  sourceAlias: "source",
  sourceKeying: `source.principal_id = version.principal_id
      AND source.item_id = version.item_id AND source.version_id = version.version_id`,
});

/**
 * The same predicate where a living note cites an item: `item` is that item's
 * `memory_items` row, `item_source` is its `memory_item_sources` rows, and the
 * keying runs through the note's own source row (`memory_topic_note_sources`,
 * aliased `source` in that arm) rather than through a version.
 */
export const NOTE_SOURCE_SUPPRESSION_CLAUSES = suppressionClauses({
  connective: "OR EXISTS",
  itemAlias: "item",
  itemPrincipal: "source.principal_id",
  sourceAlias: "item_source",
  sourceKeying: `item_source.principal_id = source.principal_id
      AND item_source.item_id = source.source_id AND item_source.version_id = source.item_version_id`,
});
