import { TransactionRunner } from "../persistence/transaction.js";
import type {
  AnswerDecisionResult,
  DecisionItem,
  DecisionOption,
  DecisionOptionKind,
  DecisionRepositoryContract,
  DecisionStatus,
  DecisionUrgency,
  PersistDecisionInput,
  PersistResponseInput,
} from "./decision-types.js";

interface DecisionItemRow {
  readonly decision_id: string;
  readonly principal_id: string;
  readonly origin: string;
  readonly origin_reference: string | null;
  readonly urgency: DecisionUrgency;
  readonly question: string;
  readonly detail: string | null;
  readonly status: DecisionStatus;
  readonly rank: number;
  readonly expires_at: string | null;
  readonly created_at: string;
  readonly delivered_at: string | null;
  readonly resolved_at: string | null;
  readonly option_key: string;
  readonly label: string;
  readonly ordinal: number;
  readonly kind: DecisionOptionKind;
}

interface AnswerContextRow {
  readonly status: DecisionStatus;
  readonly principal_id: string;
  readonly identity_principal_id: string | null;
  readonly option_matches: number;
  readonly response_id: string | null;
  readonly response_option_key: string | null;
  readonly response_free_text: string | null;
  readonly response_identity_id: string | null;
  readonly responded_at: string | null;
  readonly origin: string;
  readonly origin_reference: string | null;
  readonly response_option_kind: DecisionOptionKind | null;
}

const ITEM_COLUMNS = `item.decision_id, item.principal_id, item.origin, item.origin_reference, item.urgency,
       item.question, item.detail, item.status, item.rank, item.expires_at, item.created_at,
       item.delivered_at, item.resolved_at,
       opt.option_key, opt.label, opt.ordinal, opt.kind`;

/**
 * Urgent interrupts, everything else waits its turn. Expressed as a sort key
 * rather than two queries so a normal item can never be read ahead of an
 * urgent one by a caller that forgot to concatenate in the right order.
 */
const QUEUE_ORDER = `CASE item.urgency WHEN 'urgent' THEN 0 ELSE 1 END, item.rank, item.created_at, item.decision_id`;

function itemFrom(row: DecisionItemRow, options: readonly DecisionOption[]): DecisionItem {
  return Object.freeze({
    decisionId: row.decision_id,
    principalId: row.principal_id,
    origin: row.origin,
    originReference: row.origin_reference,
    urgency: row.urgency,
    question: row.question,
    detail: row.detail,
    status: row.status,
    rank: row.rank,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    deliveredAt: row.delivered_at,
    resolvedAt: row.resolved_at,
    options,
  });
}

/**
 * Fold the item-by-option join back into items.
 *
 * Both queries that produce these rows order by the item sort key first and
 * the option ordinal second, so every item's rows are contiguous and already
 * in the order the keyboard is built in. Grouping on a change of decision id
 * is therefore exact rather than approximate.
 */
function groupItems(rows: readonly DecisionItemRow[]): readonly DecisionItem[] {
  const items: DecisionItem[] = [];
  let current: DecisionItemRow | null = null;
  let options: DecisionOption[] = [];
  for (const row of rows) {
    if (current !== null && row.decision_id !== current.decision_id) {
      items.push(itemFrom(current, Object.freeze(options)));
      options = [];
    }
    current = row;
    options.push(Object.freeze({
      optionKey: row.option_key,
      label: row.label,
      ordinal: row.ordinal,
      kind: row.kind,
    }));
  }
  if (current !== null) items.push(itemFrom(current, Object.freeze(options)));
  return Object.freeze(items);
}

/** Durable state for the owner's decision queue in D1. */
export class DecisionRepository implements DecisionRepositoryContract {
  readonly #database: D1Database;
  readonly #transactions: TransactionRunner;

  constructor(database: D1Database) {
    this.#database = database;
    this.#transactions = new TransactionRunner(database);
  }

