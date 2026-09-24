import { newUlid } from "../../../../packages/contracts/src/index.js";
import { DecisionRepository } from "../decisions/decision-repository.js";
import { DecisionService } from "../decisions/decision-service.js";
import type { DecisionItem } from "../decisions/decision-types.js";
import { decodeCanonicalBase64, encodeBase64Url } from "../sync/signed-request.js";
import { requireText } from "../deadlines/deadline-types.js";
import { type CollectorKey, exact, SCHOOL_PAIR_ORIGIN, SCHOOL_PAIR_TTL_MS } from "./collector-protocol.js";

export class SchoolCollectorPairing {
  constructor(private readonly database: D1Database, private readonly owner: string, private readonly now: () => Date) {}

  async start(body: unknown): Promise<CollectorKey> {
    const input = exact(body, ["publicKeyBase64", "deviceLabel"]);
    decodeCanonicalBase64(input.publicKeyBase64, 32);
    const label = requireText(input.deviceLabel, "school_device_label", 64);
    if (/[\p{C}]/u.test(label)) throw new Error("school_device_label_invalid");
    const now = this.now();
    const collectorId = newUlid(now);
    const challenge = encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));
    const code = Array.from(crypto.getRandomValues(new Uint8Array(4)), (byte) => byte.toString(16).padStart(2, "0")).join("").toUpperCase();
    // A public pairing request cannot choose the owner or fill the queue without bound.
    const result = await this.database.prepare(`INSERT INTO school_collector_keys
      (collector_id, principal_id, public_key_base64, device_label, status, challenge, pairing_code, created_at, expires_at)
      SELECT ?, principal_id, ?, ?, 'pending', ?, ?, ?, ? FROM principals
      WHERE principal_id = ? AND status = 'active' AND principal_type = 'human'
      AND (SELECT COUNT(*) FROM school_collector_keys WHERE created_at > ?) < 4 RETURNING *`)
      .bind(collectorId, input.publicKeyBase64, label, challenge, code, now.toISOString(),
        new Date(now.getTime() + SCHOOL_PAIR_TTL_MS).toISOString(), this.owner,
        new Date(now.getTime() - SCHOOL_PAIR_TTL_MS).toISOString()).first<CollectorKey>();
    if (result === null) throw new Error("school_pairing_unavailable");
    return result;
  }

  async prove(key: CollectorKey, body: unknown): Promise<DecisionItem> {
    const input = exact(body, ["challenge"]);
    const now = this.now();
    if (input.challenge !== key.challenge || key.expires_at <= now.toISOString()) throw new Error("school_challenge_invalid");
    const claimed = await this.database.prepare(`UPDATE school_collector_keys SET proved_at = ?
      WHERE collector_id = ? AND principal_id = ? AND status = 'pending' AND proved_at IS NULL
        AND expires_at > ? RETURNING collector_id`).bind(now.toISOString(), key.collector_id, this.owner, now.toISOString()).first();
    if (claimed === null) throw new Error("school_challenge_consumed");
    const decision = await new DecisionService({ repository: new DecisionRepository(this.database), now: this.now }).raise({
      principalId: this.owner, origin: SCHOOL_PAIR_ORIGIN, originReference: key.collector_id, urgency: "urgent",
      question: `Pair school collector ${JSON.stringify(key.device_label)}? Match code ${key.pairing_code} in your extension. Expires in 10 minutes.`,
      detail: "Tier 3: this key may only send Brightspace evidence. Confirm only if you started pairing and both codes match. It cannot read memory or sync data.",
      expiresAt: key.expires_at, choices: [{ key: "confirm", label: "Confirm this collector" }, { key: "reject", label: "Reject" }],
    });
    await this.database.prepare("UPDATE school_collector_keys SET decision_id = ? WHERE collector_id = ? AND decision_id IS NULL")
      .bind(decision.decisionId, key.collector_id).run();
    return decision;
  }

  /** The immutable decision response is the authority, not the callback's claimed option. */
  async activateFromDecision(decisionId: string, identityId: string): Promise<boolean> {
    const now = this.now().toISOString();
    const activated = await this.database.prepare(`UPDATE school_collector_keys SET status = 'active', activated_at = ?1
      WHERE principal_id = ?2 AND status = 'pending' AND expires_at > ?1 AND proved_at IS NOT NULL AND decision_id = ?3
      AND EXISTS (SELECT 1 FROM decision_items d JOIN decision_responses r ON r.decision_id = d.decision_id
        JOIN channel_identities i ON i.identity_id = r.answered_by_identity_id
        WHERE d.decision_id = ?3 AND d.principal_id = ?2 AND d.origin = ?4 AND d.origin_reference = collector_id
          AND d.status = 'answered' AND r.option_key = 'confirm' AND r.responded_at < expires_at
          AND i.identity_id = ?5 AND i.principal_id = ?2 AND i.channel = 'telegram' AND i.status = 'active' AND i.verified_at IS NOT NULL)
      RETURNING collector_id`).bind(now, this.owner, decisionId, SCHOOL_PAIR_ORIGIN, identityId).first();
    return activated !== null;
  }

  async revoke(collectorId: string): Promise<boolean> {
    const result = await this.database.prepare(`UPDATE school_collector_keys SET status = 'revoked', revoked_at = ?
      WHERE collector_id = ? AND principal_id = ? AND status != 'revoked' RETURNING collector_id`)
      .bind(this.now().toISOString(), collectorId, this.owner).first();
    return result !== null;
  }

  async markDelivered(decisionId: string): Promise<void> {
    await new DecisionService({ repository: new DecisionRepository(this.database), now: this.now }).markDelivered(decisionId);
  }
}
