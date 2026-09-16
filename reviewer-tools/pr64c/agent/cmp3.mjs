// Same replies through main, round-2 (ebabd18) and round-3 (61bf0f2) guards.
import * as H from "./head/apps/cloud-gateway/src/school/school-catchup-model.ts";
import * as R2 from "../../pr64b/agent/head/apps/cloud-gateway/src/school/school-catchup-model.ts";
import * as B from "./base/apps/cloud-gateway/src/school/school-catchup-model.ts";
import * as F from "./fixtures.mjs";
import { readFileSync } from "node:fs";
const file = process.argv[2];
const src = readFileSync(file, "utf8");
const lists = [...src.matchAll(/^\s+("(?:[^"\\]|\\.)*"),\s*$/gmu)].map((m) => JSON.parse(m[1]));
const s = (M, r) => M.guardSchoolReply(r, F.redactor) === r ? "shown   " : "REPLACED";
const c = { B: 0, R2: 0, H: 0 };
for (const r of lists) {
  const b = s(B, r), r2 = s(R2, r), h = s(H, r);
  if (b !== "shown   ") c.B++; if (r2 !== "shown   ") c.R2++; if (h !== "shown   ") c.H++;
  console.log(`main=${b} r2=${r2} r3=${h} | ${JSON.stringify(r)}`);
}
console.log(`replaced: main ${c.B}/${lists.length}, round2 ${c.R2}/${lists.length}, round3 ${c.H}/${lists.length}`);
