export type OwnerAccessDraft =
  | Readonly<{ kind: "add"; providerE164: string; permissionPhrases: readonly string[] }>
  | Readonly<{ kind: "replace_permissions"; providerE164: string; permissionPhrases: readonly string[] }>
  | Readonly<{ kind: "rotate_pin"; providerE164: string }>
  | Readonly<{ kind: "revoke"; providerE164: string }>
  | Readonly<{ kind: "list" }>;

const E164 = /^\+[1-9][0-9]{7,14}$/u;
const PERMISSION_PHRASE = /^[a-z][a-z0-9]*(?: [a-z][a-z0-9]*){0,3}$/u;

function permissionDraft(
  kind: "add" | "replace_permissions",
  providerE164: string,
  rawPhrases: string,
): OwnerAccessDraft | null {
  if (!E164.test(providerE164) || rawPhrases.length === 0 || rawPhrases.length > 512) return null;
  const permissionPhrases = rawPhrases.split(" and ");
  if (
    permissionPhrases.length === 0
    || permissionPhrases.length > 32
    || permissionPhrases.some((phrase) => phrase.length > 64 || !PERMISSION_PHRASE.test(phrase))
    || new Set(permissionPhrases).size !== permissionPhrases.length
  ) {
    return null;
  }
  return Object.freeze({
    kind,
    providerE164,
    permissionPhrases: Object.freeze([...permissionPhrases]),
  });
}

export function parseOwnerAccessIntent(text: unknown): OwnerAccessDraft | null {
  if (
    typeof text !== "string"
    || text.length === 0
    || text.length > 640
    || !text.isWellFormed()
    || text !== text.normalize("NFC")
  ) {
    return null;
  }

  if (text === "list allowed callers") return Object.freeze({ kind: "list" });

  let match = /^allow (\+[1-9][0-9]{7,14}) with (.+)$/u.exec(text);
  if (match !== null) return permissionDraft("add", match[1] ?? "", match[2] ?? "");

  match = /^replace permissions for (\+[1-9][0-9]{7,14}) with (.+)$/u.exec(text);
  if (match !== null) return permissionDraft("replace_permissions", match[1] ?? "", match[2] ?? "");

  match = /^rotate pin for (\+[1-9][0-9]{7,14})$/u.exec(text);
  if (match !== null) {
    const providerE164 = match[1] ?? "";
    return E164.test(providerE164) ? Object.freeze({ kind: "rotate_pin", providerE164 }) : null;
  }

  match = /^revoke (\+[1-9][0-9]{7,14})$/u.exec(text);
  if (match !== null) {
    const providerE164 = match[1] ?? "";
    return E164.test(providerE164) ? Object.freeze({ kind: "revoke", providerE164 }) : null;
  }

  return null;
}
