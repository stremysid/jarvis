# Jarvis Owner and Guest Voice Access Implementation Plan

> **Superseded for owner authentication:** This historical implementation plan
> built PIN-free owner admission. Its guest-grant work remains relevant, but
> the owner portions are replaced by the
> [2026-09-14 owner-passphrase design](../specs/2026-09-14-owner-call-passphrase-design.md).
> Do not use its PIN-free owner tests or evidence as the R1 release contract.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the retired global call PIN with a PIN-free owner identity plus owner-provisioned, per-number guest access enforced by four-digit grant-bound PINs and exact permissions.

**Architecture:** Task 6 owns the complete voice-access vertical slice: shared contracts, additive D1 state, guest PIN cryptography, owner/guest authority, verified-number admission, owner administration, and Durable Object enforcement. Task 8 consumes the reviewed Task 6 interfaces for route and fake end-to-end integration; Task 9 consumes the reviewed route outcomes for offline-safe release evidence. Authority is nominal and server-issued, phone numbers only select stored identities, unknown numbers fail before ConversationRelay, and every guest decision revalidates current grant lineage. Commit `6060570` is an integration checkpoint for Task 6A–6C only; integrate Task 6 into this branch only from the complete reviewed, committed Task 6D–6F tip, after its admission, PIN-capture/administration, and Durable Object interfaces are fixed.

**Tech Stack:** TypeScript 7, Cloudflare Workers and Durable Objects, D1/SQLite migrations, Web Crypto, Vitest with `@cloudflare/vitest-pool-workers`, pnpm 11, Twilio ConversationRelay adapters.

**Spec:** `docs/superpowers/specs/2026-08-30-jarvis-owner-guest-call-access-design.md`

## Global Constraints

- The configured active owner voice identity is PIN-free; Caller ID text alone never mints owner authority.
- Unknown, disabled, revoked, or unprovisioned numbers are rejected before ConversationRelay.
- Guests authenticate once per call with exactly four decimal digits and a verifier bound to their grant ID.
- `DEFAULT_GUEST_PIN` is accepted only for an owner-confirmed `use the default` provisioning choice; it never authenticates an unknown number.
- `GUEST_PIN_PEPPER_V1` is a 32-byte private binding; verifier version `2.0` uses HMAC-SHA-256 followed by exactly 600,000 PBKDF2-HMAC-SHA-256 iterations, a random 16-byte salt, and a 32-byte digest.
- Three failed guest PIN candidates terminate only that call; the existing five-minute call/composite/global attempt budgets remain.
- Owner-administration proposals expire exactly 60 seconds after creation, are same-session and single-use, and require exact confirmation.
- Call authority expires no later than 30 minutes after provider connection and immediately on socket close or a terminal call state.
- The model and normal conversation pipeline can propose neither authority nor repository mutations.
- PINs, direct phone numbers, unrestricted transcripts, secrets, provider bodies, and credentials never enter events, logs, prompts, memory, error details, TwiML, tracked fixtures, or release evidence.
- All automated tests use synthetic E.164 values and synthetic PINs. The private owner number, Jarvis number, and operator-selected default PIN never enter Git.
- No task may deploy, place a live call, use live credentials/providers, send a message, or spend money.

## File and Ownership Map

| Owner | Path | Responsibility |
| --- | --- | --- |
| Task 6 | `packages/contracts/src/voice-access.ts` | Closed capability IDs, resource scopes, and access-binding types. |
| Task 6 | `packages/contracts/src/calls.ts` | Relay binding extended with owner/guest candidate lineage. |
| Task 6 | `apps/cloud-gateway/src/persistence/migrations/0006_voice_access.sql` | Owner singleton, grant/event/authority tables, call-session access columns, constraints, and guards. |
| Task 6 | `apps/cloud-gateway/src/persistence/device-repository.ts` | Bootstrap owner designation and local-challenge-only owner phone activation persistence. |
| Task 6 | `apps/cloud-gateway/src/security/guest-pin-verifier.ts` | Versioned peppered four-digit verifier creation and constant-time verification. |
| Task 6 | `apps/cloud-gateway/src/voice/pin-capture.ts` | Four-digit DTMF/spoken guest and owner-administration PIN capture with byte clearing. |
| Task 6 | `apps/cloud-gateway/src/voice/capability-registry.ts` | Installed/grantable capability and resource-scope validation. |
| Task 6 | `apps/cloud-gateway/src/persistence/voice-access-repository.ts` | Atomic owner, guest, grant, activation, rotation, revocation, listing, and authority persistence. |
| Task 6 | `apps/cloud-gateway/src/voice/voice-access-authority.ts` | Nominal in-process owner/guest capabilities and current-lineage checks. |
| Task 6 | `apps/cloud-gateway/src/voice/owner-access-service.ts` | Same-session 60-second proposals, default/explicit PIN selection, confirmation, and mutations. |
| Task 6 | `apps/cloud-gateway/src/voice/owner-access-intent.ts` | Closed deterministic administration grammar and strict spoken-digit normalization. |
| Task 6 | `apps/cloud-gateway/src/voice/inbound-auth.ts` | Existing abuse budgets adapted to guest grant authentication. |
| Task 6 | `apps/cloud-gateway/src/persistence/call-repository.ts` | Owner/guest inbound and outbound admission plus immutable relay binding. |
| Task 6 | `apps/cloud-gateway/src/voice/call-session-do.ts` | Relay binding, owner activation, guest PIN, owner administration, interruption, and lifecycle. |
| Task 6 | `apps/cloud-gateway/src/sync/device-enrollment.ts` and `identity-challenge.ts` | Owner designation at bootstrap and local-challenge-only owner phone activation. |
| Task 6 | `apps/cloud-gateway/src/env.ts` and `index.ts` | Private binding types and real Durable Object export. |
| Task 8 | `apps/cloud-gateway/src/http/voice-*.ts`, `apps/cloud-gateway/src/voice/outbound-recipient-lookup.ts` | Route construction, callbacks, recipient lookup, and fail-closed Worker wiring. |
| Task 8 | `tests/acceptance/fake/voice-call-*.ts` | Credential-free owner/guest/unknown/revocation/permission acceptance. |
| Task 9 | `tests/acceptance/live/voice-smoke*` and `docs/runbooks/voice-smoke.md` | Owner-path live evidence contract plus offline guest isolation evidence. |

---

### Task 6A: Shared Voice-Access Contracts and Additive Schema

**Files:**
- Create: `packages/contracts/src/voice-access.ts`
- Modify: `packages/contracts/src/calls.ts`
- Modify: `packages/contracts/src/index.ts`
- Test: `packages/contracts/test/voice-access.test.ts`
- Create: `apps/cloud-gateway/src/persistence/migrations/0006_voice_access.sql`
- Modify: `apps/cloud-gateway/test/persistence/migration.ts`
- Test: `apps/cloud-gateway/test/persistence/migration-schema.test.ts`

**Interfaces:**
- Consumes: current `RelayBinding`, `Ulid`, canonical JSON/hash helpers, `principals`, `channel_identities`, and `call_sessions`.
- Produces: `GuestCapabilityId`, `VoiceResourceScopesV1`, `VoiceAccessBinding`, the owner/grant/event/session-authority schema, and immutable candidate lineage used by every later task.

- [ ] **Step 1: Write failing contract tests**

```ts
import { describe, expect, it } from "vitest";
import { GUEST_CAPABILITY_IDS, type RelayBinding } from "../src/index.js";

describe("voice access contracts", () => {
  it("publishes one closed duplicate-free capability registry", () => {
    expect(GUEST_CAPABILITY_IDS).toEqual([
      "conversation.basic", "research.web", "memory.own", "reminders.manage",
      "calendar.read", "calendar.manage", "owner.contact", "communications.draft",
      "communications.send", "calls.place", "files.read", "files.write", "pc.control",
      "spending.propose", "destructive.propose",
    ]);
    expect(new Set(GUEST_CAPABILITY_IDS).size).toBe(GUEST_CAPABILITY_IDS.length);
    expect(GUEST_CAPABILITY_IDS).not.toContain("access.manage");
  });

  it("requires relay bindings to carry exact owner or guest lineage", () => {
    const owner: RelayBinding = {
      callSid: `CA${"a".repeat(32)}`, principalId: "principal:owner", identityId: "identity:owner:voice",
      destinationIdentityId: "identity:owner:voice", relayNonce: `${"a".repeat(42)}A`, direction: "inbound",
      activationOnly: false, activationChallengeId: null, accessKind: "owner", guestGrantId: null,
      guestGrantVersion: null, accessDocumentHash: null,
    };
    expect(owner.accessKind).toBe("owner");
  });
});
```

- [ ] **Step 2: Run the contract test and verify RED**

Run: `pnpm exec vitest --config vitest.workspace.ts run packages/contracts/test/voice-access.test.ts`

Expected: FAIL because `voice-access.ts` and the new `RelayBinding` fields do not exist.

- [ ] **Step 3: Add the exact shared types**

```ts
const capabilityIds = [
  "conversation.basic", "research.web", "memory.own", "reminders.manage",
  "calendar.read", "calendar.manage", "owner.contact", "communications.draft",
  "communications.send", "calls.place", "files.read", "files.write", "pc.control",
  "spending.propose", "destructive.propose",
] as const;

export type GuestCapabilityId = typeof capabilityIds[number];
export const GUEST_CAPABILITY_IDS: readonly GuestCapabilityId[] = Object.freeze([...capabilityIds]);
export type VoiceAccessKind = "owner" | "guest";

export interface VoiceResourceScopesV1 {
  readonly schemaVersion: "1.0";
  readonly calendarConnectionIds: readonly string[];
  readonly fileRootIds: readonly string[];
  readonly pcActionIds: readonly string[];
}

export interface VoiceAccessBinding {
  readonly accessKind: VoiceAccessKind;
  readonly guestGrantId: string | null;
  readonly guestGrantVersion: number | null;
  readonly accessDocumentHash: string | null;
}
```

Extend `RelayBinding` with every `VoiceAccessBinding` field. Owner bindings require all guest fields to be `null`; guest bindings require a lowercase ULID grant ID, a positive safe integer version, and a lowercase 64-hex document hash.

- [ ] **Step 4: Write failing migration tests**

