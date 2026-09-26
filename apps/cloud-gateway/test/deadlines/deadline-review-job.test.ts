import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runDeadlineReview } from "../../src/deadlines/deadline-review-job.js";
import { DeadlineRepository } from "../../src/deadlines/deadline-repository.js";
import { applyNewestRuntimeMigration } from "../persistence/migration.js";
import { resetDeadlineTables } from "./deadline-fixture.js";
import type {
  ModelAgentCompletion,
  ModelAgentCompletionInput,
  ModelAgentProvider,
} from "../../src/providers/provider-types.js";

const NOW = new Date("2026-09-23T14:00:00.000Z");
const OWNER = "principal:owner";

class ScriptedAgent implements ModelAgentProvider {
  readonly requests: ModelAgentCompletionInput[] = [];
  constructor(private readonly completions: readonly ModelAgentCompletion[]) {}

  async completeAgent(input: ModelAgentCompletionInput): Promise<ModelAgentCompletion> {
    this.requests.push(input);
    return this.completions[this.requests.length - 1] ?? { content: "", toolCalls: [], finishReason: "stop" };
  }
}

function toolCall(name: string, args: Record<string, unknown>, id = "call-1") {
  return { id, name, arguments: JSON.stringify(args) };
}

async function collected(title: string, dueAt: string | null): Promise<string> {
  const repository = new DeadlineRepository(env.DB);
  await repository.ensureSource({ sourceId: "brightspace-ical", kind: "brightspace", label: "Brightspace", now: NOW });
  const created = await repository.upsert({
    sourceId: "brightspace-ical", externalId: `id-${title}`, course: "SPH4U Physics", title, dueAt, now: NOW,
  });
  return created.deadline.deadlineId;
}

function review(provider: ModelAgentProvider, messages: string[]) {
  return runDeadlineReview({
    database: env.DB,
    provider,
    ownerPrincipalId: OWNER,
    ownerZone: "America/Toronto",
    now: NOW,
    delivery: { async send(text: string) { messages.push(text); } },
  });
}

describe("scheduled deadline review", () => {
  beforeAll(async () => { await applyNewestRuntimeMigration(); });

  beforeEach(async () => {
    await resetDeadlineTables();
    await env.DB.prepare("DELETE FROM owner_reminders").run();
    await env.DB.prepare(`INSERT INTO principals (principal_id, principal_type, status, display_name, created_at, updated_at)
      VALUES (?, 'human', 'active', 'Sid', ?, ?) ON CONFLICT(principal_id) DO NOTHING`)
      .bind(OWNER, NOW.toISOString(), NOW.toISOString()).run();
  });

  it("does not call the model when there is nothing to review", async () => {
    const provider = new ScriptedAgent([]);
    const messages: string[] = [];

    const outcome = await review(provider, messages);

    expect(outcome).toMatchObject({ outcome: "nothing_to_review", seen: 0 });
    expect(provider.requests).toHaveLength(0);
    expect(messages).toEqual([]);
  });

  it("shows the model the stored deadlines and lets it schedule its own warning", async () => {
    const deadlineId = await collected("Final Exam", "2026-09-25T18:00:00.000Z");
    const provider = new ScriptedAgent([
      { content: null, finishReason: "tool_calls", toolCalls: [
        toolCall("reminder_schedule", { at: "2026-09-24T22:00:00.000Z", text: "Final Exam tomorrow" }),
      ] },
      { content: "", finishReason: "stop", toolCalls: [] },
    ]);
    const messages: string[] = [];

    const outcome = await review(provider, messages);

    expect(outcome).toMatchObject({ outcome: "reviewed", seen: 1, toolCalls: 1, messaged: false });
    // The model saw the row and the reminder tools; it chose the warning.
    expect(provider.requests[0]?.userText).toContain("Final Exam");
    expect(provider.requests[0]?.tools.map((tool) => tool.name))
      .toEqual(["reminder_schedule", "reminder_list", "reminder_cancel"]);
    const rows = await env.DB.prepare("SELECT * FROM owner_reminders").all<Record<string, unknown>>();
    expect(rows.results).toMatchObject([{ due_at: "2026-09-24T22:00:00.000Z", text: "Final Exam tomorrow", status: "pending", created_turn_id: null }]);
    // Nothing was sent to Sid: the model chose not to write anything.
    expect(messages).toEqual([]);
    void deadlineId;
  });

  it("delivers the model's own question about a deadline with no due date", async () => {
    await collected("Comparative essay", null);
    const provider = new ScriptedAgent([
      { content: "The Comparative essay has no due date. What is it?", finishReason: "stop", toolCalls: [] },
    ]);
    const messages: string[] = [];

    const outcome = await review(provider, messages);

    expect(outcome).toMatchObject({ outcome: "reviewed", seen: 1, messaged: true });
    expect(provider.requests[0]?.userText).toContain("no due date");
    expect(messages).toEqual(["The Comparative essay has no due date. What is it?"]);
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM owner_reminders").first<{ count: number }>())?.count).toBe(0);
  });

  it("reports a provider failure without messaging Sid or failing the digest", async () => {
    await collected("Final Exam", "2026-09-25T18:00:00.000Z");
    const provider: ModelAgentProvider = { async completeAgent() { throw new Error("model_unavailable"); } };
    const messages: string[] = [];

    const outcome = await review(provider, messages);

    expect(outcome).toMatchObject({ outcome: "failed", failure: "model_unavailable" });
    expect(messages).toEqual([]);
  });

  it("refuses a tool the review pass does not offer instead of executing it", async () => {
    await collected("Final Exam", "2026-09-25T18:00:00.000Z");
    const provider = new ScriptedAgent([
      { content: null, finishReason: "tool_calls", toolCalls: [toolCall("deadline_record", { course: "x", title: "y" })] },
      { content: "", finishReason: "stop", toolCalls: [] },
    ]);

    const outcome = await review(provider, []);

    expect(outcome).toMatchObject({ outcome: "reviewed", toolCalls: 0 });
    expect(provider.requests[1]?.toolResults?.[0]?.content).toContain("not available in this pass");
  });
});
