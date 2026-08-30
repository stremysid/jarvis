import {
  canonicalJson,
  GUEST_CAPABILITY_IDS,
  newUlid,
  sha256Hex,
  type GuestCapabilityId,
  type Sha256Hex,
  type Ulid,
  type VoiceResourceScopesV1,
} from "../../../../packages/contracts/src/index.js";
import {
  type GuestGrantSnapshot,
  VoiceAccessRepository,
} from "../persistence/voice-access-repository.js";
import { GuestPinVerifier } from "../security/guest-pin-verifier.js";
import { CapabilityRegistry, type CapabilitySnapshot } from "./capability-registry.js";
import type { OwnerAccessDraft } from "./owner-access-intent.js";
import {
  type OwnerCallAuthority,
  VoiceAccessAuthorityService,
} from "./voice-access-authority.js";

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

export interface OwnerAccessServiceDependencies {
  readonly repository: VoiceAccessRepository;
  readonly registry: CapabilityRegistry;
  readonly authorities: VoiceAccessAuthorityService;
  readonly verifier: GuestPinVerifier;
  readonly scopeResolver?: TargetGuestResourceScopeResolver;
  readonly idFactory?: (now: Date) => Ulid;
  readonly proposalIdFactory?: () => string;
  readonly defaultGuestPin?: () => unknown;
}

export interface OwnerAccessExecutionResult {
  readonly outcome: "created" | "changed" | "rotated" | "revoked" | "listed";
  readonly speech: string;
}

type CapturedDraft =
  | Readonly<{
    kind: "add" | "replace_permissions";
    providerE164: string;
    permissionPhrases: readonly string[];
    resourceScopes: VoiceResourceScopesV1 | null;
  }>
  | Readonly<{ kind: "rotate_pin"; providerE164: string }>
  | Readonly<{ kind: "revoke"; providerE164: string }>
  | Readonly<{ kind: "list" }>;

interface PreparedState {
  readonly proposal: PreparedOwnerAccessProposal;
  readonly ownerAuthority: OwnerCallAuthority;
  readonly draft: CapturedDraft;
  readonly providerE164: string | null;
  readonly grantId: string | null;
  readonly expectedGrantVersion: number | null;
  readonly snapshot: CapabilitySnapshot | null;
}

interface CapturedPinSelection {
  readonly kind: "explicit" | "default";
  readonly source: Uint8Array | null;
  readonly digits: Uint8Array | null;
}

const ULID = /^[0-7][0-9a-hjkmnp-tv-z]{25}$/u;
const E164 = /^\+[1-9][0-9]{7,14}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,255}$/u;
const SAFE_PROPOSAL_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/u;
const PERMISSION_PHRASE = /^[a-z][a-z0-9]*(?: [a-z][a-z0-9]*){0,3}$/u;
const OPAQUE_SCOPE_ID = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/u;
const DEPENDENCY_FIELDS = new Set([
  "repository", "registry", "authorities", "verifier", "scopeResolver", "idFactory", "proposalIdFactory",
  "defaultGuestPin",
]);
const REQUIRED_DEPENDENCY_FIELDS = new Set(["repository", "registry", "authorities", "verifier"]);
const PREPARE_FIELDS = new Set(["ownerAuthority", "sessionId", "draft", "now"]);
const EXECUTE_FIELDS = new Set(["proposal", "ownerAuthority", "pinSelection", "now"]);
const PERMISSION_DRAFT_FIELDS = new Set(["kind", "providerE164", "permissionPhrases"]);
const SCOPED_PERMISSION_DRAFT_FIELDS = new Set([
  "kind", "providerE164", "permissionPhrases", "resourceScopes",
]);
const TARGET_DRAFT_FIELDS = new Set(["kind", "providerE164"]);
const LIST_DRAFT_FIELDS = new Set(["kind"]);
const RESOURCE_SCOPE_FIELDS = new Set([
  "schemaVersion", "calendarConnectionIds", "fileRootIds", "pcActionIds",
]);
const SCOPE_ASSIGNMENT_FIELDS = new Set(["providerE164", "resourceScopes"]);

