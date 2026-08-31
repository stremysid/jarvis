import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { canonicalize, sha256Hex, validateHermesManifests } from "../src/validate-manifests.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const file = (path) => new URL(`../${path}`, import.meta.url);

async function loadJson(path) {
  return JSON.parse(await readFile(file(path), "utf8"));
}

describe("Hermes H1 source locks", () => {
  it("accepts the reviewed exact source, artifact, contract, patch, license, and SBOM locks", async () => {
    const source = await loadJson("hermes-source-lock.json");
    const artifacts = await loadJson("runtime-artifacts-lock.json");
    const contract = await loadJson("contracts/hermes-runs-api-v2026.8.27.json");
    const patches = await loadJson("patches/series.json");
    const sbom = await loadJson("sbom/hermes-agent-v2026.8.27-windows-x86_64-cpython-3.11.16.cdx.json");

    await expect(validateHermesManifests({ source, artifacts, contract, patches, sbom })).resolves.toEqual(expect.objectContaining({
      jarvisH0Commit: "814535de21df37e6abac1f63e5953d693b78e003",
      sourceCommit: "5fc308a70719a83cccdbba4c0e39c23f5a8239d5",
      runsEventContractHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    }));
  });

  it("binds the source lock and Task 1 readiness fixture to the canonical Runs event contract", async () => {
    const source = await loadJson("hermes-source-lock.json");
    const contract = await loadJson("contracts/hermes-runs-api-v2026.8.27.json");
    const readiness = JSON.parse(await readFile(new URL("../../../tests/fixtures/hermes-h1/readiness-golden-v1.json", import.meta.url), "utf8"));
    const hash = await sha256Hex(canonicalize(contract));

    expect(source.runsEventContractHash).toBe(hash);
    expect(readiness.runsEventContractHash).toBe(hash);
  });

  it("rejects each reviewed source-lock drift fixture", async () => {
    const valid = await loadJson("hermes-source-lock.json");
    const invalids = await loadJson("test/fixtures/invalid-source-locks.json");
    const artifacts = await loadJson("runtime-artifacts-lock.json");
    const contract = await loadJson("contracts/hermes-runs-api-v2026.8.27.json");
    const patches = await loadJson("patches/series.json");
    const sbom = await loadJson("sbom/hermes-agent-v2026.8.27-windows-x86_64-cpython-3.11.16.cdx.json");

    for (const source of invalids.map((change) => ({ ...valid, ...change }))) {
      await expect(validateHermesManifests({ source, artifacts, contract, patches, sbom })).rejects.toThrow();
    }
  });

  it("rejects noncanonical contract fields, forbidden tool events, and source-lock hash embedding in the SBOM", async () => {
    const source = await loadJson("hermes-source-lock.json");
    const artifacts = await loadJson("runtime-artifacts-lock.json");
    const contract = await loadJson("contracts/hermes-runs-api-v2026.8.27.json");
    const patches = await loadJson("patches/series.json");
    const sbom = await loadJson("sbom/hermes-agent-v2026.8.27-windows-x86_64-cpython-3.11.16.cdx.json");

    await expect(validateHermesManifests({ source, artifacts, patches, sbom, contract: { ...contract, tool_event: "tool.called" } })).rejects.toThrow();
    await expect(validateHermesManifests({ source, artifacts, patches, contract, sbom: { ...sbom, sourceLockHash: source.sbomSha256 } })).rejects.toThrow();
  });

  it("refuses an unsafe UNC runtime root before any source acquisition command", async () => {
    const script = new URL("../scripts/fetch-hermes.ps1", import.meta.url);
    const result = await new Promise((resolve, reject) => {
      const child = spawn("pwsh", ["-NoProfile", "-NonInteractive", "-File", fileURLToPath(script), "-RuntimeRoot", "\\\\server\\share\\Hermes", "-VerifyOnly"], { windowsHide: true });
      let stderr = "";
      child.stderr.on("data", (data) => { stderr += data; });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stderr }));
    });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/RuntimeRoot|UNC|unsafe/i);
  });
});
