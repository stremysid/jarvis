import { D1, migrate, allMigrations } from "./d1.mjs";
const dir = "./head/apps/cloud-gateway/src/persistence/migrations";
const d1 = new D1();
const names = allMigrations(dir);
console.log(names.join(" "));
migrate(d1, dir, names);
const db = d1.db;
console.log("triggers on 0029 tables:", db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name LIKE 'university_workflow%'").all().map((r) => r.name).length);
console.log(db.prepare("SELECT sql FROM sqlite_master WHERE name='principals'").get().sql.slice(0, 50));
