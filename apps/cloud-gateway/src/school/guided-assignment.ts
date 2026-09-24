import { newUlid } from "../../../../packages/contracts/src/index.js";
import type { ExecutedTool } from "../agent/owner-agent-core.js";
import type { ModelAdapterStreamInput } from "../model/model-adapter.js";
import { DeviceRepository } from "../persistence/device-repository.js";
import type { ModelFunctionCall, TelegramProvider } from "../providers/provider-types.js";

export interface AssignmentEvidence {
  readonly assignmentId: string;
  readonly title: string;
  readonly course: string;
  readonly instructions: string | null;
  readonly rubric: string | null;
  readonly dueDate: string;
  readonly source: string;
  readonly sourceText?: string | null;
}

// Follow-up guided-assignment-d2l-evidence: implement this reader after #169
// lands. Its collector records must preserve their own ids and provenance.
export interface AssignmentEvidenceReader {
  list(principalId: string): Promise<readonly AssignmentEvidence[]>;
}

export class StoredAssignmentEvidenceReader implements AssignmentEvidenceReader {
  constructor(private readonly database: D1Database) {}

  async list(principalId: string): Promise<readonly AssignmentEvidence[]> {
    const facts = await this.database.prepare(`SELECT 'fact:' || f.fact_id AS assignmentId,
      f.statement AS title, c.course_name AS course, f.statement AS instructions,
      NULL AS rubric, 'no date known' AS dueDate, f.evidence_source AS source,
      json_extract(e.envelope_json, '$.payload.text') AS sourceText
      FROM school_course_facts f JOIN school_course_cards c
        ON c.principal_id = f.principal_id AND c.course_id = f.course_id
      LEFT JOIN conversation_turns t ON t.turn_id = f.source_turn_id
      LEFT JOIN events e ON e.event_id = t.user_event_id
      WHERE f.principal_id = ? ORDER BY f.observed_at, f.fact_id`)
      .bind(principalId).all<AssignmentEvidence>();
    const actions = await this.database.prepare(`SELECT 'action:' || a.action_id AS assignmentId,
      a.action_text AS title, c.course_name AS course, a.action_text AS instructions,
      NULL AS rubric, 'no date known' AS dueDate, 'catchup_plan' AS source
      FROM school_catchup_actions a JOIN school_course_cards c
        ON c.principal_id = a.principal_id AND c.course_id = a.course_id
      WHERE a.principal_id = ? ORDER BY a.local_date, a.sequence_rank, a.action_id`)
      .bind(principalId).all<AssignmentEvidence>();
    // Main's deadline store is single-owner and has no principal column. The
    // service authorizes the configured owner before this reader is reached.
    const deadlines = await this.database.prepare(`SELECT 'deadline:' || deadline_id AS assignmentId,
      title, course, NULL AS instructions, NULL AS rubric, due_at AS dueDate,
      source_id AS source FROM deadlines ORDER BY due_at, deadline_id`).all<AssignmentEvidence>();
    return [...facts.results, ...actions.results, ...deadlines.results];
  }
}

interface AnswerRow {
  readonly answerId: string;
  readonly raw: string;
  readonly scribed: string;
  readonly stepNotes: string;
  readonly createdAt: string;
  readonly assignmentJson: string;
}

function text(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) throw new TypeError("guided_assignment_text_required");
  return value;
}

function argumentsFor(call: ModelFunctionCall, fields: readonly string[]): Record<string, unknown> {
  const args: unknown = JSON.parse(call.arguments);
  if (args === null || typeof args !== "object" || Array.isArray(args)
    || Object.keys(args).length !== fields.length || fields.some((field) => !Object.hasOwn(args, field))) {
    throw new TypeError("guided_assignment_arguments_invalid");
  }
  return args as Record<string, unknown>;
}

function result(call: ModelFunctionCall, data: unknown, receipt: string | null = null): ExecutedTool {
  const receiptId = receipt === null ? null : `receipt:${call.id}`;
  return {
    providerResult: { toolCallId: call.id, name: call.name,
      content: JSON.stringify({ status: "completed", receiptId, receipt, data }) },
    receiptId, receipt, referencedItemIds: [],
  };
}

export class GuidedAssignmentService {
  constructor(private readonly dependencies: {
    readonly database: D1Database;
    readonly ownerPrincipalId: string;
    readonly evidence: AssignmentEvidenceReader;
    readonly telegram?: TelegramProvider;
    readonly now: () => Date;
  }) {}

  private async answers(principalId: string, assignmentId: string): Promise<readonly AnswerRow[]> {
    const rows = await this.dependencies.database.prepare(`SELECT answer_id AS answerId, raw, scribed,
      step_notes AS stepNotes, created_at AS createdAt, assignment_json AS assignmentJson
      FROM guided_assignment_answers WHERE principal_id = ? AND assignment_id = ?
      ORDER BY created_at, answer_id`).bind(principalId, assignmentId).all<AnswerRow>();
    return rows.results;
  }