const PERMISSION_CAPABILITIES = Object.freeze({
  conversation: "conversation.basic",
  "web research": "research.web",
  memory: "memory.own",
  reminders: "reminders.manage",
  "calendar reading": "calendar.read",
  "calendar management": "calendar.manage",
  "owner contact": "owner.contact",
  "communication drafting": "communications.draft",
  "communication sending": "communications.send",
  calls: "calls.place",
  "file reading": "files.read",
  "file writing": "files.write",
  "computer control": "pc.control",
  "spending proposals": "spending.propose",
  "destructive proposals": "destructive.propose",
  "destructive action proposals": "destructive.propose",
  "access management": "access.manage",
} as const);

const CAPABILITY_LABELS: Readonly<Record<GuestCapabilityId, string>> = Object.freeze({
  "conversation.basic": "conversation",
  "research.web": "web research",
  "memory.own": "memory",
  "reminders.manage": "reminders",
  "calendar.read": "calendar reading",
  "calendar.manage": "calendar management",
  "owner.contact": "owner contact",
  "communications.draft": "communication drafting",
  "communications.send": "communication sending",
  "calls.place": "calls",
  "files.read": "file reading",
  "files.write": "file writing",
  "pc.control": "computer control",
  "spending.propose": "spending proposals",
  "destructive.propose": "destructive action proposals",
});

function invalidInput(): never {
  throw new TypeError("owner_access_input_invalid");
}

function captureExact(value: unknown, fields: ReadonlySet<string>, invalid: () => never = invalidInput): Record<string, unknown> {
  let prototype: object | null;
  let keys: readonly PropertyKey[];
  try {
    prototype = value !== null && typeof value === "object" ? Object.getPrototypeOf(value) : null;
    keys = value !== null && typeof value === "object" ? Reflect.ownKeys(value) : [];
  } catch {
    invalid();
  }
  if (value === null || typeof value !== "object" || Array.isArray(value) || prototype !== Object.prototype) invalid();
  if (keys.length !== fields.size || keys.some((key) => typeof key !== "string" || !fields.has(key))) invalid();
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const field of fields) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, field);
    } catch {
      invalid();
    }
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) invalid();
    result[field] = descriptor.value;
  }
  return result;
}

function invalidScopeResolver(): never {
  throw new TypeError("owner_access_scope_resolver_invalid");
}

function captureScopeIds(value: unknown, invalid: () => never): readonly string[] {
  let prototype: object | null;
  let keys: readonly PropertyKey[];
  let length: number;
  try {
    prototype = value !== null && typeof value === "object" ? Object.getPrototypeOf(value) : null;
    keys = value !== null && typeof value === "object" ? Reflect.ownKeys(value) : [];
    const lengthDescriptor = value !== null && typeof value === "object"
      ? Object.getOwnPropertyDescriptor(value, "length")
      : undefined;
    length = lengthDescriptor !== undefined && "value" in lengthDescriptor
      ? Number(lengthDescriptor.value)
      : Number.NaN;
  } catch {
    return invalid();
  }
  if (
    !Array.isArray(value) || prototype !== Array.prototype || !Number.isSafeInteger(length)
    || length < 0 || length > 256
    || keys.some((key) => key !== "length"
      && !(typeof key === "string" && /^(?:0|[1-9][0-9]*)$/u.test(key) && Number(key) < length))
  ) {
    invalid();
  }
  const ids: string[] = [];
  for (let index = 0; index < length; index += 1) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    } catch {
      return invalid();
    }
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) invalid();
    const id = descriptor.value;
    if (
      typeof id !== "string" || !id.isWellFormed() || id !== id.normalize("NFC")
      || !OPAQUE_SCOPE_ID.test(id) || id.includes("*") || id.includes("/") || id.includes("\\")
    ) {
      invalid();
    }
    ids.push(id);
  }
  return Object.freeze([...new Set(ids)].sort());
}

