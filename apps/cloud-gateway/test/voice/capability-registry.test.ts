import { describe, expect, it } from "vitest";
import { sha256Hex } from "../../../../packages/contracts/src/index.js";
import { CapabilityRegistry } from "../../src/voice/capability-registry.js";

const emptyScopes = {
  schemaVersion: "1.0",
  calendarConnectionIds: [],
  fileRootIds: [],
  pcActionIds: [],
} as const;

describe("CapabilityRegistry", () => {
  it("snapshots only installed guest-grantable capabilities", () => {
    const registry = new CapabilityRegistry({
      installed: ["conversation.basic", "research.web", "access.manage"],
    });

    expect(registry.resolve(["research.web", "conversation.basic"])).toEqual([
      "conversation.basic",
      "research.web",
    ]);
    expect(registry.resolve("everything")).toEqual(["conversation.basic", "research.web"]);
    expect(() => registry.resolve(["access.manage"])).toThrow("capability_not_grantable");
    expect(() => registry.resolve(["stremy.use"])).toThrow("capability_unknown");
    expect(() => registry.resolve(["calls.place"])).toThrow("capability_not_installed");
  });

  it("requires exact adapter-owned resource scopes", async () => {
    const registry = new CapabilityRegistry({
      installed: ["conversation.basic", "files.read", "calendar.read", "pc.control"],
      calendarConnectionIds: ["calendar:guest"],
      fileRootIds: ["file-root:guest-docs"],
      pcActionIds: ["pc-action:open-notes"],
    });

    const snapshot = await registry.snapshot(["files.read"], {
      schemaVersion: "1.0",
      calendarConnectionIds: [],
      fileRootIds: ["file-root:guest-docs"],
      pcActionIds: [],
    });
    expect(snapshot.resourceScopes.fileRootIds).toEqual(["file-root:guest-docs"]);

    await expect(registry.snapshot(["files.read"], {
      ...emptyScopes,
      fileRootIds: ["C:\\"],
    })).rejects.toThrow("resource_scope_invalid");
    await expect(registry.snapshot(["calendar.read"], emptyScopes))
      .rejects.toThrow("resource_scope_required");
    await expect(registry.snapshot(["conversation.basic"], {
      ...emptyScopes,
      calendarConnectionIds: ["calendar:guest"],
    })).rejects.toThrow("resource_scope_unused");
  });

  it("canonicalizes sorted duplicate-free permissions and scope IDs", async () => {
    const registry = new CapabilityRegistry({
      installed: ["files.read", "conversation.basic", "files.read"],
      fileRootIds: ["file-root:z", "file-root:a", "file-root:a"],
    });

    const snapshot = await registry.snapshot(["files.read", "conversation.basic", "files.read"], {
      schemaVersion: "1.0",
      calendarConnectionIds: [],
      fileRootIds: ["file-root:z", "file-root:a", "file-root:a"],
      pcActionIds: [],
    });

    expect(snapshot.capabilityIds).toEqual(["conversation.basic", "files.read"]);
    expect(snapshot.resourceScopes.fileRootIds).toEqual(["file-root:a", "file-root:z"]);
    expect(snapshot.canonicalDocument).toBe(
      '{"capabilityIds":["conversation.basic","files.read"],"resourceScopes":{"calendarConnectionIds":[],"fileRootIds":["file-root:a","file-root:z"],"pcActionIds":[],"schemaVersion":"1.0"}}',
    );
    await expect(sha256Hex(snapshot.canonicalDocument)).resolves.toBe(snapshot.accessDocumentHash);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.resourceScopes.fileRootIds)).toBe(true);
  });

  it("rejects accessors, unknown fields, wildcards, and raw paths", async () => {
    const configuration = { installed: ["conversation.basic"] } as Record<string, unknown>;
    Object.defineProperty(configuration, "fileRootIds", { enumerable: true, get: () => [] });
    expect(() => new CapabilityRegistry(configuration as never)).toThrow("capability_registry_invalid");
    expect(() => new CapabilityRegistry({ installed: ["conversation.basic"], unknown: [] } as never))
      .toThrow("capability_registry_invalid");

    const registry = new CapabilityRegistry({ installed: ["files.read"], fileRootIds: ["file-root:guest"] });
    await expect(registry.snapshot(["files.read"], {
      schemaVersion: "1.0",
      calendarConnectionIds: [],
      fileRootIds: ["*"],
      pcActionIds: [],
    })).rejects.toThrow("resource_scope_invalid");
    await expect(registry.snapshot(["files.read"], {
      ...emptyScopes,
      unknown: [],
    } as never)).rejects.toThrow("resource_scope_invalid");
  });
});
