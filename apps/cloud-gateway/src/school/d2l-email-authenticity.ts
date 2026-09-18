/**
 * What counts as proof that a school-mail delivery really came from D2L.
 *
 * Nothing here verifies a signature: DKIM and ARC both need the signer's DNS
 * record, and a Worker has only the delivered headers plus whatever the
 * receiving MTA wrote on arrival. What this module does instead is refuse to
 * read *absence* of evidence as trust, give the receiving MTA's own evaluation
 * precedence over anything the sender wrote, and name the path that granted
 * trust so the stored receipt says why the message was believed.
 *
 * The residual limit is deliberate and recorded in KNOWN_ISSUES.md: a sender
 * can write every header read here, so these paths are only as strong as the
 * receiving MTA's own record being present and last.
 */

export type AuthenticityPath =
  | "cloudflare-dkim-pass"
  | "arc-chain"
  | "dkim-signature"
  | "none";

export interface AuthenticityEvidence {
  readonly trusted: boolean;
  readonly path: AuthenticityPath;
  /** Bounded, address-free explanation retained with the receipt. */
  readonly detail: string;
  /** The authserv-id whose evaluation was used, when one was. */
  readonly evaluatedBy: string | null;
}

export interface AuthenticitySignal {
  /** Lowercased header names to bounded values, as measured at delivery. */
  readonly headerValues: Readonly<Record<string, readonly string[]>>;
  readonly pinnedDomains: ReadonlySet<string>;
  /** Forwarder tenants whose ARC seal may be believed; empty disables ARC. */
  readonly arcSealerDomains: ReadonlySet<string>;
  readonly receivingMtaAuthservIds?: readonly string[];
}

/**
 * Cloudflare's own receiving MTA.
 *
 * This is the one authentication result the sender cannot make last. It is an
 * assumption about a provider string, so it is checked rather than assumed at
 * the only place it matters: a message whose result does not carry it fails
 * closed into quarantine (see KNOWN_ISSUES.md).
 */
export const RECEIVING_MTA_AUTHSERV_IDS = Object.freeze(["mx.cloudflare.net"]);

const FAILING_RESULTS = new Set(["fail", "permerror", "temperror", "policy"]);

interface AuthenticationMethod {
  readonly method: string;
  readonly result: string;
  readonly properties: ReadonlyMap<string, string>;
}

interface AuthenticationGroup {
  readonly authservId: string;
  readonly methods: readonly AuthenticationMethod[];
}

function methodDomain(method: AuthenticationMethod): string | null {
  const value = method.properties.get("header.d");
  if (value === undefined) return null;
  const normalized = value.trim().toLowerCase().replace(/\.$/u, "");
  if (
    normalized.length === 0
    || normalized.length > 253
    || normalized.includes("..")
    || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u.test(normalized)
  ) return null;
  return normalized;
}

/**
 * A pin authorises the domain itself and everything under it, because D2L
 * signs and sends from a subdomain while Sid may pin the board parent.
 */
export function pinnedDomain(domain: string | null, pinned: ReadonlySet<string>): boolean {
  if (domain === null || domain.length === 0) return false;
  if (pinned.has(domain)) return true;
  for (const candidate of pinned) if (domain.endsWith(`.${candidate}`)) return true;
  return false;
}

function methodsIn(body: string): readonly AuthenticationMethod[] {
  const found: AuthenticationMethod[] = [];
  for (const token of body.split(";")) {
    const head = /^\s*([A-Za-z][A-Za-z0-9-]*)\s*=\s*([A-Za-z][A-Za-z0-9-]*)([\s\S]*)$/u.exec(token);
    if (head === null) continue;
    const properties = new Map<string, string>();
    for (const property of (head[3] ?? "").matchAll(/([A-Za-z][A-Za-z0-9._-]*)\s*=\s*([^\s;]+)/gu)) {
      properties.set(
        (property[1] ?? "").toLowerCase(),
        (property[2] ?? "").replace(/^"|"$/gu, "").toLowerCase(),
      );
    }
    found.push(Object.freeze({
      method: (head[1] ?? "").toLowerCase(),
      result: (head[2] ?? "").toLowerCase(),
      properties,
    }));
  }
  return Object.freeze(found);
}

/**
 * Split one Authentication-Results value into its authserv-id groups.
 *
 * A value can carry several groups, and every header a sender writes arrives
 * before the receiving MTA's own, which is what `last` below relies on.
 */
function groupsIn(value: string): readonly AuthenticationGroup[] {
 const starts: Readonly<{ authservId: string; start: number; bodyStart: number }>[] = [];
  // The optional `\s+\d+` is Microsoft's own format: its records read
  // `mx.microsoft.com 1; ...`, and without tolerating that version token the
  // tenant's ARC evidence parses to no groups at all and the ARC path can
  // never fire on the mail it exists for.
  for (const match of value.matchAll(/(?:^|[,;])\s*([A-Za-z0-9][A-Za-z0-9._-]*)(?:\s+\d+)?\s*;/gu)) {
    const start = match.index ?? 0;
    starts.push(Object.freeze({
      authservId: (match[1] ?? "").toLowerCase(),
      start,
      bodyStart: start + match[0].length,
    }));
  }
  return Object.freeze(starts.map((entry, index) => Object.freeze({
    authservId: entry.authservId,
    methods: methodsIn(value.slice(entry.bodyStart, starts[index + 1]?.start ?? value.length)),
  })));
}

