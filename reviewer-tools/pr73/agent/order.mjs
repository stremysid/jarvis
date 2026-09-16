import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { splitMigration } from "./main-tree/scripts/split-migration.mjs";

const dir = new URL("./sql/", import.meta.url);
const all = readdirSync(dir).filter((name) => name.endsWith(".sql")).sort();
const base = all.filter((name) => name < "0029");

function run(label, order) {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  try {
    for (const name of order) {
      for (const statement of splitMigration(readFileSync(new URL(name, dir), "utf8"))) {
        db.exec(statement);
      }
    }
    const fk = db.prepare("PRAGMA foreign_key_check").all();
    const integrity = db.prepare("PRAGMA integrity_check").all();
    const tables = db.prepare("SELECT name FROM sqlite_schema WHERE name LIKE 'school_study_check%' OR name LIKE 'school_study_signal%' OR name LIKE 'university_workflow_items'").all().map((r) => r.name);
    console.log(label, "OK", JSON.stringify({ fk: fk.length, integrity: integrity[0], tables }));
  } catch (error) {
    console.log(label, "FAILED", String(error));
  }
}

run("0001..0028 + 0030", [...base, "0030_study_coach_weak_spots.sql"]);
run("0001..0028 + 0030 then 0029", [...base, "0030_study_coach_weak_spots.sql", "0029_university_application_details.sql"]);
run("0001..0028 + 0029 then 0030", [...base, "0029_university_application_details.sql", "0030_study_coach_weak_spots.sql"]);
