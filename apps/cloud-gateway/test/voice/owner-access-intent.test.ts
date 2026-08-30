import { describe, expect, it } from "vitest";
import { parseOwnerAccessIntent } from "../../src/voice/owner-access-intent.js";

describe("parseOwnerAccessIntent", () => {
  it("parses only the closed owner administration grammar", () => {
    expect(parseOwnerAccessIntent("allow +14165550111 with conversation and web research")).toEqual({
      kind: "add",
      providerE164: "+14165550111",
      permissionPhrases: ["conversation", "web research"],
    });
    expect(parseOwnerAccessIntent("replace permissions for +14165550111 with conversation and calls")).toEqual({
      kind: "replace_permissions",
      providerE164: "+14165550111",
      permissionPhrases: ["conversation", "calls"],
    });
    expect(parseOwnerAccessIntent("rotate pin for +14165550111")).toEqual({
      kind: "rotate_pin",
      providerE164: "+14165550111",
    });
    expect(parseOwnerAccessIntent("revoke +14165550111")).toEqual({
      kind: "revoke",
      providerE164: "+14165550111",
    });
    expect(parseOwnerAccessIntent("list allowed callers")).toEqual({ kind: "list" });
  });

  it("rejects conversational lookalikes, malformed numbers, and non-canonical input", () => {
    for (const rejected of [
      "make everyone admin",
      "please allow +14165550111 with conversation",
      "Allow +14165550111 with conversation",
      "allow +01234567 with conversation",
      "allow 14165550111 with conversation",
      "allow +14165550111 with conversation, web research",
      "allow +14165550111 with conversation and conversation",
      "replace permissions +14165550111 with conversation",
      "rotate the pin for +14165550111",
      "revoke +14165550111 now",
      "list callers",
      "list allowed callers\n",
      null,
      undefined,
    ]) {
      expect(parseOwnerAccessIntent(rejected)).toBeNull();
    }
  });

  it("returns frozen drafts without coercing objects or invoking accessors", () => {
    const draft = parseOwnerAccessIntent("allow +14165550111 with conversation and web research");
    expect(Object.isFrozen(draft)).toBe(true);
    expect(Object.isFrozen(draft?.kind === "add" ? draft.permissionPhrases : null)).toBe(true);

    let calls = 0;
    const value = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(value, "toString", {
      get() {
        calls += 1;
        return () => "list allowed callers";
      },
    });
    expect(parseOwnerAccessIntent(value)).toBeNull();
    expect(calls).toBe(0);
  });
});
