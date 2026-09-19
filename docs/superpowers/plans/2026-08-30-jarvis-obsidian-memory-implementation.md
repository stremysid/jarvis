> **Superseded - read this before using this document.** Its remaining work
> should not be executed as written. [the roadmap](../plan/2026-09-03-jarvis-roadmap.md)
> section 6 records the disposition:
>
> Historical implementation based on an unconfirmed editable-notes premise. Keep the code, but build no Obsidian path in R2. Only compatibility with a later one-way export remains current.
>
> Kept rather than deleted, as section 6 instructs. Current state is
> [docs/STATE.md](../STATE.md); what is in flight is [docs/QUEUE.md](../QUEUE.md).

# Jarvis Obsidian Memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a required, root-confined Obsidian memory adapter to Jarvis 0.1.0 while preserving the immutable archive, source-backed fact authority, cloud-model boundary, and write-once filesystem policy.

**Architecture:** The Cloudflare gateway accepts only device-signed, versioned vault commands and commits sequenced observation events, authority decisions, quotas, heads, and outbox state atomically. The Windows Python agent owns an NTFS-only vault through a pinned Rust/PyO3 bridge, appends local observations into the existing archive database, exposes deterministic local search, and projects only separately authorized facts or captures as new Markdown files. The legacy Telegram/memory plan remains the baseline for the local agent, archive, semantic index, facts, service, and release harness; this plan supplies the missing Obsidian contracts and interleaves its tasks at explicit dependency gates.

**Tech Stack:** TypeScript 7, Node.js 24.19.x, pnpm 11.19.0, Cloudflare Workers/D1/R2, Vitest/Miniflare, Python 3.14.7 (`requires-python >=3.12,<3.15`), SQLite/FTS5, pytest, Rust 1.98.0, PyO3 0.29.2 ABI3 for Python 3.12+, `windows` 0.62.2, `winapi` 0.3.9, maturin 1.15.0, PowerShell 7.6+, NTFS USN Journal, Windows Cloud Files API, and VSS.

**Spec:** `docs/superpowers/specs/2026-08-30-jarvis-obsidian-memory-design.md`

## Global Constraints

- This plan supersedes the Obsidian hard block in `docs/superpowers/plans/2026-08-29-jarvis-telegram-memory-release.md`; both plans execute through the combined graph below, and neither can certify 0.1.0 alone.
- Foundation and calling code through `codex/task-6-relay-session-core` remain authoritative until the voice-consolidation task produces one reviewed integration branch. Do not wire `apps/cloud-gateway/src/index.ts` from this plan before that consolidation lands.
- Every cross-boundary payload uses a supported major schema, lowercase ULIDs, RFC 3339 UTC timestamps with milliseconds, Unicode NFC, RFC 8785 canonical JSON, SHA-256 over canonical post-redaction payloads, source/subject/correlation/causation IDs, redaction metadata, and producer version.
- `contentType` remains `application/json`; semantic discriminators use `eventType` or `commandType`, including `vault.note.observed.v1`.
- Current signed-request verification retains its 64 KiB per-command-body cap. A vault batch contains at most 16 independently signed and independently verified commands, at most 256 KiB canonical note text, and at most 512 KiB encoded outer body. Do not raise the global verifier limit.
- Cloud note text is at most 32 KiB. A local Markdown file is at most 1 MiB. A reconciliation slice is at most 64 changed documents or 4 MiB raw input.
- Per-vault cloud limits are 120 accepted events/2 MiB per rolling minute, 10,000 events/64 MiB per UTC day, and 250,000 retained events/2 GiB canonical text. The local upload queue is at most 10,000 materialized requests or 256 MiB canonical request text.
- `SensitivityV1` is closed to `personal | restricted`; absent or unknown values fail closed.
- Raw paths never cross the local protected mapping boundary. Cloud payloads, model inputs, logs, diagnostics, and release evidence carry opaque IDs and redacted labels only.
- A local-only or unbound vault observation is available only through deterministic `jarvis vault search/show`; it cannot reach DeepSeek, calls, Telegram, fact promotion, permissions, policy, identity, or tools.
- The adapter never replaces, renames, moves, or deletes an existing file. It publishes new files only through handle-relative create-new operations while holding no-delete-sharing namespace fences through durable receipt commit.
- The configured vault must be local NTFS, outside Git repositories/worktrees, cloud-sync roots, reparse roots, credential/protected-data trees, and backup staging trees. The existing `C:\javis\Jarvis` seed vault is never adopted, imported, moved, overwritten, or deleted by Jarvis.
- The reference vault is derived from the Windows Profile Known Folder and resolves to `C:\Users\Ksid1\Jarvis Vault`; the fixed fallback is `%LOCALAPPDATA%\Jarvis\Vault`.
- Obsidian 1.13.7 is currently installed at `C:\Program Files\Obsidian\Obsidian.exe` with a valid `Dynalist Inc` signature. Do not store the signed-in account identity or change Sync, publishing, plugin, or account settings.
- `ArchiveDatabase` owns both immutable archive records and vault operational tables so observation append, generation staging, and head changes can share one SQLite transaction. Rebuildable FTS/vector indexes remain derived state.
- Native release wheels are built once, hash-pinned, Authenticode-scanned, and bundled. End-user setup never requires Rust, Visual Studio, maturin, or network compilation.
- Rust dependencies use exact `=` versions and `Cargo.lock`; Python uses `pip --require-hashes`; npm uses the committed `pnpm-lock.yaml`.
- VSS tests that require backup privileges use an explicit `windows_elevated` marker. Credential-free CI must pass mocks and capability-denial tests; the reference-machine release gate must also pass the elevated real snapshot-set test.
- No credential, PIN, phone number, account email, bearer token, private key, or derived fingerprint enters source, Git, fixtures, logs, screenshots, Markdown projections, or release evidence.
- Live Twilio/Telegram tests are authorized only between the configured Jarvis identities and Sid's configured verified identities, after every credential-free gate passes. They remain bounded and never target third parties or purchase resources.
- Each task follows red-green-refactor, runs its focused tests before the full affected suite, receives independent spec-compliance and code-quality review, and commits only its named file set.

## Combined Execution Graph

```text
Voice branch consolidation
          |
Legacy Tasks 1-3 (Telegram/shared conversation)
          |
          +--> O1 shared vault contracts
                    |
                    +--> O2 cloud ingest authority --> O3 observation ledger --> O4 routes
                    |
Legacy Task 4 ------+--> O5 native Windows bridge --> O6 vault identity/setup repository
Legacy Tasks 5-6 ------------------------------+-----> O7 reconciliation/archive/indexing
Legacy Task 7 ---------------------------------+-----> O8 deterministic retrieval + sync client
Legacy Task 8 + O3 + O8 ------------------------------> O9 fact authority + projection
O6 ---------------------------------------------------> O10 setup/doctor/closed-app handoff
Legacy Task 9 + O7 + O9 ------------------------------> O11 coordinated backup/restore
Legacy Task 10 + all above ---------------------------> O12 acceptance/release audit/live smoke
```

Tasks O2 and O5 may run in parallel after O1 and legacy Task 4 prerequisites are available. O3 follows O2. O6 follows O5 plus legacy Task 4. O10 follows O6 and may run in parallel with O7/O8. O9 waits for the baseline fact/memory interfaces from legacy Task 8. O11 and O12 are integration tasks and run only after their full predecessor sets are merged.

## File Structure

| Path | Responsibility |
|---|---|
| `packages/contracts/src/command-envelope.ts` | Shared signed command envelope creation/validation. |
| `packages/contracts/src/vault.ts` | Vault observations, decisions, batch results, retrieval, and lineage contracts. |
| `packages/contracts/schemas/*vault*.json` | Versioned JSON schemas used by TypeScript/Python parity fixtures. |
| `apps/cloud-gateway/src/vault/*.ts` | Cloud authority, observation, quota, provenance, and fact-transition services. |
| `apps/cloud-gateway/src/persistence/migrations/0008_*.sql`, `0009_*.sql`, `0011_*.sql` | Vault D1 authority, observation, and fact-authority state. Migration `0010` remains reserved for baseline memory. |
| `apps/cloud-gateway/src/http/vault-*.ts` | Signed vault authority, batch, and equality routes. |
| `apps/local-agent/native/jarvis-vault-native/*` | Pinned Windows/PyO3 bridge for Known Folders, NTFS identity/fences, USN, no-replace publication, Cloud Files checks, and VSS. |
| `apps/local-agent/jarvis_local/vault/models.py` | Frozen local vault types mirroring shared contracts. |
| `apps/local-agent/jarvis_local/vault/repository.py` | Vault SQLite state machines, mappings, heads, queues, and receipts on `ArchiveDatabase`. |
| `apps/local-agent/jarvis_local/vault/reconciliation.py` | Watcher-before-crawl generations, stable reads, USN replay, and tombstones. |
| `apps/local-agent/jarvis_local/vault/indexing.py`, `retrieval.py` | Current-head FTS/semantic indexing and deterministic local CLI results. |
| `apps/local-agent/jarvis_local/vault/sync.py` | Signed bounded upload queue, equality recovery, and local binding records. |
| `apps/local-agent/jarvis_local/vault/projection.py` | Fact/capture authorization and write-once projection journal. |
| `apps/local-agent/jarvis_local/vault/setup.py`, `diagnostics.py` | Owned-root setup, Obsidian detection, closed-app handoff, and doctor checks. |
| `apps/local-agent/jarvis_local/vault/backup.py`, `restore.py` | Coordinated VSS backup, encrypted sealing, crash-delta classification, and physical rebasing. |
| `apps/local-agent/jarvis_local/vault/migrations/0003_*.sql` through `0006_*.sql` | Local setup, reconciliation, authority/projection, and recovery state. |
| `tests/acceptance/obsidian-*.py` | Local recall, confirmed cloud recall, projection, setup, and backup/restore acceptance. |
| `scripts/{bootstrap,build,test}-vault-native.ps1` | Reproducible native toolchain/build/verification. |
| `scripts/setup-obsidian-vault.ps1` | Idempotent local vault setup and doctor invocation. |

## Shared Interfaces

```ts
export type SensitivityV1 = "personal" | "restricted";
export type VaultNoteOperationV1 = "observed" | "tombstoned";
export type VaultNoteOriginV1 =
  | "user_authored"
  | "jarvis_projection"
  | "user_edited_projection";

export interface VaultNoteLocalObservationV1 {
  readonly schemaVersion: "1.0";
  readonly observationId: Ulid;
  readonly vaultId: Ulid;
  readonly documentId: Ulid;
  readonly documentVersion: number;
  readonly operation: VaultNoteOperationV1;
  readonly previousObservationId: Ulid | null;
  readonly previousContentHash: Sha256Hex | null;
  readonly derivedFromObservationId: Ulid | null;
  readonly canonicalText: string;
  readonly canonicalContentHash: Sha256Hex;
  readonly observedAt: string;
  readonly sensitivity: SensitivityV1;
  readonly redaction: { readonly status: "none" | "redacted"; readonly markers: readonly string[] };
  readonly origin: VaultNoteOriginV1;
  readonly projectionOperationId: Ulid | null;
  readonly projectionReceiptId: Ulid | null;
  readonly displayLabel: string;
}

export interface VaultNoteSubmitV1 {
  readonly schemaVersion: "1.0";
  readonly observation: VaultNoteLocalObservationV1;
  readonly localArchiveEnvelopeId: Ulid;
  readonly localArchiveEnvelopeHash: Sha256Hex;
  readonly observationPayloadHash: Sha256Hex;
  readonly cloudIngestDecisionId: Ulid;
  readonly cloudIngestDecisionEventId: Ulid;
  readonly cloudIngestDecisionSequence: number;
  readonly cloudIngestDecisionHash: Sha256Hex;
}
```

```python
class WindowsVaultKernel(Protocol):
    def known_folder(self, folder: Literal["profile", "local_app_data"]) -> Path: ...
    def inspect_root(self, path: Path, *, denied_roots: Sequence[Path]) -> RootInspection: ...
    def begin_owned_tree(self, parent: Path, components: tuple[str, ...], *, setup_id: str) -> OwnedTreeLease: ...
    def open_owned_root(self, path: Path, *, expected_identity: NtfsIdentity, expected_final_path: str) -> RootLease: ...
    def enumerate_markdown(self, root: RootLease, *, cursor: EnumerationCursor | None, max_records: int, max_bytes: int) -> EnumerationPage: ...
    def start_watcher(self, root: RootLease, sink: DurableHintSink) -> WatcherLease: ...
    def stable_read(self, root: RootLease, candidate: FileCandidate, *, upper: JournalCheckpoint, max_bytes: int = 1_048_576, debounce_ms: int = 250) -> StableRead: ...
    def publish_new(self, root: RootLease, *, directory_parts: tuple[str, ...], temporary_name: str, final_name: str, content: bytes) -> PublishedFile: ...

class PrivilegedVaultBroker(Protocol):
    def register_owned_vault(self, elevated_request: SignedBrokerRegistration) -> BrokerRegistrationReceipt: ...
    def journal_checkpoint(self, vault_id: str) -> JournalCheckpoint: ...
    def read_journal_page(self, vault_id: str, lower: JournalCheckpoint, upper: JournalCheckpoint, *, max_records: int, max_bytes: int) -> JournalPage: ...
    def create_snapshot_set(self, component_ids: Sequence[str]) -> SnapshotSetLease: ...
    def duplicate_shadow_root(self, lease_id: str, component_id: str) -> ReadOnlyShadowRootLease: ...

class VaultLocalRetriever(Protocol):
    def search(self, query: str, *, principal_id: str, purpose: Literal["vault_cli"], limit: int, max_chars: int) -> list[VaultObservationRetrievalV1]: ...
```

