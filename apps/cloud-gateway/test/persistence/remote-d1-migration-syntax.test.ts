import { describe, expect, it } from "vitest";

declare global {
  interface ImportMeta {
    glob(
      pattern: string,
      options: { readonly eager: true; readonly import: "default"; readonly query: "?raw" },
    ): Record<string, string>;
  }
}

const migrationModules = import.meta.glob(
  "../../src/persistence/migrations/*.sql",
  { eager: true, import: "default", query: "?raw" },
) as Record<string, string>;

const remoteD1Migrations = Object.entries(migrationModules).map(([path, sql]) => {
  const name = path.split("/").at(-1);
  if (name === undefined) throw new Error(`migration name missing: ${path}`);
  const sequence = Number.parseInt(name.slice(0, 4), 10);
  return { name, sequence, sql };
}).filter(({ sequence }) => sequence >= 14).sort((left, right) => left.sequence - right.sequence);

describe("remote D1 migration trigger syntax", () => {
  it("discovers every migration from 0014 onward", () => {
    expect(remoteD1Migrations.map(({ name }) => name)).toEqual([
      "0014_memory_projection.sql",
      "0015_voice_runtime.sql",
      "0016_cloud_memory.sql",
      "0017_owner_passphrase.sql",
      "0018_owner_call_step_up.sql",
      "0019_memory_ingress.sql",
      "0020_school_catchup.sql",
      "0021_voice_owner_delivery.sql",
    ]);
  });

  it.each(remoteD1Migrations)("rejects CASE-wrapped RAISE statements in $name", ({ sql }) => {
    expect(sql).not.toMatch(/\bSELECT\s+CASE\b[^;]*\bRAISE\s*\(/iu);
  });
});
