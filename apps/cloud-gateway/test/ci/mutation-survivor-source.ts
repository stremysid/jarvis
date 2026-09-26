/**
 * Fixture for `reviewer-tools/test/verdict-selftest.ps1`.
 *
 * `mutation-survivor.test.ts` covers `labeled` only, so the spec at
 * `reviewer-tools/test-fixtures/mutation-spec-deliberate-survivor.json` plants a
 * change in `untestedTail` that no test notices. That produces a real SURVIVED
 * report and a non-zero `mutate.ps1` exit, which the mutation workflow's verdict
 * step must turn into a failed job. Not production code.
 */
export function labeled(value: number): string {
  return value > 0 ? "positive" : "non-positive";
}

export function untestedTail(value: number): number {
  return value * 2;
}
