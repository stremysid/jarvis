import {
  canonicalJson,
  GUEST_CAPABILITY_IDS,
  sha256Hex,
  type GuestCapabilityId,
  type Sha256Hex,
  type VoiceResourceScopesV1,
} from "../../../../packages/contracts/src/index.js";

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

const CONFIGURATION_FIELDS = new Set([
  "installed",
  "calendarConnectionIds",
  "fileRootIds",
  "pcActionIds",
]);
const SCOPE_FIELDS = new Set([
  "schemaVersion",
  "calendarConnectionIds",
  "fileRootIds",
  "pcActionIds",
]);
const OWNER_ONLY_CAPABILITIES = new Set([
  "owner.root",
  "access.manage",
  "credentials.manage",
  "safety.configure",
  "identity.owner.rotate",
]);
const GUEST_CAPABILITIES = new Set<string>(GUEST_CAPABILITY_IDS);
const OPAQUE_SCOPE_ID = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/u;

function invalidRegistry(): never {
  throw new TypeError("capability_registry_invalid");
}

function invalidScope(): never {
  throw new TypeError("resource_scope_invalid");
}

function captureObject(
  value: unknown,
  allowedFields: ReadonlySet<string>,
  requiredFields: ReadonlySet<string>,
  invalid: () => never,
): Record<string, unknown> {
  let prototype: object | null;
  let keys: readonly PropertyKey[];
  try {
    prototype = value !== null && typeof value === "object" ? Object.getPrototypeOf(value) : null;
    keys = value !== null && typeof value === "object" ? Reflect.ownKeys(value) : [];
  } catch {
    return invalid();
  }
  if (value === null || typeof value !== "object" || Array.isArray(value) || prototype !== Object.prototype) invalid();
  if (keys.some((key) => typeof key !== "string" || !allowedFields.has(key))) invalid();
  for (const field of requiredFields) if (!keys.includes(field)) invalid();

  const captured: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    if (typeof key !== "string") invalid();
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      return invalid();
    }
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) invalid();
    captured[key] = descriptor.value;
  }
  return captured;
}

function captureStringArray(value: unknown, invalid: () => never, validate: (value: string) => boolean): readonly string[] {
  if (!Array.isArray(value) || value.length > 256) invalid();
  const result: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    } catch {
      return invalid();
    }
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) invalid();
    const item = descriptor.value;
    if (typeof item !== "string" || !item.isWellFormed() || item !== item.normalize("NFC") || !validate(item)) invalid();
    result.push(item);
  }
  const extraKeys = Reflect.ownKeys(value).filter((key) => key !== "length" && !(typeof key === "string" && /^(?:0|[1-9][0-9]*)$/u.test(key)));
  if (extraKeys.length > 0) invalid();
  return Object.freeze([...new Set(result)].sort());
}

function captureInstalled(value: unknown): readonly string[] {
  return captureStringArray(value, invalidRegistry, (item) => item.length > 0 && item.length <= 128 && /^[a-z][a-z0-9._-]*$/u.test(item));
}

function captureScopeIds(value: unknown): readonly string[] {
  return captureStringArray(value, invalidScope, (item) => OPAQUE_SCOPE_ID.test(item) && !item.includes("*") && !item.includes("\\") && !item.includes("/"));
}

function needsCalendar(capabilities: readonly GuestCapabilityId[]): boolean {
  return capabilities.some((capability) => capability === "calendar.read" || capability === "calendar.manage");
}

function needsFiles(capabilities: readonly GuestCapabilityId[]): boolean {
  return capabilities.some((capability) => capability === "files.read" || capability === "files.write");
}

function needsPc(capabilities: readonly GuestCapabilityId[]): boolean {
  return capabilities.includes("pc.control");
}

export class CapabilityRegistry {
  readonly #installed: ReadonlySet<string>;
  readonly #calendarConnectionIds: ReadonlySet<string>;
  readonly #fileRootIds: ReadonlySet<string>;
  readonly #pcActionIds: ReadonlySet<string>;

