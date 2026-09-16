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

const VOICE_OWNER_DELIVERY_TRIGGERS = Object.freeze([
  "owner_call_step_up_disabled_rejections_insert_guard",
  "owner_call_step_up_disabled_rejections_terminalize",
  "owner_call_step_up_disabled_rejections_immutable",
  "owner_call_step_up_disabled_rejections_delete_forbidden",
  "owner_call_step_up_rejection_deliveries_insert_guard",
  "owner_call_step_up_rejection_deliveries_immutable",
  "owner_call_step_up_rejection_deliveries_delete_forbidden",
  "guest_grant_notices_insert_guard",
  "guest_grant_notices_transition_guard",
  "guest_grant_notices_delete_forbidden",
]);

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
      "0022_university_tracker.sql",
      "0023_study_coach.sql",
    ]);
  });

  it.each(remoteD1Migrations)("rejects CASE-wrapped RAISE statements in $name", ({ sql }) => {
    expect(sql).not.toMatch(/\bSELECT\s+CASE\b[^;]*\bRAISE\s*\(/iu);
  });

  it("pins every 0021 trigger as one complete named definition", () => {
    const migration = remoteD1Migrations.find(({ name }) => name === "0021_voice_owner_delivery.sql");
    expect(migration).toBeDefined();
    const names = [...(migration?.sql ?? "").matchAll(/\bCREATE\s+TRIGGER\s+([a-z0-9_]+)/giu)]
      .map((match) => match[1]);
    expect(names).toEqual(VOICE_OWNER_DELIVERY_TRIGGERS);
  });
});