  /**
   * Write the item and its options as one transaction.
   *
   * An item without options is a question with no way to answer it: it would
   * sit at the top of the owner's queue forever, and the delete guard on
   * `decision_items` means it could not even be cleaned up afterwards. The
   * batch is what makes that state unreachable.
   */
  async raise(input: PersistDecisionInput): Promise<void> {
    await this.#transactions.batch([
      this.#database.prepare(
        `INSERT INTO decision_items (
           decision_id, principal_id, origin, origin_reference, urgency, question, detail,
           status, rank, expires_at, created_at, delivered_at, resolved_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, NULL, NULL)`,
      ).bind(
        input.decisionId, input.principalId, input.origin, input.originReference, input.urgency,
        input.question, input.detail, input.rank, input.expiresAt, input.createdAt,
      ),
      ...input.options.map((option) => this.#database.prepare(
        "INSERT INTO decision_options (decision_id, option_key, label, ordinal, kind) VALUES (?, ?, ?, ?, ?)",
      ).bind(input.decisionId, option.optionKey, option.label, option.ordinal, option.kind)),
    ]);
  }

  async readItem(decisionId: string): Promise<DecisionItem | null> {
    const rows = await this.#database.prepare(
      `SELECT ${ITEM_COLUMNS}
       FROM decision_items item
       JOIN decision_options opt ON opt.decision_id = item.decision_id
       WHERE item.decision_id = ?
       ORDER BY ${QUEUE_ORDER}, opt.ordinal`,
    ).bind(decisionId).all<DecisionItemRow>();
    return groupItems(rows.results)[0] ?? null;
  }

  /**
   * The queue is what is still owed an answer: raised or delivered, not yet
   * resolved, and not past its own expiry. An item whose deadline has passed is
   * dropped here rather than shown, because offering the owner a button that
   * can no longer route anywhere is worse than not asking.
   *
   * The join to options is inner: an item with no options cannot be answered,
   * so listing it would only put an unanswerable question on the owner's screen.
   */
  async listOpenQueue(input: { readonly principalId: string; readonly now: string }): Promise<readonly DecisionItem[]> {
    const rows = await this.#database.prepare(
      `SELECT ${ITEM_COLUMNS}
       FROM decision_items item
       JOIN decision_options opt ON opt.decision_id = item.decision_id
       WHERE item.principal_id = ? AND item.status IN ('open', 'delivered')
         AND (item.expires_at IS NULL OR item.expires_at > ?)
       ORDER BY ${QUEUE_ORDER}, opt.ordinal`,
    ).bind(input.principalId, input.now).all<DecisionItemRow>();
    return groupItems(rows.results);
  }

  /**
   * Only an open item becomes delivered. A second delivery of the same item
   * reports false rather than moving `delivered_at` forward, because that
   * timestamp is the record of when the owner was actually asked.
   */
  async markDelivered(input: { readonly decisionId: string; readonly now: string }): Promise<boolean> {
    const result = await this.#database.prepare(
      "UPDATE decision_items SET status = 'delivered', delivered_at = ? WHERE decision_id = ? AND status = 'open'",
    ).bind(input.now, input.decisionId).run();
    return result.meta.changes > 0;
  }

  /**
   * Record one answer and resolve the item, or report why neither happened.
   *
   * Almost every refusal here is already a structural guarantee of the schema,
   * and this deliberately does not restate any of them: the unique index
   * refuses a second answer, the compound foreign key refuses an option that
   * belongs to another item, the status trigger refuses an answer to a
   * withdrawn item, and the delivered/open check refuses an answer to a
   * question the owner was never shown. Restating them in a WHERE clause would
   * give two authorities on the same rule, and the weaker one would eventually
   * disagree.
   *
   * The one condition the schema cannot state is the one that matters most:
   * the answering identity must belong to the principal that owns the item.
   * That is the join, and it is why this insert selects from `decision_items`
   * rather than binding values directly.
   *
   * `expires_at` is deliberately not consulted here, though the queue hides an
   * item once it passes. Expiry is a transition to the 'expired' status that
   * something else has to make; once it has, this refuses the answer without
   * being asked to. Refusing on the timestamp alone would instead leave the
   * owner tapping a button that reports nothing while the item sits delivered
   * forever, which is the same silence the queue exists to end.
   */
  async recordResponse(input: PersistResponseInput): Promise<AnswerDecisionResult> {
    let failure: unknown = null;
    try {
      const written = await this.#transactions.batch([
        this.#database.prepare(
          `INSERT INTO decision_responses (
             response_id, decision_id, option_key, free_text, answered_by_identity_id, responded_at
           )
           SELECT ?, item.decision_id, ?, ?, ?, ?
           FROM decision_items item
           JOIN channel_identities identity
             ON identity.identity_id = ? AND identity.principal_id = item.principal_id
           WHERE item.decision_id = ?`,
        ).bind(
          input.responseId, input.optionKey, input.freeText, input.answeredByIdentityId, input.now,
          input.answeredByIdentityId, input.decisionId,
        ),
        // Guarded by changes() so a response that was refused above cannot
        // resolve the item anyway, which would silently retire a question
        // nobody answered.
        this.#database.prepare(
          "UPDATE decision_items SET status = 'answered', resolved_at = ? WHERE decision_id = ? AND changes() = 1",
        ).bind(input.now, input.decisionId),
      ]);
      if (written[0]?.meta.changes === 1 && written[1]?.meta.changes === 1) {
        return await this.#routeRecorded(input.decisionId);
      }
    } catch (error) {
      failure = error;
    }
    return this.#explainRefusal(input, failure);
  }

  async #routeRecorded(decisionId: string): Promise<AnswerDecisionResult> {
    const context = await this.#readAnswerContext(decisionId, null, null);
    if (context === null || context.responded_at === null || context.response_identity_id === null) {
      throw new Error("decision_response_lost");
    }
    return Object.freeze({
      outcome: "recorded",
      routing: Object.freeze({
        decisionId,
        origin: context.origin,
        originReference: context.origin_reference,
        optionKey: context.response_option_key,
        optionKind: context.response_option_kind,
        freeText: context.response_free_text,
        answeredByIdentityId: context.response_identity_id,
        respondedAt: context.responded_at,
      }),
    });
  }

  /**
   * Classify a refused answer.
   *
   * Ownership is decided before anything else is reported. The standing answer
   * and the item's status are facts about the owner's queue, and an identity
   * that does not belong to the owning principal learns nothing here beyond
   * that it was refused -- not even whether the item exists under some other
   * principal.
   */
  async #explainRefusal(input: PersistResponseInput, failure: unknown): Promise<AnswerDecisionResult> {
    const context = await this.#readAnswerContext(input.decisionId, input.answeredByIdentityId, input.optionKey);
    if (context === null) return Object.freeze({ outcome: "unknown_decision" });
    if (context.identity_principal_id === null || context.identity_principal_id !== context.principal_id) {
      return Object.freeze({ outcome: "not_owner" });
    }
    if (context.response_id !== null && context.responded_at !== null && context.response_identity_id !== null) {
      return Object.freeze({
        outcome: "already_answered",
        standing: Object.freeze({
          responseId: context.response_id,
          decisionId: input.decisionId,
          optionKey: context.response_option_key,
          freeText: context.response_free_text,
          answeredByIdentityId: context.response_identity_id,
          respondedAt: context.responded_at,
        }),
      });
    }
    if (context.status !== "delivered") return Object.freeze({ outcome: "not_answerable", status: context.status });
    if (input.optionKey !== null && context.option_matches === 0) {
      return Object.freeze({ outcome: "unknown_option" });
    }
    // Nothing about the item explains the refusal, so the cause is not one this
    // queue understands. Reporting an outcome here would invent a reason.
    throw failure ?? new Error("decision_answer_refused_without_cause");
  }

  #readAnswerContext(
    decisionId: string,
    identityId: string | null,
    optionKey: string | null,
  ): Promise<AnswerContextRow | null> {
    return this.#database.prepare(
      `SELECT item.status, item.principal_id, item.origin, item.origin_reference,
         identity.principal_id AS identity_principal_id,
         (SELECT COUNT(*) FROM decision_options opt
          WHERE opt.decision_id = item.decision_id AND opt.option_key = ?) AS option_matches,
         response.response_id, response.option_key AS response_option_key,
         response.free_text AS response_free_text,
         response.answered_by_identity_id AS response_identity_id, response.responded_at,
         answered.kind AS response_option_kind
       FROM decision_items item
       LEFT JOIN channel_identities identity ON identity.identity_id = ?
       LEFT JOIN decision_responses response ON response.decision_id = item.decision_id
       LEFT JOIN decision_options answered
         ON answered.decision_id = item.decision_id AND answered.option_key = response.option_key
       WHERE item.decision_id = ?`,
    ).bind(optionKey, identityId, decisionId).first<AnswerContextRow>();
  }
}
