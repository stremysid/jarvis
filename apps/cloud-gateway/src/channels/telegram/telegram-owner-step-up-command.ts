import { newUlid } from "../../../../../packages/contracts/src/index.js";
import type { AcceptedTelegramUpdate } from "./telegram-webhook.js";

export type OwnerStepUpDisableOutcome = "disabled" | "already_disabled" | "unconfigured" | "private_chat_required";

function stateChanged(error: unknown): boolean {
  return error instanceof Error && (
    /^(?:D1_ERROR: )?owner_passphrase_disable_state_changed(?::|$)/u.test(error.message)
    || error.message.startsWith("D1_ERROR: UNIQUE constraint failed: owner_passphrase_disable_commits")
  );
}

/** Commits only the exact accepted Telegram event protected by migration 0017. */
export class D1TelegramOwnerStepUpCommands {
  readonly #input: Readonly<{
    database: D1Database;
    ownerPrincipalId: string;
    ownerVoiceIdentityId: string;
    now?: () => Date;
    newCommitId?: () => string;
  }>;

  constructor(input: Readonly<{
    database: D1Database;
    ownerPrincipalId: string;
    ownerVoiceIdentityId: string;
    now?: () => Date;
    newCommitId?: () => string;
  }>) {
    this.#input = Object.freeze({ ...input });
  }

  async disable(accepted: AcceptedTelegramUpdate): Promise<OwnerStepUpDisableOutcome> {
    if (accepted.principalId !== this.#input.ownerPrincipalId) throw new Error("owner_step_up_disable_not_owner");
    if (accepted.text !== "/disable-owner-step-up --confirm") {
      throw new Error("owner_step_up_disable_confirmation_invalid");
    }
    if (accepted.chatId !== accepted.telegramUserId) return "private_chat_required";
    const head = await this.#head();
    if (head === null) return "unconfigured";
    if (head.status === "disabled") return "already_disabled";
    const committedAt = (this.#input.now ?? (() => new Date()))().toISOString();
    try {
      await this.#input.database.prepare(
        `INSERT INTO owner_passphrase_disable_commits (
          commit_id, owner_principal_id, owner_identity_id, expected_verifier_version,
          authorization_event_id, committed_at
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      ).bind(
        (this.#input.newCommitId ?? (() => newUlid()))(),
        this.#input.ownerPrincipalId,
        this.#input.ownerVoiceIdentityId,
        head.verifierVersion,
        accepted.eventId,
        committedAt,
      ).run();
      return "disabled";
    } catch (error) {
      if (stateChanged(error) && (await this.#head())?.status === "disabled") return "already_disabled";
      if (stateChanged(error)) throw new Error("owner_step_up_disable_state_changed");
      throw error;
    }
  }

  async #head(): Promise<Readonly<{ verifierVersion: number; status: "active" | "disabled" }> | null> {
    const row = await this.#input.database.prepare(
      `SELECT verifier_version, status FROM owner_passphrase_heads
       WHERE singleton_id = 1 AND owner_principal_id = ? AND owner_identity_id = ?`,
    ).bind(this.#input.ownerPrincipalId, this.#input.ownerVoiceIdentityId)
      .first<{ verifier_version: number; status: "active" | "disabled" }>();
    return row === null ? null : Object.freeze({ verifierVersion: row.verifier_version, status: row.status });
  }
}