---

### Task O1: Add shared command-envelope and vault contracts

**Files:**
- Create: `packages/contracts/src/command-envelope.ts`
- Create: `packages/contracts/src/vault.ts`
- Modify: `packages/contracts/src/envelope.ts:23-187`
- Modify: `packages/contracts/src/index.ts`
- Create: `packages/contracts/test/command-envelope.test.ts`
- Create: `packages/contracts/test/vault.test.ts`
- Create: `packages/contracts/schemas/vault-note-observed.v1.json`
- Create: `packages/contracts/fixtures/vault-note-observed.v1.json`

**Interfaces:**
- Consumes: `Ulid`, `Sha256Hex`, `canonicalJson`, `sha256Hex`, issued redaction tokens, and the foundation envelope invariants.
- Produces: `CommandEnvelopeV1<T>`, `createCommandEnvelope`, `validateCommandEnvelope`, `VaultNoteLocalObservationV1`, `VaultNoteSubmitV1`, `VaultNoteObservedEventV1`, all vault decision types, `VaultObservationRetrievalV1`, and strict parsers exported by `@jarvis/contracts`.

- [ ] **Step 1: Write failing envelope and vault contract tests**

```ts
it("accepts validated structural scalars but never raw note text", async () => {
  const command = await createCommandEnvelope(vaultSubmitInput({
    observationId: ulid("01k5d8s0m00000000000000001"),
    canonicalText: sanitizeRedaction("project alpha").value,
  }));
  expect(command.commandType).toBe("vault.note.submit.v1");
  await expect(createCommandEnvelope(forgedRawTextInput())).rejects.toThrow("payload text must be redacted");
});

it.each([
  projectionEcho(), nonEmptyTombstone(), over32KiB(), mismatchedContentHash(), unknownSensitivity(), rawPathField(),
])("rejects a structurally unsafe vault observation", async (payload) => {
  await expect(parseVaultNoteSubmitV1(payload)).rejects.toThrow();
});

it("round-trips the canonical fixture with the Python-compatible hash", async () => {
  const fixture = await readFixture("vault-note-observed.v1.json");
  expect(await sha256Hex(canonicalJson(fixture.payload))).toBe(fixture.expectedPayloadHash);
  await expect(parseVaultNoteObservedV1(fixture.envelope)).resolves.toMatchObject({
    eventType: "vault.note.observed.v1",
  });
});
```

- [ ] **Step 2: Run the contract tests and verify red**

Run: `pnpm --filter @jarvis/contracts test -- command-envelope.test.ts vault.test.ts`

Expected: FAIL because the command envelope, structural-scalar minting, vault types, schemas, and parsers do not exist.

- [ ] **Step 3: Implement narrow structural tokens, command envelopes, and exact vault parsers**

```ts
const structuralScalarBrand: unique symbol = Symbol("structuralScalar");
type StructuralKind = "ulid" | "sha256" | "utc_millis" | "closed_enum";
export type StructuralScalar = Readonly<{
  value: string;
  kind: StructuralKind;
  [structuralScalarBrand]: true;
}>;

export function issueStructuralScalar(kind: StructuralKind, value: unknown, allowed: readonly string[] = []): StructuralScalar {
  if (typeof value !== "string" || value !== value.normalize("NFC")) throw new TypeError("structural scalar invalid");
  if (kind === "ulid" && !/^[0-7][0-9a-hjkmnp-tv-z]{25}$/.test(value)) throw new TypeError("lowercase ULID required");
  if (kind === "sha256" && !/^[a-f0-9]{64}$/.test(value)) throw new TypeError("SHA-256 required");
  if (kind === "utc_millis" && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) throw new TypeError("UTC milliseconds required");
  if (kind === "closed_enum" && !allowed.includes(value)) throw new TypeError("closed enum required");
  return Object.freeze({ value, kind, [structuralScalarBrand]: true });
}
```

`materializePayload` recognizes only tokens minted by this module's `WeakSet`; forged objects and ordinary strings still fail. `createCommandEnvelope` freezes a canonical payload and includes `schemaVersion`, lowercase `commandId`, `commandType`, `source`, `subjectId`, `occurredAt`, local-boundary `receivedAt`, correlation/causation IDs, `contentType: "application/json"`, content hash, redaction metadata, and producer version. Vault factories mint structural tokens for IDs, hashes, timestamps, and closed enums; canonical note text and display labels must be issued redaction tokens.

```ts
export async function parseVaultNoteSubmitV1(value: unknown): Promise<VaultNoteSubmitV1> {
  const submit = exactVaultSubmit(value);
  validateObservationLineage(submit.observation);
  if (submit.observation.origin === "jarvis_projection") throw new TypeError("projection echo cannot upload");
  if (new TextEncoder().encode(submit.observation.canonicalText).byteLength > 32_768) throw new TypeError("vault text too large");
  if (await sha256Hex(canonicalJson({ text: submit.observation.canonicalText })) !== submit.observation.canonicalContentHash) {
    throw new TypeError("vault content hash mismatch");
  }
  return deepFreeze(submit);
}
```

- [ ] **Step 4: Run focused contracts, typecheck, and fixture parity**

Run: `pnpm --filter @jarvis/contracts test -- command-envelope.test.ts vault.test.ts; if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}; pnpm --filter @jarvis/contracts typecheck`

Expected: PASS; raw text/paths and forged structural tokens fail, the valid fixture produces one stable hash, and additive same-major fields remain non-executable.

- [ ] **Step 5: Commit the shared vault boundary**

```powershell
git add packages/contracts/src packages/contracts/test packages/contracts/schemas packages/contracts/fixtures
git commit -m "feat(contracts): add versioned vault command boundary"
```

### Task O2: Persist cloud-ingest grants and exact observation decisions

**Files:**
- Create: `apps/cloud-gateway/src/persistence/migrations/0008_vault_ingest_authority.sql`
- Create: `apps/cloud-gateway/src/vault/vault-authority-repository.ts`
- Create: `apps/cloud-gateway/src/vault/vault-authority-service.ts`
- Create: `apps/cloud-gateway/test/persistence/vault-authority-repository.test.ts`
- Create: `apps/cloud-gateway/test/vault/vault-authority-service.test.ts`
- Modify: `apps/cloud-gateway/test/persistence/migration.ts`
- Modify: `apps/cloud-gateway/test/persistence/migration-schema.test.ts`

**Interfaces:**
- Consumes: Task O1 command/decision contracts, `DeviceRequestVerifier`, `EventRepository`, `VerifiedDeviceRequest`, and foundation operator authority.
- Produces: `VaultAuthorityRepository`, `VaultAuthorityService.recordStandingGrant`, `recordCloudIngestDecision`, and `requireAllowedCloudIngest`.

- [ ] **Step 1: Write failing append-only authority and fail-closed policy tests**

```ts
it("does not let an ordinary standing grant cover restricted or third-party content", async () => {
  await service.recordStandingGrant(verifiedGrant({ classes: ["ordinary_personal", "ordinary_project"] }));
  await expect(service.requireAllowedCloudIngest(restrictedObservation())).rejects.toThrow("vault_ingest_exact_approval_required");
  await expect(service.requireAllowedCloudIngest(thirdPartyObservation())).rejects.toThrow("vault_ingest_exact_approval_required");
});

it("rejects a decision whose observation version or hash differs", async () => {
  const decision = await service.recordCloudIngestDecision(verifiedExactDecision());
  await expect(service.requireAllowedCloudIngest({ ...validInput(decision), observation: changedHashObservation() }))
    .rejects.toThrow("vault_ingest_decision_mismatch");
});
```

- [ ] **Step 2: Run the authority tests and verify red**

Run: `pnpm test:cloud -- persistence/vault-authority-repository.test.ts vault/vault-authority-service.test.ts`

Expected: FAIL because migration `0008`, the repository, and the policy service are absent.

- [ ] **Step 3: Add append-only event tables and current grant projection**

```sql
CREATE TABLE vault_standing_grant_events (
  grant_event_id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL,
  vault_id TEXT NOT NULL,
  grant_id TEXT NOT NULL,
  grant_version INTEGER NOT NULL CHECK (grant_version > 0),
  decision TEXT NOT NULL CHECK (decision IN ('allowed','denied','revoked')),
  classes_json TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  body_hash TEXT NOT NULL CHECK (length(body_hash) = 64),
  created_at TEXT NOT NULL,
  UNIQUE (principal_id, vault_id, grant_id, grant_version)
);
CREATE TABLE vault_standing_grants (
  principal_id TEXT NOT NULL,
  vault_id TEXT NOT NULL,
  grant_id TEXT NOT NULL,
  current_version INTEGER NOT NULL,
  current_event_id TEXT NOT NULL REFERENCES vault_standing_grant_events(grant_event_id),
  status TEXT NOT NULL CHECK (status IN ('allowed','denied','revoked')),
  PRIMARY KEY (principal_id, vault_id, grant_id)
);
CREATE TABLE vault_cloud_ingest_decisions (
  decision_id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL,
  vault_id TEXT NOT NULL,
  observation_id TEXT NOT NULL,
  document_version INTEGER NOT NULL,
  observation_payload_hash TEXT NOT NULL CHECK (length(observation_payload_hash) = 64),
  sensitivity TEXT NOT NULL CHECK (sensitivity IN ('personal','restricted')),
  result TEXT NOT NULL CHECK (result IN ('allowed','denied')),
  policy_version TEXT NOT NULL,
  authority_event_id TEXT NOT NULL,
  event_sequence INTEGER NOT NULL,
  body_hash TEXT NOT NULL CHECK (length(body_hash) = 64),
  created_at TEXT NOT NULL,
  UNIQUE (principal_id, vault_id, observation_id, body_hash)
);
```

Add no-update/no-delete triggers for event/decision rows. `vault_standing_grants` is the sole mutable projection and advances only by compare-and-swap to a higher version. The service verifies principal ownership, exact hashes, closed classes, redaction success, decision freshness, and authenticated source events before returning `VerifiedCloudIngestDecision`.

- [ ] **Step 4: Prove policy, append-only triggers, replay, and migration behavior**

Run: `pnpm test:cloud -- persistence/vault-authority-repository.test.ts vault/vault-authority-service.test.ts persistence/migration-schema.test.ts`

Expected: PASS; decisions are immutable, equality replay returns the winner, and standing grants never broaden restricted/ambiguous classes.

- [ ] **Step 5: Commit cloud-ingest authority**

```powershell
git add apps/cloud-gateway/src/persistence/migrations/0008_vault_ingest_authority.sql apps/cloud-gateway/src/vault apps/cloud-gateway/test/persistence apps/cloud-gateway/test/vault
git commit -m "feat(vault): add cloud ingest authority"
```

### Task O3: Add the atomic vault observation ledger, source heads, and quotas

**Files:**
- Create: `apps/cloud-gateway/src/persistence/migrations/0009_vault_observations.sql`
- Create: `apps/cloud-gateway/src/vault/vault-observation-repository.ts`
- Create: `apps/cloud-gateway/src/vault/vault-observation-service.ts`
- Modify: `apps/cloud-gateway/src/persistence/event-repository.ts:15-339`
- Create: `apps/cloud-gateway/test/persistence/vault-observation-repository.test.ts`
- Create: `apps/cloud-gateway/test/vault/vault-observation-service.test.ts`
- Create: `apps/cloud-gateway/test/faults/vault-observation-transaction-faults.test.ts`
- Modify: `apps/cloud-gateway/test/persistence/migration.ts`
- Modify: `apps/cloud-gateway/test/persistence/migration-schema.test.ts`

**Interfaces:**
- Consumes: Tasks O1-O2, `EventRepository`, D1 transactions, generic idempotency/outbox, and `VerifiedCloudIngestDecision`.
- Produces: `EventRepository.appendAtomicWithDependencies`, `VaultObservationRepository.appendVerified/lookupBound`, and `VaultObservationService.submit`.

- [ ] **Step 1: Write failing transaction, lineage, head, and quota tests**

