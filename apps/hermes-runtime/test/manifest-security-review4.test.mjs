import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { canonicalize, sha256Hex } from "../src/canonical-json.mjs";
import { validateSbomIntegrity } from "../src/validate-manifests.mjs";

const runtimeRoot = new URL("..", import.meta.url);

async function loadReviewedInputs() {
  const [source, artifacts, patches, sbom] = await Promise.all([
    readFile(new URL("hermes-source-lock.json", runtimeRoot), "utf8").then(JSON.parse),
    readFile(new URL("runtime-artifacts-lock.json", runtimeRoot), "utf8").then(JSON.parse),
    readFile(new URL("patches/series.json", runtimeRoot), "utf8").then(JSON.parse),
    readFile(new URL("sbom/hermes-agent-v2026.8.27-windows-x86_64-cpython-3.11.16.cdx.json", runtimeRoot), "utf8").then(JSON.parse),
  ]);
  return { source, artifacts, patches, sbom };
}

describe("Task 2 manifest security review 4", () => {
  it("rejects a nested record accessor without executing it", async () => {
    const inputs = await loadReviewedInputs();
    const original = inputs.sbom.metadata.component;
    let reads = 0;
    Object.defineProperty(inputs.sbom.metadata, "component", {
      configurable: true,
      enumerable: true,
      get() {
        reads += 1;
        return original;
      },
    });

    await expect(validateSbomIntegrity(inputs)).rejects.toThrow(/accessor|data field|canonical JSON/i);
    expect(reads, "validation executed a nested record accessor").toBe(0);
  });

  it("rejects a nested array accessor without executing it", async () => {
    const inputs = await loadReviewedInputs();
    const original = inputs.sbom.components[0];
    let reads = 0;
    Object.defineProperty(inputs.sbom.components, "0", {
      configurable: true,
      enumerable: true,
      get() {
        reads += 1;
        return original;
      },
    });

    await expect(validateSbomIntegrity(inputs)).rejects.toThrow(/accessor|data field|canonical JSON/i);
    expect(reads, "validation executed a nested array accessor").toBe(0);
  });

  it("rejects the canonical source-lock digest when embedded in an otherwise shaped SBOM", async () => {
    const inputs = await loadReviewedInputs();
    const sourceLockDigest = await sha256Hex(canonicalize(inputs.source));
    inputs.sbom.metadata.properties[0].value = sourceLockDigest;

    await expect(validateSbomIntegrity(inputs)).rejects.toThrow(/forbidden digest/i);
  });
});
