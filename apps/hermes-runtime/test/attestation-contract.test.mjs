import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";
import { canonicalJsonFileBytes, sha256Hex } from "../src/canonical-json.mjs";

const file = (path) => new URL(`../${path}`, import.meta.url);
const temporary = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
async function json(path) { return JSON.parse(await readFile(file(path), "utf8")); }

async function validAttestation(mode) {
  const lock = await json("hermes-profile-lock.json"); const source = await json("hermes-source-lock.json"); const profile = lock.profiles[0]; const route = profile.runtimeModes[mode];
  return {
    schemaVersion: "1", kind: "HermesRuntimeAttestationV1", profileId: profile.id, serviceId: profile.serviceId, process: profile.process, mode,
    configurationHash: route.configurationHash, sourceCommit: source.sourceCommit, sourceTree: source.sourceTree,
    sourceLockHash: await sha256Hex(source), profileLockHash: await sha256Hex(lock), managedConfigHash: route.configurationHash,
    runsContractHash: source.runsEventContractHash,
    compatibilityStub: mode === "pinned_runtime" ? { baseUrl: lock.compatibilityStub.baseUrl, contractHash: lock.compatibilityStub.contractHash, sourceHash: "1".repeat(64), processRunning: true, credentialMode: "nonsecret-test-token" } : null,
    environment: ["HERMES_MANAGED", "HERMES_SAFE_MODE"], selectedProvider: route.provider, selectedModel: route.model,
    providerInventory: profile.providerInventory, providerInventoryHash: profile.providerInventoryHash,
    providerOverrides: profile.providerOverrides, modelOverride: { contextTokens: 1_000_000, maxOutputTokens: 393_216, reasoning: true, tools: false, vision: false },
    catalog: { modelCatalogEnabled: false, modelsDevUrl: "jarvis-disabled://models-dev", remoteCacheHash: profile.catalog.remoteCatalog.sha256, modelsDevCacheHash: profile.catalog.modelsDev.sha256, etagPaths: [], alternateCachePaths: [], networkRequests: 0, backgroundRefresh: false },
    compression: profile.compression, generalPlugins: [], effectiveTools: [], effectiveToolsHash: profile.effectiveToolsHash, mcpServers: [],
    memory: profile.memory, backgroundReviewEnabled: false, messagingGateways: [], writablePaths: profile.writablePaths,
    immutableArtifacts: profile.immutablePaths.map((path) => ({ path, sha256: "2".repeat(64), writable: false })),
    installedDistributions: [{ name: "hermes-agent", version: "0.20.6", recordHash: "3".repeat(64) }], installedDistributionsHash: "4".repeat(64), recordAggregateHash: "5".repeat(64),
    versions: { python: "3.11.16", uv: "0.12.7", package: "0.20.6", serviceHost: "WinSW-2.12.0" },
    listener: profile.listener, updaterAvailable: false, sbomHash: source.sbomSha256,
  };
}

function setPath(value, dottedPath, replacement) { const parts = dottedPath.split("."); let target = value; for (const part of parts.slice(0, -1)) target = target[part]; target[parts.at(-1)] = replacement; }

describe("Hermes runtime attestation", () => {
  it("accepts both closed modes and rejects a third mode", async () => {
    const schema = await json("schemas/hermes-runtime-attestation-v1.schema.json"); const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
    expect(validate(await validAttestation("live")), JSON.stringify(validate.errors)).toBe(true);
    expect(validate(await validAttestation("pinned_runtime")), JSON.stringify(validate.errors)).toBe(true);
    const unknown = await validAttestation("live"); unknown.mode = "fake"; expect(validate(unknown)).toBe(false);
  });

  it("rejects every reviewed attestation drift class", async () => {
    const invalids = await json("test/fixtures/invalid-attestations.json");
    const script = fileURLToPath(file("attestation/inspect_profile.py")); const lockPath = fileURLToPath(file("hermes-profile-lock.json"));
    for (const fixture of invalids) {
      const root = await mkdtemp(join(tmpdir(), "jarvis-attestation-")); temporary.push(root);
      const attestation = await validAttestation(fixture.mode ?? "live");
      if (fixture.add) Object.assign(attestation, fixture.add); else setPath(attestation, fixture.path, fixture.value);
      const path = join(root, "attestation.json"); await writeFile(path, canonicalJsonFileBytes(attestation));
      const result = spawnSync("py", ["-V:Astral/CPython3.11.16", "-I", script, "--validate-attestation", path, "--profile-lock", lockPath], { encoding: "utf8", windowsHide: true });
      expect(result.status, `${fixture.name}: ${result.stdout}${result.stderr}`).not.toBe(0);
      expect(result.stdout).toBe(""); expect(result.stderr.replaceAll("\r\n", "\n")).toBe("Hermes runtime attestation invalid\n");
    }
  }, 30_000);

  it("emits byte-identical canonical validation output without secret-shaped data", async () => {
    const root = await mkdtemp(join(tmpdir(), "jarvis-attestation-")); temporary.push(root);
    const input = join(root, "attestation.json"); const attestation = await validAttestation("live"); await writeFile(input, canonicalJsonFileBytes(attestation));
    const result = spawnSync("py", ["-V:Astral/CPython3.11.16", "-I", fileURLToPath(file("attestation/inspect_profile.py")), "--validate-attestation", input, "--profile-lock", fileURLToPath(file("hermes-profile-lock.json"))], { encoding: "utf8", windowsHide: true });
    expect(result.status, result.stderr).toBe(0); expect(result.stderr).toBe("");
    expect(Buffer.from(result.stdout)).toEqual(Buffer.from(canonicalJsonFileBytes(attestation)));
    expect(result.stdout).not.toMatch(/"(?:api[_-]?key|password|secret|credential|token)"\s*:/i);
  });
});
