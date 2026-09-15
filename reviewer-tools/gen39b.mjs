import fs from "node:fs";
const [src, out, branch] = process.argv.slice(2);
const sql = fs.readFileSync(src, "utf8").replace(/\r\n/g, "\n");
const names = [...sql.matchAll(/^CREATE TRIGGER ([a-z0-9_]+)$/gm)].map((m) => m[1]);
const file = "apps/cloud-gateway/src/persistence/migrations/0016_cloud_memory.sql";
const tests = ["apps/cloud-gateway/test/persistence/cloud-memory-migration.test.ts"];
const muts = [{ id: "BASE", file, from: `CREATE TRIGGER ${names[0]}\n`, to: `CREATE TRIGGER ${names[0]}\n`, tests }];
for (const n of names) {
  const start = sql.indexOf(`CREATE TRIGGER ${n}\n`);
  const end = sql.indexOf("\nEND;", start);
  const block = sql.slice(start, end + 5);
  if (start < 0 || end < 0 || sql.split(block).length - 1 !== 1) { console.log("skip", n); continue; }
  muts.push({ id: `T-${n}`, file, from: block, to: "", tests });
}
fs.writeFileSync(out, JSON.stringify({ root: "C:/Users/Sid/jarvis-deploy", branch, mutations: muts }, null, 1));
console.log("mutations", muts.length - 1);
