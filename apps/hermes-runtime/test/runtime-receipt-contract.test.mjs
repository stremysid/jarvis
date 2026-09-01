import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";
import { canonicalize, sha256Hex } from "../src/canonical-json.mjs";

const file = (path) => new URL(`../${path}`, import.meta.url);
const H = "a".repeat(64);
async function schema(name) { return JSON.parse(await readFile(file(`schemas/${name}`), "utf8")); }
const distribution = { name: "example-package", version: "1.2.3", recordHash: H };
const versions = { python: "3.11.16", uv: "0.8.17", package: "0.20.6" };

const hermes = () => ({
  schemaVersion: "1", kind: "hermes-runtime", sourceCommit: "5fc308a70719a83cccdbba4c0e39c23f5a8239d5", sourceTree: "222ec43b5237deb643277bc2f64fa4b873dd7f28",
  sourceLockHash: H, profileLockHash: H, liveConfigurationHash: H, compatibilityConfigurationHash: H, liveAttestationHash: H, compatibilityAttestationHash: H, runsContractHash: H,
  compatibilityStub: { contractHash: H, sourceHash: H, launcherBundleHash: H, baseUrl: "http://127.0.0.1:8792/v1" },
  catalogs: { remoteCatalogHash: "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a", remoteCatalogPath: "cache/model_catalog.json", modelsDevHash: "0ad75b8d2d416f1a1015ef33b2d3f7da25221314c911bc49e95556ddaa1e02b4", modelsDevPath: "cache/models_dev_cache.json", etagPaths: [], alternateCachePaths: [] },
  launcherHash: H, sbomHash: H, installedDistributions: [distribution], installedDistributionsHash: H, recordAggregateHash: H, versions,
});
const bridge = () => ({ schemaVersion: "1", kind: "brain-bridge-runtime", reviewedCommit: "b".repeat(40), reviewedTree: "c".repeat(40), bridgeContractHash: H, configurationHash: H, launcherHash: H, sbomHash: H, installedDistributions: [distribution], installedDistributionsHash: H, recordAggregateHash: H, versions: { ...versions, package: "0.1.0" } });
const services = () => ({ schemaVersion: "1", kind: "hermes-services", launcherBundleManifestHash: H, launcherBundleHash: H, launcherFiles: [{ path: "launchers/HermesRuntime.ps1", sha256: H }, { path: "launchers/OpenAICompatibilityStub.py", sha256: H }], winswSourceHash: H, services: [{ id: "JarvisHermesVoiceSafe", account: "NT SERVICE\\JarvisHermesVoiceSafe", sidType: "unrestricted", numericSid: "S-1-5-80-1-2-3-4-5", executableHash: H, xmlHash: H }], daclDescriptorHashes: { immutable: H, state: H, secret: H, receipt: H, parentProtection: H }, hermesSbomHash: H, bridgeSbomHash: H, hermesRuntimeReceiptHash: H, brainBridgeRuntimeReceiptHash: H });

describe("runtime receipt schemas", () => {
  it("accepts only the three closed discriminated receipt kinds", async () => {
    for (const [name, value] of [["hermes-runtime-receipt-v1.schema.json", hermes()], ["brain-bridge-runtime-receipt-v1.schema.json", bridge()], ["hermes-services-receipt-v1.schema.json", services()]]) {
      const validate = new Ajv2020({ allErrors: true, strict: true }).compile(await schema(name));
      expect(validate(value), `${name}: ${JSON.stringify(validate.errors)}`).toBe(true);
      expect(validate({ ...value, kind: "wrong" })).toBe(false); expect(validate({ ...value, unexpected: true })).toBe(false);
    }
  });

  it("rejects short hashes, absolute/traversing paths, host identifiers, secret-shaped values, and cross-kind fields", async () => {
    const hermesValidate = new Ajv2020({ allErrors: true, strict: true }).compile(await schema("hermes-runtime-receipt-v1.schema.json"));
    for (const drift of [
      { ...hermes(), sourceLockHash: "short" },
      { ...hermes(), catalogs: { ...hermes().catalogs, remoteCatalogPath: "C:/Users/name/model_catalog.json" } },
      { ...hermes(), catalogs: { ...hermes().catalogs, remoteCatalogPath: "../model_catalog.json" } },
      { ...hermes(), hostName: "machine" },
      { ...hermes(), versions: { ...versions, package: "secret-token-value" } },
      { ...hermes(), reviewedCommit: "b".repeat(40) },
    ]) expect(hermesValidate(drift)).toBe(false);
  });

  it("defines receipt references as hashes of canonical validated JSON without self hashes", async () => {
    const value = hermes();
    expect(Object.keys(value).some((key) => /self.*hash/i.test(key))).toBe(false);
    const expected = await sha256Hex(canonicalize(value));
    expect(expected).toMatch(/^[a-f0-9]{64}$/);
    const drift = structuredClone(value); drift.versions.package = "0.20.7";
    expect(await sha256Hex(canonicalize(drift))).not.toBe(expected);
  });

  it("keeps every receipt schema canonical UTF-8 with exactly one LF", async () => {
    for (const name of ["hermes-runtime-receipt-v1.schema.json", "brain-bridge-runtime-receipt-v1.schema.json", "hermes-services-receipt-v1.schema.json", "hermes-runtime-attestation-v1.schema.json"]) {
      const bytes = await readFile(file(`schemas/${name}`)); const value = JSON.parse(bytes.toString("utf8"));
      expect(bytes.equals(Buffer.concat([Buffer.from(canonicalize(value)), Buffer.from("\n")]))).toBe(true);
    }
  });
});
