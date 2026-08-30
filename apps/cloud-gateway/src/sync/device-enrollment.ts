import { canonicalJson, sha256Hex } from "../../../../packages/contracts/src/index.js";
import { TransactionRunner } from "../persistence/transaction.js";

export interface DeviceEnrollmentInput {
  schemaVersion: "1.0";
  bootstrapToken: string;
  displayName: string;
  deviceLabel: string;
  publicKeyBase64: string;
  phoneProviderSubject: string;
  telegramProviderSubject: string;
}

export interface DeviceEnrollmentResult {
  principalId: string;
  deviceId: string;
  keyId: string;
  keyGeneration: number;
  phoneIdentityId: string;
  telegramIdentityId: string;
  recovered: boolean;
}

export interface DeviceEnrollmentIdFactory {
  principalId(): string;
  deviceId(): string;
  keyId(): string;
  phoneIdentityId(): string;
  telegramIdentityId(): string;
}

interface ExistingEnrollment {
  principal_id: string;
  device_id: string;
  key_id: string;
  key_generation: number;
  bootstrap_metadata_hash: string;
  phone_identity_id: string | null;
  telegram_identity_id: string | null;
}

const FIELDS = ["schemaVersion", "bootstrapToken", "displayName", "deviceLabel", "publicKeyBase64", "phoneProviderSubject", "telegramProviderSubject"] as const;
const FIELD_SET = new Set<string>(FIELDS);
const encoder = new TextEncoder();

function defaultIds(): DeviceEnrollmentIdFactory {
  const randomId = (prefix: string) => `${prefix}:${crypto.randomUUID()}`;
  return {
    principalId: () => randomId("principal"), deviceId: () => randomId("device"), keyId: () => randomId("key"),
    phoneIdentityId: () => randomId("identity"), telegramIdentityId: () => randomId("identity"),
  };
}

function exactRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new TypeError("bootstrap_request_invalid");
  const keys = Reflect.ownKeys(value);
  if (keys.length !== FIELDS.length || keys.some((key) => typeof key !== "string" || !FIELD_SET.has(key))) throw new TypeError("bootstrap_request_invalid");
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const field of FIELDS) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) throw new TypeError("bootstrap_request_invalid");
    result[field] = descriptor.value;
  }
  return result;
}

function safeText(value: unknown, maximumBytes: number): value is string {
  return typeof value === "string" && value.length > 0 && value.isWellFormed() && value === value.normalize("NFC") && encoder.encode(value).byteLength <= maximumBytes;
}

