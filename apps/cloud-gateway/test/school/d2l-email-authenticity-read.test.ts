import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { newUlid, sha256Hex } from "../../../../packages/contracts/src/index.js";
import { D2lEmailRepository } from "../../src/school/d2l-email-repository.js";
import { applyD2lNotificationEmailMigration } from "../persistence/migration.js";

/**
 * The digest's one question about mail: what did the message that produced
 * this deadline prove?
 *
 * The answer is read here rather than stored on `deadlines`, because a
 * deadline is a deadline whatever reported it and the deadline store
 * deliberately knows nothing about provenance. That makes this lookup the only
 * thing standing between a scraped date and an unlabelled one.
 */

const NOW = new Date("2026-09-17T23:45:00.000Z");

async function principal(suffix: string): Promise<string> {
  const principalId = `principal:mail-authenticity-${suffix}`;
  await env.DB.prepare(`INSERT OR IGNORE INTO principals (
    principal_id, principal_type, status, display_name, created_at, updated_at
  ) VALUES (?, 'human', 'active', ?, ?, ?)`).bind(
    principalId, `Authenticity ${suffix} owner`, NOW.toISOString(), NOW.toISOString(),
  ).run();
  return principalId;
}

async function receipt(
  principalId: string,
  suffix: string,
  authenticity: "verified" | "unverified",
  eventKind: string,
  structured: Readonly<Record<string, unknown>>,
): Promise<void> {
  const repository = new D2lEmailRepository(env.DB);
  const begun = await repository.begin({
    principalId,
    ingestionKey: `message-id-sha256:${suffix}`,
    rawSha256: await sha256Hex(suffix),
    providerMessageId: `<${suffix}@example.test>`,
    headerNames: [],
    authentication: {},
    envelopeFromDomain: "notifications.example",
    fromDomain: "notifications.example",
    authenticity,
    eventKind: eventKind as never,
    structured,
    rawMimeBase64: "",
    now: NOW,
  });
  await repository.complete(principalId, begun.receipt.emailId, {
    status: authenticity === "verified" ? "ingested" : "quarantined",
    ...(authenticity === "verified" ? {} : { reason: "authentication_unproven" }),
  } as never, NOW);
}

beforeAll(async () => {
  await applyD2lNotificationEmailMigration();
});

describe("reading the provenance of a deadline's mail", () => {
  it("answers unverified for a deadline whose only receipt was unproven", async () => {
    const principalId = await principal("unverified-only");
    await receipt(principalId, "unverified-only", "unverified", "assignment_due", {
      kind: "assignment_due", externalId: "d2l:only-unverified",
    });
    const authenticity = await new D2lEmailRepository(env.DB)
      .readAuthenticityBySourceExternalId(principalId, ["d2l:only-unverified"]);
    expect(authenticity.get("d2l:only-unverified")).toBe("unverified");
  });

  it("answers verified when any receipt naming the deadline was proven", async () => {
    const principalId = await principal("both");
    // An unproven copy arrives first, then the proven one. One proven delivery
    // is positive evidence about the assignment even though a later unproven
    // one repeated it, so the pair must not resolve to the weaker of the two.
    await receipt(principalId, "both-unverified", "unverified", "assignment_due", {
      kind: "assignment_due", externalId: "d2l:both",
    });
    await receipt(principalId, "both-verified", "verified", "assignment_updated", {
      kind: "assignment_updated", externalId: "d2l:both",
    });
    const authenticity = await new D2lEmailRepository(env.DB)
      .readAuthenticityBySourceExternalId(principalId, ["d2l:both"]);
    expect(authenticity.get("d2l:both")).toBe("verified");
  });

  it("says nothing about a deadline no message produced", async () => {
    const principalId = await principal("none");
    const authenticity = await new D2lEmailRepository(env.DB)
      .readAuthenticityBySourceExternalId(principalId, ["d2l:seeded-by-hand"]);
    // Absent rather than "verified". A deadline with no email provenance has
    // none to report, and a default would be a claim about a message that does
    // not exist.
    expect(authenticity.has("d2l:seeded-by-hand")).toBe(false);
  });

  it("reads only the owner's own receipts", async () => {
    const mine = await principal("mine");
    const theirs = await principal("theirs");
    await receipt(theirs, "theirs", "verified", "assignment_due", {
      kind: "assignment_due", externalId: "d2l:shared-external-id",
    });
    const authenticity = await new D2lEmailRepository(env.DB)
      .readAuthenticityBySourceExternalId(mine, ["d2l:shared-external-id"]);
    expect(authenticity.size).toBe(0);
  });

  it("does not answer for an event kind that never names a deadline", async () => {
    const principalId = await principal("other-kind");
    await receipt(principalId, "grade", "verified", "grade_released", {
      kind: "grade_released", externalId: "d2l:grade-only", course: "Calculus", title: "Limits quiz",
      assignedGrade: 18, maxPoints: 20,
    });
    const authenticity = await new D2lEmailRepository(env.DB)
      .readAuthenticityBySourceExternalId(principalId, ["d2l:grade-only"]);
    expect(authenticity.size).toBe(0);
  });

  it("returns nothing for an empty question without touching the database", async () => {
    const authenticity = await new D2lEmailRepository(env.DB)
      .readAuthenticityBySourceExternalId(await principal("empty"), []);
    expect(authenticity.size).toBe(0);
  });
});