/** Domains the group reported a DKIM failure for; `null` is an unscoped failure. */
function failingDomains(group: AuthenticationGroup): ReadonlySet<string | null> {
  const failing = new Set<string | null>();
  for (const method of group.methods) {
    if (method.method !== "dkim" || !FAILING_RESULTS.has(method.result)) continue;
    failing.add(methodDomain(method));
  }
  return failing;
}

function contradicts(group: AuthenticationGroup, domain: string | null): boolean {
  const failing = failingDomains(group);
  return failing.has(null) || (domain !== null && failing.has(domain));
}

function arcSeals(values: readonly string[]): ReadonlyMap<number, string> {
  const seals = new Map<number, string>();
  for (const value of values) {
    const instance = /\bi\s*=\s*(\d{1,3})\b/u.exec(value);
    const seal = /\bcv\s*=\s*([A-Za-z0-9-]+)/u.exec(value);
    const domain = /(?:^|;)\s*d\s*=\s*([^;\s]+)/iu.exec(value);
    if (instance === null || seal === null || domain === null) continue;
    if ((seal[1] ?? "").toLowerCase() !== "pass") continue;
    seals.set(Number(instance[1]), (domain[1] ?? "").toLowerCase().replace(/\.$/u, ""));
  }
  return seals;
}

function trusted(path: AuthenticityPath, detail: string, evaluatedBy: string | null): AuthenticityEvidence {
  return Object.freeze({ trusted: true, path, detail, evaluatedBy });
}

function untrusted(detail: string, evaluatedBy: string | null): AuthenticityEvidence {
  return Object.freeze({ trusted: false, path: "none" as const, detail, evaluatedBy });
}

function arcEvidence(signal: AuthenticitySignal): AuthenticityEvidence | null {
  const seals = arcSeals(signal.headerValues["arc-seal"] ?? []);
  if (seals.size === 0 || signal.arcSealerDomains.size === 0) return null;
  for (const value of signal.headerValues["arc-authentication-results"] ?? []) {
    const instance = /^\s*i\s*=\s*(\d{1,3})\s*;/u.exec(value);
    if (instance === null) continue;
    const number = Number(instance[1]);
    const sealer = seals.get(number);
    if (sealer === undefined || !pinnedDomain(sealer, signal.arcSealerDomains)) continue;
    for (const group of groupsIn(value)) {
      for (const method of group.methods) {
        if (method.method !== "dkim" || method.result !== "pass") continue;
        const domain = methodDomain(method);
        if (domain === null || !pinnedDomain(domain, signal.pinnedDomains)) continue;
        if (contradicts(group, domain)) continue;
        return trusted(
          "arc-chain",
          `ARC instance ${String(number)} sealed by a pinned forwarder records dkim=pass for a pinned signer`,
          group.authservId,
        );
      }
    }
  }
  return null;
}

export function assessAuthenticity(signal: AuthenticitySignal): AuthenticityEvidence {
  const accepted = new Set(
    (signal.receivingMtaAuthservIds ?? RECEIVING_MTA_AUTHSERV_IDS).map((id) => id.toLowerCase()),
  );
  const evaluations = (signal.headerValues["authentication-results"] ?? []).flatMap(groupsIn);
  const mine = evaluations.filter((group) => accepted.has(group.authservId));
  const evaluated = mine.length === 0 ? null : mine[mine.length - 1]!;

  if (evaluated !== null) {
    for (const method of evaluated.methods) {
      if (method.method !== "dkim" || method.result !== "pass") continue;
      const domain = methodDomain(method);
      if (domain === null || !pinnedDomain(domain, signal.pinnedDomains)) continue;
      if (contradicts(evaluated, domain)) continue;
      return trusted(
        "cloudflare-dkim-pass",
        "the receiving MTA recorded dkim=pass for a pinned signer",
        evaluated.authservId,
      );
    }
  }

  // A chain the receiving MTA called broken never reaches here: an ARC or
  // DKIM failure is `hard_fail`, which quarantines before evidence is read.
  const arc = arcEvidence(signal);
  if (arc !== null) return arc;

  for (const value of signal.headerValues["dkim-signature"] ?? []) {
    for (const match of value.matchAll(/(?:^|;)\s*d\s*=\s*([^;\s]+)/giu)) {
      const raw = (match[1] ?? "").toLowerCase().replace(/\.$/u, "");
      if (raw.length === 0 || !pinnedDomain(raw, signal.pinnedDomains)) continue;
      // The header text is the sender's, so it is only evidence while the
      // receiving MTA has not reported the signature failing.
      if (evaluated !== null && contradicts(evaluated, raw)) continue;
      return trusted(
        "dkim-signature",
        "a DKIM signature names a pinned signer and the receiving MTA did not report it failing",
        evaluated?.authservId ?? null,
      );
    }
  }

  return untrusted(
    evaluated !== null && failingDomains(evaluated).size > 0
      ? "the receiving MTA recorded a DKIM failure and no pinned signer passed"
      : "no DKIM signature, receiving-MTA pass, or pinned ARC chain names a pinned sender",
    evaluated?.authservId ?? null,
  );
}
