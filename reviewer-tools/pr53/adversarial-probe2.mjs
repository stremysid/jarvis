import { readFileSync } from "node:fs";
const src = readFileSync("./probe.mjs", "utf8");
const fn = src.slice(src.indexOf("function parseOwnerStudyObservation"), src.indexOf("function parsePracticeRequest"));
const parse = new Function(`${fn}; return parseOwnerStudyObservation;`)();
for (const t of [
  "I finished the lab, that was easy",
  "Done with the unit 2 homework and it was hard",
  "Check D2L now",
  "The essay due date is wrong",
  "What you said about my chemistry mark is wrong",
  "That plan is wrong",
  "I thought I did the worksheet wrong",
  "My password is wrong",
]) console.log(t.padEnd(52), JSON.stringify(parse(t)));
