import { isAuthenticatedFirstPersonQuote } from "./policy-r1.ts";

const cases: Array<[string, string]> = [
  ["I wrote my Western essay.", "I wrote my Western essay."],
  ["I emailed my counsellor today. I am applying to Waterloo.", "I am applying to Waterloo."],
  ["I texted Priya about the project. I prefer morning study sessions.", "I prefer morning study sessions."],
  ["I mentioned it to Dad. My surgery was in August.", "My surgery was in August."],
  ["I wrote the lab report. My physics teacher is Mr. Chen.", "My physics teacher is Mr. Chen."],
];
for (const [source, quote] of cases) {
  const r = isAuthenticatedFirstPersonQuote({ quote, sourceText: source, authenticatedOwner: true });
  console.log(`${r ? "trusted " : "DEMOTED "} | quote=${JSON.stringify(quote)} | source=${JSON.stringify(source)}`);
}