function captureResourceScopes(
  value: unknown,
  invalid: () => never = invalidInput,
): VoiceResourceScopesV1 {
  const captured = captureExact(value, RESOURCE_SCOPE_FIELDS, invalid);
  if (captured.schemaVersion !== "1.0") invalid();
  return Object.freeze({
    schemaVersion: "1.0",
    calendarConnectionIds: captureScopeIds(captured.calendarConnectionIds, invalid),
    fileRootIds: captureScopeIds(captured.fileRootIds, invalid),
    pcActionIds: captureScopeIds(captured.pcActionIds, invalid),
  });
}

const EMPTY_RESOURCE_SCOPES: VoiceResourceScopesV1 = Object.freeze({
  schemaVersion: "1.0",
  calendarConnectionIds: Object.freeze([] as string[]),
  fileRootIds: Object.freeze([] as string[]),
  pcActionIds: Object.freeze([] as string[]),
});
const GUEST_CAPABILITIES = new Set<string>(GUEST_CAPABILITY_IDS);

export interface TargetGuestResourceScopeAssignment {
  readonly providerE164: string;
  readonly resourceScopes: VoiceResourceScopesV1;
}

export class TargetGuestResourceScopeResolver {
  readonly #ownedByProvider = new Map<string, VoiceResourceScopesV1>();

  constructor(assignments: readonly TargetGuestResourceScopeAssignment[]) {
    let prototype: object | null;
    let keys: readonly PropertyKey[];
    let length: number;
    try {
      prototype = Object.getPrototypeOf(assignments);
      keys = Reflect.ownKeys(assignments);
      const lengthDescriptor = Object.getOwnPropertyDescriptor(assignments, "length");
      length = lengthDescriptor !== undefined && "value" in lengthDescriptor
        ? Number(lengthDescriptor.value)
        : Number.NaN;
    } catch {
      invalidScopeResolver();
    }
    if (
      !Array.isArray(assignments) || prototype !== Array.prototype || !Number.isSafeInteger(length)
      || length < 0 || length > 256
      || keys.some((key) => key !== "length"
        && !(typeof key === "string" && /^(?:0|[1-9][0-9]*)$/u.test(key) && Number(key) < length))
    ) {
      invalidScopeResolver();
    }
    for (let index = 0; index < length; index += 1) {
      let descriptor: PropertyDescriptor | undefined;
      try {
        descriptor = Object.getOwnPropertyDescriptor(assignments, String(index));
      } catch {
        invalidScopeResolver();
      }
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) invalidScopeResolver();
      const captured = captureExact(descriptor.value, SCOPE_ASSIGNMENT_FIELDS, invalidScopeResolver);
      if (typeof captured.providerE164 !== "string" || !E164.test(captured.providerE164)) {
        invalidScopeResolver();
      }
      if (this.#ownedByProvider.has(captured.providerE164)) invalidScopeResolver();
      this.#ownedByProvider.set(
        captured.providerE164,
        captureResourceScopes(captured.resourceScopes, invalidScopeResolver),
      );
    }
  }

  resolve(
    providerE164: string,
    capabilityIds: readonly GuestCapabilityId[],
    requestedScopes: VoiceResourceScopesV1 | null,
  ): VoiceResourceScopesV1 {
    if (
      typeof providerE164 !== "string" || !E164.test(providerE164) || !Array.isArray(capabilityIds)
      || capabilityIds.some((capability) => !GUEST_CAPABILITIES.has(capability))
      || new Set(capabilityIds).size !== capabilityIds.length
    ) {
      invalidScopeResolver();
    }
    const owned = this.#ownedByProvider.get(providerE164) ?? EMPTY_RESOURCE_SCOPES;
    const requested = requestedScopes === null
      ? null
      : captureResourceScopes(requestedScopes, invalidScopeResolver);
    const select = (
      required: boolean,
      requestedIds: readonly string[] | null,
      ownedIds: readonly string[],
    ): readonly string[] => {
      if (!required) {
        if ((requestedIds?.length ?? 0) > 0) invalidScopeResolver();
        return Object.freeze([] as string[]);
      }
      const selected = requestedIds ?? ownedIds;
      if (selected.length === 0 || selected.some((id) => !ownedIds.includes(id))) invalidScopeResolver();
      return Object.freeze([...selected]);
    };
    const needsCalendar = capabilityIds.some((capability) =>
      capability === "calendar.read" || capability === "calendar.manage");
    const needsFiles = capabilityIds.some((capability) =>
      capability === "files.read" || capability === "files.write");
    const needsPc = capabilityIds.includes("pc.control");
    return Object.freeze({
      schemaVersion: "1.0",
      calendarConnectionIds: select(
        needsCalendar,
        requested?.calendarConnectionIds ?? null,
        owned.calendarConnectionIds,
      ),
      fileRootIds: select(needsFiles, requested?.fileRootIds ?? null, owned.fileRootIds),
      pcActionIds: select(needsPc, requested?.pcActionIds ?? null, owned.pcActionIds),
    });
  }
}