```ts
it("atomically commits observation, event, quota, head, idempotency, and outbox", async () => {
  deps.failAt = "after-head-before-event";
  await expect(service.submit(validSubmission())).rejects.toThrow("simulated_transaction_failure");
  expect(await snapshotVaultState()).toEqual(emptyVaultState());
});

it("accepts a delayed predecessor as historical without rolling back the head", async () => {
  const descendant = await service.submit(validVersion(2, { predecessorBound: false }));
  const predecessor = await service.submit(validVersion(1));
  expect(descendant.status).toBe("accepted");
  expect(predecessor.disposition).toBe("historical_predecessor");
  expect(await repository.readHead(documentId)).toMatchObject({ documentVersion: 2 });
});

it("reserves concurrent event and byte quota once", async () => {
  const results = await Promise.allSettled(Array.from({ length: 121 }, () => service.submit(oneKiBSubmission())));
  expect(results.filter(isAccepted)).toHaveLength(120);
  expect(results.filter(hasRetryAfter)).toHaveLength(1);
});
```

- [ ] **Step 2: Run the ledger tests and verify red**

Run: `pnpm test:cloud -- persistence/vault-observation-repository.test.ts vault/vault-observation-service.test.ts faults/vault-observation-transaction-faults.test.ts`

Expected: FAIL because migration `0009`, dependency-aware event append, vault heads, and quota reservations are absent.

- [ ] **Step 3: Implement bounded dependency append and vault tables**

```ts
async appendAtomicWithDependencies(input: EventAppendInput, build: AtomicDependencyBuilder): Promise<AppendedEvent> {
  const createdAt = this.now().toISOString();
  const dependencies = build(this.database, createdAt);
  if (dependencies.before.length + dependencies.after.length > 8) throw new RangeError("event_dependency_limit");
  return this.appendPrepared(input, [...dependencies.before, this.eventInsert(input, createdAt), ...dependencies.after]);
}
```

Migration `0009` creates `vault_observations`, `vault_predecessor_edges`, `vault_document_heads`, `vault_quota_reservations`, `vault_rate_limit_state`, and `vault_distill_queue`. It enforces unique `(principal_id, vault_id, document_id, document_version)`, exact observation equality, unresolved predecessor ID/hash commitments, closed head disposition, and no path columns. The service uses idempotency scope `vault:note-observed:${principalId}:${vaultId}`, key `observationId`, and request hash `observationPayloadHash`; a projection echo is rejected before any D1 statement.

- [ ] **Step 4: Run focused persistence, migration, fault, and full cloud tests**

Run: `pnpm test:cloud -- persistence/vault-observation-repository.test.ts vault/vault-observation-service.test.ts faults/vault-observation-transaction-faults.test.ts persistence/migration-schema.test.ts; if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}; pnpm test:cloud`

Expected: PASS; fault injection leaves zero partial state, historical arrivals do not roll back heads, and quota/capacity responses allocate no event ID or sequence.

- [ ] **Step 5: Commit the observation ledger**

```powershell
git add apps/cloud-gateway/src/persistence apps/cloud-gateway/src/vault apps/cloud-gateway/test/persistence apps/cloud-gateway/test/vault apps/cloud-gateway/test/faults
git commit -m "feat(vault): add atomic observation ledger"
```

### Task O4: Expose bounded signed vault authority, batch, and equality routes

**Files:**
- Create: `apps/cloud-gateway/src/http/vault-sync-routes.ts`
- Create: `apps/cloud-gateway/src/http/vault-route-construction.ts`
- Create: `apps/cloud-gateway/test/http/vault-sync-routes.test.ts`
- Create: `apps/cloud-gateway/test/security/vault-ingest-security.test.ts`
- Modify after voice consolidation: `apps/cloud-gateway/src/index.ts`
- Modify after voice consolidation: `apps/cloud-gateway/test/workspace.test.ts`

**Interfaces:**
- Consumes: Tasks O1-O3, `DeviceRequestVerifier`, `VaultAuthorityService`, `VaultObservationService`, `TieredEventReader`, and the consolidated Worker route composer.
- Produces: `routeVaultSyncRequest`, `submitBatch`, and routes `POST /sync/vault/authority`, `/sync/vault/observations/batch`, and `/sync/vault/observations/lookup`.

- [ ] **Step 1: Write failing route/security tests for independently signed bounded items**

```ts
it("verifies every batch item independently under the 64 KiB command cap", async () => {
  const response = await routeVaultSyncRequest(batchRequest([validSignedItem(), badSignatureItem()]), deps);
  expect(await response.json()).toEqual({ results: [expect.objectContaining({ status: "accepted" }), { status: "invalid" }] });
  expect(deps.verifier.calls).toHaveLength(2);
});

it.each([17, 513 * 1024])("rejects an outer batch limit before service mutation", async (size) => {
  const response = await routeVaultSyncRequest(oversizedBatchRequest(size), deps);
  expect(response.status).toBe(413);
  expect(deps.observations.calls).toHaveLength(0);
});

it("returns the original archived sequenced event on equality lookup", async () => {
  deps.events.readById.mockResolvedValue(archivedVaultEvent());
  const response = await routeVaultSyncRequest(validLookupRequest(), deps);
  expect(await response.json()).toMatchObject({ eventSequence: 41, envelope: { eventType: "vault.note.observed.v1" } });
});
```

- [ ] **Step 2: Run the HTTP/security tests and verify red**

Run: `pnpm test:cloud -- http/vault-sync-routes.test.ts security/vault-ingest-security.test.ts`

Expected: FAIL because vault routes and route construction do not exist.

- [ ] **Step 3: Implement exact route parsing and partial batch results**

```ts
export type VaultSubmissionStatus = "accepted" | "already_bound" | "retry_after" | "capacity_exceeded" | "invalid";

export async function submitBatch(batch: VaultNoteSubmitBatchV1, deps: VaultBatchDependencies): Promise<VaultNoteSubmitBatchResultV1> {
  assertBatchLimits(batch, { items: 16, canonicalTextBytes: 262_144, encodedBytes: 524_288 });
  const results = [];
  for (const item of batch.items) {
    results.push(await verifyAndSubmitOne(item, deps).catch((error) => safeItemFailure(error)));
  }
  return Object.freeze({ schemaVersion: "1.0", results: Object.freeze(results) });
}
```

Parse exact raw bytes once, reject extra top-level fields, authenticate before reading canonical note text, and expose only safe status/retry metadata. Equality lookup uses `TieredEventReader` so archived events remain retrievable. Wire `index.ts` only after the voice-consolidation branch's route composition is the integration base.

- [ ] **Step 4: Run focused routes, security, typecheck, and the full workspace**

Run: `pnpm test:cloud -- http/vault-sync-routes.test.ts security/vault-ingest-security.test.ts; if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}; pnpm typecheck; if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}; pnpm test`

Expected: PASS; one bad item cannot authorize another, all limits hold, and voice/Telegram routes remain unchanged.

- [ ] **Step 5: Commit vault HTTP integration**

```powershell
git add apps/cloud-gateway/src/http/vault-sync-routes.ts apps/cloud-gateway/src/http/vault-route-construction.ts apps/cloud-gateway/src/index.ts apps/cloud-gateway/test/http/vault-sync-routes.test.ts apps/cloud-gateway/test/security/vault-ingest-security.test.ts apps/cloud-gateway/test/workspace.test.ts
git commit -m "feat(vault): expose signed observation sync routes"
```

### Task O5: Build the pinned Windows vault kernel, minimal broker, and hash-locked release

**Files:**
- Create: `apps/local-agent/native/jarvis-vault-native/Cargo.toml`
- Create: `apps/local-agent/native/jarvis-vault-native/Cargo.lock`
- Create: `apps/local-agent/native/jarvis-vault-native/pyproject.toml`
- Create: `apps/local-agent/native/jarvis-vault-native/rust-toolchain.toml`
- Create: `apps/local-agent/native/jarvis-vault-native/src/lib.rs`
- Create: `apps/local-agent/native/jarvis-vault-native/src/errors.rs`
- Create: `apps/local-agent/native/jarvis-vault-native/src/handles.rs`
- Create: `apps/local-agent/native/jarvis-vault-native/src/known_folders.rs`
- Create: `apps/local-agent/native/jarvis-vault-native/src/ntfs.rs`
- Create: `apps/local-agent/native/jarvis-vault-native/src/usn.rs`
- Create: `apps/local-agent/native/jarvis-vault-native/src/publish.rs`
- Create: `apps/local-agent/native/jarvis-vault-native/src/cloud_files.rs`
- Create: `apps/local-agent/native/jarvis-vault-native/src/vss.rs`
- Create: `apps/local-agent/native/jarvis-vault-native/src/bin/jarvis-vault-broker.rs`
- Create: `apps/local-agent/native/jarvis-vault-native/src/broker/mod.rs`
- Create: `apps/local-agent/native/jarvis-vault-native/src/broker/ipc.rs`
- Create: `apps/local-agent/native/jarvis-vault-native/src/broker/policy.rs`
- Create: `apps/local-agent/native/jarvis-vault-native/src/broker/registration.rs`
- Create: `apps/local-agent/native/jarvis-vault-native/src/broker/journal.rs`
- Create: `apps/local-agent/native/jarvis-vault-native/src/broker/snapshot.rs`
- Create: `apps/local-agent/jarvis_local/vault/__init__.py`
- Create: `apps/local-agent/jarvis_local/vault/native.py`
- Create: `apps/local-agent/jarvis_local/vault/broker.py`
- Create: `apps/local-agent/tests/vault/test_native_contract.py`
- Create: `apps/local-agent/tests/vault/test_native_ntfs_security.py`
- Create: `apps/local-agent/tests/vault/test_native_usn.py`
- Create: `apps/local-agent/tests/vault/test_native_publish.py`
- Create: `apps/local-agent/tests/vault/test_native_vss.py`
- Create: `apps/local-agent/tests/vault/test_broker_security.py`
- Create: `apps/local-agent/tests/vault/test_broker_journal_filter.py`
- Create: `apps/local-agent/tests/vault/test_broker_vss_lifecycle.py`
- Create: `apps/local-agent/vendor/jarvis-vault-native/native-wheel-lock.json`
- Create: `apps/local-agent/vendor/jarvis-vault-native/native-broker-lock.json`
- Create: `scripts/bootstrap-vault-native.ps1`
- Create: `scripts/build-vault-native.ps1`
- Create: `scripts/test-vault-native.ps1`
- Create: `scripts/install-vault-broker.ps1`
- Create: `scripts/test-vault-broker.ps1`

**Interfaces:**
- Consumes: legacy Task 4 protected device identity/configuration, Rust 1.98.0, PyO3 0.29.2 ABI3, `windows` 0.62.2, `winapi` 0.3.9, maturin 1.15.0, Windows Known Folder/NTFS/USN/Cloud Files/VSS/service/named-pipe APIs, and Task O1 structural types.
- Produces: an unprivileged Python `WindowsVaultKernel` for handles/enumeration/watcher/stable-read/create-new publication; a networkless `LocalSystem` `JarvisVaultBroker` limited to registered root-filtered USN and coordinated VSS; a signed nonce-protected owner-only broker client; and hash-pinned `cp312-abi3-win_amd64` wheel plus broker executable. Public values are frozen IDs/checkpoints/receipts or opaque lease objects; native/broker errors expose only closed codes and path-safe metadata.

- [ ] **Step 1: Write failing ABI, confinement, race, journal, publication, and snapshot tests**

```python
def test_root_rename_is_blocked_for_the_entire_validated_read(monkeypatch: pytest.MonkeyPatch) -> None:
    root = synthetic_ntfs_root()
    with kernel.open_owned_root(root.path, expected_identity=root.identity, expected_final_path=root.final_path) as lease:
        read = begin_stable_read(lease, "note.md")
        assert concurrent_rename(root.path).error_code == "sharing_violation"
        assert read.finish().bytes == b"stable"

def test_publish_never_replaces_an_existing_target() -> None:
    lease = owned_root_with_file("00 Inbox/Entries/fact-01.md", b"user bytes")
    with pytest.raises(VaultNativeError, match="vault_target_exists"):
        kernel.publish_new(lease, directory_parts=("00 Inbox", "Entries"), temporary_name=".jarvis-01.tmp", final_name="fact-01.md", content=b"new")
    assert lease.read_for_test("00 Inbox/Entries/fact-01.md") == b"user bytes"

def test_journal_reset_refuses_interval_replay() -> None:
    lower = JournalCheckpoint(journal_id=11, usn=100)
    upper = JournalCheckpoint(journal_id=12, usn=140)
    with pytest.raises(VaultNativeError, match="vault_journal_discontinuous"):
        broker.read_journal_page(VAULT_ID, lower, upper, max_records=64, max_bytes=262_144)

def test_owned_tree_requires_a_durable_record_between_components() -> None:
    with kernel.begin_owned_tree(profile_parent(), ("Jarvis", "Vault"), setup_id=SETUP_ID) as tree:
        first = tree.create_next()
        with pytest.raises(VaultNativeError, match="vault_setup_record_required"):
            tree.create_next()
        tree.acknowledge_durable_record(first.identity, first.content_hash)
        assert tree.create_next().name == "Vault"

def test_broker_returns_no_record_outside_the_registered_root() -> None:
    page = broker.read_journal_page(VAULT_ID, lower_checkpoint(), upper_checkpoint(), max_records=64, max_bytes=262_144)
    assert all(record.parent_file_id in registered_descendant_ids() for record in page.changes)
    assert "outside-secret.md" not in page.encoded_for_test.decode("utf-8")

def test_broker_rejects_remote_wrong_sid_replay_and_arbitrary_path() -> None:
    for request in [remote_request(), wrong_sid_request(), replayed_request(), request_with_path_field()]:
        assert broker_call(request).error_code in {"broker_remote_denied", "broker_owner_denied", "broker_replay", "broker_schema_invalid"}

@pytest.mark.windows_elevated
def test_vss_uses_one_snapshot_set_for_every_included_volume() -> None:
    with broker.create_snapshot_set(REGISTERED_COMPONENT_IDS) as snapshot:
        assert len(snapshot.volume_roots) == 2
        assert {item.snapshot_set_id for item in snapshot.volume_roots} == {snapshot.snapshot_set_id}
```

