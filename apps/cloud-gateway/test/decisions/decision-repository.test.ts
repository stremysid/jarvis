import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { newUlid } from "../../../../packages/contracts/src/index.js";
import { DecisionRepository } from "../../src/decisions/decision-repository.js";
import type { DecisionOption } from "../../src/decisions/decision-types.js";
import { createDecisionPrincipal } from "./decision-fixture.js";

const NOW = "2026-09-01T09:00:00.000Z";

const escapes: readonly DecisionOption[] = [
  { optionKey: "other", label: "Other — I'll type it", ordinal: 0, kind: "free_text" },
  { optionKey: "explain", label: "Explain more", ordinal: 1, kind: "explain" },
];

describe("the decision repository", () => {
  let repository: DecisionRepository;

  beforeEach(() => {
    repository = new DecisionRepository(env.DB);
  });

  it("writes an item and its options together, or writes neither", async () => {
    const owner = await createDecisionPrincipal();
    const decisionId = newUlid();

    // Two options claiming the same ordinal: the unique index refuses the
    // second insert, which is the only way to make the second half of this
    // transaction fail without reaching past the repository to arrange it.
    await expect(repository.raise({
      decisionId,
      principalId: owner.principalId,
      origin: "jarvis",
      originReference: null,
      urgency: "normal",
      question: "Does the item survive its own options failing?",
      detail: null,
      rank: 100,
      expiresAt: null,
      createdAt: NOW,
      options: [
        { optionKey: "other", label: "Other — I'll type it", ordinal: 0, kind: "free_text" },
        { optionKey: "explain", label: "Explain more", ordinal: 0, kind: "explain" },
      ],
    })).rejects.toThrow();

    // An item without options is unanswerable, and decision_items refuses
    // DELETE, so a half-written raise would be a question stuck at the top of
    // the queue with nothing that could clear it.
    await expect(env.DB.prepare("SELECT COUNT(*) AS count FROM decision_items WHERE decision_id = ?")
      .bind(decisionId).first<{ count: number }>()).resolves.toEqual({ count: 0 });
    await expect(env.DB.prepare("SELECT COUNT(*) AS count FROM decision_options WHERE decision_id = ?")
      .bind(decisionId).first<{ count: number }>()).resolves.toEqual({ count: 0 });
    await expect(repository.readItem(decisionId)).resolves.toBeNull();
  });

  it("reads back nothing for a decision id that was never raised", async () => {
    await expect(repository.readItem(newUlid())).resolves.toBeNull();
  });

  it("keeps one principal's queue out of another's", async () => {
    const owner = await createDecisionPrincipal();
    const other = await createDecisionPrincipal();
    const mine = newUlid();
    await repository.raise({
      decisionId: mine,
      principalId: owner.principalId,
      origin: "jarvis",
      originReference: null,
      urgency: "normal",
      question: "Mine to answer?",
      detail: null,
      rank: 100,
      expiresAt: null,
      createdAt: NOW,
      options: escapes,
    });
    await repository.raise({
      decisionId: newUlid(),
      principalId: other.principalId,
      origin: "jarvis",
      originReference: null,
      urgency: "urgent",
      question: "Somebody else's to answer?",
      detail: null,
      rank: 1,
      expiresAt: null,
      createdAt: NOW,
      options: escapes,
    });

    const queue = await repository.listOpenQueue({ principalId: owner.principalId, now: NOW });

    expect(queue.map((item) => item.decisionId)).toEqual([mine]);
  });

  it("hides an item whose options never landed, since it cannot be answered", async () => {
    const owner = await createDecisionPrincipal();
    const decisionId = newUlid();
    // Written past the repository on purpose: this is the state the raise
    // transaction exists to prevent, and the queue must not surface it even
    // if some other writer produces it.
    await env.DB.prepare(
      `INSERT INTO decision_items (
         decision_id, principal_id, origin, origin_reference, urgency, question, detail,
         status, rank, expires_at, created_at, delivered_at, resolved_at
       ) VALUES (?, ?, 'jarvis', NULL, 'urgent', 'Unanswerable?', NULL, 'open', 0, NULL, ?, NULL, NULL)`,
    ).bind(decisionId, owner.principalId, NOW).run();

    await expect(repository.listOpenQueue({ principalId: owner.principalId, now: NOW })).resolves.toEqual([]);
    await expect(repository.readItem(decisionId)).resolves.toBeNull();
  });
});
