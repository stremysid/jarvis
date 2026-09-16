import { readFileSync, writeFileSync, rmSync } from "node:fs";
import * as F from "./fixtures.mjs";
const dir = "./head/apps/cloud-gateway/src/university/";
const src = readFileSync(dir + "university-tracker-model.ts", "utf8");
const NL = src.includes("\r\n") ? "\r\n" : "\n";
const from = NL + "    || options.rejectForwardedOrQuoted === true && FORWARDED_OR_QUOTED_OWNER_CLAIM.test(evidence)) return false;";
console.log("pattern count", src.split(from).length - 1);
const file = dir + "university-tracker-model.x6.ts";
writeFileSync(file, src.replace(from, ") return false;"));
try {
  const mod = await import(file);
  const snap = F.snapshot({ sameProgramName: false });
  for (const t of [
    "Email from Ms Lee: I emailed Ms Lee about the Ms Lee reference request for the Western reference.",
    "Forwarded message: I paid the Waterloo AIF fee for the Waterloo AIF.",
    "\"I paid the Waterloo AIF fee for the Waterloo AIF\"",
  ]) {
    const wf = /Lee/.test(t) ? F.WF_CONTACT : F.WF_AIF_PAY, prog = /Lee/.test(t) ? F.WESTERN : F.WATERLOO;
    try { mod.parseOwnerUniversityPlan({ engaged: true, programUpdates: [], applicationUpdates: [], workflowUpdates: [F.existingUpdate(wf, prog, "owner_reported_done", t)] }, t, F.redactor, snap); console.log("mutant ACCEPTED |", t); } catch { console.log("mutant refused  |", t); }
  }
} finally { rmSync(file); }