Parameterize the security suite over traversal, reserved devices, ADS, UNC, long-path aliases, case/8.3 aliases, reparse points, hard links, Cloud Files placeholders, whole-root replacement, ancestor/destination/target rename-delete races, and loss of the no-delete-sharing fence. Add broker cases for service binary/registration/firewall mismatch, remote clients, wrong SID/session, forged signatures, nonce replay, unknown fields, arbitrary paths/volumes, root-map ambiguity, pagination overflow, disconnect/restart/expiry, and volume-wide filename non-disclosure. Each case must either operate on the intended retained identity or return a closed refusal before bytes are read, published, or returned across the privileged pipe.

- [ ] **Step 2: Run Python contract tests and Rust tests to verify red**

Run: `python -m pytest apps/local-agent/tests/vault/test_native_contract.py apps/local-agent/tests/vault/test_native_ntfs_security.py apps/local-agent/tests/vault/test_native_usn.py apps/local-agent/tests/vault/test_native_publish.py apps/local-agent/tests/vault/test_native_vss.py apps/local-agent/tests/vault/test_broker_security.py apps/local-agent/tests/vault/test_broker_journal_filter.py apps/local-agent/tests/vault/test_broker_vss_lifecycle.py -m "not windows_elevated" -q; if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}; cargo test --manifest-path apps/local-agent/native/jarvis-vault-native/Cargo.toml --locked`

Expected: FAIL because the extension, leases, exact wheel, and build scripts are absent.

- [ ] **Step 3: Implement handle-owned Windows primitives and an exception-safe ABI**

```rust
#[pyclass(unsendable)]
struct RootLease {
    root: OwnedHandle,
    ancestor_fences: Vec<OwnedHandle>,
    identity: NtfsIdentity,
    canonical_final_path: String,
}

#[pymethods]
impl RootLease {
    fn enumerate_markdown(&self, cursor: Option<EnumerationCursor>, max_records: usize, max_bytes: usize) -> PyResult<EnumerationPage> {
        verify_root_binding(self)?;
        enumerate_bounded_by_handle(self, cursor, max_records, max_bytes).map_err(to_python_error)
    }
}

#[pyclass(unsendable)]
struct OwnedTreeLease {
    retained_parent: OwnedHandle,
    remaining_components: VecDeque<ValidatedComponent>,
    awaiting_durable_ack: Option<CreatedObjectEvidence>,
}

fn validate_read_handle(root: &RootLease, file: &OwnedHandle) -> Result<FileEvidence, VaultError> {
    let evidence = query_file_evidence(file)?;
    ensure_same_volume(root.identity.volume_serial, evidence.identity.volume_serial)?;
    ensure_descendant_final_path(&root.canonical_final_path, &evidence.final_path)?;
    ensure_no_reparse_or_placeholder(&evidence)?;
    ensure_single_link(evidence.link_count)?;
    Ok(evidence)
}
```

Use `SHGetKnownFolderPath` only to locate the initial Profile/LocalAppData parent, then retain handles. Open the root, required ancestors, destination, and target without `FILE_SHARE_DELETE` from final identity/path validation through read or publish and the caller's durable-commit acknowledgement. `publish_new` creates the temporary and final objects relative to retained directory handles, flushes content and directory metadata, and uses no-replace rename semantics. No security decision is made from a Python string after the lease opens.

`OwnedTreeLease.create_next` creates exactly one component and refuses another call until Python commits that component's identity/hash and acknowledges the durable row. Enumeration is handle-relative and paged. `WatcherLease` delivers path-confined hints to a callback that must durably enqueue each hint before acknowledging it; watcher sequence is never treated as a durable checkpoint.

The `JarvisVaultBroker` service is the only code that opens volume USN or VSS control handles. Its pipe uses `PIPE_REJECT_REMOTE_CLIENTS`, owner-SID/`SYSTEM` SDDL, client impersonation, local-session/token checks, strict framed schemas, bounded lengths, and existing device-key signatures with nonce replay protection. Elevated registration binds one ownership-receipt hash, owner SID, device public key, vault/root/volume identities, and allowed backup component IDs; ordinary requests contain IDs, never paths or volumes. A service-specific Windows Firewall outbound deny rule is a readiness requirement.

The broker maintains a registered-root descendant file-ID map and filters USN records before response. `JournalPage` is bounded by `max_records <= 256` and `max_bytes <= 262_144`, includes journal ID/start/next/upper checkpoints and `complete`, and fails the entire page on wrap/reset/map ambiguity. It never returns an outside-root name. VSS owns COM initialization and snapshot cleanup, creates one set for registered component volumes, and duplicates read-only shadow-root handles into only the authenticated client process. Leases bind owner PID, expiry, set ID, per-volume checkpoint, and idempotent release; disconnect, exit, restart, or expiry cleans them up. Every native/service destructor is idempotent.

- [ ] **Step 4: Build and verify the release wheel without requiring a compiler at install time**

`bootstrap-vault-native.ps1` is developer-only: it verifies the checked-in toolchain manifest before installing/using Rust 1.98.0 and maturin 1.15.0. `build-vault-native.ps1` requires the exact toolchain and locked crates, builds both `maturin build --release --locked --compatibility pypi` and the release broker executable, runs `cargo audit`, scans the wheel, extracted `.pyd`, and broker `.exe` with Microsoft Defender and Authenticode tooling, verifies the release-manifest signature, writes filename/size/SHA-256/ABI/dependency versions to both lock files, and refuses an undeclared artifact. `test-vault-native.ps1` installs only with `pip --require-hashes` into a fresh venv and runs the Python native suite offline. `install-vault-broker.ps1` requires explicit elevation, installs only the locked executable, service recovery policy, owner-only pipe policy, machine-protected registration store, and outbound deny rule; `-DryRun` mutates nothing.

Run: `powershell -ExecutionPolicy Bypass -File scripts/build-vault-native.ps1; if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}; powershell -ExecutionPolicy Bypass -File scripts/test-vault-native.ps1; if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}; powershell -ExecutionPolicy Bypass -File scripts/test-vault-broker.ps1; if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}; powershell -ExecutionPolicy Bypass -File scripts/install-vault-broker.ps1 -DryRun; if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}; python -m pytest apps/local-agent/tests/vault -m "not windows_elevated" -q`

Expected: PASS; both artifact hashes equal their locks, install performs no network/compiler work, broker mocks prove root-only disclosure and lease cleanup, and all non-elevated gates pass. On the reference machine, install/register the service once through UAC and separately run `python -m pytest apps/local-agent/tests/vault/test_native_usn.py apps/local-agent/tests/vault/test_native_vss.py apps/local-agent/tests/vault/test_broker_journal_filter.py apps/local-agent/tests/vault/test_broker_vss_lifecycle.py -m windows_elevated -q`; retain only redacted evidence.

- [ ] **Step 5: Commit the native kernel and locked artifact metadata**

```powershell
git add apps/local-agent/native/jarvis-vault-native apps/local-agent/jarvis_local/vault/__init__.py apps/local-agent/jarvis_local/vault/native.py apps/local-agent/jarvis_local/vault/broker.py apps/local-agent/tests/vault apps/local-agent/vendor/jarvis-vault-native scripts/bootstrap-vault-native.ps1 scripts/build-vault-native.ps1 scripts/test-vault-native.ps1 scripts/install-vault-broker.ps1 scripts/test-vault-broker.ps1
git commit -m "feat(vault): add confined Windows kernel and broker"
```

### Task O6: Add vault identity, owned-root setup state, and protected local storage

**Files:**
- Create: `apps/local-agent/jarvis_local/vault/models.py`
- Create: `apps/local-agent/jarvis_local/vault/repository.py`
- Create: `apps/local-agent/jarvis_local/vault/root_policy.py`
- Create: `apps/local-agent/jarvis_local/vault/migrations/0003_vault_identity_setup.sql`
- Modify: `apps/local-agent/jarvis_local/archive/database.py`
- Modify: `apps/local-agent/jarvis_local/archive/migrations.py`
- Modify: `apps/local-agent/jarvis_local/config.py`
- Create: `apps/local-agent/tests/vault/test_models.py`
- Create: `apps/local-agent/tests/vault/test_repository.py`
- Create: `apps/local-agent/tests/vault/test_root_policy.py`
- Create: `apps/local-agent/tests/vault/test_setup_state.py`

**Interfaces:**
- Consumes: legacy Tasks 4-6 `JarvisLocalConfig` and `ArchiveDatabase`, Task O1 contracts, Task O5 native identities/leases, Windows Profile/LocalAppData known folders, and explicit denied-root inputs.
- Produces: frozen `VaultId`, `DocumentId`, `ObservationId`, `NtfsIdentity`, `OwnershipReceipt`, `VaultSetupOperation`, `VaultRepository`, `VaultRootPolicy`, and protected `JARVIS_OBSIDIAN_VAULT_PATH` activation on the same physical archive database.

- [ ] **Step 1: Write failing schema, identity, setup-recovery, and denied-root tests**

```python
def test_vault_tables_share_the_archive_transaction(tmp_path: Path) -> None:
    db = ArchiveDatabase.open(tmp_path / "archive.sqlite3")
    with pytest.raises(SimulatedCrash), db.transaction() as tx:
        archive_id = db.archive.append_local_event(tx, local_observation_event())
        db.vaults.stage_observation(tx, observation(local_archive_record_id=archive_id))
        raise SimulatedCrash()
    assert db.archive.count_local_events() == 0
    assert db.vaults.count_observations() == 0

def test_setup_never_adopts_the_repo_seed_vault(reference_roots: ReferenceRoots) -> None:
    result = root_policy.inspect(reference_roots.repo / "Jarvis")
    assert result.code == "vault_unsupported_location"
    assert tree_hash(reference_roots.repo / "Jarvis") == reference_roots.seed_hash

def test_setup_resume_refuses_unrecorded_name_squatting(tmp_path: Path) -> None:
    operation = repository.prepare_setup(profile_parent(), ("Jarvis Vault",), installer_evidence())
    foreign_create(operation.intended_path, b"foreign")
    assert repository.resume_setup(operation.setup_id, kernel).code == "vault_setup_conflict"
    assert operation.intended_path.read_bytes() == b"foreign"
```

- [ ] **Step 2: Run local storage tests and verify red**

Run: `python -m pytest apps/local-agent/tests/vault/test_models.py apps/local-agent/tests/vault/test_repository.py apps/local-agent/tests/vault/test_root_policy.py apps/local-agent/tests/vault/test_setup_state.py -q`

Expected: FAIL because migration `0003`, vault models, repositories, and root policy are absent.

- [ ] **Step 3: Implement one-database state machines and strict location policy**

Migration `0003_vault_identity_setup.sql` creates append-only `vault_local_event`, `vault_identity`, `vault_document`, `vault_path_mapping`, `vault_setup_operation`, `vault_setup_component`, `vault_ownership_receipt`, `vault_configuration_event`, and `vault_health_event` tables. It adds update/delete denial triggers to evidence and receipt tables; only closed current-state projections advance through compare-and-swap transactions. Raw relative paths exist only in `vault_path_mapping`, which is DPAPI-protected at rest and excluded from archive/model/log renderers.

```python
class VaultRepository:
    def append_local_observation(self, tx: ArchiveTransaction, envelope: LocalEventEnvelope, observation: VaultNoteLocalObservationV1) -> StoredLocalObservation:
        verify_envelope_binding(envelope, observation)
        self._events.insert_exact(tx, envelope)
        return self._observations.insert_exact(tx, observation, envelope.record_id)

    def activate_setup(self, tx: ArchiveTransaction, setup: VaultSetupOperation, receipt: OwnershipReceipt) -> None:
        require_state(setup, "ownership_recorded")
        require_receipt_matches_every_component(setup, receipt)
        self._configuration.append_activation(tx, receipt)
        self._set_setup_state_cas(tx, setup.setup_id, "ownership_recorded", "configured")
```

`VaultRootPolicy` obtains repository/worktree paths from `git worktree list --porcelain` using argument arrays and adds the protected config/credential tree, backup staging roots, OneDrive/cloud roots, UNC paths, non-NTFS volumes, reparse roots, placeholders, and the current unsupported seed vault. It canonicalizes through Task O5 and rejects equal, child, parent-alias, and replaced-root identities. Model output cannot supply a path.