  async execute(input: Readonly<ModelAdapterStreamInput>, call: ModelFunctionCall): Promise<ExecutedTool> {
    if (input.principalId !== this.dependencies.ownerPrincipalId) throw new Error("guided_assignment_owner_required");
    const { database } = this.dependencies;
    if (call.name === "guided_assignment_read") {
      const args = argumentsFor(call, ["assignmentId"]);
      const catalogue = await this.dependencies.evidence.list(input.principalId);
      if (args.assignmentId === null) {
        const saved = await database.prepare(`SELECT DISTINCT assignment_id AS assignmentId,
          assignment_json AS assignmentJson FROM guided_assignment_answers WHERE principal_id = ?`)
          .bind(input.principalId).all<{ assignmentId: string; assignmentJson: string }>();
        return result(call, { catalogue, saved: saved.results.map((row) => JSON.parse(row.assignmentJson) as AssignmentEvidence) });
      }
      const assignmentId = text(args.assignmentId);
      const answers = await this.answers(input.principalId, assignmentId);
      const assignment = catalogue.find((entry) => entry.assignmentId === assignmentId)
        ?? (answers[0] === undefined ? null : JSON.parse(answers[0].assignmentJson) as AssignmentEvidence);
      return result(call, { assignment, answers });
    }
    if (call.name === "guided_assignment_save") {
      const args = argumentsFor(call, ["assignmentId", "scribed", "stepNotes"]);
      const assignmentId = text(args.assignmentId);
      const scribed = text(args.scribed);
      const stepNotes = text(args.stepNotes);
      const answers = await this.answers(input.principalId, assignmentId);
      const catalogue = await this.dependencies.evidence.list(input.principalId);
      const assignment = catalogue.find((entry) => entry.assignmentId === assignmentId)
        ?? (answers[0] === undefined ? null : JSON.parse(answers[0].assignmentJson) as AssignmentEvidence);
      if (assignment === null) throw new Error("guided_assignment_missing");
      // RETURNING binds the receipt to the write itself. The retry only assigns
      // the same turn id, so it returns the original answer without a second read.
      const saved = await database.prepare(`INSERT INTO guided_assignment_answers
        (principal_id, assignment_id, answer_id, turn_id, assignment_json, raw, scribed, step_notes, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (principal_id, assignment_id, turn_id) DO UPDATE SET turn_id = excluded.turn_id
        RETURNING answer_id AS answerId, raw, scribed, step_notes AS stepNotes`)
        .bind(input.principalId, assignmentId, newUlid(), input.correlationId, JSON.stringify(assignment),
          input.userText, scribed, stepNotes, this.dependencies.now().toISOString()).first();
      return result(call, saved, "Saved your answer, with your raw words, scribed text and step notes.");
    }
    if (call.name === "guided_assignment_draft") {
      const args = argumentsFor(call, ["assignmentId", "answerIds"]);
      const assignmentId = text(args.assignmentId);
      if (!Array.isArray(args.answerIds) || args.answerIds.length === 0
        || new Set(args.answerIds).size !== args.answerIds.length) throw new Error("guided_assignment_answer_ids_invalid");
      const answers = await this.answers(input.principalId, assignmentId);
      const draft = args.answerIds.map((id) => {
        const answer = answers.find((entry) => entry.answerId === text(id));
        if (answer === undefined) throw new Error("guided_assignment_answer_missing");
        return answer.scribed;
      }).join("\n\n");
      // A single message gives one delivery receipt. Never truncate the owner's
      // words or send a partial draft and then report that nothing was sent.
      if (draft.length > 4_096) throw new Error("guided_assignment_draft_too_long");
      const chatId = await new DeviceRepository(database).findOwnerTelegramChat(this.dependencies.ownerPrincipalId);
      if (chatId === null || this.dependencies.telegram === undefined) throw new Error("guided_assignment_delivery_unavailable");
      let sent;
      try {
        sent = await this.dependencies.telegram.sendMessage({ chatId, text: draft,
          idempotencyKey: `guided-assignment:${input.correlationId}:${call.id}` });
      } catch {
        // A lost provider acknowledgement is not proof of non-delivery.
        return { providerResult: { toolCallId: call.id, name: call.name,
          content: JSON.stringify({ status: "delivery_unconfirmed", receiptId: null,
            receipt: "Telegram delivery could not be confirmed. Check your Telegram before asking to send it again." }) },
          receiptId: null, receipt: "Telegram delivery could not be confirmed. Check your Telegram before asking to send it again.",
          referencedItemIds: [] };
      }
      return result(call, { providerMessageId: sent.providerMessageId }, "Sent your scribed draft to your own Telegram.");
    }
    throw new Error("guided_assignment_tool_unknown");
  }
}
