// Runs the real PR test file(s) against a (possibly mutated) validator copy.
import { runAll } from "./vitest-shim.mjs";

const files = process.argv.slice(2);
if (files.length === 0) files.push("./voice-smoke.test.ts");
for (const file of files) await import(file);

const result = await runAll();
console.log(`total=${result.total} passed=${result.passed} failed=${result.failures.length}`);
for (const failure of result.failures) {
  console.log(`  FAIL [${failure.suite}] ${failure.test}`);
}
process.exitCode = result.failures.length === 0 ? 0 : 1;