function dateEpoch(value: unknown): number {
  let epoch: number;
  try {
    epoch = Date.prototype.getTime.call(value);
  } catch {
    invalidInput();
  }
  if (!Number.isFinite(epoch)) invalidInput();
  return epoch;
}

function captureStringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) invalidInput();
  const result: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) invalidInput();
    const phrase = descriptor.value;
    if (
      typeof phrase !== "string" || phrase.length > 64 || !phrase.isWellFormed()
      || phrase !== phrase.normalize("NFC") || !PERMISSION_PHRASE.test(phrase)
    ) {
      invalidInput();
    }
    result.push(phrase);
  }
  if (
    Reflect.ownKeys(value).some((key) => key !== "length"
      && !(typeof key === "string" && /^(?:0|[1-9][0-9]*)$/u.test(key)))
    || new Set(result).size !== result.length
  ) {
    invalidInput();
  }
  return Object.freeze(result);
}

function captureDraft(value: unknown): CapturedDraft {
  let kindDescriptor: PropertyDescriptor | undefined;
  let resourceScopesDescriptor: PropertyDescriptor | undefined;
  try {
    kindDescriptor = value !== null && typeof value === "object"
      ? Object.getOwnPropertyDescriptor(value, "kind")
      : undefined;
    resourceScopesDescriptor = value !== null && typeof value === "object"
      ? Object.getOwnPropertyDescriptor(value, "resourceScopes")
      : undefined;
  } catch {
    invalidInput();
  }
  if (kindDescriptor === undefined || !("value" in kindDescriptor)) invalidInput();
  const kind = kindDescriptor.value;
  if (kind === "add" || kind === "replace_permissions") {
    const captured = captureExact(
      value,
      resourceScopesDescriptor === undefined ? PERMISSION_DRAFT_FIELDS : SCOPED_PERMISSION_DRAFT_FIELDS,
    );
    if (typeof captured.providerE164 !== "string" || !E164.test(captured.providerE164)) invalidInput();
    return Object.freeze({
      kind,
      providerE164: captured.providerE164,
      permissionPhrases: captureStringArray(captured.permissionPhrases),
      resourceScopes: resourceScopesDescriptor === undefined
        ? null
        : captureResourceScopes(captured.resourceScopes),
    });
  }
  if (kind === "rotate_pin" || kind === "revoke") {
    const captured = captureExact(value, TARGET_DRAFT_FIELDS);
    if (typeof captured.providerE164 !== "string" || !E164.test(captured.providerE164)) invalidInput();
    return Object.freeze({ kind, providerE164: captured.providerE164 });
  }
  if (kind === "list") {
    captureExact(value, LIST_DRAFT_FIELDS);
    return Object.freeze({ kind });
  }
  invalidInput();
}

function capturePinSelection(value: unknown): CapturedPinSelection | null {
  if (value === null) return null;
  const kindDescriptor = value !== null && typeof value === "object"
    ? Object.getOwnPropertyDescriptor(value, "kind")
    : undefined;
  if (kindDescriptor === undefined || !("value" in kindDescriptor)) invalidInput();
  if (kindDescriptor.value === "default") {
    captureExact(value, new Set(["kind"]));
    return Object.freeze({ kind: "default", source: null, digits: null });
  }
  if (kindDescriptor.value !== "explicit") invalidInput();
  const captured = captureExact(value, new Set(["kind", "digits"]));
  const digits = captured.digits;
  if (!(digits instanceof Uint8Array) || Object.getPrototypeOf(digits) !== Uint8Array.prototype) invalidInput();
  const source = digits;
  if (source.byteLength !== 4 || source.some((byte) => byte < 0x30 || byte > 0x39)) {
    source.fill(0);
    throw new TypeError("owner_access_pin_invalid");
  }
  return Object.freeze({ kind: "explicit", source, digits: source.slice() });
}

