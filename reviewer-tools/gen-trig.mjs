import fs from "node:fs";
// usage: node gen-trig.mjs <sql> <out.json> <branch> <root> <repo-relative sql path> <test1,test2,...>
const [src, out, branch, root, file, testsCsv] = process.argv.slice(2);
const sql = fs.readFileSync(src, "utf8").replace(/\r\n/g, "\n");
const names = [...sql.matchAll(/^CREATE TRIGGER ([a-z0-9_]+)$/gm)].map((m) => m[1]);
const tests = testsCsv.split(",");
const muts = [{ id: "BASE", file, from: `CREATE TRIGGER ${names[0]}\n`, to: `CREATE TRIGGER ${names[0]}\n`, tests }];
for (const n of names) {
  const start = sql.indexOf(`CREATE TRIGGER ${n}\n`);
  const end = sql.indexOf("\nEND;", start);
  const block = sql.slice(start, end + 5);
  if (start < 0 || end < 0 || sql.split(block).length - 1 !== 1) { console.log("skip", n); continue; }
  muts.push({ id: `T-${n}`, file, from: block, to: "", tests });
}
fs.writeFileSync(out, JSON.stringify({ root, branch, mutations: muts }, null, 1));
console.log("triggers", names.length, "mutations", muts.length - 1);
