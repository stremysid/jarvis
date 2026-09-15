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
import { EventRepository } from "../../src/persistence/event-repository.js";
import {
  MemoryRepositoryError,
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
      explicitMemoryIntent: true,
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
      rememberInput(turn, "identifier redaction must be deterministic"),
    );

    expect(result.item.lifecycle.transitionId).toBe(transitionId);
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

  it("refuses casual, forwarded, quoted, pasted, attached, model, tool and guest content before command ingress", async () => {
    const turn = await seedTurn("Please remember that my reports should be short.");
    const before = await commandCount();
    const rejectedFlags = [
      { explicitMemoryIntent: false },
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
      ownerTurn: { ...casualTurn.input, explicitMemoryIntent: false },
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
    const forgetTurn = await seedTurn("Please forget the testing preference I just mentioned.");
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

  it("explains deterministic provenance without a command or a mutation", async () => {
    const rememberedTurn = await seedTurn("Remember that my summaries use plain language.");
    const remembered = await new MemoryOwnerControlsService(env.DB).remember(
      rememberInput(rememberedTurn, "my summaries use plain language"),
    );
    const whyTurn = await seedTurn("Why do you remember my summary preference?");
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
    const forgetTurn = await seedTurn("Please forget my report formatting preference.");

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

    const hiddenWhyTurn = await seedTurn("Why is that report preference hidden?");
    const hidden = await service.explain({
      ownerTurn: hiddenWhyTurn.input,
      candidateItemIds: [remembered.item.itemId],
    });
    expect(hidden.text).toBeNull();
    expect(hidden.sources[0]?.excerpt).toBeNull();

    const liftTurn = await seedTurn("Use my report formatting preference again.");
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

  it("rolls back a faulted forget batch and completes it on the exact command replay", async () => {
    const sourceTurn = await seedTurn("Remember that transactional memory updates matter.");
    const remembered = await new MemoryOwnerControlsService(env.DB).remember(
      rememberInput(sourceTurn, "transactional memory updates matter"),
    );
    const forgetTurn = await seedTurn("Forget the transactional memory note.");
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