The setup repository records `prepared -> root_created -> layout_created -> ownership_recorded -> configured -> completed`, exact parent/component NTFS identities, README hash, installer evidence, and every state transition before the next mutation. Activation is one transaction containing configuration plus ownership receipt; failed setup never disables baseline memory.

- [ ] **Step 4: Run migrations, crash points, and the full local-agent baseline**

Run: `python -m pytest apps/local-agent/tests/vault/test_models.py apps/local-agent/tests/vault/test_repository.py apps/local-agent/tests/vault/test_root_policy.py apps/local-agent/tests/vault/test_setup_state.py -q; if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}; python -m pytest apps/local-agent/tests -q`

Expected: PASS; every setup crash point either resumes the same recorded object or preserves it and reports a conflict, the seed vault hash is unchanged, and no raw path reaches an archive event or diagnostic.

- [ ] **Step 5: Commit protected vault identity and setup storage**

```powershell
git add apps/local-agent/jarvis_local/archive apps/local-agent/jarvis_local/config.py apps/local-agent/jarvis_local/vault/models.py apps/local-agent/jarvis_local/vault/repository.py apps/local-agent/jarvis_local/vault/root_policy.py apps/local-agent/jarvis_local/vault/migrations/0003_vault_identity_setup.sql apps/local-agent/tests/vault
git commit -m "feat(vault): add protected local identity and setup state"
```

### Task O7: Implement watcher-before-crawl reconciliation and immutable local observations

**Files:**
- Create: `apps/local-agent/jarvis_local/vault/migrations/0004_vault_reconciliation_index.sql`
- Create: `apps/local-agent/jarvis_local/vault/watcher.py`
- Create: `apps/local-agent/jarvis_local/vault/markdown.py`
- Create: `apps/local-agent/jarvis_local/vault/content_pipeline.py`
- Create: `apps/local-agent/jarvis_local/vault/reconciliation.py`
- Create: `apps/local-agent/jarvis_local/vault/indexing.py`
- Modify: `apps/local-agent/jarvis_local/vault/repository.py`
- Modify: `apps/local-agent/jarvis_local/archive/archive_repository.py`
- Create: `apps/local-agent/tests/vault/test_markdown.py`
- Create: `apps/local-agent/tests/vault/test_content_pipeline.py`
- Create: `apps/local-agent/tests/vault/test_watcher_queue.py`
- Create: `apps/local-agent/tests/vault/test_reconciliation.py`
- Create: `apps/local-agent/tests/vault/test_reconciliation_faults.py`
- Create: `apps/local-agent/tests/vault/test_current_head_index.py`

**Interfaces:**
- Consumes: legacy Tasks 5-6 `ArchiveDatabase`/`ArchiveRepository`, Tasks O5-O6 leases/repository, foundation classifier/redactor rules, and NTFS watcher/USN checkpoints.
- Produces: `VaultWatcher.arm`, `VaultReconciler.run_baseline/run_incremental`, durable generations/hints/checkpoints, immutable observation/tombstone envelopes, exact projection-origin classification, `VaultFullTextIndex`, and current local document heads.

- [ ] **Step 1: Write failing generation, stable-read, origin, redaction, tombstone, and fault tests**

```python
def test_edit_during_crawl_is_replayed_before_generation_commit() -> None:
    harness = reconciliation_harness(files={"note.md": b"v1"})
    harness.on_enumerated("note.md", lambda: harness.edit("note.md", b"v2"))
    generation = harness.reconciler.run_baseline()
    assert generation.status == "completed"
    assert harness.current_text("note.md") == "v2"
    assert harness.processed_checkpoint == harness.upper_checkpoint

def test_unstable_read_advances_no_head_watermark_or_tombstone() -> None:
    harness = reconciliation_harness(files={"note.md": b"old"})
    harness.kernel.make_unstable("note.md")
    result = harness.reconciler.run_baseline()
    assert result.status == "incomplete"
    assert harness.current_text("note.md") == "old"
    assert harness.processed_checkpoint == harness.prior_checkpoint
    assert harness.tombstones == []

def test_projection_echo_is_classified_only_from_receipt_and_exact_hash() -> None:
    receipt = recorded_projection_receipt(content=b"generated")
    assert classify_origin(receipt.path_id, b"generated", receipt_store()).origin == "jarvis_projection"
    assert classify_origin(receipt.path_id, b"edited", receipt_store()).origin == "user_edited_projection"
    assert classify_origin(forged_frontmatter_path(), b"generated", receipt_store()).origin == "user_authored"
```

Include fault injection after watcher arm, lower checkpoint commit, each 64-document/4-MiB slice, local event append, candidate-head stage, upper checkpoint, journal replay, index stage, and generation commit. Include creates/edits/renames/deletes during enumeration, watcher overflow, USN reset/wrap, mixed UTF-8 reads, >1-MiB sources, malformed YAML/Markdown, hostile instruction text, secret-like filenames, hard-link/reparse swaps, and process restart.

- [ ] **Step 2: Run reconciliation tests and verify red**

Run: `python -m pytest apps/local-agent/tests/vault/test_markdown.py apps/local-agent/tests/vault/test_content_pipeline.py apps/local-agent/tests/vault/test_watcher_queue.py apps/local-agent/tests/vault/test_reconciliation.py apps/local-agent/tests/vault/test_reconciliation_faults.py apps/local-agent/tests/vault/test_current_head_index.py -q`

Expected: FAIL because migration `0004`, durable watcher generations, the bounded parser, and current-head index are absent.

- [ ] **Step 3: Implement durable lower/upper-watermark reconciliation**

Migration `0004_vault_reconciliation_index.sql` creates `vault_reconciliation_generation`, `vault_reconciliation_slice`, `vault_change_hint`, `vault_candidate_head`, `vault_document_head`, `vault_local_observation`, `vault_tombstone_proposal`, `vault_fts_queue`, `vault_upload_cursor`, `vault_upload_request`, `vault_retry_state`, and the FTS5 current-head index. Immutable event/observation/binding rows receive update/delete denial triggers. Queue/current-head tables advance only in the transaction that proves their input record.

```python
def run_baseline(self) -> ReconciliationResult:
    with self.kernel.open_owned_root_from_receipt(self.ownership.current()) as root:
        lower = root.journal_checkpoint()
        generation = self.repository.prepare_generation(lower)
        self.watcher.arm_and_persist(root, generation.generation_id, lower)
        self._enumerate_in_slices(root, generation, max_documents=64, max_raw_bytes=4 * 1024 * 1024)
        upper = root.journal_checkpoint()
        self.repository.record_upper(generation.generation_id, upper)
        self._replay_interval_and_drain_hints(root, generation, lower, upper)
        self._require_every_candidate_stable(generation)
        return self.repository.commit_generation_and_heads(generation.generation_id, upper)
```

Every read comes from one Task O5 stable-read lease and is accepted only when pre/post identity, size, write/change evidence, and queued changes through `upper` agree after a 250-ms quiet interval. The parser accepts only bounded UTF-8 `.md`, treats all syntax as data, emits a redacted safe display label, and refuses any secret that the redaction boundary cannot remove. It appends the shared local event and observation, stages the candidate head, and queues FTS in one `ArchiveDatabase` transaction. A complete generation alone advances current heads, processed USN, and absence-derived tombstones. Rename matching uses durable file identity or becomes tombstone plus new document; it never guesses.

An exact projection receipt/hash yields `jarvis_projection` and is structurally excluded from upload/facts. Any later byte change yields `user_edited_projection` with the prior receipt but proposal-only authority. User-supplied frontmatter never binds identity or ownership. The rebuildable FTS index contains only current non-tombstoned heads and opaque/redacted labels.

- [ ] **Step 4: Run fault suites, archive invariants, and deterministic rebuild**

Run: `python -m pytest apps/local-agent/tests/vault/test_markdown.py apps/local-agent/tests/vault/test_content_pipeline.py apps/local-agent/tests/vault/test_watcher_queue.py apps/local-agent/tests/vault/test_reconciliation.py apps/local-agent/tests/vault/test_reconciliation_faults.py apps/local-agent/tests/vault/test_current_head_index.py apps/local-agent/tests/archive -q`

Expected: PASS; no incomplete generation changes a head/watermark/tombstone, every stored source is complete and redacted, projection echoes cannot feed back, and rebuilding FTS from the immutable archive yields identical current-head results.

- [ ] **Step 5: Commit lossless vault reconciliation**

```powershell
git add apps/local-agent/jarvis_local/vault apps/local-agent/jarvis_local/archive/archive_repository.py apps/local-agent/tests/vault
git commit -m "feat(vault): add durable NTFS reconciliation"
```

### Task O8: Add deterministic vault retrieval, signed upload recovery, and backpressure

**Files:**
- Create: `apps/local-agent/jarvis_local/vault/retrieval.py`
- Create: `apps/local-agent/jarvis_local/vault/sync.py`
- Create: `apps/local-agent/jarvis_local/vault/render.py`
- Modify: `apps/local-agent/jarvis_local/memory/vector_index.py`
- Modify: `apps/local-agent/jarvis_local/sync/cloud_client.py`
- Modify: `apps/local-agent/jarvis_local/sync/event_replicator.py`
- Modify: `apps/local-agent/jarvis_local/cli.py`
- Modify: `apps/local-agent/jarvis_local/vault/repository.py`
- Create: `apps/local-agent/tests/vault/test_retrieval.py`
- Create: `apps/local-agent/tests/vault/test_retrieval_isolation.py`
- Create: `apps/local-agent/tests/vault/test_upload_queue.py`
- Create: `apps/local-agent/tests/vault/test_binding_recovery.py`
- Create: `apps/local-agent/tests/vault/test_backpressure.py`

**Interfaces:**
- Consumes: legacy Tasks 4-7 device signing, sync, archive, and semantic index; Tasks O1/O4/O7 contracts/routes/current heads; exact local cloud-ingest decisions; and sequenced `vault.note.observed.v1` events.
- Produces: `VaultLocalRetriever.search/show`, deterministic `jarvis vault search/show`, `VaultSyncCoordinator.drain_once`, restart-safe upload queue/backoff, equality lookup, and append-only `vault.note.binding.v1` derivation after authenticated event replication.

- [ ] **Step 1: Write failing typed-retrieval, zero-model, ordered-upload, binding, and saturation tests**

```python
def test_local_only_search_renders_exact_excerpt_without_any_model_call() -> None:
    result = retriever.search("coffee", principal_id=OWNER, purpose="vault_cli", limit=5, max_chars=1200)
    assert result[0].kind == "vault_observation"
    assert result[0].authority == "proposal_only"
    assert result[0].provenance.gateway_event_id is None
    assert fake_model.calls == []

@pytest.mark.parametrize("consumer", ["conversation", "voice", "telegram", "fact_authority", "tool_authorization"])
def test_raw_vault_observation_is_rejected_by_non_cli_consumers(consumer: str) -> None:
    with pytest.raises(VaultRetrievalDenied, match="vault_cli_only"):
        retriever.search("x", principal_id=OWNER, purpose=consumer, limit=1, max_chars=100)

def test_lost_response_binds_only_after_authenticated_sync_event() -> None:
    coordinator.submit_once(eligible_observation(), lose_response=True)
    lookup = coordinator.lookup_exact_with_fresh_signature()
    assert lookup.gateway_event_id is not None
    assert repository.binding_for(lookup.observation_id) is None
    replicator.apply_page(authenticated_page(lookup.envelope))
    assert repository.binding_for(lookup.observation_id).global_sequence == lookup.event_sequence

def test_queue_saturation_preserves_chain_cursor_and_rebuilds_requests_after_restart() -> None:
    coordinator.fill_materialized_queue(items=10_000)
    coordinator.discover(eligible_observation(document_version=10_001))
    assert coordinator.health.code == "sync_backpressured"
    assert coordinator.materialized_count == 10_000
    restarted = restart_and_drain(coordinator)
    assert restarted.submitted_versions == list(range(1, 10_002))
```

- [ ] **Step 2: Run retrieval and sync tests and verify red**

Run: `python -m pytest apps/local-agent/tests/vault/test_retrieval.py apps/local-agent/tests/vault/test_retrieval_isolation.py apps/local-agent/tests/vault/test_upload_queue.py apps/local-agent/tests/vault/test_binding_recovery.py apps/local-agent/tests/vault/test_backpressure.py -q`

Expected: FAIL because typed current-head retrieval, vault upload orchestration, and binding recovery are absent.

- [ ] **Step 3: Implement bounded retrieval and stable-ID signed queueing**

