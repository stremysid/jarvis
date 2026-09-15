import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  canonicalJson,
  newUlid,
  sha256Hex,
  type Ulid,
} from "../../../../packages/contracts/src/index.js";
import {
  MemoryOwnerControlsService,
  type RememberMemoryInput,
} from "../../src/memory/memory-owner-controls.js";
import {
  createMemoryRepositoryForTest,
  MemoryRepository,
} from "../../src/memory/memory-repository.js";
import { ConversationRepository } from "../../src/conversation/conversation-repository.js";
import { EventRepository } from "../../src/persistence/event-repository.js";
import { Redactor } from "../../src/security/redaction.js";
import {
  MemoryRepositoryError,
  type CanonicalMemoryItem,
  type MemoryControlIntent,
  type MemoryOwnerTurnInput,
  type MemoryRepositoryErrorCode,
} from "../../src/memory/memory-types.js";
import { applyMemoryIngressMigration } from "../persistence/migration.js";

const OWNER_ID = "principal:memory-owner-controls";
let eventClock = Date.now() + 10_000;

interface SeededTurn {
  readonly input: MemoryOwnerTurnInput;
  readonly text: string;
}

async function seedPrincipal(
  principalId: string,
  principalType: "human" | "service",
): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO principals (
    principal_id, principal_type, status, display_name, created_at, updated_at
  ) VALUES (?, ?, 'active', 'memory controls test', ?, ?)`).bind(
    principalId,
    principalType,
    now,
    now,
  ).run();
}

async function seedTurn(
  text: string,
  options: Readonly<{
    principalId?: string;
    channelCode?: 1 | 2;
    memoryIntent?: MemoryControlIntent | null;
  }> = {},
): Promise<SeededTurn> {
  eventClock += 10;
  const principalId = options.principalId ?? OWNER_ID;
  const eventType = "conversation.user_committed";
  const channelCode = options.channelCode ?? 2;
  const eventId = newUlid(new Date(eventClock));
  const occurredAt = new Date(eventClock).toISOString();
  const payload = {
    schemaCode: 1,
    channelCode,
    sensitivityCode: 1,
    historyEligible: true,
    text,
  };
  const contentHash = await sha256Hex(canonicalJson(payload));
  const envelope = {
    schemaVersion: "1.0",
    eventId,
    eventType,
    source: "conversation",
    subjectId: principalId,
    occurredAt,
    receivedAt: occurredAt,
    correlationId: newUlid(new Date(eventClock + 1)),
    contentType: "application/json",
    contentHash,
    payload,
    redaction: { status: "none", markers: [] },
    producerVersion: "conversation-v1",
  };
  await env.DB.prepare(`INSERT INTO events (
    event_id, event_type, source, subject_id, occurred_at, received_at,
    content_hash, envelope_json, created_at
  ) VALUES (?, ?, 'conversation', ?, ?, ?, ?, ?, ?)`).bind(
    eventId,
    eventType,
    principalId,
    occurredAt,
    occurredAt,
    contentHash,
    canonicalJson(envelope),
    occurredAt,
  ).run();
  const row = await env.DB.prepare("SELECT sequence FROM events WHERE event_id = ?")
    .bind(eventId).first<{ sequence: number }>();
  if (row === null) throw new Error("memory_owner_turn_missing");
  return {
    text,
    input: Object.freeze({
      principalId,
      eventId,
      eventSequence: row.sequence,
      occurredAt,
      channel: channelCode === 1 ? "voice" : "telegram",
      memoryIntent: options.memoryIntent === undefined ? "remember" : options.memoryIntent,
      forwarded: false,
      quoted: false,
      pasted: false,
      hasAttachment: false,
      modelGenerated: false,
      toolGenerated: false,
      guest: false,
    }),
  };
}

function rememberInput(turn: SeededTurn, text: string): RememberMemoryInput {
  return Object.freeze({
    ownerTurn: turn.input,
    text,
    kind: "preference",
    sensitivity: "normal",
  });
}

async function commitItemFromTurn(
  turn: SeededTurn,
  text: string,
  options: Readonly<{
    lifecycleState?: "active" | "proposed";
    origin?: "authenticated_first_person" | "model";
  }> = {},
): Promise<CanonicalMemoryItem> {
  const repository = new MemoryRepository(env.DB);
  const topics = await repository.bootstrapTopics(OWNER_ID);
  const lifecycleState = options.lifecycleState ?? "active";
  const origin = options.origin ?? "authenticated_first_person";
  const result = await repository.commitInitialItem({
    principalId: OWNER_ID,
    itemId: newUlid(),
    kind: "preference",
    creationEventId: turn.input.eventId,
    creationEventSequence: turn.input.eventSequence,
    version: {
      versionId: newUlid(),
      text,
      textHash: await sha256Hex(text),
      basis: origin === "model" ? "inferred" : "stated",
      origin,
      uncertain: origin === "model",
      sensitivity: "normal",
      validFrom: null,
      validTo: null,
      extractorVersion: "memory-owner-controls-test-v1",
      extractorModelId: origin === "model" ? "openai:test-model" : null,
    },
    sources: [{
      sourceId: newUlid(),
      eventId: turn.input.eventId,
      eventSequence: turn.input.eventSequence,
      sourceLocation: "live",
      r2SegmentId: null,
      excerpt: text,
      excerptHash: await sha256Hex(text),
      channel: turn.input.channel,
      occurredAt: turn.input.occurredAt,
    }],
    transition: {
      transitionId: newUlid(),
      lifecycleState,
      reason: "test fixture uses a verified source",
      policyVersion: "memory-owner-controls-test-v1",
    },
    placement: {
      placementId: newUlid(),
      placementEventId: newUlid(),
      topicId: topics.inbox.topicId,
      filingSource: "rule",
      confidence: 0.4,
      reason: "test fixture starts in the explicit inbox",
    },
  });
  return result.item;
}

async function expectCode(
  promise: Promise<unknown>,
  code: MemoryRepositoryErrorCode,
): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(MemoryRepositoryError);
    expect((error as MemoryRepositoryError).code).toBe(code);
    expect((error as Error).message).toBe(code);
    return;
  }
  throw new Error(`expected_memory_owner_control_error:${code}`);
}

async function commandCount(): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT count(*) AS count FROM events WHERE event_type = 'memory.owner_command'",
  ).first<{ count: number }>();
  return row?.count ?? -1;
}

beforeAll(async () => {
  await applyMemoryIngressMigration();
  await seedPrincipal(OWNER_ID, "human");
});

describe("MemoryOwnerControlsService", () => {
  it("remembers exact text from the authenticated owner's current turn and replays it exactly", async () => {
    const turn = await seedTurn("Please remember that I prefer concise release notes.");
    const service = new MemoryOwnerControlsService(env.DB);
    const input = rememberInput(turn, "I prefer concise release notes.");

    const first = await service.remember(input);
    await seedTurn("This newer owner turn must not break exact command recovery.");
    const replay = await service.remember(input);

    expect(first.replayed).toBe(false);
    expect(replay.replayed).toBe(true);
    expect(replay.item).toEqual(first.item);
    expect(first.item.lifecycle.actor).toBe("owner");
    expect(first.item.sources).toMatchObject([{
      eventId: turn.input.eventId,
      eventSequence: turn.input.eventSequence,
      excerpt: "I prefer concise release notes.",
      channel: "telegram",
    }]);
    expect(first.item.topicPath.map((entry) => entry.displayName)).toEqual([
      "Memory",
      "Inbox / Needs filing",
    ]);
    expect(first.receipt).toMatch(/^Remembered 1 memory\.[^\n]+ordinary language/u);
    expect(await commandCount()).toBe(1);
    const command = await env.DB.prepare(`SELECT event_id, subject_id,
      json_extract(envelope_json, '$.causationId') AS causation_id,
      json_extract(envelope_json, '$.payload.operation') AS operation,
      json_extract(envelope_json, '$.payload.targetId') AS target_id
      FROM events WHERE event_type = 'memory.owner_command' AND subject_id = ?
      ORDER BY sequence DESC LIMIT 1`).bind(OWNER_ID).first<Record<string, unknown>>();
    expect(command).toMatchObject({
      event_id: first.item.lifecycle.ownerAuthorizingEventId,
      subject_id: OWNER_ID,
      causation_id: turn.input.eventId,
      operation: "item.transition",
      target_id: first.item.lifecycle.transitionId,
    });
  });

  it("suppresses text when a remember replay is no longer the current transition", async () => {
    const turn = await seedTurn("Remember that I prefer dark mode.");
    const service = new MemoryOwnerControlsService(env.DB);
    const input = rememberInput(turn, "I prefer dark mode.");
    const remembered = await service.remember(input);
    const forgetTurn = await seedTurn(
      "Forget my dark mode preference.",
      { memoryIntent: "forget" },
    );
    await service.forget({
      ownerTurn: forgetTurn.input,
      candidateItemIds: [remembered.item.itemId],
    });
    const beforeReplay = await commandCount();

    const replay = await service.remember(input);

    expect(replay).toMatchObject({
      replayed: true,
      item: { lifecycle: { state: "forgotten" }, version: { text: null, textHash: null } },
      receipt: "That remember request was already handled; the memory is currently hidden.",
    });
    expect(replay.item.sources[0]?.excerpt).toBeNull();
    expect(replay.item.sources[0]?.excerptHash).toBeNull();
    expect(JSON.stringify(replay)).not.toContain("I prefer dark mode.");
    expect(await commandCount()).toBe(beforeReplay);
  });

  it("reports a malformed stored owner command as corrupt", async () => {
    const turn = await seedTurn("Remember that I prefer corrupt receipts to be explicit.");
    const input = rememberInput(turn, "I prefer corrupt receipts to be explicit.");
    const events = new EventRepository(env.DB);
    const append = vi.spyOn(events, "append");
    const service = new MemoryOwnerControlsService(env.DB, new MemoryRepository(env.DB), events);
    await service.remember(input);
    const stored = await append.mock.results[0]?.value;
    if (stored === undefined) throw new Error("memory_owner_command_fixture_missing");
    append.mockResolvedValue({
      ...stored,
      envelope: {
        ...stored.envelope,
        payload: { operation: "item.transition", targetId: "not-a-ulid" },
      },
      replayed: true,
    });
    const beforeReplay = await commandCount();

    await expectCode(service.remember(input), "memory_corrupt");

    expect(await commandCount()).toBe(beforeReplay);
  });

  it("preserves a valid command ULID containing a six-digit run", async () => {
    const turn = await seedTurn("Remember that identifier redaction must be deterministic.");
    const transitionId = "01abcde123456fghjkmnpqrstv" as Ulid;
    let issued = false;
    const service = new MemoryOwnerControlsService(
      env.DB,
      new MemoryRepository(env.DB),
      undefined,
      {
        idFactory: (now) => {
          if (!issued) {
            issued = true;
            return transitionId;
          }
          return newUlid(now);
        },
      },
    );

    const result = await service.remember(
      rememberInput(turn, "identifier redaction must be deterministic."),
    );

    expect(result.item.lifecycle.transitionId).toBe(transitionId);
  });

  it.each([
    ["a meaning-flipping negation fragment", "Remember I don't want to move to Boston.", "want to move to Boston"],
    ["a reported-speech fragment", "Remember my brother said Sid failed calculus.", "Sid failed calculus."],
    ["a conditional fragment", "Remember if I get into Waterloo I will move.", "I will move."],
    ["a mid-word fragment", "Remember I prefer teal.", "I prefer tea"],
  ])("refuses %s before recording a command", async (_label, ownerText, requestedText) => {
    const turn = await seedTurn(ownerText);
    const before = await commandCount();

    await expectCode(
      new MemoryOwnerControlsService(env.DB).remember(rememberInput(turn, requestedText)),
      "memory_refused",
    );

    expect(await commandCount()).toBe(before);
    expect(await env.DB.prepare(
      "SELECT count(*) AS count FROM memory_items WHERE creation_event_id = ?",
    ).bind(turn.input.eventId).first()).toEqual({ count: 0 });
  });

  it("refuses memory text over the canonical byte limit before recording a command", async () => {
    const text = `I prefer ${"x".repeat(4_087)}.`;
    const turn = await seedTurn(`Remember that ${text}`);
    const before = await commandCount();

    await expectCode(
      new MemoryOwnerControlsService(env.DB).remember(rememberInput(turn, text)),
      "memory_refused",
    );

    expect(new TextEncoder().encode(text).byteLength).toBe(4_097);
    expect(await commandCount()).toBe(before);
  });

  it("refuses text absent from the owner's turn without recording a command or canonical item", async () => {
    const turn = await seedTurn("Remember that the launch is Tuesday.");
    const before = await commandCount();
    const events = new EventRepository(env.DB);
    const append = vi.spyOn(events, "append");

    await expectCode(
      new MemoryOwnerControlsService(env.DB, new MemoryRepository(env.DB), events)
        .remember(rememberInput(turn, "The launch is Friday.")),
      "memory_refused",
    );

    expect(append).not.toHaveBeenCalled();
    expect(await commandCount()).toBe(before);
    const row = await env.DB.prepare(
      "SELECT count(*) AS count FROM memory_items WHERE creation_event_id = ?",
    ).bind(turn.input.eventId).first<{ count: number }>();
    expect(row?.count).toBe(0);
  });

  it("refuses a superseded owner turn before recording a command", async () => {
    const stale = await seedTurn("Remember that stale turns cannot authorize memory.");
    await seedTurn("This is the owner's newer current turn.");
    const before = await commandCount();

    await expectCode(new MemoryOwnerControlsService(env.DB).remember(
      rememberInput(stale, stale.text),
    ), "memory_refused");

    expect(await commandCount()).toBe(before);
  });

  it("refuses an owner turn whose claimed channel differs from its stored channel", async () => {
    const turn = await seedTurn("Remember that I prefer channel-bound controls.");
    const before = await commandCount();

    await expectCode(new MemoryOwnerControlsService(env.DB).remember({
      ...rememberInput(turn, "I prefer channel-bound controls."),
      ownerTurn: { ...turn.input, channel: "voice" },
    }), "memory_refused");

    expect(await commandCount()).toBe(before);
  });

  it("accepts a current owner request after an assistant delivery", async () => {
    const now = new Date(eventClock);
    const identityId = `identity:memory-controls:${newUlid(now)}`;
    await env.DB.prepare(`INSERT INTO channel_identities (
      identity_id, principal_id, channel, provider_subject, status, verified_at, created_at
    ) VALUES (?, ?, 'telegram', ?, 'active', ?, ?)`).bind(
      identityId,
      OWNER_ID,
      `provider:${newUlid(now)}`,
      now.toISOString(),
      now.toISOString(),
    ).run();
    const conversations = new ConversationRepository(env.DB, new EventRepository(env.DB));
    const earlierText = new Redactor().redactText("An earlier turn awaits delivery.");
    if (!earlierText.ok) throw new Error("memory_assistant_fixture_redaction_failed");
    const earlierTurnId = newUlid(now);
    const admission = await conversations.getOrCreateTurn({
      turnId: earlierTurnId,
      sessionId: `session:memory-controls:${earlierTurnId}`,
      principalId: OWNER_ID,
      channel: "telegram",
      userText: earlierText,
      now,
    });
    const modelClaim = await conversations.claimModelTurn({
      turnId: earlierTurnId,
      requestHash: admission.turn.requestHash,
      now,
    });
    if (modelClaim.kind !== "claimed") throw new Error("memory_assistant_fixture_claim_failed");
    conversations.beginModelStream(modelClaim.capability, earlierTurnId, admission.turn.requestHash);
    const assistantText = new Redactor().redactText("I can remember that.");
    if (!assistantText.ok) throw new Error("memory_assistant_fixture_redaction_failed");
    const staged = await conversations.stageAssistantDelivery({
      claim: modelClaim.capability,
      text: assistantText,
      targetIdentityId: identityId,
      replyToMessageId: null,
      now,
    });
    const turn = await seedTurn("Remember that I prefer controls after the reply.");
    const deliveryClaim = await conversations.claimDelivery({
      deliveryId: staged.delivery.deliveryId,
      now: new Date(eventClock + 1),
    });
    if (deliveryClaim.kind !== "claimed") throw new Error("memory_assistant_fixture_lease_failed");
    conversations.beginDelivery(
      deliveryClaim.capability,
      staged.delivery.deliveryId,
      staged.delivery.materialHash,
    );
    const receipt = conversations.mintProviderDeliveryReceipt({
      capability: deliveryClaim.capability,
      providerMessageId: `provider-message:${newUlid()}`,
    });
    await conversations.recordDeliverySuccess({
      capability: deliveryClaim.capability,
      receipt,
      now: new Date(eventClock + 1),
    });

    const result = await new MemoryOwnerControlsService(env.DB).remember(
      rememberInput(turn, "I prefer controls after the reply."),
    );

    expect(result.item.lifecycle.state).toBe("active");
  });

  it("refuses casual, forwarded, quoted, pasted, attached, model, tool and guest content before command ingress", async () => {
    const turn = await seedTurn("Please remember that my reports should be short.");
    const before = await commandCount();
    const rejectedFlags = [
      { memoryIntent: null },
      { forwarded: true },
      { quoted: true },
      { pasted: true },
      { hasAttachment: true },
      { modelGenerated: true },
      { toolGenerated: true },
      { guest: true },
    ] as const;

    for (const flags of rejectedFlags) {
      await expectCode(new MemoryOwnerControlsService(env.DB).remember({
        ...rememberInput(turn, "my reports should be short"),
        ownerTurn: { ...turn.input, ...flags },
      }), "memory_refused");
    }

    expect(await commandCount()).toBe(before);
  });

  it("treats a casual forget-that turn as conversation rather than a memory control", async () => {
    const sourceTurn = await seedTurn("Remember that I prefer short status updates.");
    const service = new MemoryOwnerControlsService(env.DB);
    const remembered = await service.remember(
      rememberInput(sourceTurn, "I prefer short status updates."),
    );
    const casualTurn = await seedTurn("Forget that, let us discuss something else.");
    const before = await commandCount();

    await expectCode(service.forget({
      ownerTurn: { ...casualTurn.input, memoryIntent: null },
      candidateItemIds: [remembered.item.itemId],
    }), "memory_refused");

    expect(await commandCount()).toBe(before);
    expect((await new MemoryRepository(env.DB).readCurrentItem(
      OWNER_ID,
      remembered.item.itemId,
    )).lifecycle.state).toBe("active");
  });

  it("refuses an operation that does not match the trusted per-operation intent", async () => {
    const sourceTurn = await seedTurn("Remember that I prefer operation-bound controls.");
    const remembered = await new MemoryOwnerControlsService(env.DB).remember(
      rememberInput(sourceTurn, "I prefer operation-bound controls."),
    );
    const mismatched = await seedTurn("Forget the operation-bound preference.");
    const before = await commandCount();

    await expectCode(new MemoryOwnerControlsService(env.DB).forget({
      ownerTurn: mismatched.input,
      candidateItemIds: [remembered.item.itemId],
    }), "memory_refused");

    expect(await commandCount()).toBe(before);
  });

  it("refuses a second different mutation authorized by one owner event", async () => {
    const turn = await seedTurn("Remember that I prefer one mutation per turn.");
    const service = new MemoryOwnerControlsService(env.DB);
    const remembered = await service.remember(
      rememberInput(turn, "I prefer one mutation per turn."),
    );
    const before = await commandCount();

    await expectCode(service.forget({
      ownerTurn: { ...turn.input, memoryIntent: "forget" },
      candidateItemIds: [remembered.item.itemId],
    }), "memory_refused");

    expect(await commandCount()).toBe(before);
    expect((await new MemoryRepository(env.DB).readCurrentItem(
      OWNER_ID,
      remembered.item.itemId,
    )).lifecycle.state).toBe("active");
  });

  it("refuses model-marked turns and non-owner principals before command ingress", async () => {
    const modelTurn = await seedTurn("Remember this generated answer.");
    const guestId = `principal:memory-guest:${newUlid()}`;
    await seedPrincipal(guestId, "service");
    const guest = await seedTurn("Remember this guest claim.", { principalId: guestId });
    const before = await commandCount();

    await expectCode(new MemoryOwnerControlsService(env.DB).remember({
      ...rememberInput(modelTurn, modelTurn.text),
      ownerTurn: { ...modelTurn.input, modelGenerated: true },
    }), "memory_refused");
    await expectCode(new MemoryOwnerControlsService(env.DB).remember(
      rememberInput(guest, guest.text),
    ), "memory_refused");

    expect(await commandCount()).toBe(before);
  });

  it("refuses an ambiguous target before recording a command or changing memory", async () => {
    const rememberedTurn = await seedTurn("Remember that I prefer deterministic tests.");
    const remembered = await new MemoryOwnerControlsService(env.DB).remember(
      rememberInput(rememberedTurn, "I prefer deterministic tests."),
    );
    const forgetTurn = await seedTurn(
      "Please forget the testing preference I just mentioned.",
      { memoryIntent: "forget" },
    );
    const before = await commandCount();

    await expectCode(new MemoryOwnerControlsService(env.DB).forget({
      ownerTurn: forgetTurn.input,
      candidateItemIds: [remembered.item.itemId, newUlid()],
    }), "memory_ambiguous");

    expect(await commandCount()).toBe(before);
    const current = await new MemoryRepository(env.DB).readCurrentItem(
      OWNER_ID,
      remembered.item.itemId,
    );
    expect(current.lifecycle.state).toBe("active");
  });

  it("refuses to lift a memory that is not forgotten before recording a command", async () => {
    const sourceTurn = await seedTurn("Remember that I prefer explicit restore state.");
    const service = new MemoryOwnerControlsService(env.DB);
    const remembered = await service.remember(
      rememberInput(sourceTurn, "I prefer explicit restore state."),
    );
    const liftTurn = await seedTurn(
      "Restore that preference.",
      { memoryIntent: "lift" },
    );
    const before = await commandCount();

    await expectCode(service.lift({
      ownerTurn: liftTurn.input,
      candidateItemIds: [remembered.item.itemId],
    }), "memory_refused");

    expect(await commandCount()).toBe(before);
  });

  it("atomically accepts at most one concurrent mutation for one owner event", async () => {
    const existingTurn = await seedTurn("Remember that I prefer existing controls.");
    const service = new MemoryOwnerControlsService(env.DB);
    const existing = await service.remember(
      rememberInput(existingTurn, "I prefer existing controls."),
    );
    const sharedTurn = await seedTurn("Remember that I prefer raced controls.");
    const before = await commandCount();

    const attempts = await Promise.allSettled([
      service.remember(rememberInput(sharedTurn, "I prefer raced controls.")),
      service.forget({
        ownerTurn: { ...sharedTurn.input, memoryIntent: "forget" },
        candidateItemIds: [existing.item.itemId],
      }),
    ]);

    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);
    const rejected = attempts.find((attempt) => attempt.status === "rejected");
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: { code: "memory_refused" },
    });
    expect(await commandCount()).toBe(before + 1);
  });

  it("explains deterministic provenance without a command or a mutation", async () => {
    const rememberedTurn = await seedTurn("Remember that my summaries use plain language.");
    const remembered = await new MemoryOwnerControlsService(env.DB).remember(
      rememberInput(rememberedTurn, "my summaries use plain language"),
    );
    const whyTurn = await seedTurn(
      "Why do you remember my summary preference?",
      { memoryIntent: "explain" },
    );
    const before = await commandCount();

    const explanation = await new MemoryOwnerControlsService(env.DB).explain({
      ownerTurn: whyTurn.input,
      candidateItemIds: [remembered.item.itemId],
    });

    expect(explanation).toMatchObject({
      itemId: remembered.item.itemId,
      state: "active",
      uncertain: false,
      topicPath: ["Memory", "Inbox / Needs filing"],
      text: "my summaries use plain language",
      sources: [{
        eventId: rememberedTurn.input.eventId,
        occurredAt: rememberedTurn.input.occurredAt,
        channel: "telegram",
        excerpt: "my summaries use plain language",
      }],
    });
    expect(explanation.receipt).toBe("Explained 1 memory from verified evidence; nothing changed.");
    expect(await commandCount()).toBe(before);
    expect((await new MemoryRepository(env.DB).readCurrentItem(
      OWNER_ID,
      remembered.item.itemId,
    )).lifecycle.transitionId).toBe(remembered.item.lifecycle.transitionId);
  });

  it("forgets and restores one memory with exact suppression counts while retaining raw evidence", async () => {
    const sourceTurn = await seedTurn("Remember that I prefer reports without tables.");
    const service = new MemoryOwnerControlsService(env.DB);
    const remembered = await service.remember(
      rememberInput(sourceTurn, "I prefer reports without tables."),
    );
    const forgetTurn = await seedTurn(
      "Please forget my report formatting preference.",
      { memoryIntent: "forget" },
    );

    const forgotten = await service.forget({
      ownerTurn: forgetTurn.input,
      candidateItemIds: [remembered.item.itemId],
    });
    const forgetReplay = await service.forget({
      ownerTurn: forgetTurn.input,
      candidateItemIds: [remembered.item.itemId],
    });

    expect(forgotten).toMatchObject({
      newlyHiddenTurnCount: 1,
      totalCoveredTurnCount: 1,
      replayed: false,
      itemId: remembered.item.itemId,
      state: "forgotten",
    });
    expect(JSON.stringify(forgotten)).not.toContain("reports without tables");
    expect(forgetReplay.replayed).toBe(true);
    expect(forgotten.receipt).not.toContain("reports without tables");
    const visible = await env.DB.prepare(
      "SELECT count(*) AS count FROM memory_visible_recent_events WHERE event_id = ?",
    ).bind(sourceTurn.input.eventId).first<{ count: number }>();
    const retrievable = await env.DB.prepare(
      "SELECT count(*) AS count FROM memory_retrievable_item_versions WHERE item_id = ?",
    ).bind(remembered.item.itemId).first<{ count: number }>();
    const raw = await env.DB.prepare(
      "SELECT count(*) AS count FROM events WHERE event_id = ?",
    ).bind(sourceTurn.input.eventId).first<{ count: number }>();
    expect([visible?.count, retrievable?.count, raw?.count]).toEqual([0, 0, 1]);

    const hiddenWhyTurn = await seedTurn(
      "Why is that report preference hidden?",
      { memoryIntent: "explain" },
    );
    const hidden = await service.explain({
      ownerTurn: hiddenWhyTurn.input,
      candidateItemIds: [remembered.item.itemId],
    });
    expect(hidden.text).toBeNull();
    expect(hidden.topicPath).toEqual([]);
    expect(hidden.sources[0]?.excerpt).toBeNull();

    const liftTurn = await seedTurn(
      "Use my report formatting preference again.",
      { memoryIntent: "lift" },
    );
    const restored = await service.lift({
      ownerTurn: liftTurn.input,
      candidateItemIds: [remembered.item.itemId],
    });
    const liftReplay = await service.lift({
      ownerTurn: liftTurn.input,
      candidateItemIds: [remembered.item.itemId],
    });
    expect(restored).toMatchObject({
      liftedSuppressionCount: 1,
      replayed: false,
      item: { lifecycle: { state: "active", actor: "owner" } },
    });
    expect(restored.item.version.versionNumber).toBe(2);
    expect(liftReplay.replayed).toBe(true);
    const restoredViews = await Promise.all([
      env.DB.prepare("SELECT count(*) AS count FROM memory_visible_recent_events WHERE event_id = ?")
        .bind(sourceTurn.input.eventId).first<{ count: number }>(),
      env.DB.prepare("SELECT count(*) AS count FROM memory_retrievable_item_versions WHERE item_id = ?")
        .bind(remembered.item.itemId).first<{ count: number }>(),
      env.DB.prepare(`SELECT count(*) AS count FROM memory_event_suppressions suppression
        JOIN memory_event_suppression_lifts lift
          ON lift.principal_id = suppression.principal_id
          AND lift.suppression_id = suppression.suppression_id
        WHERE suppression.principal_id = ? AND suppression.target_event_id = ?`)
        .bind(OWNER_ID, sourceTurn.input.eventId).first<{ count: number }>(),
    ]);
    expect(restoredViews.map((row) => row?.count)).toEqual([1, 1, 1]);
  });

  it("reports sibling memories hidden by a forget and a restore that remains suppressed", async () => {
    const sourceTurn = await seedTurn("I prefer dark mode. I prefer compact menus.");
    const service = new MemoryOwnerControlsService(env.DB);
    const first = await service.remember(rememberInput(sourceTurn, "I prefer dark mode."));
    const sibling = await commitItemFromTurn(sourceTurn, "I prefer compact menus.");
    const forgetFirstTurn = await seedTurn(
      "Forget my dark mode preference.",
      { memoryIntent: "forget" },
    );

    const forgotFirst = await service.forget({
      ownerTurn: forgetFirstTurn.input,
      candidateItemIds: [first.item.itemId],
    });

    expect(forgotFirst.hiddenSiblingItemCount).toBe(1);
    expect(forgotFirst.receipt).toContain("also hid 1 other active memory");
    const explainSiblingTurn = await seedTurn(
      "Why do you remember my compact menu preference?",
      { memoryIntent: "explain" },
    );
    const siblingExplanation = await service.explain({
      ownerTurn: explainSiblingTurn.input,
      candidateItemIds: [sibling.itemId],
    });
    expect(siblingExplanation).toMatchObject({
      state: "active",
      text: "I prefer compact menus.",
      sources: [{ excerpt: null }],
      receipt: "Explained 1 memory; hidden source excerpts were not revealed; nothing changed.",
    });

    const forgetSiblingTurn = await seedTurn(
      "Forget my compact menu preference.",
      { memoryIntent: "forget" },
    );
    await service.forget({
      ownerTurn: forgetSiblingTurn.input,
      candidateItemIds: [sibling.itemId],
    });
    const liftFirstTurn = await seedTurn(
      "Restore my dark mode preference.",
      { memoryIntent: "lift" },
    );
    const restored = await service.lift({
      ownerTurn: liftFirstTurn.input,
      candidateItemIds: [first.item.itemId],
    });

    expect(restored.retrievable).toBe(false);
    expect(restored.receipt).toContain("still hidden because another forgotten memory");
    expect(await env.DB.prepare(
      "SELECT count(*) AS count FROM memory_retrievable_item_versions WHERE item_id = ?",
    ).bind(first.item.itemId).first()).toEqual({ count: 0 });
  });

  it("restores a forgotten proposed model memory to proposed rather than promoting it", async () => {
    const sourceTurn = await seedTurn("I might prefer violet layouts.");
    const proposed = await commitItemFromTurn(sourceTurn, sourceTurn.text, {
      lifecycleState: "proposed",
      origin: "model",
    });
    const service = new MemoryOwnerControlsService(env.DB);
    const forgetTurn = await seedTurn(
      "Forget the proposed violet layout preference.",
      { memoryIntent: "forget" },
    );
    await service.forget({
      ownerTurn: forgetTurn.input,
      candidateItemIds: [proposed.itemId],
    });
    const liftTurn = await seedTurn(
      "Restore the proposed violet layout preference.",
      { memoryIntent: "lift" },
    );

    const restored = await service.lift({
      ownerTurn: liftTurn.input,
      candidateItemIds: [proposed.itemId],
    });

    expect(restored).toMatchObject({
      retrievable: false,
      item: { lifecycle: { state: "proposed" }, version: { origin: "model" } },
    });
    expect(restored.receipt).toContain("Restored 1 memory to proposed");
  });

  it("rolls back a faulted forget batch and completes it on the exact command replay", async () => {
    const sourceTurn = await seedTurn("Remember that transactional memory updates matter.");
    const remembered = await new MemoryOwnerControlsService(env.DB).remember(
      rememberInput(sourceTurn, "transactional memory updates matter."),
    );
    const forgetTurn = await seedTurn(
      "Forget the transactional memory note.",
      { memoryIntent: "forget" },
    );
    const faultingMemory = createMemoryRepositoryForTest(env.DB, {
      batchFault: (operation) => operation === "forget"
        ? env.DB.prepare("INSERT INTO memory_owner_controls_missing_fault_target(value) VALUES (1)")
        : null,
    });

    await expectCode(new MemoryOwnerControlsService(env.DB, faultingMemory).forget({
      ownerTurn: forgetTurn.input,
      candidateItemIds: [remembered.item.itemId],
    }), "memory_unavailable");

    const afterFault = await new MemoryRepository(env.DB).readCurrentItem(
      OWNER_ID,
      remembered.item.itemId,
    );
    const suppressionCount = await env.DB.prepare(`SELECT count(*) AS count
      FROM memory_event_suppressions WHERE principal_id = ? AND target_event_id = ?`)
      .bind(OWNER_ID, sourceTurn.input.eventId).first<{ count: number }>();
    expect(afterFault.lifecycle.state).toBe("active");
    expect(suppressionCount?.count).toBe(0);

    await seedTurn("This newer turn must not strand an already accepted forget command.");
    const recovered = await new MemoryOwnerControlsService(env.DB).forget({
      ownerTurn: forgetTurn.input,
      candidateItemIds: [remembered.item.itemId],
    });
    expect(recovered).toMatchObject({ replayed: true, newlyHiddenTurnCount: 1 });
  });
});