describe("receipts the raw-body bound must not retire", () => {
  it("never retires the body of a message a grade was read out of", async () => {
    const principalId = await principal("grade-body");
    const repository = new D2lEmailRepository(env.DB);
    const staleAt = new Date(NOW.getTime() - 400 * 24 * 60 * 60 * 1_000);
    const emailId = newUlid();
    await env.DB.prepare(`INSERT INTO d2l_email_messages (
      principal_id, email_id, ingestion_key, raw_sha256, provider_message_id,
      header_names_json, authentication_json, envelope_from_domain, from_domain,
      authenticity, event_kind, status, quarantine_reason, structured_json, raw_mime_base64,
      received_at, processed_at, verification_notified_at
    ) VALUES (?, ?, ?, ?, ?, '[]', '{}', NULL, NULL,
      'verified', 'grade_released', 'pending', NULL, ?, 'Ynl0ZXM=', ?, NULL, NULL)`)
      .bind(
        principalId, emailId, "message-id-sha256:grade-body", await sha256Hex("grade-body"),
        "<grade-body@example.test>", JSON.stringify({ kind: "grade_released", externalId: "d2l:graded" }),
        staleAt.toISOString(),
      ).run();
    // Left pending on purpose: the grade insert guard binds an observation to
    // a receipt that is still being written, so completing the receipt first
    // would make the grade unrepresentable.
    await env.DB.prepare(`INSERT INTO d2l_email_grade_observations (
      principal_id, observation_id, email_id, deadline_id, external_id, course, title,
      assigned_grade, max_points, content_hash, observed_at
    ) VALUES (?, ?, ?, NULL, 'd2l:graded', 'Calculus', 'Limits quiz', 18, 20, ?, ?)`)
      .bind(principalId, newUlid(), emailId, await sha256Hex("graded"), staleAt.toISOString()).run();
    await repository.complete(principalId, emailId, { status: "ingested" }, staleAt);
    const current = await repository.begin({
      principalId,
      ingestionKey: "message-id-sha256:current-after-grade",
      rawSha256: "c".repeat(64),
      providerMessageId: "<current-after-grade@example.test>",
      headerNames: [],
      authentication: {},
      envelopeFromDomain: null,
      fromDomain: null,
      authenticity: "verified",
      eventKind: "announcement",
      structured: {},
      rawMimeBase64: btoa("current"),
      now: NOW,
    });
    await repository.complete(principalId, current.receipt.emailId, { status: "ingested" }, NOW);
    await repository.pruneRetainedRaw(principalId, current.receipt.emailId, NOW);
    // The grade row's foreign key is RESTRICT and the body is the message the
    // grade was read out of, so retiring it would either fail or force the
    // grade to be deleted. Age does not change that.
    expect((await repository.read(principalId, emailId))?.rawMimeBase64).toBe("Ynl0ZXM=");
  });
});