```ts
it("enforces one owner and append-only grant lineage", async () => {
  await seedOwnerAndGuest();
  await expect(env.DB.prepare("INSERT INTO voice_owner_identity (singleton_id, principal_id, identity_id, created_at) VALUES (1, ?, ?, ?)")
    .bind("principal:other", "identity:other", now).run()).rejects.toThrow();
  await expect(env.DB.prepare("DELETE FROM voice_access_grants WHERE grant_id = ?").bind(GRANT_ID).run())
    .rejects.toThrow(/voice_access_grant_delete_forbidden/u);
  await expect(env.DB.prepare("UPDATE voice_access_grants SET grant_version = 3 WHERE grant_id = ?").bind(GRANT_ID).run())
    .rejects.toThrow(/voice_access_grant_version_invalid/u);
});

it("rejects owner-as-guest, duplicate live grants, and mutable authority", async () => {
  await expect(insertGrant({ identityId: OWNER_IDENTITY_ID })).rejects.toThrow();
  await insertGrant({ identityId: GUEST_IDENTITY_ID });
  await expect(insertGrant({ identityId: GUEST_IDENTITY_ID, grantId: SECOND_GRANT_ID })).rejects.toThrow();
  await expect(env.DB.prepare("UPDATE call_session_authorities SET grant_version = 2 WHERE session_id = ?")
    .bind(SESSION_ID).run()).rejects.toThrow(/call_session_authority_immutable/u);
});
```

- [ ] **Step 5: Run migration tests and verify RED**

Run: `pnpm exec vitest --config vitest.workspace.ts run apps/cloud-gateway/test/persistence/migration-schema.test.ts`

Expected: FAIL because migration `0006_voice_access.sql` is not loaded and its tables do not exist.

- [ ] **Step 6: Add and register the additive migration**

Use these exact table and column contracts:

```sql
PRAGMA defer_foreign_keys = ON;
PRAGMA legacy_alter_table = ON;

DROP INDEX principals_one_human_idx;
ALTER TABLE principals RENAME TO principals_legacy;

CREATE TABLE principals (
  principal_id TEXT PRIMARY KEY,
  principal_type TEXT NOT NULL CHECK (principal_type IN ('human', 'service')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'disabled')),
  display_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL CHECK (updated_at >= created_at)
);

INSERT INTO principals (principal_id, principal_type, status, display_name, created_at, updated_at)
SELECT principal_id, principal_type, status, display_name, created_at, updated_at
FROM principals_legacy;

DROP TABLE principals_legacy;
PRAGMA legacy_alter_table = OFF;

CREATE TABLE voice_owner_identity (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  principal_id TEXT NOT NULL UNIQUE REFERENCES principals(principal_id) ON DELETE RESTRICT,
  identity_id TEXT NOT NULL UNIQUE REFERENCES channel_identities(identity_id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at)
);

CREATE TABLE voice_access_grants (
  grant_id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principals(principal_id) ON DELETE RESTRICT,
  identity_id TEXT NOT NULL REFERENCES channel_identities(identity_id) ON DELETE RESTRICT,
  grant_version INTEGER NOT NULL CHECK (grant_version > 0),
  capability_ids_json TEXT NOT NULL CHECK (json_valid(capability_ids_json) AND json_type(capability_ids_json) = 'array'),
  resource_scopes_json TEXT NOT NULL CHECK (json_valid(resource_scopes_json) AND json_type(resource_scopes_json) = 'object'),
  access_document_hash TEXT NOT NULL CHECK (length(access_document_hash) = 64 AND access_document_hash NOT GLOB '*[^0-9a-f]*'),
  pin_schema_version TEXT NOT NULL CHECK (pin_schema_version = '2.0'),
  pin_algorithm TEXT NOT NULL CHECK (pin_algorithm = 'hmac-sha256-pepper+pbkdf2-hmac-sha256'),
  pin_pepper_version TEXT NOT NULL CHECK (pin_pepper_version = 'v1'),
  pin_iterations INTEGER NOT NULL CHECK (pin_iterations = 600000),
  pin_salt_base64 TEXT NOT NULL CHECK (length(pin_salt_base64) = 24),
  pin_digest_base64 TEXT NOT NULL CHECK (length(pin_digest_base64) = 44),
  status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'revoked')),
  created_by_identity_id TEXT NOT NULL REFERENCES channel_identities(identity_id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  activated_at TEXT CHECK (activated_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', activated_at) IS activated_at),
  updated_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS updated_at),
  revoked_at TEXT CHECK (revoked_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', revoked_at) IS revoked_at),
  CHECK (updated_at >= created_at),
  CHECK ((status = 'pending' AND activated_at IS NULL AND revoked_at IS NULL)
    OR (status = 'active' AND activated_at IS NOT NULL AND revoked_at IS NULL)
    OR (status = 'revoked' AND revoked_at IS NOT NULL))
);

CREATE UNIQUE INDEX voice_access_grants_one_live_identity
  ON voice_access_grants(identity_id) WHERE status IN ('pending', 'active');

CREATE TABLE voice_access_grant_events (
  event_id TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL REFERENCES voice_access_grants(grant_id) ON DELETE RESTRICT,
  grant_version INTEGER NOT NULL CHECK (grant_version > 0),
  event_type TEXT NOT NULL CHECK (event_type IN ('created', 'activated', 'permissions_replaced', 'pin_rotated', 'revoked')),
  owner_identity_id TEXT NOT NULL REFERENCES channel_identities(identity_id) ON DELETE RESTRICT,
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64 AND request_hash NOT GLOB '*[^0-9a-f]*'),
  capability_ids_json TEXT NOT NULL CHECK (json_valid(capability_ids_json) AND json_type(capability_ids_json) = 'array'),
  access_document_hash TEXT NOT NULL CHECK (length(access_document_hash) = 64 AND access_document_hash NOT GLOB '*[^0-9a-f]*'),
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at)
);

ALTER TABLE call_sessions ADD COLUMN access_kind TEXT CHECK (access_kind IN ('owner', 'guest'));
ALTER TABLE call_sessions ADD COLUMN guest_grant_id TEXT REFERENCES voice_access_grants(grant_id) ON DELETE RESTRICT;
ALTER TABLE call_sessions ADD COLUMN guest_grant_version INTEGER CHECK (guest_grant_version IS NULL OR guest_grant_version > 0);
ALTER TABLE call_sessions ADD COLUMN access_document_hash TEXT CHECK (access_document_hash IS NULL OR (length(access_document_hash) = 64 AND access_document_hash NOT GLOB '*[^0-9a-f]*'));

DROP TRIGGER call_sessions_require_matching_outbound_attempt;

CREATE TABLE call_session_authorities (
  session_id TEXT PRIMARY KEY REFERENCES call_sessions(session_id) ON DELETE RESTRICT,
  authority_kind TEXT NOT NULL CHECK (authority_kind IN ('owner', 'guest')),
  principal_id TEXT NOT NULL REFERENCES principals(principal_id) ON DELETE RESTRICT,
  identity_id TEXT NOT NULL REFERENCES channel_identities(identity_id) ON DELETE RESTRICT,
  grant_id TEXT REFERENCES voice_access_grants(grant_id) ON DELETE RESTRICT,
  grant_version INTEGER CHECK (grant_version IS NULL OR grant_version > 0),
  access_document_hash TEXT CHECK (access_document_hash IS NULL OR (length(access_document_hash) = 64 AND access_document_hash NOT GLOB '*[^0-9a-f]*')),
  authenticated_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', authenticated_at) IS authenticated_at),
  expires_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', expires_at) IS expires_at),
  CHECK (expires_at > authenticated_at AND expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ', authenticated_at, '+1800 seconds')),
  CHECK ((authority_kind = 'owner' AND grant_id IS NULL AND grant_version IS NULL AND access_document_hash IS NULL)
    OR (authority_kind = 'guest' AND grant_id IS NOT NULL AND grant_version IS NOT NULL AND access_document_hash IS NOT NULL))
);

PRAGMA defer_foreign_keys = OFF;
```

Add exact triggers named `voice_owner_identity_requires_voice_human`, `voice_owner_identity_immutable`, `voice_owner_identity_delete_forbidden`, `voice_access_grants_require_guest_identity`, `voice_access_grants_immutable_lineage`, `voice_access_grants_version_invalid`, `voice_access_grants_status_invalid`, `voice_access_grants_delete_forbidden`, `voice_access_grant_events_immutable`, `voice_access_grant_events_delete_forbidden`, `call_sessions_voice_access_required`, `call_sessions_voice_access_immutable`, `call_session_authorities_require_current_lineage`, `call_session_authorities_immutable`, and `call_session_authorities_delete_forbidden`. Each trigger must use `RAISE(ABORT, '<trigger-name-without-prefix>')`; direct-D1 tests must exercise every rejection path.

`voice_access_grants_version_invalid` permits pending-to-active first-use activation at the same version because no authority existed before it; permission replacement, PIN rotation, and revocation require `NEW.grant_version = OLD.grant_version + 1`. No other version or status change is valid. Recreate `call_sessions_require_matching_outbound_attempt` so the attempt retains the issuing actor in `outbound_call_attempts.principal_id`, while `call_sessions.principal_id` must equal the destination identity's principal. The trigger must also require the destination to classify as the configured owner or the exact current guest grant stored on the session.