function maskNumber(value: string): string {
  if (!E164.test(value)) invalidInput();
  const prefixLength = Math.min(2, value.length - 4);
  return `${value.slice(0, prefixLength)}${"*".repeat(value.length - prefixLength - 4)}${value.slice(-4)}`;
}

function safeProposalId(value: unknown): string {
  if (
    typeof value !== "string" || !value.isWellFormed() || value !== value.normalize("NFC")
    || !SAFE_PROPOSAL_ID.test(value)
  ) {
    throw new Error("owner_access_id_invalid");
  }
  return value;
}

function safeUlid(value: unknown): Ulid {
  if (typeof value !== "string" || !ULID.test(value)) throw new Error("owner_access_id_invalid");
  return value as Ulid;
}

function safeError(message: string): Error {
  return new Error(message);
}

export class OwnerAccessService {
  readonly #repository: VoiceAccessRepository;
  readonly #registry: CapabilityRegistry;
  readonly #authorities: VoiceAccessAuthorityService;
  readonly #verifier: GuestPinVerifier;
  readonly #scopeResolver: TargetGuestResourceScopeResolver;
  readonly #idFactory: (now: Date) => Ulid;
  readonly #proposalIdFactory: () => string;
  readonly #defaultGuestPin: (() => unknown) | undefined;
  readonly #issued = new WeakMap<object, PreparedState>();
  readonly #currentBySession = new Map<Ulid, PreparedOwnerAccessProposal>();