function decodeCanonicalBase64(value: unknown, byteLength: number, error: string): Uint8Array {
  if (typeof value !== "string" || value.length === 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new TypeError(error);
  try {
    const decoded = Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
    if (decoded.byteLength !== byteLength || btoa(String.fromCharCode(...decoded)) !== value) throw new TypeError(error);
    return decoded;
  } catch { throw new TypeError(error); }
}

function decodeCanonicalBase64Url(value: unknown, byteLength: number, error: string): Uint8Array {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) throw new TypeError(error);
  const padding = "=".repeat((4 - value.length % 4) % 4);
  try {
    const decoded = Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/") + padding), (character) => character.charCodeAt(0));
    const encoded = btoa(String.fromCharCode(...decoded)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
    if (decoded.byteLength !== byteLength || encoded !== value) throw new TypeError(error);
    return decoded;
  } catch { throw new TypeError(error); }
}

function validateInput(value: unknown): DeviceEnrollmentInput {
  const record = exactRecord(value);
  if (record.schemaVersion !== "1.0") throw new TypeError("bootstrap_request_invalid");
  decodeCanonicalBase64Url(record.bootstrapToken, 32, "bootstrap_token_invalid");
  decodeCanonicalBase64(record.publicKeyBase64, 32, "bootstrap_public_key_invalid");
  for (const [field, limit] of [["displayName", 128], ["deviceLabel", 128], ["phoneProviderSubject", 128], ["telegramProviderSubject", 128]] as const) {
    if (!safeText(record[field], limit)) throw new TypeError("bootstrap_request_invalid");
  }
  if (!/^\+[1-9]\d{7,14}$/.test(record.phoneProviderSubject as string) || !/^[1-9]\d{0,19}$/.test(record.telegramProviderSubject as string)) {
    throw new TypeError("bootstrap_identity_invalid");
  }
  return record as unknown as DeviceEnrollmentInput;
}

export class DeviceEnrollment {
  private readonly transactions: TransactionRunner;
  private readonly ids: DeviceEnrollmentIdFactory;

  constructor(private readonly deps: {
    database: D1Database;
    now?: () => Date;
    ids?: DeviceEnrollmentIdFactory;
    afterCommit?: () => void;
  }) {
    this.transactions = new TransactionRunner(deps.database);
    this.ids = deps.ids ?? defaultIds();
  }

  async bootstrap(rawInput: DeviceEnrollmentInput): Promise<DeviceEnrollmentResult> {
    const input = validateInput(rawInput);
    const now = (this.deps.now ?? (() => new Date()))();
    const nowText = now.toISOString();
    const tokenBytes = decodeCanonicalBase64Url(input.bootstrapToken, 32, "bootstrap_token_invalid");
    const tokenHash = await sha256Hex(tokenBytes);
    const publicKey = decodeCanonicalBase64(input.publicKeyBase64, 32, "bootstrap_public_key_invalid");
    const keyFingerprint = await sha256Hex(publicKey);
    const metadataHash = await sha256Hex(canonicalJson({
      schemaVersion: input.schemaVersion,
      displayName: input.displayName,
      deviceLabel: input.deviceLabel,
      publicKeyBase64: input.publicKeyBase64,
      phoneProviderSubject: input.phoneProviderSubject,
      telegramProviderSubject: input.telegramProviderSubject,
    }));

    if (!await this.validToken(tokenHash, nowText)) throw new Error("bootstrap_token_invalid");
    const existing = await this.findExisting(input.publicKeyBase64, input.phoneProviderSubject, input.telegramProviderSubject);
    if (existing !== null) {
      if (existing.bootstrap_metadata_hash !== metadataHash || existing.phone_identity_id === null || existing.telegram_identity_id === null) {
        throw new Error("bootstrap_recovery_conflict");
      }
      const result = await this.transactions.batch([
        this.deps.database.prepare(
          `UPDATE bootstrap_tokens SET consumed_at = ?, principal_id = ?, device_id = ?
           WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > ?
             AND EXISTS (SELECT 1 FROM device_keys d JOIN principals p ON p.principal_id = d.principal_id
               WHERE d.device_id = ? AND d.principal_id = ? AND d.key_id = ? AND d.public_key_base64 = ?
                 AND d.key_generation = ? AND d.bootstrap_metadata_hash = ? AND d.status = 'active' AND p.status = 'active')`,
        ).bind(nowText, existing.principal_id, existing.device_id, tokenHash, nowText, existing.device_id, existing.principal_id, existing.key_id, input.publicKeyBase64, existing.key_generation, metadataHash),
      ]);
      if (result[0]?.meta.changes !== 1) throw new Error("bootstrap_token_invalid");
      this.deps.afterCommit?.();
      return {
        principalId: existing.principal_id, deviceId: existing.device_id, keyId: existing.key_id, keyGeneration: existing.key_generation,
        phoneIdentityId: existing.phone_identity_id, telegramIdentityId: existing.telegram_identity_id, recovered: true,
      };
    }

    const created: DeviceEnrollmentResult = {
      principalId: this.ids.principalId(), deviceId: this.ids.deviceId(), keyId: this.ids.keyId(), keyGeneration: 1,
      phoneIdentityId: this.ids.phoneIdentityId(), telegramIdentityId: this.ids.telegramIdentityId(), recovered: false,
    };
    try {
      const results = await this.transactions.batch([
        this.deps.database.prepare(
          `INSERT INTO principals (principal_id, principal_type, status, display_name, created_at, updated_at)
           VALUES (?, 'human', 'active', ?,
             (SELECT ? WHERE EXISTS (SELECT 1 FROM bootstrap_tokens WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > ?)), ?)`,
        ).bind(created.principalId, input.displayName, nowText, tokenHash, nowText, nowText),
        this.deps.database.prepare(
          "INSERT INTO device_keys (device_id, principal_id, key_id, public_key_base64, key_fingerprint, key_generation, algorithm, status, device_label, bootstrap_metadata_hash, created_at, revoked_at) VALUES (?, ?, ?, ?, ?, 1, 'ed25519', 'active', ?, ?, ?, NULL)",
        ).bind(created.deviceId, created.principalId, created.keyId, input.publicKeyBase64, keyFingerprint, input.deviceLabel, metadataHash, nowText),
        this.deps.database.prepare(
          "INSERT INTO channel_identities (identity_id, principal_id, channel, provider_subject, status, verified_at, created_at, enrolled_by_device_id) VALUES (?, ?, 'voice', ?, 'pending', NULL, ?, ?)",
        ).bind(created.phoneIdentityId, created.principalId, input.phoneProviderSubject, nowText, created.deviceId),
        this.deps.database.prepare(
          "INSERT INTO voice_owner_identity (singleton_id, principal_id, identity_id, created_at) VALUES (1, ?, ?, ?)",
        ).bind(created.principalId, created.phoneIdentityId, nowText),
        this.deps.database.prepare(
          "INSERT INTO channel_identities (identity_id, principal_id, channel, provider_subject, status, verified_at, created_at, enrolled_by_device_id) VALUES (?, ?, 'telegram', ?, 'pending', NULL, ?, ?)",
        ).bind(created.telegramIdentityId, created.principalId, input.telegramProviderSubject, nowText, created.deviceId),
        this.deps.database.prepare("INSERT INTO consumer_cursors (consumer_name, current_sequence, updated_at) VALUES (?, 0, ?)")
          .bind(`device:${created.deviceId}`, nowText),
        this.deps.database.prepare(
          "UPDATE bootstrap_tokens SET consumed_at = ?, principal_id = ?, device_id = ? WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > ?",
        ).bind(nowText, created.principalId, created.deviceId, tokenHash, nowText),
      ]);
      if (results.some((result) => result.meta.changes !== 1)) throw new Error("bootstrap_transaction_incomplete");
    } catch (error) {
      if (error instanceof Error && /NOT NULL constraint failed: principals.created_at/.test(error.message)) {
        throw new Error("bootstrap_token_invalid");
      }
      throw error;
    }
    this.deps.afterCommit?.();
    return created;
  }

  private findExisting(publicKeyBase64: string, phoneProviderSubject: string, telegramProviderSubject: string): Promise<ExistingEnrollment | null> {
    return this.deps.database.prepare(
      `SELECT d.principal_id, d.device_id, d.key_id, d.key_generation, d.bootstrap_metadata_hash,
        voice.identity_id AS phone_identity_id, telegram.identity_id AS telegram_identity_id
       FROM device_keys d
       JOIN voice_owner_identity owner ON owner.principal_id = d.principal_id
       LEFT JOIN channel_identities voice ON voice.principal_id = d.principal_id AND voice.enrolled_by_device_id = d.device_id
         AND voice.channel = 'voice' AND voice.provider_subject = ? AND voice.identity_id = owner.identity_id
       LEFT JOIN channel_identities telegram ON telegram.principal_id = d.principal_id AND telegram.enrolled_by_device_id = d.device_id
         AND telegram.channel = 'telegram' AND telegram.provider_subject = ?
       WHERE d.public_key_base64 = ?`,
    ).bind(phoneProviderSubject, telegramProviderSubject, publicKeyBase64).first<ExistingEnrollment>();
  }

  private async validToken(tokenHash: string, now: string): Promise<boolean> {
    const row = await this.deps.database.prepare("SELECT 1 AS valid FROM bootstrap_tokens WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > ?")
      .bind(tokenHash, now).first<{ valid: number }>();
    return row?.valid === 1;
  }
}