Register the migration with `PRAGMA defer_foreign_keys = ON` as documented by [Cloudflare D1 foreign-key guidance](https://developers.cloudflare.com/d1/sql-api/foreign-keys/), add `clearVoiceAccessDataForTest()` that temporarily drops only the new delete guards and clears authorities, grant events, grants, and owner rows in child-first order, and assert `PRAGMA foreign_key_check` returns no rows after migration.

- [ ] **Step 7: Run focused schema and contract tests**

Run: `pnpm exec vitest --config vitest.workspace.ts run packages/contracts/test/voice-access.test.ts apps/cloud-gateway/test/persistence/migration-schema.test.ts`

Expected: PASS with no actual phone number or operator PIN in snapshots or diagnostics.

- [ ] **Step 8: Commit Task 6A**

```bash
git add packages/contracts apps/cloud-gateway/src/persistence/migrations/0006_voice_access.sql apps/cloud-gateway/test/persistence
git commit -m "feat(calls): add owner and guest access schema"
```

### Task 6B: Grant-Bound Guest PIN Verifier

**Files:**
- Create: `apps/cloud-gateway/src/security/guest-pin-verifier.ts`
- Test: `apps/cloud-gateway/test/security/guest-pin-verifier.test.ts`
- Modify: `apps/cloud-gateway/src/env.ts`
- Modify: `apps/cloud-gateway/test/contracts/calls.test.ts`

**Interfaces:**
- Consumes: Web Crypto and Task 6A grant IDs.
- Produces: `GuestPinVerifierRecordV2`, `GuestPinVerifier.create`, `GuestPinVerifier.verify`, and private environment bindings `GUEST_PIN_PEPPER_V1` and optional `DEFAULT_GUEST_PIN`.

- [ ] **Step 1: Write failing verifier tests**

```ts
it("derives a grant-bound v2 record and verifies only four exact digits", async () => {
  const verifier = new GuestPinVerifier(pepper, () => Uint8Array.from({ length: 16 }, (_, index) => index + 1));
  const record = await verifier.create(GRANT_ID, new TextEncoder().encode("4827"));
  expect(record).toMatchObject({
    schemaVersion: "2.0", algorithm: "hmac-sha256-pepper+pbkdf2-hmac-sha256",
    pepperVersion: "v1", iterations: 600_000,
  });
  await expect(verifier.verify(GRANT_ID, new TextEncoder().encode("4827"), record)).resolves.toBe(true);
  await expect(verifier.verify(OTHER_GRANT_ID, new TextEncoder().encode("4827"), record)).resolves.toBe(false);
  await expect(verifier.verify(GRANT_ID, new TextEncoder().encode("48270"), record)).resolves.toBe(false);
});

it("rejects malformed records and clears transient byte copies", async () => {
  expect(() => decodeGuestPinVerifierRecord({ schemaVersion: "2.0", iterations: 1 }))
    .toThrow("guest_pin_verifier_invalid");
  const candidate = new TextEncoder().encode("4827");
  await verifier.verify(GRANT_ID, candidate, record);
  expect(candidate).toEqual(new Uint8Array(4));
});
```

- [ ] **Step 2: Run verifier tests and verify RED**

Run: `pnpm exec vitest --config vitest.workspace.ts run apps/cloud-gateway/test/security/guest-pin-verifier.test.ts`

Expected: FAIL because the verifier module does not exist.

- [ ] **Step 3: Implement the exact verifier contract**

```ts
export interface GuestPinVerifierRecordV2 {
  readonly schemaVersion: "2.0";
  readonly algorithm: "hmac-sha256-pepper+pbkdf2-hmac-sha256";
  readonly pepperVersion: "v1";
  readonly iterations: 600_000;
  readonly saltBase64: string;
  readonly digestBase64: string;
}

export class GuestPinVerifier {
  constructor(pepper: Uint8Array, randomSalt?: () => Uint8Array);
  create(grantId: string, pinDigits: Uint8Array): Promise<GuestPinVerifierRecordV2>;
  verify(grantId: string, pinDigits: Uint8Array, record: GuestPinVerifierRecordV2): Promise<boolean>;
}

export function decodeGuestPinVerifierRecord(value: unknown): GuestPinVerifierRecordV2;
```

Both methods must require a canonical lowercase ULID grant ID and exactly four ASCII digit bytes. Derive the PBKDF2 input from `HMAC-SHA-256(pepper, UTF8("jarvis.guest-pin/v1") || 0x00 || UTF8(grantId) || 0x00 || pinBytes)`, derive 256 bits with the record salt, and compare all 32 bytes without early exit. `create` and `verify` clear the caller candidate plus every internal PIN/HMAC/salt/digest copy in `finally`. Decoding requires an exact plain record, canonical base64 for 16/32 bytes, and the exact version, algorithm, pepper version, and iteration count.

- [ ] **Step 4: Add private binding types and contract guards**

```ts
export interface Env {
  DB: D1Database;
  ARCHIVE: R2Bucket;
  CALL_SESSION: DurableObjectNamespace<CallSession>;
  OWNER_VOICE_IDENTITY_ID: string;
  GUEST_PIN_PEPPER_V1: string;
  AUTHENTICATION_BUDGET_PEPPER: string;
  IDENTITY_CHALLENGE_HMAC_PEPPER: string;
  DEFAULT_GUEST_PIN?: string;
}
```

Tests require peppers to decode from canonical private configuration to exactly 32 bytes, require `DEFAULT_GUEST_PIN` to be absent or `[0-9]{4}`, and assert that contract tests contain only synthetic values.

- [ ] **Step 5: Run verifier, contract, type, and lint gates**

Run: `pnpm exec vitest --config vitest.workspace.ts run apps/cloud-gateway/test/security/guest-pin-verifier.test.ts apps/cloud-gateway/test/contracts/calls.test.ts`

Run: `pnpm typecheck && pnpm lint`

Expected: all commands PASS.

- [ ] **Step 6: Commit Task 6B**

```bash
git add apps/cloud-gateway/src/security/guest-pin-verifier.ts apps/cloud-gateway/src/env.ts apps/cloud-gateway/test/security/guest-pin-verifier.test.ts apps/cloud-gateway/test/contracts/calls.test.ts
git commit -m "feat(calls): add grant-bound guest PIN verifier"
```

### Task 6C: Capability Registry, Grant Repository, and Nominal Authority

**Files:**
- Create: `apps/cloud-gateway/src/voice/capability-registry.ts`
- Test: `apps/cloud-gateway/test/voice/capability-registry.test.ts`
- Create: `apps/cloud-gateway/src/persistence/voice-access-repository.ts`
- Test: `apps/cloud-gateway/test/persistence/voice-access-repository.test.ts`
- Test: `apps/cloud-gateway/test/faults/voice-access-transaction-faults.test.ts`
- Create: `apps/cloud-gateway/src/voice/voice-access-authority.ts`
- Test: `apps/cloud-gateway/test/security/voice-access-authority.test.ts`
- Modify: `apps/cloud-gateway/test/persistence/migration.ts`

**Interfaces:**
- Consumes: Task 6A schema/contracts, Task 6B verifier records, canonical JSON/SHA-256, D1 batch transactions, and current call-session lineage.
- Produces: closed installed-capability snapshots, atomic grant lifecycle methods, owner/guest candidate resolution, immutable call-authority rows, and nominal runtime capabilities.

- [ ] **Step 1: Write failing capability-registry tests**

```ts
it("snapshots only installed guest-grantable capabilities", () => {
  const registry = new CapabilityRegistry({ installed: ["conversation.basic", "research.web", "access.manage"] });
  expect(registry.resolve(["research.web", "conversation.basic"])).toEqual([
    "conversation.basic", "research.web",
  ]);
  expect(() => registry.resolve(["access.manage"])).toThrow("capability_not_grantable");
  expect(() => registry.resolve(["stremy.use"])).toThrow("capability_unknown");
});

it("requires exact adapter-owned resource scopes", () => {
  const registry = new CapabilityRegistry({
    installed: ["files.read"],
    calendarConnectionIds: [], fileRootIds: ["file-root:guest-docs"], pcActionIds: [],
  });
  expect(registry.snapshot(["files.read"], {
    schemaVersion: "1.0", calendarConnectionIds: [], fileRootIds: ["file-root:guest-docs"], pcActionIds: [],
  }).resourceScopes.fileRootIds).toEqual(["file-root:guest-docs"]);
  expect(() => registry.snapshot(["files.read"], {
    schemaVersion: "1.0", calendarConnectionIds: [], fileRootIds: ["C:\\"], pcActionIds: [],
  })).toThrow("resource_scope_invalid");
});
```

- [ ] **Step 2: Run registry tests and verify RED**

Run: `pnpm exec vitest --config vitest.workspace.ts run apps/cloud-gateway/test/voice/capability-registry.test.ts`

Expected: FAIL because `CapabilityRegistry` does not exist.

- [ ] **Step 3: Implement the closed registry**

```ts
export interface CapabilityRegistryConfiguration {
  readonly installed: readonly string[];
  readonly calendarConnectionIds?: readonly string[];
  readonly fileRootIds?: readonly string[];
  readonly pcActionIds?: readonly string[];
}

export interface CapabilitySnapshot {
  readonly capabilityIds: readonly GuestCapabilityId[];
  readonly resourceScopes: VoiceResourceScopesV1;
  readonly canonicalDocument: string;
  readonly accessDocumentHash: Sha256Hex;
}

export class CapabilityRegistry {
  constructor(configuration: CapabilityRegistryConfiguration);
  resolve(requested: readonly string[] | "everything"): readonly GuestCapabilityId[];
  snapshot(requested: readonly string[] | "everything", scopes: VoiceResourceScopesV1): Promise<CapabilitySnapshot>;
}
```

Capture configuration through exact own data properties, sort/deduplicate every opaque ID, reject wildcards/raw paths/unknown fields/accessors, and require the relevant non-empty scope for `calendar.*`, `files.*`, and `pc.control`. `everything` snapshots only the currently installed guest-grantable intersection. Never register `owner.root`, `access.manage`, `credentials.manage`, `safety.configure`, `identity.owner.rotate`, or `stremy.*`.

- [ ] **Step 4: Write failing repository lifecycle and fault tests**

```ts
it("creates a separate pending guest identity and grant atomically", async () => {
  const created = await repository.createGuestGrant({
    mutationId: MUTATION_ID, requestHash: REQUEST_HASH, ownerIdentityId: OWNER_IDENTITY_ID,
    grantId: GRANT_ID, guestPrincipalId: GUEST_PRINCIPAL_ID, guestIdentityId: GUEST_IDENTITY_ID,
    providerE164: "+14165550111", capabilityIds: ["conversation.basic"], resourceScopes: EMPTY_SCOPES,
    accessDocumentHash: DOCUMENT_HASH, pinVerifier: SYNTHETIC_RECORD, now,
  });
  expect(created).toMatchObject({ grantId: GRANT_ID, grantVersion: 1, status: "pending" });
  expect(await counts()).toEqual({ principals: 2, identities: 2, grants: 1, events: 1 });
});

it("rolls back every row when the event append fails", async () => {
  const repository = new VoiceAccessRepository(env.DB, { beforeEventWrite: () => { throw new Error("fault"); } });
  await expect(repository.createGuestGrant(validCreateInput())).rejects.toThrow("fault");
  expect(await counts()).toEqual({ principals: 1, identities: 1, grants: 0, events: 0 });
});

it("invalidates stale authority after replacement, rotation, or revocation", async () => {
  const authority = await seedAuthenticatedGuestAuthority();
  await repository.replacePermissions(validReplacementInput());
  await expect(repository.requireCurrentAuthority(authority)).rejects.toThrow("call_authority_stale");
});
```

- [ ] **Step 5: Run repository tests and verify RED**

Run: `pnpm exec vitest --config vitest.workspace.ts run apps/cloud-gateway/test/persistence/voice-access-repository.test.ts apps/cloud-gateway/test/faults/voice-access-transaction-faults.test.ts`

Expected: FAIL because the repository and reset helpers do not exist.

- [ ] **Step 6: Implement exact repository inputs and outputs**

```ts
export type VoiceAccessCandidate =
  | Readonly<{ kind: "owner"; principalId: string; identityId: string; activationChallengeId: string | null }>
  | Readonly<{ kind: "guest"; principalId: string; identityId: string; grantId: string; grantVersion: number;
      accessDocumentHash: Sha256Hex; status: "pending" | "active"; pinVerifier: GuestPinVerifierRecordV2 }>;

export interface PersistedCallAuthority {
  readonly sessionId: Ulid;
  readonly kind: "owner" | "guest";
  readonly principalId: string;
  readonly identityId: string;
  readonly grantId: string | null;
  readonly grantVersion: number | null;
  readonly accessDocumentHash: Sha256Hex | null;
  readonly authenticatedAt: string;
  readonly expiresAt: string;
}

export class VoiceAccessRepository {
  constructor(database: D1Database, hooks?: Readonly<{ beforeEventWrite?: () => void | Promise<void> }>);
  resolveInboundCandidate(input: { providerE164: string; ownerIdentityId: string; challengeHmacKeyVersion: string; now: Date }): Promise<VoiceAccessCandidate | null>;
  resolveIdentityCandidate(input: { identityId: string; ownerIdentityId: string; now: Date }): Promise<VoiceAccessCandidate | null>;
  createGuestGrant(input: CreateGuestGrantInput): Promise<GuestGrantSnapshot>;
  replacePermissions(input: ReplaceGuestPermissionsInput): Promise<GuestGrantSnapshot>;
  rotatePin(input: RotateGuestPinInput): Promise<GuestGrantSnapshot>;
  revokeGrant(input: RevokeGuestGrantInput): Promise<GuestGrantSnapshot>;
  listGuests(input: { ownerIdentityId: string }): Promise<readonly MaskedGuestGrant[]>;
  mintOwnerAuthority(input: MintOwnerAuthorityInput): Promise<PersistedCallAuthority>;
  mintGuestAuthority(input: MintGuestAuthorityInput): Promise<PersistedCallAuthority>;
  requireCurrentAuthority(input: PersistedCallAuthority): Promise<PersistedCallAuthority>;
}
```

Every mutation validates an exact issued owner authority before its first write, uses one `TransactionRunner.batch()`, writes one safe `voice_access_grant_events` row, and supports idempotent replay only when the same `mutationId` has the same `requestHash`. Creation inserts a non-owner human principal into the rebuilt PIN-free principal table. Listing returns only `identityId`, `status`, `grantVersion`, capability IDs, and a server-masked number such as `+1******0111`.

`mintGuestAuthority` atomically activates a pending identity/grant when necessary, inserts the activation event once, inserts `call_session_authorities`, and transitions `call_sessions` from `pre_auth` to `authenticated`. `requireCurrentAuthority` joins the nonterminal session and current owner row or active exact grant version/hash, and rejects at or after `expiresAt`.

- [ ] **Step 7: Write failing nominal-authority tests**

```ts
it("rejects structural, cross-session, stale, and expired authority", async () => {
  const service = new VoiceAccessAuthorityService(repository);
  const owner = await service.mintOwner({ sessionId: OWNER_SESSION_ID, binding: ownerBinding(), now });
  expect(() => service.snapshot({ ...owner })).toThrow("call_authority_invalid");
  await expect(service.authorize(owner, "conversation.basic", now)).resolves.toMatchObject({ kind: "owner" });
  await expect(service.authorize(owner, "conversation.basic", new Date(now.valueOf() + 1_800_000)))
    .rejects.toThrow("call_authority_expired");
});

it("denies absent and owner-only guest capabilities before adapter invocation", async () => {
  const guest = await authenticatedGuest(service, ["conversation.basic"]);
  await expect(service.authorize(guest, "research.web", now)).rejects.toThrow("capability_denied");
  await expect(service.authorize(guest, "access.manage", now)).rejects.toThrow("capability_not_grantable");
});
```

- [ ] **Step 8: Implement nominal authority issuance**

```ts
export interface OwnerCallAuthority {
  readonly authorityId: string;
  readonly kind: "owner";
  readonly sessionId: Ulid;
  readonly principalId: string;
  readonly identityId: string;
  readonly expiresAt: string;
}

export interface GuestCallAuthority {
  readonly authorityId: string;
  readonly kind: "guest";
  readonly sessionId: Ulid;
  readonly principalId: string;
  readonly identityId: string;
  readonly grantId: string;
  readonly grantVersion: number;
  readonly accessDocumentHash: Sha256Hex;
  readonly capabilityIds: readonly GuestCapabilityId[];
  readonly resourceScopes: VoiceResourceScopesV1;
  readonly expiresAt: string;
}

export class VoiceAccessAuthorityService {
  constructor(repository: VoiceAccessRepository, registry: CapabilityRegistry);
  mintOwner(input: { sessionId: Ulid; binding: RelayBinding; now: Date }): Promise<OwnerCallAuthority>;
  mintGuest(input: { sessionId: Ulid; binding: RelayBinding; pinProof: GuestPinAuthenticationProof; now: Date }): Promise<GuestCallAuthority>;
  snapshot(value: unknown): OwnerCallAuthority | GuestCallAuthority;
  authorize(value: unknown, capabilityId: string, now: Date): Promise<OwnerCallAuthority | GuestCallAuthority>;
  invalidate(value: unknown): void;
}
```

Use private `WeakMap` issuers, frozen objects, random opaque authority IDs, repository revalidation on every `authorize`, and explicit invalidation on terminal lifecycle. Owner authorization accepts installed capabilities but still delegates effect-specific confirmation to the adapter. Guest authorization additionally checks the frozen capability/resource snapshot.

- [ ] **Step 9: Run Task 6C focused and regression gates**

Run: `pnpm exec vitest --config vitest.workspace.ts run apps/cloud-gateway/test/voice/capability-registry.test.ts apps/cloud-gateway/test/persistence/voice-access-repository.test.ts apps/cloud-gateway/test/faults/voice-access-transaction-faults.test.ts apps/cloud-gateway/test/security/voice-access-authority.test.ts`

Run: `pnpm test:cloud && pnpm typecheck && pnpm lint`

Expected: all commands PASS.

- [ ] **Step 10: Commit Task 6C**

```bash
git add apps/cloud-gateway/src/voice/capability-registry.ts apps/cloud-gateway/src/persistence/voice-access-repository.ts apps/cloud-gateway/src/voice/voice-access-authority.ts apps/cloud-gateway/test
git commit -m "feat(calls): add verified guest access authority"
```

### Task 6D: Owner Enrollment and Verified-Number Call Admission

**Files:**
- Modify: `apps/cloud-gateway/src/sync/device-enrollment.ts`
- Test: `apps/cloud-gateway/test/sync/device-enrollment.test.ts`
- Modify: `apps/cloud-gateway/src/persistence/device-repository.ts`
- Modify: `apps/cloud-gateway/src/sync/identity-challenge.ts`
- Test: `apps/cloud-gateway/test/sync/identity-challenge.test.ts`
- Modify: `apps/cloud-gateway/src/persistence/call-repository.ts`
- Test: `apps/cloud-gateway/test/persistence/call-session-repository.test.ts`
- Modify: `apps/cloud-gateway/src/voice/inbound.ts`
- Test: `apps/cloud-gateway/test/http/inbound-voice.test.ts`
- Modify: `apps/cloud-gateway/src/voice/outbound.ts`
- Test: `apps/cloud-gateway/test/voice/outbound.test.ts`
- Modify: `apps/cloud-gateway/src/policy/policy-engine.ts`
- Test: `apps/cloud-gateway/test/policy/policy-engine.test.ts`
- Test: `apps/cloud-gateway/test/security/inbound-auth-security.test.ts`
- Test: `apps/cloud-gateway/test/security/outbound-security.test.ts`

**Interfaces:**
- Consumes: Task 6C `VoiceAccessCandidate`, the configured opaque owner identity ID, signed Twilio form authority, current local-device identity challenges, and existing expected-call/nonce/session admission.
- Produces: one bootstrap-designated owner identity, local-challenge-only owner activation, and immutable owner/guest relay bindings for inbound and outbound calls.

- [ ] **Step 1: Write failing bootstrap and owner-activation tests**

```ts
it("bootstraps exactly one pending owner voice identity without consuming a reusable call PIN", async () => {
  const enrolled = await new DeviceEnrollment({ database: env.DB, now: () => now, ids: ids() }).bootstrap(input());
  expect(await env.DB.prepare("SELECT principal_id, identity_id FROM voice_owner_identity WHERE singleton_id = 1").first())
    .toEqual({ principal_id: enrolled.principalId, identity_id: enrolled.phoneIdentityId });
});

it("activates only the configured owner phone with the signed local challenge", async () => {
  const observation = observations.issue(ownerPhoneObservation());
  await expect(service.confirm(observation)).resolves.toEqual({ identityId: OWNER_IDENTITY_ID, state: "active" });
  await expect(service.confirm(observations.issue(guestPhoneObservation())))
    .rejects.toThrow("owner_voice_identity_required");
});
```

- [ ] **Step 2: Run enrollment tests and verify RED**

Run: `pnpm exec vitest --config vitest.workspace.ts run apps/cloud-gateway/test/sync/device-enrollment.test.ts apps/cloud-gateway/test/sync/identity-challenge.test.ts`

Expected: FAIL because bootstrap does not create the owner singleton and phone confirmation still requires the retired PIN proof.

- [ ] **Step 3: Make owner designation and activation exact**

Remove `pinVerifierJson` from `DeviceEnrollment` dependencies and stop decoding or referencing `PIN_VERIFIER_JSON`. Insert the owner into the rebuilt PIN-free `principals` table. In the same bootstrap batch that creates the phone identity, insert:

```sql
INSERT INTO voice_owner_identity (singleton_id, principal_id, identity_id, created_at)
VALUES (1, ?, ?, ?);
```

Remove `pinAuthentication` from `ChannelObservationInput`. `IdentityChallengeService.confirm` must allow a voice observation only when `DeviceRepository.isOwnerVoiceIdentity(identityId, principalId)` returns true; Telegram behavior is unchanged. A pending guest becomes active only through first successful grant PIN authentication, never through `IdentityChallengeService`.

- [ ] **Step 4: Write failing admission tests**

```ts
it("admits owner without PIN, admits only provisioned guests, and rejects unknown before TwiML", async () => {
  await expect(repository.getOrCreateInboundSession(ownerSessionInput())).resolves.toMatchObject({
    binding: { accessKind: "owner", guestGrantId: null, guestGrantVersion: null },
  });
  await expect(repository.getOrCreateInboundSession(guestSessionInput())).resolves.toMatchObject({
    binding: { accessKind: "guest", guestGrantId: GRANT_ID, guestGrantVersion: 1, accessDocumentHash: DOCUMENT_HASH },
  });
  await expect(repository.getOrCreateInboundSession(unknownSessionInput()))
    .rejects.toSatisfy(isCallSessionAdmissionError);
});

it("returns neutral 403 without initializing a relay for an active but ungranted number", async () => {
  const response = await handleInboundVoiceWebhook(signedInboundRequest(UNGRANTED_E164), dependencies);
  expect(response.status).toBe(403);
  expect(await response.text()).toBe("forbidden");
  expect(dependencies.initializeSession).not.toHaveBeenCalled();
});
```

- [ ] **Step 5: Run admission tests and verify RED**

Run: `pnpm exec vitest --config vitest.workspace.ts run apps/cloud-gateway/test/persistence/call-session-repository.test.ts apps/cloud-gateway/test/http/inbound-voice.test.ts apps/cloud-gateway/test/voice/outbound.test.ts`

Expected: FAIL because relay/session bindings do not carry access lineage and active identities are admitted without owner/grant classification.

- [ ] **Step 6: Extend exact binding validation everywhere**

Update the exact-field validators in `packages/contracts/src/calls.ts`, `call-repository.ts`, `inbound.ts`, `outbound.ts`, `inbound-auth.ts`, and `call-session-do.ts` together. The invariant is:

```ts
function validAccessBinding(binding: RelayBinding): boolean {
  return binding.accessKind === "owner"
    ? binding.guestGrantId === null && binding.guestGrantVersion === null && binding.accessDocumentHash === null
    : binding.accessKind === "guest"
      && typeof binding.guestGrantId === "string"
      && /^[0-7][0-9a-hjkmnp-tv-z]{25}$/u.test(binding.guestGrantId)
      && Number.isSafeInteger(binding.guestGrantVersion) && (binding.guestGrantVersion ?? 0) > 0
      && typeof binding.accessDocumentHash === "string" && /^[a-f0-9]{64}$/u.test(binding.accessDocumentHash)
      && binding.activationOnly === false && binding.activationChallengeId === null;
}
```

`getOrCreateInboundSession` selects only one of: configured owner active; configured owner pending with the newest valid signed local challenge; active/pending exact guest grant; or no candidate. It inserts the candidate access fields into `call_sessions` and rejects ambiguous candidates. Exact replay requires every access field and current owner/grant lineage to match.

`claimExpectedCall` and `getOrCreateOutboundSession` resolve the destination identity, not the command issuer, as the call-session principal. Owner destinations bind `owner`; guest destinations bind the exact current grant/version/hash. Preserve the initiating owner principal on the outbound attempt for policy/audit, but never load that principal's memory into a guest destination session.

Replace `PolicyEngine.resolveVerifiedVoiceDestination(principalId, identityId)` with an access-aware query that requires the actor principal to match `voice_owner_identity.principal_id` and allows only the configured owner destination or a pending/active, non-revoked guest grant. It returns the canonical provider subject while retaining the destination principal separately. Tests prove an arbitrary active identity, revoked grant, guest-issued command, and actor/destination substitution all return `destination_not_verified`.

- [ ] **Step 7: Prove signature, replay, and no-leak boundaries**

Add tests for stale `OWNER_VOICE_IDENTITY_ID`, changed identity rows, active-but-ungranted numbers, pending/active/revoked guests, cross-grant replay, guest outbound destination-principal isolation, duplicated `From`/`To`/`CallSid`, and access metadata absence from TwiML and public errors.

Run: `pnpm exec vitest --config vitest.workspace.ts run apps/cloud-gateway/test/http/inbound-voice.test.ts apps/cloud-gateway/test/persistence/call-session-repository.test.ts apps/cloud-gateway/test/security/inbound-auth-security.test.ts apps/cloud-gateway/test/security/outbound-security.test.ts apps/cloud-gateway/test/voice/outbound.test.ts`

Expected: PASS with owner/guest/unknown decisions occurring only after signed provider facts and before relay construction.

- [ ] **Step 8: Commit Task 6D**

```bash
git add packages/contracts/src apps/cloud-gateway/src/sync apps/cloud-gateway/src/persistence apps/cloud-gateway/src/voice apps/cloud-gateway/test
git commit -m "feat(calls): admit owner and verified guest numbers"
```

### Task 6E: Owner Voice Administration and PIN Capture

**Files:**
- Create: `apps/cloud-gateway/src/voice/pin-capture.ts`
- Test: `apps/cloud-gateway/test/voice/pin-capture.test.ts`
- Modify: `packages/contracts/src/calls.ts`
- Modify: `apps/cloud-gateway/test/security/redaction.test.ts`
- Create: `apps/cloud-gateway/src/voice/owner-access-intent.ts`
- Test: `apps/cloud-gateway/test/voice/owner-access-intent.test.ts`
- Create: `apps/cloud-gateway/src/voice/owner-access-service.ts`
- Test: `apps/cloud-gateway/test/voice/owner-access-service.test.ts`
- Test: `apps/cloud-gateway/test/security/owner-access-security.test.ts`

**Interfaces:**
- Consumes: nominal owner authority, Task 6B verifier, Task 6C registry/repository, explicit/default PIN selection, synthetic intent text, and a trusted clock/ID factory.
- Produces: strict four-digit capture, closed administration drafts, nominal 60-second proposals, masked listing, and atomic confirmed mutations.

- [ ] **Step 1: Write failing PIN-capture tests**

```ts
it("accepts only four DTMF digits or four canonical spoken digits", () => {
  const capture = new FourDigitPinCapture();
  for (const digit of ["4", "8", "2", "7"] as const) capture.pushDtmf(digit);
  expect(capture.take()).toEqual(Uint8Array.from([52, 56, 50, 55]));
  expect(normalizeSpokenPin("four eight two seven")).toEqual(Uint8Array.from([52, 56, 50, 55]));
  expect(normalizeSpokenPin("for eight to seven")).toBeNull();
  expect(normalizeSpokenPin("my pin is four eight two seven")).toBeNull();
});

it("clears on star, hash, cancel, socket close, and take", () => {
  const capture = new FourDigitPinCapture();
  capture.pushDtmf("4");
  capture.pushDtmf("*");
  expect(capture.length).toBe(0);
  capture.clear();
  expect(capture.take()).toBeNull();
});
```

- [ ] **Step 2: Run PIN-capture tests and verify RED**

Run: `pnpm exec vitest --config vitest.workspace.ts run apps/cloud-gateway/test/voice/pin-capture.test.ts`

Expected: FAIL because capture and spoken normalization do not exist.

- [ ] **Step 3: Implement bounded capture and strict spoken normalization**

```ts
export class FourDigitPinCapture {
  readonly #bytes = new Uint8Array(4);
  #length = 0;
  get length(): number { return this.#length; }
  pushDtmf(digit: string): "incomplete" | "complete" | "cleared";
  take(): Uint8Array | null;
  clear(): void;
}

export function normalizeSpokenPin(text: unknown): Uint8Array | null;
```

Accept only exact NFC `^[0-9]{4}$` or exactly four lowercased whitespace-separated words from `zero|one|two|three|four|five|six|seven|eight|nine`. Reject punctuation, prefixes, suffixes, homophones, non-English alternatives, accessors, and partial prompts. `take` returns one copy and zeros the internal array; every caller zeros the returned array in `finally`.

- [ ] **Step 4: Write failing intent/proposal tests**

```ts
it("parses only the closed owner administration grammar", () => {
  expect(parseOwnerAccessIntent("allow +14165550111 with conversation and web research")).toEqual({
    kind: "add", providerE164: "+14165550111", permissionPhrases: ["conversation", "web research"]
  });
  expect(parseOwnerAccessIntent("list allowed callers")).toEqual({ kind: "list" });
  expect(parseOwnerAccessIntent("make everyone admin")).toBeNull();
});

it("requires same-session unexpired explicit confirmation", async () => {
  const proposal = await service.prepare({ ownerAuthority, sessionId: OWNER_SESSION_ID, draft: addDraft(), now });
  await expect(service.execute({ proposal: { ...proposal }, ownerAuthority, pinSelection: explicitPin(), now }))
    .rejects.toThrow("owner_access_proposal_invalid");
  await expect(service.execute({ proposal, ownerAuthority, pinSelection: explicitPin(), now: new Date(now.valueOf() + 60_000) }))
    .rejects.toThrow("owner_access_proposal_expired");
});
```

- [ ] **Step 5: Run intent/service tests and verify RED**

Run: `pnpm exec vitest --config vitest.workspace.ts run apps/cloud-gateway/test/voice/owner-access-intent.test.ts apps/cloud-gateway/test/voice/owner-access-service.test.ts apps/cloud-gateway/test/security/owner-access-security.test.ts`

Expected: FAIL because the parser/service do not exist.

- [ ] **Step 6: Implement the closed draft and nominal proposal interfaces**

```ts
export type OwnerAccessDraft =
  | Readonly<{ kind: "add"; providerE164: string; permissionPhrases: readonly string[] }>
  | Readonly<{ kind: "replace_permissions"; providerE164: string; permissionPhrases: readonly string[] }>
  | Readonly<{ kind: "rotate_pin"; providerE164: string }>
  | Readonly<{ kind: "revoke"; providerE164: string }>
  | Readonly<{ kind: "list" }>;

export interface PreparedOwnerAccessProposal {
  readonly proposalId: string;
  readonly sessionId: Ulid;
  readonly ownerIdentityId: string;
  readonly operation: "add" | "replace_permissions" | "rotate_pin" | "revoke" | "list";
  readonly maskedTarget: string | null;
  readonly capabilityIds: readonly GuestCapabilityId[];
  readonly accessDocumentHash: Sha256Hex | null;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export type OwnerPinSelection =
  | Readonly<{ kind: "explicit"; digits: Uint8Array }>
  | Readonly<{ kind: "default" }>;

export class OwnerAccessService {
  prepare(input: { ownerAuthority: OwnerCallAuthority; sessionId: Ulid; draft: OwnerAccessDraft; now: Date }): Promise<PreparedOwnerAccessProposal>;
  execute(input: { proposal: PreparedOwnerAccessProposal; ownerAuthority: OwnerCallAuthority;
    pinSelection: OwnerPinSelection | null; now: Date }): Promise<Readonly<{ outcome: "created" | "changed" | "rotated" | "revoked" | "listed"; speech: string }>>;
  invalidate(proposal: unknown): void;
}
```

`prepare` canonicalizes E.164, resolves phrases only through `CapabilityRegistry`, snapshots `everything`, allocates an unguessable ID, stores proposal authority in a private `WeakMap`, and sets `expiresAt = createdAt + 60_000`. `execute` accepts exact normalized `confirm` only from the call-session state that already holds the issued proposal; it revalidates owner authority and the proposal before calling one repository method. `kind: "default"` reads `DEFAULT_GUEST_PIN` only inside `execute`, validates four digits, converts to a byte array, and clears it after verifier creation. Responses contain masked numbers and safe capability labels only.

- [ ] **Step 7: Prove no proposal or PIN leakage**

Test model-like structural proposals, accessors, cross-session owner authority, replay, expiry boundary, ordinary-conversation `confirm`, newer-proposal invalidation, unknown/owner-only permissions, duplicate/revoked numbers, missing/invalid default binding, and injected transaction faults. Assert that repository events, errors, logs, conversation calls, model calls, and JSON serialization contain no candidate PIN or direct number. Add this exact contextual-redaction regression in `apps/cloud-gateway/test/security/redaction.test.ts`; it must redact a four-digit candidate only when the field is PIN-bearing and preserve unrelated four-digit prose such as a year:

```ts
it("redacts a four-digit voice PIN by field context without redacting a year", () => {
  const redactor = new Redactor();
  expect(redactor.redact({ text: "4827", channel: "voice", field: "guest.pin" }))
    .toEqual({ ok: true, text: "[REDACTED_AUTH_DIGITS]", markers: ["authentication_digits"] });
  expect(redactor.redact({ text: "Roadmap review in 2026", channel: "voice", field: "prompt.text" }))
    .toEqual({ ok: true, text: "Roadmap review in 2026", markers: [] });
});
```

The production redaction rule must use the existing normalized voice-field context (`pin`, `dtmf`, `digits`, and their suffix forms), never a blanket four-digit regular expression over ordinary text.

Run: `pnpm exec vitest --config vitest.workspace.ts run apps/cloud-gateway/test/voice/pin-capture.test.ts apps/cloud-gateway/test/voice/owner-access-intent.test.ts apps/cloud-gateway/test/voice/owner-access-service.test.ts apps/cloud-gateway/test/security/owner-access-security.test.ts apps/cloud-gateway/test/security/redaction.test.ts`

Expected: PASS.

- [ ] **Step 8: Commit Task 6E**

```bash
git add packages/contracts/src/calls.ts apps/cloud-gateway/src/voice/pin-capture.ts apps/cloud-gateway/src/voice/owner-access-intent.ts apps/cloud-gateway/src/voice/owner-access-service.ts apps/cloud-gateway/test/voice apps/cloud-gateway/test/security
git commit -m "feat(calls): add owner-managed guest access"
```

### Task 6F: Durable Call-Session Integration

**Files:**
- Modify: `apps/cloud-gateway/src/voice/call-session-do.ts`
- Modify: `apps/cloud-gateway/src/index.ts`
- Test: `apps/cloud-gateway/test/voice/call-session-do.test.ts`
- Test: `apps/cloud-gateway/test/security/relay-binding.test.ts`

**Interfaces:**
- Consumes: Task 6 checkpoint `e1c9ece`, access-aware `RelayBinding`, `VoiceAccessAuthorityService`, guest verifier/budgets, `OwnerAccessService`, `FourDigitPinCapture`, ConversationService, and relay lifecycle events.
- Produces: a real Durable Object that activates owners without PIN, authenticates exact guests, handles owner administration, survives replay/hibernation safely, invalidates authority on every terminal path, and exposes the reviewed terminal-callback RPC consumed by Task 8A.

**Task 6F to Task 8A termination contract:** Export the following types from `call-session-do.ts` and implement the exact Durable Object method on `CallSession`:

```ts
export type CallSessionTerminalPhase = "completed" | "failed";

export interface CallSessionTermination {
  readonly sessionId: Ulid;
  readonly phase: CallSessionTerminalPhase;
  readonly reason: "provider_callback";
}

export interface CallSessionTerminationResult {
  readonly sessionId: Ulid;
  readonly terminalPhase: CallSessionTerminalPhase;
  readonly invalidated: boolean;
}

export class CallSession extends DurableObject<Env> {
  terminate(input: CallSessionTermination): Promise<CallSessionTerminationResult>;
}
```

`terminate` accepts only exact own-data input for this named object (`input.sessionId === this.ctx.id.name`). It atomically terminalizes the matching call/session authority and clears relay/PIN/proposal state before returning `{ sessionId, terminalPhase: input.phase, invalidated: true }`. A replay with the same terminal phase and reason is idempotent and returns the same IDs/phase with `invalidated: false`; a different terminal phase or malformed input fails closed without changing state. Task 6 owns this RPC and its Durable Object tests. Task 8 owns the Worker-side `DurableObjectCallSessionTerminator` adapter: it obtains `env.CALL_SESSION.get(env.CALL_SESSION.idFromName(input.sessionId))`, calls that stub's `terminate(input)`, and passes the adapter into route construction. No callback handler calls a Durable Object before the callback recorder's D1 transaction commits.

- [ ] **Step 1: Preserve checkpoint behavior and write failing access-state tests**

Keep the checkpoint's relay setup, exact named-object initialization, one-live-socket rule, frame bounds, partial-prompt suppression, streaming, interruption, cancellation, and durable hydration tests. Replace only global-PIN expectations and add:

```ts
it("moves an active owner from relay setup to active with zero PIN work", async () => {
  const harness = await ownerHarness();
  await harness.instance.handleRelayEvent(relaySetup(harness.stored));
  expect(harness.instance.phase).toBe("active");
  expect(harness.guestAuthentication.authenticate).not.toHaveBeenCalled();
  expect(harness.relay.messages).not.toContainEqual(expect.stringMatching(/pin|passcode/iu));
});

it("authenticates only the bound guest grant and rechecks it before conversation", async () => {
  const harness = await guestHarness({ pin: "4827", capabilities: ["conversation.basic"] });
  await harness.instance.handleRelayEvent(relaySetup(harness.stored));
  for (const digit of ["4", "8", "2", "7"] as const) await harness.instance.handleRelayEvent({ type: "dtmf", digit });
  expect(harness.instance.phase).toBe("active");
  await harness.revokeGrant();
  await expect(harness.instance.handleRelayEvent({ type: "prompt", last: true, lang: "en-US", text: "hello" }))
    .rejects.toThrow("call_authority_stale");
  expect(harness.conversation.handleTurn).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run session tests and verify RED**

Run: `pnpm exec vitest --config vitest.workspace.ts run apps/cloud-gateway/test/voice/call-session-do.test.ts apps/cloud-gateway/test/security/relay-binding.test.ts`

Expected: FAIL because the checkpoint still uses the global eight-digit PIN and PIN-backed owner activation.

- [ ] **Step 3: Replace the checkpoint's authentication center with the exact interaction union**

```ts
type CallInteraction =
  | Readonly<{ kind: "owner_enrollment" }>
  | Readonly<{ kind: "guest_pin" }>
  | Readonly<{ kind: "conversation" }>
  | Readonly<{ kind: "owner_access_pin"; proposal: PreparedOwnerAccessProposal }>
  | Readonly<{ kind: "owner_access_confirmation"; proposal: PreparedOwnerAccessProposal; pinSelection: OwnerPinSelection | null }>;
```

On valid first relay setup, always preserve `created -> connecting -> pre_auth`. Then:

- active owner: mint/revalidate owner authority, transition `pre_auth -> authenticated -> active`, and emit no PIN prompt;
- pending owner enrollment: capture only the existing six-digit signed local challenge, confirm the owner identity, and end the activation-only call;
- guest: capture DTMF or strict final spoken four digits, reserve one existing attempt budget per complete candidate, verify only the bound grant record, terminate after three failures, and atomically mint guest authority on success;
- active conversation: call `authority.authorize(this.#authority, "conversation.basic", now)` before context/model/conversation work;
- active owner administration: intercept only a recognized `OwnerAccessDraft`; otherwise use ordinary conversation;
- owner PIN selection: accept DTMF, strict spoken digits, or exact `use the default`, then enter confirmation;
- owner confirmation: accept only exact normalized `confirm` or `cancel` while the issued proposal is current.

- [ ] **Step 4: Add interruption, hibernation, expiry, restart, and terminal-RPC tests**

Prove that partial/final prompts in PIN states never call ConversationService; `confirm` during normal conversation cannot mutate; interruption/new proposal/socket close/provider error/setup failure/DO restart clears PIN bytes and proposal authority; a rehydrated `active` D1 phase does not itself mint authority; current owner/guest lineage can rehydrate through `VoiceAccessAuthorityService`; exact 30-minute expiry transitions to `expired`; and terminal callbacks invalidate authority. Add an exact RPC test: `terminate({ sessionId, phase: "completed", reason: "provider_callback" })` returns `{ sessionId, terminalPhase: "completed", invalidated: true }`, clears authority, and the identical replay returns the same session/phase with `invalidated: false`; `phase: "failed"` after the completed result rejects without changing the completed state.

Run: `pnpm exec vitest --config vitest.workspace.ts run apps/cloud-gateway/test/voice/call-session-do.test.ts apps/cloud-gateway/test/security/relay-binding.test.ts`

Expected: PASS with all original checkpoint relay/lifecycle cases retained.

- [ ] **Step 5: Export the real Durable Object and run Task 6 gates**

Replace the stub export in `index.ts` with the reviewed `CallSession` from `call-session-do.ts`. Keep Worker HTTP routing separate until Task 8. Run:

`pnpm exec vitest --config vitest.workspace.ts run apps/cloud-gateway/test/voice/call-session-do.test.ts apps/cloud-gateway/test/security/relay-binding.test.ts apps/cloud-gateway/test/security/guest-pin-verifier.test.ts apps/cloud-gateway/test/security/voice-access-authority.test.ts apps/cloud-gateway/test/security/owner-access-security.test.ts apps/cloud-gateway/test/persistence/voice-access-repository.test.ts apps/cloud-gateway/test/persistence/call-session-repository.test.ts`

Run: `pnpm test:cloud && pnpm typecheck && pnpm lint && pnpm audit --audit-level high`

Expected: every command PASS; no live smoke command runs.

- [ ] **Step 6: Commit Task 6F**

```bash
git add apps/cloud-gateway/src/index.ts apps/cloud-gateway/src/voice/call-session-do.ts apps/cloud-gateway/test/voice/call-session-do.test.ts apps/cloud-gateway/test/security/relay-binding.test.ts
git commit -m "feat(calls): enforce owner and guest relay access"
```

### Task 8A: Worker Routes, Recipient Resolution, and Terminal Callbacks

**Files:**
- Modify: `apps/cloud-gateway/src/http/voice-routes.ts`
- Modify: `apps/cloud-gateway/src/http/voice-route-construction.ts`
- Modify: `apps/cloud-gateway/src/http/voice-callbacks.ts`
- Modify: `apps/cloud-gateway/src/http/voice-callback-recorder.ts`
- Modify: `apps/cloud-gateway/src/voice/outbound-recipient-lookup.ts`
- Modify: `apps/cloud-gateway/src/voice/inbound.ts`
- Modify: `apps/cloud-gateway/src/voice/outbound.ts`
- Modify: `apps/cloud-gateway/src/index.ts`
- Modify: `apps/cloud-gateway/wrangler.toml`
- Test: `apps/cloud-gateway/test/http/voice-routes.test.ts`
- Test: `apps/cloud-gateway/test/http/voice-route-construction.test.ts`
- Test: `apps/cloud-gateway/test/http/voice-callbacks.test.ts`
- Test: `apps/cloud-gateway/test/http/voice-callback-recorder.test.ts`
- Test: `apps/cloud-gateway/test/voice/outbound-recipient-lookup.test.ts`

**Interfaces:**
- Consumes: the complete reviewed Task 6D–6F tip (not the Task 6A–6C-only commit `6060570`), `VoiceAccessCandidate`, access-aware `RelayBinding`, `CallSession` initializer/termination RPC, `CallRepository`, signed Twilio verifier, and Task 8 checkpoint commits `06d3298` plus `91a7a9b`.
- Produces: real Worker routing for the fixed public voice routes, classified owner/guest recipient resolution, atomic terminal callback disposition, and Durable Object invalidation.

- [ ] **Step 1: Integrate the reviewed Task 8 checkpoint commits**

Rebase or cherry-pick these checkpoints only after the complete Task 6D–6F tip is reviewed. Retain Task 6's real `CallSession` export while resolving `index.ts`; never restore the checkpoint stub or its permanently unavailable route dependencies.

```bash
git cherry-pick 06d3298d492bb18cea9397ab7c8900b00452f4fa
git cherry-pick 91a7a9b55473fd9ffe30a742f33ddb4664107e7c
```

Run: `pnpm exec vitest --config vitest.workspace.ts run apps/cloud-gateway/test/http/voice-routes.test.ts apps/cloud-gateway/test/http/voice-route-construction.test.ts apps/cloud-gateway/test/http/voice-callbacks.test.ts apps/cloud-gateway/test/http/voice-callback-recorder.test.ts apps/cloud-gateway/test/voice/outbound-recipient-lookup.test.ts`

Expected: the checkpoint tests PASS before owner/guest adaptation.

Keep focused route-boundary coverage for the fail-closed capacity guard before the inbound handler:

```ts
it("fails closed at the inbound capacity guard before calling the handler", async () => {
  const inbound = vi.fn(async () => new Response("unexpected"));
  const response = await routeVoiceRequest(inboundRequest(), dependencies({
    capacity: { assertAcceptingNewTurn: async () => { throw new Error("full"); } },
    inbound,
  }));
  expect(response.status).toBe(503);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(inbound).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Write failing access-aware route tests**

```ts
it("resolves the configured owner and exact guest grant without exposing access metadata", async () => {
  await expect(lookup.resolveAccessCandidate(OWNER_IDENTITY_ID, now)).resolves.toMatchObject({ kind: "owner" });
  await expect(lookup.resolveAccessCandidate(GUEST_IDENTITY_ID, now)).resolves.toMatchObject({
    kind: "guest", grantId: GRANT_ID, grantVersion: 1,
  });
  await expect(lookup.resolveAccessCandidate(UNGRANTED_IDENTITY_ID, now)).resolves.toBeNull();
});

it("forwards every access dependency through route construction", async () => {
  const routes = constructVoiceRoutes(dependencies);
  await routes(new Request("https://jarvis.invalid/voice/inbound", signedPost));
  expect(dependencies.inbound).toHaveBeenCalledWith(expect.any(Request), expect.objectContaining({
    ownerVoiceIdentityId: OWNER_IDENTITY_ID,
    access: dependencies.access,
  }));
});
```

- [ ] **Step 3: Run route tests and verify RED**

Run: `pnpm exec vitest --config vitest.workspace.ts run apps/cloud-gateway/test/http/voice-route-construction.test.ts apps/cloud-gateway/test/voice/outbound-recipient-lookup.test.ts`

Expected: FAIL because the checkpoint manually reconstructs old fields and the recipient lookup returns only a bare identity ID.

- [ ] **Step 4: Implement exact access-aware route construction**

```ts
export interface OutboundRecipientAccessLookup {
  resolveAccessCandidate(identityId: string, now: Date): Promise<VoiceAccessCandidate | null>;
}

export interface CallSessionInitialization {
  readonly sessionId: Ulid;
  readonly binding: RelayBinding;
  readonly relaySetupExpiresAt: string | null;
}
```

The candidate is already frozen into `binding`; do not pass a second mutable candidate object. `voice-route-construction.ts` must explicitly snapshot and forward `ownerVoiceIdentityId`, access repository/service, initializer, callback recorder, and session terminator. Preserve only these public routes: `POST /voice/inbound`, `POST /voice/outbound/:attemptId`, `POST /voice/status/:attemptId`, `POST /voice/relay-ended`, and signed WebSocket `GET /voice/relay/:sessionId`. No access kind, grant, permission, PIN, phone number, or purpose appears in TwiML or a URL.

- [ ] **Step 5: Write failing callback invalidation tests**

```ts
it("atomically terminalizes and invalidates on terminal callbacks", async () => {
  const disposition = await recorder.record(completedStatusCallback());
  expect(disposition).toEqual({ localSessionId: SESSION_ID, terminalPhase: "completed" });
  await terminator.terminate({ sessionId: SESSION_ID, phase: "completed", reason: "provider_callback" });
  expect(sessionStub.terminate).toHaveBeenCalledWith({
    sessionId: SESSION_ID, phase: "completed", reason: "provider_callback",
  });
});

it("does not invalidate on nonterminal callbacks", async () => {
  const disposition = await recorder.record(ringingStatusCallback());
  expect(disposition).toEqual({ localSessionId: SESSION_ID, terminalPhase: null });
  expect(sessionStub.terminate).not.toHaveBeenCalled();
});

it("accepts a valid initiated callback without terminalizing the session", async () => {
  const disposition = await recorder.record(initiatedStatusCallback());
  expect(disposition).toEqual({ localSessionId: SESSION_ID, terminalPhase: null });
  expect(terminator.terminate).not.toHaveBeenCalled();
  expect(sessionStub.terminate).not.toHaveBeenCalled();
});
```

- [ ] **Step 6: Implement terminal callback disposition**

```ts
export type VoiceCallbackDisposition = Readonly<{
  localSessionId: Ulid | null;
  terminalPhase: "completed" | "failed" | null;
}>;

export interface TwilioCallbackRecorder {
  record(input: TwilioCallbackRecord): Promise<VoiceCallbackDisposition>;
}

export interface CallSessionTerminator {
  terminate(input: CallSessionTermination): Promise<CallSessionTerminationResult>;
}
```

Import `CallSessionTermination` and `CallSessionTerminationResult` from Task 6's `call-session-do.ts`; do not duplicate their fields. Persist the provider event and matching terminal D1 transition atomically. After commit, notify the named Durable Object through the Task 8-owned `DurableObjectCallSessionTerminator`; identical callback replay returns the same disposition and retries the idempotent termination RPC. Relay-ended and terminal status callbacks invalidate authority; valid initiated/ringing/answered callbacks return `204`, record their nonterminal event, and do not call the terminator. Callback records retain no direct phone, grant, permission, PIN, transcript, provider body, or raw error.

- [ ] **Step 7: Wire the real Worker and run Task 8A gates**

Make `index.ts` call `routeVoiceRequest` and re-export the real Task 6 `CallSession`. Construct D1 repositories, access resolver, Twilio verifier, callback recorder, and Durable Object adapters from private bindings. `wrangler.toml` declares names but no secret values.

Run: `pnpm exec vitest --config vitest.workspace.ts run apps/cloud-gateway/test/http/voice-routes.test.ts apps/cloud-gateway/test/http/voice-route-construction.test.ts apps/cloud-gateway/test/http/voice-callbacks.test.ts apps/cloud-gateway/test/http/voice-callback-recorder.test.ts apps/cloud-gateway/test/voice/outbound-recipient-lookup.test.ts apps/cloud-gateway/test/http/inbound-voice.test.ts apps/cloud-gateway/test/voice/outbound.test.ts`

The focused route suite must include the capacity-guard-before-handler case, and the focused callback suites must include the valid `initiated` nonterminal case above.

Run: `pnpm typecheck && pnpm lint`

Expected: all commands PASS.

- [ ] **Step 8: Commit Task 8A**

```bash
git add apps/cloud-gateway/src apps/cloud-gateway/test apps/cloud-gateway/wrangler.toml
git commit -m "feat(calls): route owner and guest voice access"
```

### Task 8B: Credential-Free Voice Access Acceptance

**Files:**
- Modify: `tests/acceptance/fake/voice-call-system.ts`
- Modify: `tests/acceptance/fake/voice-call-path.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: the real signed route boundary, Task 6 session/access services, Task 8 callbacks, fake Twilio/model/conversation providers, and synthetic fixtures only.
- Produces: the permanent `test:voice-access` release prerequisite covering owner, guest, unknown, revocation, permission, and memory isolation.

- [ ] **Step 1: Write failing fake end-to-end scenarios**

```ts
it("runs PIN-free owner and isolated guest calls through the real route/session boundary", async () => {
  const system = await FakeVoiceCallSystem.create();
  const owner = await system.inboundOwner({ turns: ["owner turn"] });
  expect(owner).toMatchObject({ phase: "completed", pinPrompts: 0, pinAttempts: 0 });
  const guest = await system.inboundGuest({ guest: "guest-a", pin: "4827", turns: ["guest turn"] });
  expect(guest).toMatchObject({ phase: "completed", principalId: system.guestPrincipalId("guest-a") });
  expect(system.modelPrincipalIds()).not.toContain(system.ownerPrincipalId());
});

it("rejects unknown, cross-PIN, revoked, and absent-capability paths before effects", async () => {
  const system = await FakeVoiceCallSystem.create();
  await expect(system.inboundUnknown()).resolves.toMatchObject({ status: 403, relaySessions: 0, pinAttempts: 0 });
  await expect(system.inboundGuest({ guest: "guest-a", pin: system.pinFor("guest-b"), turns: [] }))
    .resolves.toMatchObject({ authenticated: false });
  const authority = await system.authenticateGuest("guest-a");
  await system.revoke("guest-a");
  await expect(system.invoke(authority, "research.web")).rejects.toThrow("call_authority_stale");
  expect(system.effectCalls()).toEqual([]);
});
```

- [ ] **Step 2: Run acceptance test and verify RED**

Run: `pnpm exec vitest --config vitest.workspace.ts run tests/acceptance/fake/voice-call-path.test.ts`

Expected: FAIL because the checkpoint harness stops before Task 6 activation and covers only owner-to-owner outbound routing.

- [ ] **Step 3: Extend the fake system through real boundaries**

Seed one configured owner, two guests with distinct synthetic PINs and permissions, one active-but-ungranted identity, and one unknown number. Drive signed inbound/outbound requests through `routeVoiceRequest`, real D1 admission, the real Durable Object/access boundary, fake ConversationRelay events, callbacks, and terminal invalidation. Expose only safe aggregate observations; fixture helpers may know synthetic numbers/PINs but must never serialize them into events/evidence.

Required scenarios are: PIN-free owner inbound and outbound; Guest A exact PIN; Guest B PIN/cross-session proof rejection; unknown and active-ungranted pre-relay rejection; pending first-use activation; permission allow/deny; in-flight version/revocation invalidation; guest memory principal isolation; terminal callback invalidation; and no four-digit candidate in TwiML/events/logs/model/transcript/memory/errors.

- [ ] **Step 4: Add the permanent fake release prerequisite**

```json
{
  "scripts": {
    "test:voice-access": "vitest --config vitest.workspace.ts run tests/acceptance/fake/voice-call-path.test.ts"
  }
}
```

- [ ] **Step 5: Run Task 8B gates**

Run: `pnpm test:voice-access && pnpm test:acceptance && pnpm typecheck && pnpm lint`

Expected: all commands PASS with no network/provider calls.

- [ ] **Step 6: Commit Task 8B**

```bash
git add tests/acceptance/fake package.json
git commit -m "test(calls): prove owner and guest voice access"
```

### Task 9: Release Evidence and Operator Runbook Adaptation

**Files:**
- Modify: `tests/acceptance/live/voice-smoke.ts`
- Modify: `tests/acceptance/live/voice-smoke.test.ts`
- Modify: `tests/acceptance/live/voice-smoke-cli.mjs` only if its exact schema-version check requires it
- Modify: `package.json`
- Modify: `README.md`
- Modify: `TESTING.md`
- Modify: `docs/runbooks/voice-smoke.md`

**Interfaces:**
- Consumes: reviewed Task 9 commits `911d96a`, `c000980`, `60ee428`, Task 8 fake access gate, and safe aggregate route/session outcomes.
- Produces: evidence schema `1.2`, PIN-free owner live scenarios, pre-relay unknown rejection evidence, and a release gate that always runs the credential-free owner/guest matrix first.

- [ ] **Step 1: Integrate the independently approved Task 9 commits**

```bash
git cherry-pick 911d96a2b81a6da562b90067a280dbfc21374264
git cherry-pick c0009809aef4bfc8e1f5b5b216bb0bad54df2a03
git cherry-pick 60ee4285cc2fe33cd748cc22f3f6eba5a55ac8a1
```

Run: `pnpm test:voice-smoke && pnpm typecheck`

Expected: 22 focused tests PASS and mixed-commit evidence remains rejected.

- [ ] **Step 2: Write failing schema-1.2 evidence tests**

```ts
it("requires PIN-free owner evidence for live inbound and answered outbound", () => {
  expect(validateEvidence({
    ...inboundEvidence, schemaVersion: "1.2", authenticationMode: "owner_identity_pin_free",
    pinPromptCount: 0, pinAttemptCount: 0,
  })).toBe(true);
  expect(() => validateEvidence({ ...inboundEvidence, schemaVersion: "1.2", pinPromptCount: 1 }))
    .toThrow("unsafe_or_incomplete_evidence");
});

it("requires unknown callers to stop before relay and PIN handling", () => {
  expect(validateEvidence({
    ...unauthorizedEvidence, schemaVersion: "1.2", conversationRelaySessions: 0,
    pinPromptCount: 0, pinAttemptCount: 0,
  })).toBe(true);
});
```

- [ ] **Step 3: Run smoke tests and verify RED**

Run: `pnpm test:voice-smoke`

Expected: FAIL because schema `1.1` lacks the owner authentication mode and zero-count requirements.

- [ ] **Step 4: Adapt the closed evidence schema**

Keep the existing five scenario filenames. Bump `schemaVersion` to `1.2`. Require `authenticationMode: "owner_identity_pin_free"`, `pinPromptCount: 0`, and `pinAttemptCount: 0` for `inbound` and `outbound-answer`. Require `conversationRelaySessions: 0`, `pinPromptCount: 0`, and `pinAttemptCount: 0` for `unauthorized-caller`. Retain one exact commit SHA across all records, the reviewed Task 5 `voice_sent`/failure shapes, latency/turn thresholds, exact-key rejection, and every unsafe-field denial. Reject schema `1.1`, any guest/live PIN field, any access identifier, and any direct phone number.

`validateSecretPresence` removes retired `PIN_VERIFIER_JSON`, requires `GUEST_PIN_PEPPER_V1`, and separately requires configuration name `OWNER_VOICE_IDENTITY_ID` without reading or retaining its value. `DEFAULT_GUEST_PIN` is not required for live smoke because explicit per-guest PINs remain supported and no live guest scenario is required.

- [ ] **Step 5: Make the fake access matrix block the release gate**

```json
{
  "scripts": {
    "release:voice-gate": "pnpm test:voice-access && node tests/acceptance/live/voice-smoke-cli.mjs --audit-evidence"
  }
}
```

The default non-live command remains skipped; the audit remains blocked until all five validated records exist. No implementation task may generate them with real calls.

- [ ] **Step 6: Update operator documentation and run Task 9 gates**

Document that owner calls have zero PIN interaction, guest isolation is proven offline, unknown callers never reach relay, every charged live scenario requires explicit authorization, private values are entered only through approved secret/configuration flows, and cleanup removes only the five evidence JSON files.

Run: `pnpm test:voice-smoke && pnpm smoke:voice -- --scenario inbound && pnpm typecheck && pnpm lint`

Expected: tests/type/lint PASS and the non-live smoke command reports `skipped` without calling a driver.

- [ ] **Step 7: Commit Task 9 adaptation**

```bash
git add tests/acceptance/live package.json README.md TESTING.md docs/runbooks/voice-smoke.md
git commit -m "test(calls): align voice release evidence with access roles"
```

### Task 10: Contract Alignment, Whole-Branch Review, and Release Gates

**Files:**
- Modify: `docs/superpowers/specs/2026-08-29-jarvis-foundation-design.md`
- Modify: `docs/superpowers/plans/2026-08-29-jarvis-calling.md`
- Modify: `docs/superpowers/plans/2026-08-29-jarvis-foundation-cloud.md`
- Modify: `docs/superpowers/plans/2026-08-29-jarvis-telegram-memory-release.md`
- Modify: `REQUIREMENTS.md`

**Interfaces:**
- Consumes: reviewed Tasks 6, 8, and 9 at one candidate commit.
- Produces: one non-contradictory contract set, fresh whole-branch security review, and complete offline release evidence.

- [ ] **Step 1: Replace every retired call-PIN rule in current documentation**

State exactly: configured owner identity bypasses recurring PIN; owner enrollment uses the signed local-device challenge; provisioned guests use per-grant four-digit verification; unknown callers stop before relay; optional default guest PIN only seeds a grant-bound verifier; and live guest calls are not required for the first release gate. Remove `PIN_VERIFIER_JSON` from current setup/runbook instructions and add the private binding names without values.

- [ ] **Step 2: Run stale-contract and unsafe-value scans**

Run: `rg -n -S "eight-digit|8-digit|PIN_VERIFIER_JSON|every inbound.*PIN|every outbound.*PIN" REQUIREMENTS.md docs README.md TESTING.md apps packages tests`

Expected: only explicitly labeled historical/superseded discussion or negative regression fixtures remain.

Run: `git diff --check && git status --short`

Expected: no whitespace errors and only intentional tracked changes before commit.

- [ ] **Step 3: Commit documentation alignment**

```bash
git add REQUIREMENTS.md docs README.md TESTING.md
git commit -m "docs(calls): align owner and guest authentication contracts"
```

- [ ] **Step 4: Run the complete fresh gate set**

Run: `pnpm test:voice-access`

Run: `pnpm test:voice-smoke`

Run: `pnpm test:cloud`

Run: `pnpm test:acceptance`

Run: `pnpm test`

Run: `pnpm typecheck`

Run: `pnpm lint`

Run: `pnpm audit --prod --audit-level high`

Run: `git diff --check`

Expected: every automated test/type/lint/audit/diff command PASS. `pnpm smoke:voice -- --scenario inbound` remains `skipped`, and `pnpm release:voice-gate` remains blocked without separately authorized live evidence.

- [ ] **Step 5: Dispatch one fresh whole-branch security reviewer**

The reviewer receives the base/candidate SHAs, approved design, this plan, full diff, and fresh gate logs. It must inspect owner identity spoofing, unknown pre-relay rejection, grant/PIN cross-use, proposal replay, nominal proof forgery, expiry boundaries, D1 direct-write bypass, outbound destination-principal isolation, callback invalidation, secret/PII leakage, and evidence integrity. Critical or Important findings return to the owning implementer and require a fresh scoped re-review.

- [ ] **Step 6: Verify the final candidate and push the private branch**

Run the affected focused suites plus `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm audit --prod --audit-level high`, `git diff --check`, and `git status --short --branch` after the final fix. Push only the reviewed private feature branch. Do not deploy or place a call.