```python
def search(self, query: str, *, principal_id: str, purpose: Literal["vault_cli"], limit: int, max_chars: int) -> list[VaultObservationRetrievalV1]:
    if purpose != "vault_cli":
        raise VaultRetrievalDenied("vault_cli_only")
    candidates = self.repository.current_non_tombstoned_candidates(principal_id, query)
    ranked = rank_fts_then_semantic(candidates, self.embedder, limit=min(limit, 20))
    return [self._verified_excerpt(row, remaining_chars=max_chars) for row in ranked if self._head_and_hash_still_match(row)]

def drain_once(self) -> SyncProgress:
    if self.repository.materialized_limits_reached(max_items=10_000, max_text_bytes=256 * 1024 * 1024):
        self.repository.record_backpressure()
        return SyncProgress.backpressured()
    batch = self.repository.next_ordered_eligible_batch(max_items=16, max_text_bytes=256 * 1024, max_encoded_bytes=512 * 1024)
    return self.cloud.submit_independently_signed(batch, per_command_body_max=64 * 1024)
```

The retriever checks principal, closed sensitivity, current non-tombstoned head, excerpt byte range/hash, content hash, and redacted label at render time. The CLI resolves a raw path only after selecting the opaque ID and never passes it to a model. Semantic vectors are derived/rebuildable and keyed to the exact current observation ID.

The queue materializes only exact allowed decisions; `jarvis_projection`, redaction failures, unknown sensitivity, >32-KiB text, and unapproved restricted observations remain local. Each retry preserves observation ID/version/payload hash and creates a fresh command ID/nonce/signature. Results persist `retry_after`; capacity errors stop hot loops. When materialized limits are full, compact dirty-document and immutable archive cursors preserve every chain version without coalescing. `EventReplicator` validates the gateway envelope, principal, observation/payload hashes, sequence continuity, and source disposition before appending the local binding record in the same transaction as the replicated event. HTTP response/lookup data alone never binds.

- [ ] **Step 4: Run local sync/retrieval, cloud route, and cross-runtime parity tests**

Run: `python -m pytest apps/local-agent/tests/vault/test_retrieval.py apps/local-agent/tests/vault/test_retrieval_isolation.py apps/local-agent/tests/vault/test_upload_queue.py apps/local-agent/tests/vault/test_binding_recovery.py apps/local-agent/tests/vault/test_backpressure.py -q; if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}; pnpm test:cloud -- http/vault-sync-routes.test.ts security/vault-ingest-security.test.ts; if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}; python -m pytest apps/local-agent/tests/sync apps/local-agent/tests/memory -q`

Expected: PASS; raw/local-only observations invoke no model and reach no non-CLI consumer, chains drain in document order across restarts, and only authenticated replicated events create bindings.

- [ ] **Step 5: Commit deterministic retrieval and upload recovery**

```powershell
git add apps/local-agent/jarvis_local/vault apps/local-agent/jarvis_local/memory/vector_index.py apps/local-agent/jarvis_local/sync apps/local-agent/jarvis_local/cli.py apps/local-agent/tests/vault
git commit -m "feat(vault): add deterministic retrieval and signed sync"
```

### Task O9: Enforce fact lineage and publish authorized write-once projections

**Files:**
- Create: `apps/cloud-gateway/src/persistence/migrations/0011_vault_fact_authority.sql`
- Create: `apps/cloud-gateway/src/vault/vault-fact-authority-repository.ts`
- Create: `apps/cloud-gateway/src/vault/vault-fact-authority-service.ts`
- Create: `apps/cloud-gateway/src/vault/vault-excerpt-verifier.ts`
- Create: `apps/cloud-gateway/src/http/vault-authority-routes.ts`
- Modify: `apps/cloud-gateway/src/sync/memory-distill.ts`
- Modify: `apps/cloud-gateway/src/sync/memory-projection.ts`
- Modify: `apps/cloud-gateway/src/conversation/context-retriever.ts`
- Create: `apps/cloud-gateway/test/persistence/vault-fact-authority-repository.test.ts`
- Create: `apps/cloud-gateway/test/vault/vault-fact-authority-service.test.ts`
- Create: `apps/cloud-gateway/test/vault/vault-excerpt-verifier.test.ts`
- Create: `apps/cloud-gateway/test/http/vault-authority-routes.test.ts`
- Create: `apps/cloud-gateway/test/security/vault-fact-authority-security.test.ts`
- Create: `apps/local-agent/jarvis_local/vault/migrations/0005_vault_authority_projection.sql`
- Create: `apps/local-agent/jarvis_local/vault/authority.py`
- Create: `apps/local-agent/jarvis_local/vault/projection.py`
- Modify: `apps/local-agent/jarvis_local/vault/repository.py`
- Modify: `apps/local-agent/jarvis_local/memory/facts.py`
- Modify: `apps/local-agent/jarvis_local/memory/promotion.py`
- Modify: `apps/local-agent/jarvis_local/memory/distillation.py`
- Modify: `apps/local-agent/jarvis_local/sync/projection_uploader.py`
- Modify: `apps/local-agent/jarvis_local/cli.py`
- Create: `apps/local-agent/tests/vault/test_fact_authority.py`
- Create: `apps/local-agent/tests/vault/test_correction_confirmation.py`
- Create: `apps/local-agent/tests/vault/test_retraction_authority.py`
- Create: `apps/local-agent/tests/vault/test_projection.py`
- Create: `apps/local-agent/tests/vault/test_projection_faults.py`
- Create: `apps/local-agent/tests/vault/test_capture_export.py`

**Interfaces:**
- Consumes: legacy Task 8 fact/distillation/projection baseline and D1 migration `0010`, Tasks O1/O3/O7/O8 observation/binding/head contracts, authenticated owner events, Task O5 create-new publication, and exact versioned decisions.
- Produces: append-only confirmation/supersession/retraction/export/capture authority, verified bound-observation excerpts, `VaultAuthorityCoordinator`, `VaultProjector.project_fact/project_capture/recover`, D1 active-fact projection, and write receipts that preserve exact source/decision lineage.

- [ ] **Step 1: Write failing authority, excerpt, correction, retraction, export, and crash-boundary tests**

```ts
it("verifies the excerpt bytes against the exact archived sequenced observation before model use", async () => {
  const request = distillRequest({ startByte: 4, endByte: 10, excerptHash: hash("coffee") });
  await handleMemoryDistill(request, deps);
  expect(deps.events.readById).toHaveBeenCalledWith(request.gatewayEventId);
  expect(deps.model.completeJson).toHaveBeenCalledTimes(1);
});

it("rejects a stale confirmation and commits no supersession", async () => {
  await deps.facts.activate(factVersion(2));
  await expect(service.confirmAndSupersede(confirmationForPredecessor(1))).rejects.toThrow("vault_fact_predecessor_stale");
  expect(await deps.facts.activeVersion(FACT_ID)).toBe(2);
});

it("keeps note observations out of channel context until a confirmed active fact projects", async () => {
  await deps.observations.append(boundVaultObservation("coffee"));
  expect(await deps.context.retrieve(ownerVoiceQuery())).not.toContainEqual(expect.objectContaining({ text: "coffee" }));
  await service.confirmAndSupersede(validConfirmation());
  expect(await deps.context.retrieve(ownerVoiceQuery())).toContainEqual(expect.objectContaining({ text: "coffee", authority: "active_fact" }));
});
```

```python
def test_note_edit_creates_proposal_but_never_self_promotes() -> None:
    proposal = authority.propose_from(bound_user_edit("I prefer coffee"))
    assert proposal.state == "proposed"
    assert facts.active_value(proposal.fact_id) is None

def test_fact_export_rechecks_exact_active_version_before_publish() -> None:
    decision = allowed_export_decision(fact_version=1)
    projector.prepare_fact(fact(version=1), decision)
    facts.supersede(version=2)
    with pytest.raises(VaultProjectionDenied, match="vault_export_decision_stale"):
        projector.recover()
    assert synthetic_vault().markdown_files == []

def test_published_file_crash_recovers_one_receipt_without_duplicate() -> None:
    operation = projector.project_capture(allowed_capture(), crash_after="file_published")
    restarted_projector().recover(operation.operation_id)
    assert count_files_for_operation(operation.operation_id) == 1
    assert repository.receipt_for(operation.operation_id).content_hash == operation.content_hash
```

Cover cross-principal reuse, mismatched observation/proposal/value/decision hashes, denial/revocation/expiration, stale fact version, confirmation versus retraction separation, current-head tombstones, projection echo exclusion, edited-projection proposal-only lineage, restricted/inferred/third-party/health/financial/credential-like defaults, model/vault/unauthenticated capture denial, and every `prepared -> file_published -> observed -> committed` crash point.

- [ ] **Step 2: Run cloud and local authority/projection tests and verify red**

Run: `pnpm test:cloud -- persistence/vault-fact-authority-repository.test.ts vault/vault-fact-authority-service.test.ts vault/vault-excerpt-verifier.test.ts http/vault-authority-routes.test.ts security/vault-fact-authority-security.test.ts sync/memory-distill.test.ts sync/memory-projection.test.ts; if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}; python -m pytest apps/local-agent/tests/vault/test_fact_authority.py apps/local-agent/tests/vault/test_correction_confirmation.py apps/local-agent/tests/vault/test_retraction_authority.py apps/local-agent/tests/vault/test_projection.py apps/local-agent/tests/vault/test_projection_faults.py apps/local-agent/tests/vault/test_capture_export.py -q`

Expected: FAIL because D1 migration `0011`, exact authority repositories, excerpt verification, and the write journal are absent.

- [ ] **Step 3: Implement append-only fact/export decisions and compare-and-swap lineage**

Migration `0011_vault_fact_authority.sql` creates immutable `vault_fact_confirmation_events`, `vault_fact_supersession_events`, `vault_fact_retraction_decision_events`, `vault_export_decision_events`, `vault_capture_export_decision_events`, and their event/body-hash bindings. It extends baseline active-fact projection rows with exact source/transition IDs but leaves mutation only in the guarded current projection. Every event table has no-update/no-delete triggers.

```ts
async confirmAndSupersede(input: VaultFactConfirmationV1): Promise<ActiveFactProjection> {
  const verified = await this.verifyConfirmationDependencies(input);
  return this.transactions.run([
    this.repository.insertConfirmationExact(verified),
    this.repository.insertSupersessionExact(verified.supersession),
    this.repository.compareAndSwapActiveFact(verified.predecessor, verified.successor),
    this.events.appendPrepared(verified.gatewayEvent),
    this.outbox.insert(verified.projectionOutbox),
  ]);
}
```

`VaultExcerptVerifier` loads the exact `vault.note.observed.v1` through `TieredEventReader`, validates principal/vault/observation/event/sequence/payload hashes and current non-tombstoned source eligibility, slices UTF-8 by the declared byte range, and matches the excerpt hash before `completeJson` is callable. Model output stays `proposed`; only an authenticated owner confirmation plus matching observation can activate/supersede. Tombstones only create retraction proposals until an exact allowed retraction decision commits. Calls and Telegram continue to read only active fact projections.

- [ ] **Step 4: Implement version-bound local projection and standalone capture publication**

Migration `0005_vault_authority_projection.sql` creates immutable local decision caches/bindings, `vault_fact_proposal`, `vault_retraction_proposal`, `vault_operation`, `vault_projection_receipt`, and `vault_projection_conflict`, with a guarded operation-state projection. Decision cache rows are usable only after the gateway decision event arrives through authenticated sync.

```python
def project_fact(self, fact: ActiveFact, decision: VerifiedExportDecision) -> ProjectionReceipt:
    require_exact_active_fact_and_decision(fact, decision)
    rendered = self.renderer.render_fact(fact, decision, schema_version=1)
    operation = self.repository.prepare_projection(fact, decision, rendered.content_hash, rendered.path_id)
    with self.kernel.open_owned_root_from_receipt(self.ownership.current()) as root:
        require_exact_active_fact_and_decision(fact, decision)
        published = root.publish_new(rendered.directory_parts, operation.temporary_name, rendered.final_name, rendered.bytes)
        return self.repository.record_published_observation_and_receipt(operation, published)
```

Generated filenames are allowlisted kind + stable ID + version + operation ID; display titles never supply path components. Frontmatter carries display metadata only. A later fact version creates a new file linking to the prior receipt. Inbox/Daily captures require an exact authenticated source event/sequence plus allowed content-bound capture decision. Publication holds root/ancestor/destination/target no-delete-sharing fences through the observation/receipt transaction. An existing target remains byte-identical and records a conflict; recovery never replaces, renames, moves, or deletes it.

- [ ] **Step 5: Run authority, projection, channel-isolation, and full affected suites**

Run: `pnpm test:cloud -- persistence/vault-fact-authority-repository.test.ts vault/vault-fact-authority-service.test.ts vault/vault-excerpt-verifier.test.ts http/vault-authority-routes.test.ts security/vault-fact-authority-security.test.ts sync/memory-distill.test.ts sync/memory-projection.test.ts conversation/context-retriever.test.ts; if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}; python -m pytest apps/local-agent/tests/vault apps/local-agent/tests/memory -q; if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}; pnpm typecheck`

Expected: PASS; note text alone never changes active memory or channel context, every projection/capture proves a current exact decision, and all publication crash/race cases preserve user bytes.

- [ ] **Step 6: Commit fact authority and write-once projection**

