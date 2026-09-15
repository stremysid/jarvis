import type { Ulid } from "../../../../packages/contracts/src/index.js";
import { DeviceRepository } from "../persistence/device-repository.js";
import type { TelegramProvider } from "../providers/provider-types.js";

export type GuestGrantNoticeOperation = "created" | "permissions_changed" | "pin_rotated" | "revoked";

export interface GuestGrantNoticeSink {
  notify(input: Readonly<{
    ownerPrincipalId: string;
    mutationId: Ulid;
    operation: GuestGrantNoticeOperation;
    maskedTarget: string;
    occurredAt: Date;
  }>): Promise<void>;
}

const OPERATION_TEXT: Readonly<Record<GuestGrantNoticeOperation, string>> = Object.freeze({
  created: "Guest access created",
  permissions_changed: "Guest permissions changed",
  pin_rotated: "Guest PIN rotated",
  revoked: "Guest access revoked",
});

/** Sends a fixed, content-minimal notice to Sid's sole verified Telegram identity. */
export class D1GuestGrantNoticeSink implements GuestGrantNoticeSink {
  constructor(
    private readonly database: D1Database,
    private readonly telegram: TelegramProvider,
  ) {}

  async notify(input: Parameters<GuestGrantNoticeSink["notify"]>[0]): Promise<void> {
    const chatId = await new DeviceRepository(this.database).findOwnerTelegramChat(input.ownerPrincipalId);
    if (chatId === null) throw new Error("guest_grant_notice_owner_unavailable");
    const result = await this.telegram.sendMessage({
      chatId,
      text: `${OPERATION_TEXT[input.operation]} for ${input.maskedTarget} at ${input.occurredAt.toISOString()}.`,
      idempotencyKey: `guest-grant:${input.mutationId}`,
    });
    if (!/^[1-9][0-9]{0,19}$/u.test(result.providerMessageId)) {
      throw new Error("guest_grant_notice_delivery_unconfirmed");
    }
  }
}