  constructor(dependencies: OwnerAccessServiceDependencies) {
    let prototype: object | null;
    let keys: readonly PropertyKey[];
    try {
      prototype = Object.getPrototypeOf(dependencies);
      keys = Reflect.ownKeys(dependencies);
    } catch {
      invalidInput();
    }
    if (
      dependencies === null || typeof dependencies !== "object" || Array.isArray(dependencies)
      || prototype !== Object.prototype
      || keys.some((key) => typeof key !== "string" || !DEPENDENCY_FIELDS.has(key))
      || [...REQUIRED_DEPENDENCY_FIELDS].some((field) => !keys.includes(field))
    ) {
      invalidInput();
    }
    const captured: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of keys) {
      if (typeof key !== "string") invalidInput();
      const descriptor = Object.getOwnPropertyDescriptor(dependencies, key);
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) invalidInput();
      captured[key] = descriptor.value;
    }
    const repository = captured.repository;
    const registry = captured.registry;
    const authorities = captured.authorities;
    const verifier = captured.verifier;
    const scopeResolver = captured.scopeResolver ?? new TargetGuestResourceScopeResolver([]);
    const idFactory = captured.idFactory ?? ((now: Date) => newUlid(now));
    const proposalIdFactory = captured.proposalIdFactory ?? (() => `owner-access-proposal:${crypto.randomUUID()}`);
    const defaultGuestPin = captured.defaultGuestPin;
    if (
      !(repository instanceof VoiceAccessRepository) || !(registry instanceof CapabilityRegistry)
      || !(authorities instanceof VoiceAccessAuthorityService) || !(verifier instanceof GuestPinVerifier)
      || !(scopeResolver instanceof TargetGuestResourceScopeResolver)
      || typeof idFactory !== "function" || typeof proposalIdFactory !== "function"
      || (defaultGuestPin !== undefined && typeof defaultGuestPin !== "function")
    ) {
      invalidInput();
    }
    this.#repository = repository;
    this.#registry = registry;
    this.#authorities = authorities;
    this.#verifier = verifier;
    this.#scopeResolver = scopeResolver;
    this.#idFactory = idFactory as (now: Date) => Ulid;
    this.#proposalIdFactory = proposalIdFactory as () => string;
    this.#defaultGuestPin = defaultGuestPin as (() => unknown) | undefined;
  }

  async #ownerAuthority(value: unknown, now: Date): Promise<OwnerCallAuthority> {
    try {
      const authority = this.#authorities.snapshot(value);
      if (authority.kind !== "owner") throw safeError("owner_access_authority_invalid");
      await this.#authorities.authorizeOwnerManagement(authority, now);
      return authority;
    } catch {
      throw safeError("owner_access_authority_invalid");
    }
  }

  async #snapshot(
    permissionPhrases: readonly string[],
    providerE164: string,
    requestedScopes: VoiceResourceScopesV1 | null,
  ): Promise<CapabilitySnapshot> {
    let requested: readonly string[] | "everything";
    if (permissionPhrases.length === 1 && permissionPhrases[0] === "everything") {
      requested = "everything";
    } else {
      const capabilities: string[] = [];
      for (const phrase of permissionPhrases) {
        const capability = PERMISSION_CAPABILITIES[phrase as keyof typeof PERMISSION_CAPABILITIES];
        if (capability === undefined) throw safeError("owner_access_permission_invalid");
        capabilities.push(capability);
      }
      requested = Object.freeze(capabilities);
    }
    try {
      const capabilityIds = this.#registry.resolve(requested);
      const resourceScopes = this.#scopeResolver.resolve(providerE164, capabilityIds, requestedScopes);
      return await this.#registry.snapshot(capabilityIds, resourceScopes);
    } catch {
      throw safeError("owner_access_permission_invalid");
    }
  }

  async prepare(input: {
    ownerAuthority: OwnerCallAuthority;
    sessionId: Ulid;
    draft: OwnerAccessDraft;
    now: Date;
  }): Promise<PreparedOwnerAccessProposal> {
    const captured = captureExact(input, PREPARE_FIELDS);
    if (typeof captured.sessionId !== "string" || !ULID.test(captured.sessionId)) invalidInput();
    const nowEpoch = dateEpoch(captured.now);
    const now = new Date(nowEpoch);
    const draft = captureDraft(captured.draft);
    const ownerAuthority = await this.#ownerAuthority(captured.ownerAuthority, now);
    if (ownerAuthority.sessionId !== captured.sessionId) throw safeError("owner_access_authority_invalid");

    let providerE164: string | null = null;
    let target: GuestGrantSnapshot | null = null;
    let snapshot: CapabilitySnapshot | null = null;
    let grantId: string | null = null;
    if (draft.kind !== "list") {
      providerE164 = draft.providerE164;
      target = await this.#repository.getGuestGrantByProviderE164(providerE164);
    }
    if (draft.kind === "add") {
      if (target !== null) throw safeError("owner_access_target_unavailable");
      snapshot = await this.#snapshot(draft.permissionPhrases, draft.providerE164, draft.resourceScopes);
      grantId = safeUlid(this.#idFactory(new Date(nowEpoch)));
    } else if (draft.kind === "replace_permissions") {
      if (target === null || target.status === "revoked") throw safeError("owner_access_target_unavailable");
      snapshot = await this.#snapshot(draft.permissionPhrases, draft.providerE164, draft.resourceScopes);
      grantId = target.grantId;
    } else if (draft.kind === "rotate_pin" || draft.kind === "revoke") {
      if (target === null || target.status === "revoked") throw safeError("owner_access_target_unavailable");
      grantId = target.grantId;
    }

    const previous = this.#currentBySession.get(ownerAuthority.sessionId);
    if (previous !== undefined) this.invalidate(previous);
    const createdAt = now.toISOString();
    const proposal: PreparedOwnerAccessProposal = Object.freeze({
      proposalId: safeProposalId(this.#proposalIdFactory()),
      sessionId: ownerAuthority.sessionId,
      ownerIdentityId: ownerAuthority.identityId,
      operation: draft.kind,
      maskedTarget: providerE164 === null ? null : maskNumber(providerE164),
      capabilityIds: snapshot?.capabilityIds ?? target?.capabilityIds ?? Object.freeze([] as GuestCapabilityId[]),
      accessDocumentHash: snapshot?.accessDocumentHash ?? target?.accessDocumentHash ?? null,
      createdAt,
      expiresAt: new Date(nowEpoch + 60_000).toISOString(),
    });
    const state: PreparedState = Object.freeze({
      proposal,
      ownerAuthority,
      draft,
      providerE164,
      grantId,
      expectedGrantVersion: target?.grantVersion ?? null,
      snapshot,
    });
    this.#issued.set(proposal, state);
    this.#currentBySession.set(ownerAuthority.sessionId, proposal);
    return proposal;
  }

  async #requestHash(state: PreparedState, mutationId: Ulid, verifierDigest: string | null): Promise<Sha256Hex> {
    return sha256Hex(canonicalJson([
      "jarvis.owner-access", "1.0", state.proposal.proposalId, mutationId,
      state.proposal.operation, state.grantId, state.expectedGrantVersion,
      state.proposal.accessDocumentHash, verifierDigest,
    ]));
  }

  #result(outcome: OwnerAccessExecutionResult["outcome"], speech: string): OwnerAccessExecutionResult {
    return Object.freeze({ outcome, speech });
  }

  async execute(input: {
    proposal: PreparedOwnerAccessProposal;
    ownerAuthority: OwnerCallAuthority;
    pinSelection: OwnerPinSelection | null;
    now: Date;
  }): Promise<OwnerAccessExecutionResult> {
    const captured = captureExact(input, EXECUTE_FIELDS);
    const nowEpoch = dateEpoch(captured.now);
    const selection = capturePinSelection(captured.pinSelection);
    let pinBytes = selection?.digits ?? null;
    try {
      const state = captured.proposal !== null && typeof captured.proposal === "object"
        ? this.#issued.get(captured.proposal)
        : undefined;
      if (
        state === undefined || state.proposal !== captured.proposal || !Object.isFrozen(captured.proposal)
        || this.#currentBySession.get(state.proposal.sessionId) !== state.proposal
      ) {
        throw safeError("owner_access_proposal_invalid");
      }
      if (new Date(state.proposal.expiresAt).valueOf() <= nowEpoch) {
        this.invalidate(state.proposal);
        throw safeError("owner_access_proposal_expired");
      }
      if (state.ownerAuthority !== captured.ownerAuthority) throw safeError("owner_access_authority_invalid");
      const now = new Date(nowEpoch);
      let persisted;
      try {
        const authority = this.#authorities.snapshot(captured.ownerAuthority);
        if (authority.kind !== "owner" || authority.sessionId !== state.proposal.sessionId
          || authority.identityId !== state.proposal.ownerIdentityId) {
          throw safeError("owner_access_authority_invalid");
        }
        persisted = await this.#authorities.authorizeOwnerManagement(authority, now);
      } catch {
        throw safeError("owner_access_authority_invalid");
      }

      const needsPin = state.draft.kind === "add" || state.draft.kind === "rotate_pin";
      if (needsPin && selection === null) throw safeError("owner_access_pin_required");
      if (!needsPin && selection !== null) throw safeError("owner_access_pin_unexpected");
      this.invalidate(state.proposal);

      if (selection?.kind === "default") {
        let defaultPin: unknown;
        try {
          defaultPin = this.#defaultGuestPin?.();
        } catch {
          throw safeError("owner_access_default_pin_invalid");
        }
        if (typeof defaultPin !== "string" || !/^[0-9]{4}$/u.test(defaultPin)) {
          throw safeError("owner_access_default_pin_invalid");
        }
        pinBytes = Uint8Array.from(defaultPin, (digit) => digit.charCodeAt(0));
      }

      try {
        if (state.draft.kind === "list") {
          const guests = await this.#repository.listGuests({
            ownerAuthority: persisted,
            ownerIdentityId: state.proposal.ownerIdentityId,
            now,
          });
          const speech = guests.length === 0
            ? "There are no allowed callers."
            : `Allowed callers: ${guests.map((guest) => `${guest.maskedNumber}, ${guest.status}, ${guest.capabilityIds.map((id) => CAPABILITY_LABELS[id]).join(", ")}`).join("; ")}.`;
          return this.#result("listed", speech);
        }

        const mutationId = safeUlid(this.#idFactory(new Date(nowEpoch)));
        if (state.grantId === null || state.providerE164 === null) throw safeError("owner_access_operation_failed");
        if (state.draft.kind === "add") {
          if (pinBytes === null || state.snapshot === null) throw safeError("owner_access_operation_failed");
          const pinVerifier = await this.#verifier.create(state.grantId, pinBytes);
          const requestHash = await this.#requestHash(state, mutationId, pinVerifier.digestBase64);
          await this.#repository.createGuestGrant({
            mutationId,
            requestHash,
            ownerAuthority: persisted,
            ownerIdentityId: state.proposal.ownerIdentityId,
            grantId: state.grantId,
            guestPrincipalId: `principal:voice-guest:${state.grantId}`,
            guestIdentityId: `identity:voice-guest:${state.grantId}`,
            providerE164: state.providerE164,
            capabilityIds: state.snapshot.capabilityIds,
            resourceScopes: state.snapshot.resourceScopes,
            accessDocumentHash: state.snapshot.accessDocumentHash,
            pinVerifier,
            now,
          });
          return this.#result("created", `Caller ${state.proposal.maskedTarget ?? "masked"} is allowed.`);
        }
        if (state.expectedGrantVersion === null) throw safeError("owner_access_operation_failed");
        if (state.draft.kind === "replace_permissions") {
          if (state.snapshot === null) throw safeError("owner_access_operation_failed");
          const requestHash = await this.#requestHash(state, mutationId, null);
          await this.#repository.replacePermissions({
            mutationId,
            requestHash,
            ownerAuthority: persisted,
            ownerIdentityId: state.proposal.ownerIdentityId,
            grantId: state.grantId,
            expectedGrantVersion: state.expectedGrantVersion,
            capabilityIds: state.snapshot.capabilityIds,
            resourceScopes: state.snapshot.resourceScopes,
            accessDocumentHash: state.snapshot.accessDocumentHash,
            now,
          });
          return this.#result("changed", `Permissions changed for ${state.proposal.maskedTarget ?? "the caller"}.`);
        }
        if (state.draft.kind === "rotate_pin") {
          if (pinBytes === null) throw safeError("owner_access_operation_failed");
          const pinVerifier = await this.#verifier.create(state.grantId, pinBytes);
          const requestHash = await this.#requestHash(state, mutationId, pinVerifier.digestBase64);
          await this.#repository.rotatePin({
            mutationId,
            requestHash,
            ownerAuthority: persisted,
            ownerIdentityId: state.proposal.ownerIdentityId,
            grantId: state.grantId,
            expectedGrantVersion: state.expectedGrantVersion,
            pinVerifier,
            now,
          });
          return this.#result("rotated", `The PIN changed for ${state.proposal.maskedTarget ?? "the caller"}.`);
        }
        const requestHash = await this.#requestHash(state, mutationId, null);
        await this.#repository.revokeGrant({
          mutationId,
          requestHash,
          ownerAuthority: persisted,
          ownerIdentityId: state.proposal.ownerIdentityId,
          grantId: state.grantId,
          expectedGrantVersion: state.expectedGrantVersion,
          now,
        });
        return this.#result("revoked", `Access revoked for ${state.proposal.maskedTarget ?? "the caller"}.`);
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("owner_access_")) throw error;
        throw safeError("owner_access_operation_failed");
      }
    } finally {
      selection?.source?.fill(0);
      pinBytes?.fill(0);
    }
  }

  invalidate(proposal: unknown): void {
    if (proposal === null || typeof proposal !== "object") return;
    const state = this.#issued.get(proposal);
    if (state === undefined) return;
    this.#issued.delete(proposal);
    if (this.#currentBySession.get(state.proposal.sessionId) === state.proposal) {
      this.#currentBySession.delete(state.proposal.sessionId);
    }
  }
}