```powershell
git add apps/cloud-gateway/src/persistence/migrations/0011_vault_fact_authority.sql apps/cloud-gateway/src/vault apps/cloud-gateway/src/http/vault-authority-routes.ts apps/cloud-gateway/src/sync apps/cloud-gateway/src/conversation/context-retriever.ts apps/cloud-gateway/test apps/local-agent/jarvis_local/vault apps/local-agent/jarvis_local/memory apps/local-agent/jarvis_local/sync/projection_uploader.py apps/local-agent/jarvis_local/cli.py apps/local-agent/tests/vault
git commit -m "feat(vault): add fact authority and write-once projection"
```

### Task O10: Add Obsidian detection, owned-vault setup, doctor, and closed-app handoff

**Files:**
- Create: `apps/local-agent/jarvis_local/vault/obsidian.py`
- Create: `apps/local-agent/jarvis_local/vault/setup.py`
- Create: `apps/local-agent/jarvis_local/vault/diagnostics.py`
- Modify: `apps/local-agent/jarvis_local/config.py`
- Modify: `apps/local-agent/jarvis_local/doctor.py`
- Modify: `apps/local-agent/jarvis_local/cli.py`
- Modify: `apps/local-agent/jarvis_local/service.py`
- Modify: `apps/local-agent/.env.example`
- Create: `apps/local-agent/tests/vault/test_obsidian_detection.py`
- Create: `apps/local-agent/tests/vault/test_setup.py`
- Create: `apps/local-agent/tests/vault/test_setup_faults.py`
- Create: `apps/local-agent/tests/vault/test_diagnostics.py`
- Create: `apps/local-agent/tests/vault/test_closed_app_handoff.py`
- Create: `scripts/install-obsidian.ps1`
- Create: `scripts/setup-obsidian-vault.ps1`
- Modify after legacy Task 10: `scripts/bootstrap-local-agent.ps1`
- Modify after legacy Task 10: `scripts/install-local-agent.ps1`
- Modify after legacy Task 10: `scripts/doctor.ps1`
- Create: `docs/deployment/obsidian.md`

**Interfaces:**
- Consumes: legacy Task 4 config/doctor and Task 9 service, Tasks O5-O6 native kernel/setup repository, signed local-session evidence, installed Obsidian Authenticode metadata, and approved Profile/fallback policy.
- Produces: `ObsidianDetector.inspect`, `VaultSetupService.prepare/resume/activate`, `VaultDiagnostics.run`, CLI commands `vault setup/status/open`, and an authenticated handoff that opens the owned vault only while Obsidian is closed.

- [ ] **Step 1: Write failing install, setup, crash-recovery, doctor, and handoff tests**

```python
def test_signed_in_obsidian_account_is_never_read_or_recorded() -> None:
    detector = ObsidianDetector(fake_registry(account_email="secret@example.invalid"))
    evidence = detector.inspect()
    assert evidence.publisher == "Dynalist Inc"
    assert "account" not in dataclasses.asdict(evidence)
    assert "secret@example.invalid" not in serialized_local_state()

def test_setup_creates_only_the_approved_layout_under_known_folder_handle() -> None:
    result = setup.prepare_and_resume(profile_parent(), preferred_name="Jarvis Vault")
    assert result.path == approved_profile_vault_path()
    assert result.created_relative_paths == APPROVED_LAYOUT
    assert tree_hash(repo_seed_vault()) == SEED_HASH

def test_open_refuses_while_obsidian_is_running() -> None:
    with pytest.raises(VaultSetupError, match="vault_ready_to_open"):
        setup.open_owned_vault(session=authenticated_console(), processes=obsidian_running())
    assert process_launcher.calls == []
```

Test every setup state transition, parent swap, name squatting, concurrent creator, reparse/alias insertion, invalid publisher, installer hash mismatch, missing/uninstalled app, read-only/moved/replaced root, stale backup, namespace-busy state, malformed frontmatter, unsupported seed location, and sanitized diagnostic output.

- [ ] **Step 2: Run setup/doctor tests and verify red**

Run: `python -m pytest apps/local-agent/tests/vault/test_obsidian_detection.py apps/local-agent/tests/vault/test_setup.py apps/local-agent/tests/vault/test_setup_faults.py apps/local-agent/tests/vault/test_diagnostics.py apps/local-agent/tests/vault/test_closed_app_handoff.py -q`

Expected: FAIL because Obsidian detection, layout orchestration, diagnostics, and handoff are absent.

- [ ] **Step 3: Implement signed-package detection and handle-confined setup**

`install-obsidian.ps1` detects the current signed installation first. If absent, it accepts either the reviewed stable package source or an explicitly selected installer, verifies the checked-in expected publisher and supplied SHA-256 before execution, and records only version/hash/publisher/path evidence. It never reads account state or changes Sync, Publish, community plugins, or settings. `-DryRun` is non-mutating and redacted.

```python
def prepare_and_resume(self) -> VaultSetupResult:
    evidence = self.obsidian.require_valid_install()
    parent = self.kernel.known_folder("profile")
    operation = self.repository.prepare_setup(parent.identity, ("Jarvis Vault",), evidence)
    try:
        tree = self.kernel.create_owned_tree(parent, operation.components, setup_id=operation.setup_id)
        self._create_approved_layout_and_readme(tree, operation)
        receipt = self._record_ownership(tree, operation)
        self.repository.activate_setup(self.database.transaction(), operation, receipt)
        return VaultSetupResult.ready_to_open(receipt)
    except VaultConflict as error:
        self.repository.record_setup_conflict(operation.setup_id, error.safe_code)
        return VaultSetupResult.disabled(error.safe_code)
```

The Profile Known Folder target is tried only when its parent and intended name are clean and local; `%LOCALAPPDATA%\Jarvis\Vault` is the fixed fallback. Creation is component-by-component relative to retained handles. The root and ancestors remain fenced until ownership/configuration commit. Resume accepts only identities/content recorded by the same setup operation. Any foreign/preexisting/mismatched object is preserved and disables activation. `C:\javis\Jarvis` is checked but never read as source, adopted, copied, moved, changed, or deleted.

- [ ] **Step 4: Integrate path-safe doctor and the closed-app desktop handoff**

Doctor reports closed codes and non-secret evidence for installation, signature, configured/retained root identity, NTFS/USN/VSS availability, namespace fence, watcher, last complete generation, local/cloud queues, last sealed backup fence, and adapter state. Raw paths are shown only by an explicit authenticated local `vault status --show-path`; normal logs and health use opaque IDs.

`vault open` verifies an interactive local console, current ownership receipt and root lease, confirms Obsidian is not running, then launches the signed executable with the supported local vault path via an argument array. It never switches a running process. Obsidian may close afterward without affecting Jarvis runtime.

Run: `python -m pytest apps/local-agent/tests/vault/test_obsidian_detection.py apps/local-agent/tests/vault/test_setup.py apps/local-agent/tests/vault/test_setup_faults.py apps/local-agent/tests/vault/test_diagnostics.py apps/local-agent/tests/vault/test_closed_app_handoff.py apps/local-agent/tests/test_doctor.py -q; if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}; powershell -ExecutionPolicy Bypass -File scripts/install-obsidian.ps1 -DryRun; if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}; powershell -ExecutionPolicy Bypass -File scripts/setup-obsidian-vault.ps1 -DryRun`

Expected: PASS; setup is idempotent for its own exact recorded objects, foreign content is untouched, the seed vault hash is unchanged, and diagnostic/install dry-runs expose no account or secret data.

- [ ] **Step 5: Commit safe Obsidian setup and diagnostics**

```powershell
git add apps/local-agent/jarvis_local apps/local-agent/tests/vault apps/local-agent/.env.example scripts/install-obsidian.ps1 scripts/setup-obsidian-vault.ps1 scripts/bootstrap-local-agent.ps1 scripts/install-local-agent.ps1 scripts/doctor.ps1 docs/deployment/obsidian.md
git commit -m "feat(vault): add owned Obsidian setup and doctor"
```

### Task O11: Extend backup and restore with coordinated VSS vault recovery

**Files:**
- Create: `apps/local-agent/jarvis_local/vault/migrations/0006_vault_backup_restore.sql`
- Create: `apps/local-agent/jarvis_local/vault/backup.py`
- Create: `apps/local-agent/jarvis_local/vault/restore.py`
- Modify: `apps/local-agent/jarvis_local/vault/repository.py`
- Modify: `apps/local-agent/jarvis_local/memory/backup.py`
- Modify: `apps/local-agent/jarvis_local/service.py`
- Modify: `apps/local-agent/jarvis_local/vault/diagnostics.py`
- Create: `apps/local-agent/tests/vault/test_backup.py`
- Create: `apps/local-agent/tests/vault/test_backup_faults.py`
- Create: `apps/local-agent/tests/vault/test_restore.py`
- Create: `apps/local-agent/tests/vault/test_restore_faults.py`
- Create: `apps/local-agent/tests/vault/test_backup_plaintext_boundary.py`
- Create: `tests/acceptance/obsidian-backup-restore.py`

**Interfaces:**
- Consumes: legacy Task 9 encrypted `BackupService`, Tasks O5/O7/O9 snapshot/root/reconciliation/projection state, every authoritative local SQLite store, DPAPI-wrapped AES-256-GCM keys, and service writer locks.
- Produces: `CoordinatedVaultBackup.create/resume`, `VaultRestore.prepare/resume`, one sealed encrypted backup unit, reconciled/delta classification, durable physical-rebase records, a new watcher baseline, and 24-hour fence-time RPO diagnostics.

- [ ] **Step 1: Write failing snapshot-set, fence, classification, encryption, rebase, and crash-recovery tests**

```python
def test_backup_refuses_two_independent_volume_snapshots() -> None:
    provider = FakeVssProvider(independent_snapshot_ids=True)
    with pytest.raises(BackupError, match="vault_snapshot_set_mismatch"):
        backup(provider).create(output_path())
    assert repository.latest_backup().state == "prepared"

def test_manifest_distinguishes_reconciled_bytes_from_newer_shadow_delta() -> None:
    harness = backup_harness(head=b"old", shadow=b"new")
    manifest = harness.backup.create(harness.output)
    assert manifest.vault_files[0].consistency == "crash_consistent_delta"
    assert manifest.committed_generation == harness.generation_id
    assert harness.repository.current_head_text() == "old"

def test_plaintext_vault_never_leaves_encrypted_staging_boundary() -> None:
    manifest = backup_harness(secret_vault_bytes()).backup.create(output_path())
    assert manifest.encryption == "AES-256-GCM"
    assert not any_plaintext_at_or_beyond_encrypted_destination(secret_vault_bytes())
    assert secret_pattern_absent(logs_and_manifest_labels())

def test_restore_rebases_physical_identity_without_granting_authority() -> None:
    restored = restore(valid_backup()).run_to_completion(new_empty_roots())
    assert restored.logical_ids == original_logical_ids()
    assert restored.root_identity != original_root_identity()
    assert restored.upload_decisions_added == 0
    assert restored.export_decisions_added == 0
    assert restored.watcher_baseline.journal_id == restored.new_volume_journal_id
```

Inject crashes at every `prepared -> snapshot_fenced -> artifact_staged -> sealed -> completed` backup transition and every `prepared -> roots_created -> logical_state_restored -> files_restored -> physical_rebased -> reconciled -> activated -> completed` restore transition. Cover provider absence, lost namespace fence, post-fence edits, mismatched backup/snapshot/schema/generation hashes, partial/mixed stores, missing device key, malicious relative paths, occupied targets, restored delta quarantine, and vault-only import without ownership.

- [ ] **Step 2: Run backup/restore tests and verify red**

Run: `python -m pytest apps/local-agent/tests/vault/test_backup.py apps/local-agent/tests/vault/test_backup_faults.py apps/local-agent/tests/vault/test_restore.py apps/local-agent/tests/vault/test_restore_faults.py apps/local-agent/tests/vault/test_backup_plaintext_boundary.py tests/acceptance/obsidian-backup-restore.py -m "not windows_elevated" -q`

Expected: FAIL because migration `0006`, coordinated VSS backup, classification, and physical rebase are absent.

- [ ] **Step 3: Implement one snapshot fence and encrypted sealed unit**

Migration `0006_vault_backup_restore.sql` creates immutable `vault_backup_operation`, `vault_backup_component`, `vault_snapshot_fence`, `vault_restore_operation`, `vault_restore_binding`, and current operation-state projections. Evidence rows have no-update/no-delete triggers.

```python
def create(self, destination: Path) -> SealedBackupManifest:
    operation = self.repository.prepare_backup()
    with self.service_locks.pause_projection_and_heads(), self.kernel.open_owned_root_from_receipt(self.ownership.current()) as root:
        self.reconciler.commit_only_if_complete()
        self.databases.checkpoint_all_wals()
        with self.kernel.create_snapshot_set(self._included_volume_guids()) as snapshots:
            fence = self.repository.commit_snapshot_fence(operation, snapshots, root.journal_checkpoint())
        # live watcher keeps queuing post-fence changes after locks release
    staged = self._read_shadow_handles_and_classify(fence)
    encrypted = self.parent_backup.encrypt_and_authenticate(staged, destination)
    return self.repository.seal_and_complete(operation, encrypted)
```

