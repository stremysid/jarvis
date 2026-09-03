import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { DecisionRepository } from "../../src/decisions/decision-repository.js";
import { DecisionService } from "../../src/decisions/decision-service.js";
import {
  DEFAULT_DECISION_RANK,
  EXPLAIN_OPTION_KEY,
  EXPLAIN_OPTION_LABEL,
  FREE_TEXT_OPTION_KEY,
  FREE_TEXT_OPTION_LABEL,
} from "../../src/decisions/decision-types.js";
import { countResponses, createDecisionPrincipal } from "./decision-fixture.js";

const START = "2026-09-01T09:00:00.000Z";

describe("the decision queue", () => {
  let repository: DecisionRepository;
  let service: DecisionService;
  let clock: Date;

  function tick(seconds: number): void {
    clock = new Date(clock.getTime() + seconds * 1_000);
  }

  beforeEach(() => {
    clock = new Date(START);
    repository = new DecisionRepository(env.DB);
    service = new DecisionService({ repository, now: () => clock });
  });

  it("gives a question the two escape options even when the caller supplies none", async () => {
    const owner = await createDecisionPrincipal();

    const item = await service.raise({
      principalId: owner.principalId,
      origin: "jarvis",
      urgency: "normal",
      question: "Should I keep the Tuesday supplier call?",
    });

    expect(item.options).toEqual([
      { optionKey: FREE_TEXT_OPTION_KEY, label: FREE_TEXT_OPTION_LABEL, ordinal: 0, kind: "free_text" },
      { optionKey: EXPLAIN_OPTION_KEY, label: EXPLAIN_OPTION_LABEL, ordinal: 1, kind: "explain" },
    ]);
  });

  it("appends the escape options after the choices the caller did supply", async () => {
    const owner = await createDecisionPrincipal();

    const item = await service.raise({
      principalId: owner.principalId,
      origin: "dev-session",
      urgency: "normal",
      question: "Merge the branch?",
      choices: [{ key: "merge", label: "Merge it" }, { key: "hold", label: "Hold" }],
    });

    expect(item.options).toEqual([
      { optionKey: "merge", label: "Merge it", ordinal: 0, kind: "choice" },
      { optionKey: "hold", label: "Hold", ordinal: 1, kind: "choice" },
      { optionKey: FREE_TEXT_OPTION_KEY, label: FREE_TEXT_OPTION_LABEL, ordinal: 2, kind: "free_text" },
      { optionKey: EXPLAIN_OPTION_KEY, label: EXPLAIN_OPTION_LABEL, ordinal: 3, kind: "explain" },
    ]);
  });

  it.each([FREE_TEXT_OPTION_KEY, EXPLAIN_OPTION_KEY])(
    "refuses a choice keyed %j, which would take an escape's place rather than sit beside it",
    async (key) => {
      const owner = await createDecisionPrincipal();

      await expect(service.raise({
        principalId: owner.principalId,
        origin: "dev-session",
        urgency: "normal",
        question: "Merge the branch?",
        choices: [{ key, label: "Something else" }],
      })).rejects.toThrow("decision_choice_key_reserved");
    },
  );

  it("refuses two choices under the same key, which would leave one of them untappable", async () => {
    const owner = await createDecisionPrincipal();

    await expect(service.raise({
      principalId: owner.principalId,
      origin: "dev-session",
      urgency: "normal",
      question: "Merge the branch?",
      choices: [{ key: "merge", label: "Merge it" }, { key: "merge", label: "Merge it later" }],
    })).rejects.toThrow("decision_choice_key_invalid");
  });

  it.each([["Merge"], ["merge it"], ["merge:it"], ["m".repeat(33)], [""]])(
    "refuses the choice key %j, which could not survive a round trip through callback data",
    async (key) => {
      const owner = await createDecisionPrincipal();

      await expect(service.raise({
        principalId: owner.principalId,
        origin: "dev-session",
        urgency: "normal",
        question: "Merge the branch?",
        choices: [{ key, label: "Merge it" }],
      })).rejects.toThrow("decision_choice_key_invalid");
    },
  );

  it("refuses more choices than the owner could work through on a phone", async () => {
    const owner = await createDecisionPrincipal();
    const choices = Array.from({ length: 9 }, (_unused, index) => ({ key: `k${index}`, label: `Choice ${index}` }));

    await expect(service.raise({
      principalId: owner.principalId,
      origin: "dev-session",
      urgency: "normal",
      question: "Which one?",
      choices,
    })).rejects.toThrow("decision_choices_invalid");
  });

  it("writes every field of the raised item to the row it returns", async () => {
    const owner = await createDecisionPrincipal();

    const item = await service.raise({
      principalId: owner.principalId,
      origin: "dev-session",
      originReference: "session:42",
      urgency: "urgent",
      question: "The migration failed halfway. Roll back?",
      detail: "Three tables were rewritten before it stopped.",
      rank: 5,
      expiresAt: "2026-09-01T10:00:00.000Z",
      choices: [{ key: "rollback", label: "Roll back" }],
    });

    await expect(env.DB.prepare("SELECT * FROM decision_items WHERE decision_id = ?")
      .bind(item.decisionId).first()).resolves.toEqual({
      decision_id: item.decisionId,
      principal_id: owner.principalId,
      origin: "dev-session",
      origin_reference: "session:42",
      urgency: "urgent",
      question: "The migration failed halfway. Roll back?",
      detail: "Three tables were rewritten before it stopped.",
      status: "open",
      rank: 5,
      expires_at: "2026-09-01T10:00:00.000Z",
      created_at: START,
      delivered_at: null,
      resolved_at: null,
    });
    const options = await env.DB.prepare(
      "SELECT option_key, label, ordinal, kind FROM decision_options WHERE decision_id = ? ORDER BY ordinal",
    ).bind(item.decisionId).all();
    expect(options.results).toEqual([
      { option_key: "rollback", label: "Roll back", ordinal: 0, kind: "choice" },
      { option_key: FREE_TEXT_OPTION_KEY, label: FREE_TEXT_OPTION_LABEL, ordinal: 1, kind: "free_text" },
      { option_key: EXPLAIN_OPTION_KEY, label: EXPLAIN_OPTION_LABEL, ordinal: 2, kind: "explain" },
    ]);
  });

  it("ranks an unranked question at the rank the column itself defaults to", async () => {
    const owner = await createDecisionPrincipal();

    const item = await service.raise({
      principalId: owner.principalId,
      origin: "jarvis",
      urgency: "normal",
      question: "Anything to add to the shopping list?",
    });

    // The service writes the rank rather than leaving it to the column, so the
    // two constants have to be compared against each other; a drift would
    // reorder the queue with nothing else to show for it.
    expect(item.rank).toBe(DEFAULT_DECISION_RANK);
    await expect(env.DB.prepare("SELECT dflt_value FROM pragma_table_info('decision_items') WHERE name = 'rank'")
      .first<{ dflt_value: string }>()).resolves.toEqual({ dflt_value: String(DEFAULT_DECISION_RANK) });
  });

  it("puts urgent items ahead of normal ones, then orders by rank, then oldest first", async () => {
    const owner = await createDecisionPrincipal();
    const raise = async (urgency: "urgent" | "normal", rank: number, question: string): Promise<string> => {
      const item = await service.raise({ principalId: owner.principalId, origin: "jarvis", urgency, rank, question });
      tick(60);
      return item.decisionId;
    };

    // Raised in an order that matches none of the three sort keys, so the
    // ordering that comes back cannot be insertion order wearing a disguise.
    const olderNormal = await raise("normal", 50, "Reconcile the August statement?");
    const slackUrgent = await raise("urgent", 50, "The card on file expired. Replace it?");
    const cheapNormal = await raise("normal", 5, "Approve the new supplier price list?");
    const sharpUrgent = await raise("urgent", 10, "A customer is on hold. Take the call?");
    const newerNormal = await raise("normal", 50, "Book the Thursday delivery slot?");

    const queue = await service.queue(owner.principalId);

    expect(queue.map((item) => item.decisionId)).toEqual([
      sharpUrgent, slackUrgent, cheapNormal, olderNormal, newerNormal,
    ]);
  });

  it("drops an item from the queue once its own deadline has passed", async () => {
    const owner = await createDecisionPrincipal();
    const expiring = await service.raise({
      principalId: owner.principalId,
      origin: "deadlines",
      urgency: "normal",
      question: "Confirm the 10am slot?",
      expiresAt: new Date(clock.getTime() + 60_000).toISOString(),
    });
    const standing = await service.raise({
      principalId: owner.principalId,
      origin: "deadlines",
      urgency: "normal",
      question: "Confirm next week's slot?",
    });

    await expect(service.queue(owner.principalId))
      .resolves.toEqual([expect.objectContaining({ decisionId: expiring.decisionId }), expect.objectContaining({ decisionId: standing.decisionId })]);
    tick(61);
    const queue = await service.queue(owner.principalId);

    expect(queue.map((item) => item.decisionId)).toEqual([standing.decisionId]);
  });

  it("carries each item's own options through the queue rather than sharing one set", async () => {
    const owner = await createDecisionPrincipal();
    const first = await service.raise({
      principalId: owner.principalId, origin: "jarvis", urgency: "urgent", question: "Pay the invoice?",
      choices: [{ key: "pay", label: "Pay it" }],
    });
    tick(60);
    const second = await service.raise({
      principalId: owner.principalId, origin: "jarvis", urgency: "normal", question: "Reorder stock?",
      choices: [{ key: "reorder", label: "Reorder" }, { key: "wait", label: "Wait a week" }],
    });

    const queue = await service.queue(owner.principalId);

    expect(queue.map((item) => item.options.map((option) => option.optionKey))).toEqual([
      ["pay", FREE_TEXT_OPTION_KEY, EXPLAIN_OPTION_KEY],
      ["reorder", "wait", FREE_TEXT_OPTION_KEY, EXPLAIN_OPTION_KEY],
    ]);
    expect(queue.map((item) => item.decisionId)).toEqual([first.decisionId, second.decisionId]);
  });

  it("marks an item delivered once, and reports that a second delivery changed nothing", async () => {
    const owner = await createDecisionPrincipal();
    const item = await service.raise({
      principalId: owner.principalId, origin: "jarvis", urgency: "normal", question: "Ready to file?",
    });

    await expect(service.markDelivered(item.decisionId)).resolves.toBe(true);
    const delivered = await repository.readItem(item.decisionId);
    tick(30);
    await expect(service.markDelivered(item.decisionId)).resolves.toBe(false);

    expect(delivered?.status).toBe("delivered");
    expect(delivered?.deliveredAt).toBe(START);
    // The second call must not move the record of when the owner was asked.
    await expect(repository.readItem(item.decisionId)).resolves.toEqual(delivered);
  });

  it("records the answer, resolves the item, and returns what the origin needs to route it back", async () => {
    const owner = await createDecisionPrincipal();
    const item = await service.raise({
      principalId: owner.principalId,
      origin: "dev-session",
      originReference: "session:42",
      urgency: "urgent",
      question: "Deploy the hotfix now?",
      choices: [{ key: "deploy", label: "Deploy" }, { key: "wait", label: "Wait" }],
    });
    await service.markDelivered(item.decisionId);
    tick(45);
    const answeredAt = clock.toISOString();

    const result = await service.answer({
      decisionId: item.decisionId,
      answeredByIdentityId: owner.identityId,
      optionKey: "deploy",
    });

    expect(result).toEqual({
      outcome: "recorded",
      routing: {
        decisionId: item.decisionId,
        origin: "dev-session",
        originReference: "session:42",
        optionKey: "deploy",
        optionKind: "choice",
        freeText: null,
        answeredByIdentityId: owner.identityId,
        respondedAt: answeredAt,
      },
    });
    const resolved = await repository.readItem(item.decisionId);
    expect(resolved?.status).toBe("answered");
    expect(resolved?.resolvedAt).toBe(answeredAt);
    await expect(service.queue(owner.principalId)).resolves.toEqual([]);
    await expect(countResponses(item.decisionId)).resolves.toBe(1);
  });

  it("records what the owner typed alongside the escape they tapped to type it", async () => {
    const owner = await createDecisionPrincipal();
    const item = await service.raise({
      principalId: owner.principalId,
      origin: "jarvis",
      urgency: "normal",
      question: "Which supplier for the October order?",
      choices: [{ key: "usual", label: "The usual one" }],
    });
    await service.markDelivered(item.decisionId);

    const result = await service.answer({
      decisionId: item.decisionId,
      answeredByIdentityId: owner.identityId,
      optionKey: FREE_TEXT_OPTION_KEY,
      freeText: "Split it between both of them",
    });

    expect(result).toEqual({
      outcome: "recorded",
      routing: {
        decisionId: item.decisionId,
        origin: "jarvis",
        originReference: null,
        optionKey: FREE_TEXT_OPTION_KEY,
        optionKind: "free_text",
        freeText: "Split it between both of them",
        answeredByIdentityId: owner.identityId,
        respondedAt: START,
      },
    });
  });

  it("refuses a second answer to a question already answered", async () => {
    const owner = await createDecisionPrincipal();
    const item = await service.raise({
      principalId: owner.principalId,
      origin: "dev-session",
      urgency: "urgent",
      question: "Deploy the hotfix now?",
      choices: [{ key: "deploy", label: "Deploy" }, { key: "wait", label: "Wait" }],
    });
    await service.markDelivered(item.decisionId);
    await service.answer({ decisionId: item.decisionId, answeredByIdentityId: owner.identityId, optionKey: "deploy" });
    tick(2);

    const second = await service.answer({
      decisionId: item.decisionId,
      answeredByIdentityId: owner.identityId,
      optionKey: "wait",
    });

    const stored = await env.DB.prepare("SELECT * FROM decision_responses WHERE decision_id = ?")
      .bind(item.decisionId).first<{ response_id: string; option_key: string; responded_at: string }>();
    expect(second).toEqual({
      outcome: "already_answered",
      standing: {
        responseId: stored?.response_id,
        decisionId: item.decisionId,
        optionKey: "deploy",
        freeText: null,
        answeredByIdentityId: owner.identityId,
        respondedAt: START,
      },
    });
    // The second tap chose differently; the first answer is what stands.
    expect(stored?.option_key).toBe("deploy");
    await expect(countResponses(item.decisionId)).resolves.toBe(1);
  });

  it("refuses an answer from an identity whose principal does not own the item", async () => {
    const owner = await createDecisionPrincipal();
    const stranger = await createDecisionPrincipal();
    const item = await service.raise({
      principalId: owner.principalId,
      origin: "dev-session",
      urgency: "urgent",
      question: "Deploy the hotfix now?",
      choices: [{ key: "deploy", label: "Deploy" }],
    });
    await service.markDelivered(item.decisionId);

    const result = await service.answer({
      decisionId: item.decisionId,
      answeredByIdentityId: stranger.identityId,
      optionKey: "deploy",
    });

    expect(result).toEqual({ outcome: "not_owner" });
    await expect(countResponses(item.decisionId)).resolves.toBe(0);
    await expect(repository.readItem(item.decisionId)).resolves.toEqual(expect.objectContaining({ status: "delivered" }));
  });

  it("refuses an answer from an identity that does not exist at all", async () => {
    const owner = await createDecisionPrincipal();
    const item = await service.raise({
      principalId: owner.principalId, origin: "jarvis", urgency: "normal", question: "Ready to file?",
    });
    await service.markDelivered(item.decisionId);

    const result = await service.answer({
      decisionId: item.decisionId,
      answeredByIdentityId: "identity:never-enrolled",
      optionKey: FREE_TEXT_OPTION_KEY,
      freeText: "yes",
    });

    expect(result).toEqual({ outcome: "not_owner" });
    await expect(countResponses(item.decisionId)).resolves.toBe(0);
  });

  it("tells an identity that does not own the item nothing about the answer already on it", async () => {
    const owner = await createDecisionPrincipal();
    const stranger = await createDecisionPrincipal();
    const item = await service.raise({
      principalId: owner.principalId,
      origin: "dev-session",
      urgency: "urgent",
      question: "Deploy the hotfix now?",
      choices: [{ key: "deploy", label: "Deploy" }],
    });
    await service.markDelivered(item.decisionId);
    await service.answer({ decisionId: item.decisionId, answeredByIdentityId: owner.identityId, optionKey: "deploy" });

    const result = await service.answer({
      decisionId: item.decisionId,
      answeredByIdentityId: stranger.identityId,
      optionKey: "deploy",
    });

    // not_owner rather than already_answered: the standing answer is a fact
    // about the owner's queue, and the refusal must not carry it out.
    expect(result).toEqual({ outcome: "not_owner" });
  });

  it("refuses an answer to a question the owner was never shown, and writes nothing", async () => {
    const owner = await createDecisionPrincipal();
    const item = await service.raise({
      principalId: owner.principalId,
      origin: "jarvis",
      urgency: "normal",
      question: "Ready to file?",
      choices: [{ key: "file", label: "File it" }],
    });

    const result = await service.answer({
      decisionId: item.decisionId,
      answeredByIdentityId: owner.identityId,
      optionKey: "file",
    });

    expect(result).toEqual({ outcome: "not_answerable", status: "open" });
    // The response insert and the status update are one transaction: if the
    // second half is refused, the first must not survive it.
    await expect(countResponses(item.decisionId)).resolves.toBe(0);
    await expect(repository.readItem(item.decisionId)).resolves.toEqual(expect.objectContaining({ status: "open" }));
  });

  it("refuses an option that belongs to a different question", async () => {
    const owner = await createDecisionPrincipal();
    const item = await service.raise({
      principalId: owner.principalId, origin: "jarvis", urgency: "normal", question: "Reorder stock?",
      choices: [{ key: "reorder", label: "Reorder" }],
    });
    const elsewhere = await service.raise({
      principalId: owner.principalId, origin: "jarvis", urgency: "normal", question: "Pay the invoice?",
      choices: [{ key: "pay", label: "Pay it" }],
    });
    await service.markDelivered(item.decisionId);
    await service.markDelivered(elsewhere.decisionId);

    const result = await service.answer({
      decisionId: item.decisionId,
      answeredByIdentityId: owner.identityId,
      optionKey: "pay",
    });

    expect(result).toEqual({ outcome: "unknown_option" });
    await expect(countResponses(item.decisionId)).resolves.toBe(0);
  });

  it("refuses an answer to a decision that does not exist", async () => {
    const owner = await createDecisionPrincipal();

    await expect(service.answer({
      decisionId: "01k4b3c8d9e0f1g2h3j4k5m6n7",
      answeredByIdentityId: owner.identityId,
      optionKey: "deploy",
    })).resolves.toEqual({ outcome: "unknown_decision" });
  });

  it("refuses an answer that was neither tapped nor typed", async () => {
    const owner = await createDecisionPrincipal();
    const item = await service.raise({
      principalId: owner.principalId, origin: "jarvis", urgency: "normal", question: "Ready to file?",
    });

    await expect(service.answer({
      decisionId: item.decisionId,
      answeredByIdentityId: owner.identityId,
      optionKey: null,
      freeText: "",
    })).rejects.toThrow("decision_answer_empty");
  });
});
