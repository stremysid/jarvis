// Keeps the migration number and the restore inventory in step.
// Run: node scripts/check-migrations.mjs
//
// Why this exists: apps/cloud-gateway/src/backup/memory-backup-restore-migrations.ts
// carries TWO hand-maintained lists that must mirror the migrations directory -- an
// import per file, and an entry per import. A migration added to the directory and
// forgotten here does not fail any test; it silently omits that migration from the
// restore path, which is the one code path that only runs when something has already
// gone wrong. Five registration lists exist across the repository and a numbering
// collision was resolved earlier today by hand, which is the evidence that nothing
// enforces this.
//
// NOTHING RUNS THIS YET. Sweep-5 found three of the four existing
// scripts/test/*.test.mjs files are executed by no workflow at all, so this file is
// written to be wired into the docs or unit job rather than pretending to run.
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDir = join(root, "apps/cloud-gateway/src/persistence/migrations");
const inventoryPath = join(root, "apps/cloud-gateway/src/backup/memory-backup-restore-migrations.ts");

const failures = [];

const files = readdirSync(migrationsDir).filter((name) => name.endsWith(".sql")).sort();
const numbers = files.map((name) => name.slice(0, 4));

// 1. Duplicate numbers. Two migrations may be authored in parallel on separate
//    branches; wrangler keys d1_migrations on the full filename, so a duplicate pair
//    applies deterministically rather than skipping -- quietly, in whatever order.
const seen = new Map();
for (const [index, number] of numbers.entries()) {
  if (seen.has(number)) {
    failures.push(`${number}: claimed twice, by ${seen.get(number)} and ${files[index]}`);
  } else {
    seen.set(number, files[index]);
  }
}

// 2. Gaps. A missing number is usually a deleted file rather than a mistake, so this
//    reports rather than fails -- but it must be visible.
const gaps = [];
for (let expected = 1; expected <= numbers.length; expected += 1) {
  const padded = String(expected).padStart(4, "0");
  if (!seen.has(padded)) gaps.push(padded);
}

// 3. The inventory must name exactly the files that exist.
if (!existsSync(inventoryPath)) {
  failures.push("memory-backup-restore-migrations.ts is missing; the restore inventory cannot be checked");
} else {
  const inventory = readFileSync(inventoryPath, "utf8");
  const named = new Set([...inventory.matchAll(/name:\s*"([^"]+\.sql)"/gu)].map((match) => match[1]));

  for (const file of files) {
    if (!named.has(file)) {
      failures.push(`${file} exists but is NOT in the restore inventory. A restore would silently omit it.`);
    }
  }
  for (const name of named) {
    if (!files.includes(name)) {
      failures.push(`the restore inventory names ${name}, which does not exist in the migrations directory`);
    }
  }

  // 4. The import list and the entry list must agree. A missing import is a compile
  //    error, but a missing entry is not, and neither is an entry whose sql: refers
  //    to an identifier nothing imports.
  for (const match of inventory.matchAll(/name:\s*"([^"]+\.sql)",\s*sql:\s*([A-Za-z0-9_]+)/gu)) {
    const [, name, identifier] = match;
    if (!new RegExp(`import\\s+${identifier}\\s+from`, "u").test(inventory)) {
      failures.push(`${name}: the entry uses sql: ${identifier}, which nothing imports`);
    }
  }
}

if (failures.length > 0) {
  console.error(`migration check failed (${failures.length}):`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`migration check passed: ${files.length} migrations, numbers unique, restore inventory complete${gaps.length > 0 ? `, gaps: ${gaps.join(", ")}` : ""}.`);
