import { defineConfig } from "vitest/config";

// Vitest defaults to 5,000 ms. Several tests here start the real SBOM generator,
// the trusted PowerShell host or an archive extractor, and on the shared Windows
// CI runner those take 5 s or more: on 2026-09-25 three different tests
// (sbom-integrity-round2, artifact-security, and the two #208 already bounded)
// failed with "Test timed out in 5000ms" while their assertions would have
// passed, on runs of PRs that did not touch this package. The bound is on the
// process start-up cost, not on any assertion; 30 s still catches a real hang.
export default defineConfig({
  test: {
    testTimeout: 30_000,
  },
});