The included unit contains authoritative archive/adapter SQLite, distilled-memory SQLite, protected configuration/decisions/queues/receipts, and shadow Markdown/Jarvis metadata. It excludes FTS/vector indexes, Obsidian binaries/cache/workspace/plugin state, and plaintext device keys. Each shadow file records opaque path ID, physical identity, size, hash, change position, and `reconciled_at_fence` or `crash_consistent_delta`; only an exact current-head identity/hash receives the first label. Every component shares backup ID and VSS snapshot-set ID. An incomplete/unsealed set is never recoverable evidence.

- [ ] **Step 4: Implement new-root restore, physical rebasing, and disabled-first reconciliation**

```python
def resume(self, operation_id: str) -> RestoreResult:
    operation = self.repository.require_resumable_restore(operation_id)
    self._verify_single_sealed_unit(operation)
    roots = self._create_or_reopen_recorded_empty_roots(operation)
    self._restore_logical_state_without_activation(operation, roots)
    self._restore_files_without_replace(operation, roots)
    self._rebase_physical_identities_and_append_receipt(operation, roots)
    self._start_fresh_watcher_baseline(operation, roots)
    self._verify_reconciled_heads_and_ingest_deltas_local_only(operation, roots)
    return self._activate_atomically_after_all_checks(operation, roots)
```

Cloud sync, model use, and projection stay disabled until activation. Logical IDs stay unchanged; old file IDs/USNs become immutable evidence only. Delta files stable-read as new local-only proposal observations and malformed/partial bytes remain preserved/quarantined. Missing keys require re-enrollment. Restore never overlays, switches to, or deletes the active vault. A mismatched resumable object becomes `vault_restore_conflict`, preserves every root, and performs no cleanup.

Run: `python -m pytest apps/local-agent/tests/vault/test_backup.py apps/local-agent/tests/vault/test_backup_faults.py apps/local-agent/tests/vault/test_restore.py apps/local-agent/tests/vault/test_restore_faults.py apps/local-agent/tests/vault/test_backup_plaintext_boundary.py tests/acceptance/obsidian-backup-restore.py -m "not windows_elevated" -q; if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}; python -m pytest apps/local-agent/tests/memory/test_backup_restore.py -q`

Expected: PASS; crash recovery never labels a partial artifact, restore activates only a fully consistent new root, and the reported RPO is the latest sealed snapshot fence time. Run the real elevated VSS acceptance separately on the release machine.

- [ ] **Step 5: Commit coordinated vault recovery**

```powershell
git add apps/local-agent/jarvis_local/vault apps/local-agent/jarvis_local/memory/backup.py apps/local-agent/jarvis_local/service.py apps/local-agent/tests/vault tests/acceptance/obsidian-backup-restore.py
git commit -m "feat(vault): add coordinated backup and restore"
```

### Task O12: Integrate acceptance, release audit, real setup, and bounded live smoke

**Files:**
- Create: `tests/acceptance/obsidian-local-recall.py`
- Create: `tests/acceptance/obsidian-confirmed-cloud-recall.py`
- Create: `tests/acceptance/obsidian-write-once-projection.py`
- Create: `tests/acceptance/obsidian-real-setup.py`
- Create: `tests/acceptance/release/smoke-obsidian-live.py`
- Create: `tests/acceptance/release/test_obsidian_release_evidence.py`
- Create: `scripts/test-obsidian-acceptance.ps1`
- Create: `scripts/create-obsidian-release-evidence.ps1`
- Modify: `scripts/verify-clean-setup.ps1`
- Modify: `scripts/create-release-evidence.ps1`
- Modify: `scripts/release-audit.ps1`
- Modify: `tests/acceptance/release/test_deployment_scripts.py`
- Modify: `tests/acceptance/release/fixtures/complete-passed-manifest.json`
- Modify: `docs/runbooks/release-0.1.0.md`
- Modify: `docs/deployment/windows-local-agent.md`
- Modify: `README.md`
- Modify: `REQUIREMENTS.md`
- Modify: `TESTING.md`
- Modify: `CHANGELOG.md`
- Modify: `NEXT_STEPS.md`
- Modify: `KNOWN_ISSUES.md`
- Modify: `DECISIONS.md`
- Modify: `docs/HANDOFF.md`

**Interfaces:**
- Consumes: voice consolidation, legacy Tasks 1-10, Tasks O1-O11, the real signed Obsidian install, protected provider configuration, and the user's configured Jarvis/user identities.
- Produces: credential-free synthetic-vault acceptance, a real local owned-vault setup receipt, bounded live Obsidian/Twilio/Telegram smoke evidence, an expanded non-secret release manifest, and a release audit that cannot certify 0.1.0 without every Obsidian gate.

- [ ] **Step 1: Write failing end-to-end and release-audit tests**

```python
def test_release_manifest_rejects_legacy_only_evidence(tmp_path: Path) -> None:
    manifest = legacy_complete_manifest()
    with pytest.raises(ReleaseAuditError, match="obsidian_native_wheel"):
        audit_release_manifest(manifest)

def test_projection_acceptance_never_replaces_concurrent_user_content() -> None:
    run = acceptance_harness()
    run.reserve_target_then_user_creates(b"user content")
    result = run.project_confirmed_fact()
    assert result.code == "vault_target_exists"
    assert run.target_bytes == b"user content"

def test_local_note_recall_is_source_linked_and_model_free() -> None:
    run = acceptance_harness()
    run.create_user_note("Remember the blue folder")
    result = run.wait_for_cli_search("blue folder", timeout_seconds=5)
    assert result.source_label and result.observation_id
    assert run.model_calls == []
```

The expanded `REQUIRED_EVIDENCE` set must include `obsidian_native_wheel`, `obsidian_native_security`, `obsidian_contract_parity`, `obsidian_vault_setup`, `obsidian_seed_untouched`, `obsidian_reconciliation`, `obsidian_deterministic_retrieval`, `obsidian_cloud_ingest`, `obsidian_fact_authority`, `obsidian_write_once_projection`, `obsidian_backup_restore`, `obsidian_vss_elevated`, `obsidian_secret_boundary`, and `obsidian_live_capture_recall`, in addition to every legacy/calling gate. Synthetic `passed` fixture data validates the auditor only and never counts as real release evidence.

- [ ] **Step 2: Run acceptance/audit tests and verify red**

Run: `python -m pytest tests/acceptance/obsidian-local-recall.py tests/acceptance/obsidian-confirmed-cloud-recall.py tests/acceptance/obsidian-write-once-projection.py tests/acceptance/release/test_obsidian_release_evidence.py -q; if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}; powershell -ExecutionPolicy Bypass -File scripts/release-audit.ps1 -Manifest tests/acceptance/release/fixtures/complete-passed-manifest.json`

Expected: FAIL because the end-to-end harness and expanded manifest/auditor do not exist.

- [ ] **Step 3: Implement credential-free full-story acceptance and audit gates**

`test-obsidian-acceptance.ps1` creates only synthetic temporary NTFS vaults, runs native/reconciliation/retrieval/authority/projection/backup tests, then runs the complete Python, TypeScript, typecheck, lint, audit, diff, and clean-setup gates. It never reads `C:\Users\Ksid1\Jarvis Vault` or `C:\javis\Jarvis`. `create-obsidian-release-evidence.ps1` records commit IDs, artifact hashes, test identifiers, timestamps, redacted result codes, and VSS/setup receipt IDs only; it rejects raw paths, notes, phone numbers, account identifiers, credentials, or provider bodies.

Run: `powershell -ExecutionPolicy Bypass -File scripts/test-obsidian-acceptance.ps1; if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}; pnpm test; if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}; pnpm typecheck; if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}; pnpm lint; if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}; pnpm audit --audit-level high; if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}; git diff --check`

Expected: PASS with no credentials; the real release manifest remains incomplete because real setup, elevated VSS, and authorized live gates have not run.

- [ ] **Step 4: Run the real owned-vault setup and credential-free local acceptance**

First verify the installed executable signature and close Obsidian. Run `scripts/setup-obsidian-vault.ps1 -Execute` to create the approved Profile/fallback vault through Task O10, never the repo seed. Run `tests/acceptance/obsidian-real-setup.py` to prove ownership receipt, expected layout, seed-vault tree hash stability, open/closed runtime, <5-second stable-note local recall, and model-free deterministic rendering. Use one non-sensitive synthetic note created for this gate; remove nothing afterward because the write policy is write-once. Run the elevated Task O11 VSS gate and seal one encrypted coordinated backup.

Expected: PASS; Obsidian opens the owned vault, the unsupported seed remains byte-for-byte unchanged and untracked, and only redacted evidence is retained.

- [ ] **Step 5: Run already-authorized bounded live provider and Obsidian smoke**

Only after every credential-free, setup, and elevated backup gate passes, resolve provider identities from protected configuration without printing them. The live harness may send one non-sensitive Telegram text between the user's configured bot/account identities and place one bounded Twilio call between the configured Jarvis number and the user's verified number; it must not contact third parties, create/purchase provider resources, change webhooks unless the deployment runbook already requires the configured owned endpoint, or expose provider payloads. It also records one authenticated non-sensitive capture, verifies a write-once Obsidian projection, confirms/recalls the resulting fact through the authorized channel, and checks timeout/failure cleanup. Any missing credential yields `skipped` during development but blocks the release manifest.

Run: `python -m pytest tests/acceptance/release/smoke-obsidian-live.py tests/acceptance/release/smoke-telegram-live.py -m live -q; if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}; powershell -ExecutionPolicy Bypass -File scripts/create-obsidian-release-evidence.ps1 -Release 0.1.0; if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}; powershell -ExecutionPolicy Bypass -File scripts/release-audit.ps1 -Manifest docs/release-evidence/0.1.0/release-manifest.json`

Expected for release: PASS with every real evidence status `passed`. If credentials, deployment, or owned endpoint readiness are absent, stop before any provider action and leave the release blocked; do not weaken or synthesize evidence.

- [ ] **Step 6: Commit release integration and choose the branch disposition**

```powershell
git add tests/acceptance scripts docs README.md REQUIREMENTS.md TESTING.md CHANGELOG.md NEXT_STEPS.md KNOWN_ISSUES.md DECISIONS.md
git commit -m "chore(release): certify Obsidian memory integration"
```

After all automated and real gates pass, use `superpowers:finishing-a-development-branch`. Do not push, merge to `main`, tag, publish, deploy, or purchase resources unless the user has separately placed that exact external mutation in scope.

## Plan Self-Review

**Spec coverage:** O1-O4 cover the four-part local-command-cloud-binding contract, exact ingest authority, D1 sequencing, quotas, batches, replay equality, and excerpt availability. O5-O8 cover handle-confined NTFS operations, watcher-before-crawl generations, immutable local observations, current heads/tombstones, deterministic local retrieval, stable-ID upload, binding, and backpressure. O9 covers authenticated confirmation, supersession, retraction, export/capture decisions, cloud-only distillation, active-fact channel recall, and write-once projection. O10 covers signed Obsidian detection, owned setup, closed-app handoff, and diagnostics. O11 covers coordinated VSS backup, encryption, delta classification, physical rebase, and restore refusal. O12 makes all of them release-blocking and performs the three success-story acceptances.

**Authority review:** Device signatures authorize attempts, gateway events authorize global order, authenticated owner events or deterministic narrow grants authorize decisions, and only exact stored decision/event bindings authorize ingest, fact transitions, export, or capture. Local observations, Markdown, frontmatter, filenames, model output, receipts, HTTP responses, and bindings alone never authorize tools, permissions, identity, policy, or active memory.

**Boundedness review:** Every task names an exclusive file set, public interfaces, a red test, the minimal behavior, a green command, and a commit boundary. O2/O5 are the first parallel split; O3 follows O2; O6 follows O5; O7/O8 follow local baseline prerequisites; O9/O11/O12 are intentionally serialized integration gates. Shared integration files are modified only after their named predecessor branch consolidates.

**No-data-loss review:** All local source and evidence records append. Existing vault files are never replaced, renamed, moved, or deleted. Incomplete reconciliation cannot advance heads or infer deletion. Setup and restore activate only exact recorded new roots. Backup labels only one sealed coordinated set as recoverable. Rollback disables the adapter and leaves both authoritative stores and created Markdown intact.

## Execution Handoff

Execution status: **APPROVED combined plan, pending independent plan-review closure and implementation.** After the independent reviewers return no blocking findings, amend the legacy hard block to point here, commit both plan records, then execute from the reviewed voice-consolidation base with `superpowers:subagent-driven-development`. Use one fresh implementation worker per task or parallel lane, enforce exclusive file ownership, and require separate spec-compliance and code-quality review before merging each task commit. Credential-free work proceeds autonomously; real provider smoke stays bounded to the user's configured identities and begins only after all prerequisite gates pass.