  constructor(configuration: CapabilityRegistryConfiguration) {
    const captured = captureObject(configuration, CONFIGURATION_FIELDS, new Set(["installed"]), invalidRegistry);
    const installed = captureInstalled(captured.installed);
    const calendarConnectionIds = captured.calendarConnectionIds === undefined
      ? Object.freeze([] as string[])
      : captureStringArray(captured.calendarConnectionIds, invalidRegistry, (item) => OPAQUE_SCOPE_ID.test(item));
    const fileRootIds = captured.fileRootIds === undefined
      ? Object.freeze([] as string[])
      : captureStringArray(captured.fileRootIds, invalidRegistry, (item) => OPAQUE_SCOPE_ID.test(item));
    const pcActionIds = captured.pcActionIds === undefined
      ? Object.freeze([] as string[])
      : captureStringArray(captured.pcActionIds, invalidRegistry, (item) => OPAQUE_SCOPE_ID.test(item));
    this.#installed = new Set(installed);
    this.#calendarConnectionIds = new Set(calendarConnectionIds);
    this.#fileRootIds = new Set(fileRootIds);
    this.#pcActionIds = new Set(pcActionIds);
  }

  #resourceAdapterAvailable(capability: GuestCapabilityId): boolean {
    if (capability === "calendar.read" || capability === "calendar.manage") return this.#calendarConnectionIds.size > 0;
    if (capability === "files.read" || capability === "files.write") return this.#fileRootIds.size > 0;
    if (capability === "pc.control") return this.#pcActionIds.size > 0;
    return true;
  }

  isInstalled(capabilityId: string): boolean {
    if (
      typeof capabilityId !== "string"
      || !capabilityId.isWellFormed()
      || capabilityId !== capabilityId.normalize("NFC")
      || capabilityId.length === 0
      || capabilityId.length > 128
      || !/^[a-z][a-z0-9._-]*$/u.test(capabilityId)
    ) {
      throw new TypeError("capability_unknown");
    }
    return this.#installed.has(capabilityId) && !capabilityId.startsWith("stremy.");
  }

  resolve(requested: readonly string[] | "everything"): readonly GuestCapabilityId[] {
    const requestedValues = requested === "everything"
      ? GUEST_CAPABILITY_IDS.filter((capability) => this.#installed.has(capability) && this.#resourceAdapterAvailable(capability))
      : captureStringArray(requested, invalidRegistry, (item) => item.length > 0 && item.length <= 128 && /^[a-z][a-z0-9._-]*$/u.test(item));

    const selected = new Set<GuestCapabilityId>();
    for (const capability of requestedValues) {
      if (!GUEST_CAPABILITIES.has(capability)) {
        if (OWNER_ONLY_CAPABILITIES.has(capability)) throw new TypeError("capability_not_grantable");
        throw new TypeError("capability_unknown");
      }
      const guestCapability = capability as GuestCapabilityId;
      if (!this.#installed.has(guestCapability)) throw new TypeError("capability_not_installed");
      if (!this.#resourceAdapterAvailable(guestCapability)) throw new TypeError("capability_not_grantable");
      selected.add(guestCapability);
    }
    return Object.freeze(GUEST_CAPABILITY_IDS.filter((capability) => selected.has(capability)));
  }

  async snapshot(
    requested: readonly string[] | "everything",
    scopes: VoiceResourceScopesV1,
  ): Promise<CapabilitySnapshot> {
    const capabilityIds = this.resolve(requested);
    const captured = captureObject(scopes, SCOPE_FIELDS, SCOPE_FIELDS, invalidScope);
    if (captured.schemaVersion !== "1.0") invalidScope();
    const calendarConnectionIds = captureScopeIds(captured.calendarConnectionIds);
    const fileRootIds = captureScopeIds(captured.fileRootIds);
    const pcActionIds = captureScopeIds(captured.pcActionIds);

    for (const value of calendarConnectionIds) if (!this.#calendarConnectionIds.has(value)) invalidScope();
    for (const value of fileRootIds) if (!this.#fileRootIds.has(value)) invalidScope();
    for (const value of pcActionIds) if (!this.#pcActionIds.has(value)) invalidScope();

    const enforceScope = (required: boolean, values: readonly string[]) => {
      if (required && values.length === 0) throw new TypeError("resource_scope_required");
      if (!required && values.length > 0) throw new TypeError("resource_scope_unused");
    };
    enforceScope(needsCalendar(capabilityIds), calendarConnectionIds);
    enforceScope(needsFiles(capabilityIds), fileRootIds);
    enforceScope(needsPc(capabilityIds), pcActionIds);

    const resourceScopes: VoiceResourceScopesV1 = Object.freeze({
      schemaVersion: "1.0",
      calendarConnectionIds,
      fileRootIds,
      pcActionIds,
    });
    const canonicalDocument = canonicalJson({ capabilityIds, resourceScopes });
    return Object.freeze({
      capabilityIds,
      resourceScopes,
      canonicalDocument,
      accessDocumentHash: await sha256Hex(canonicalDocument),
    });
  }
}
