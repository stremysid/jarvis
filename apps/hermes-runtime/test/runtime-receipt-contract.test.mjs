import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";
import { canonicalize, sha256Hex } from "../src/canonical-json.mjs";

const file = (path) => new URL(`../${path}`, import.meta.url);
const H = "a".repeat(64);
async function schema(name) { return JSON.parse(await readFile(file(`schemas/${name}`), "utf8")); }
async function json(name) { return JSON.parse(await readFile(file(name), "utf8")); }
const sourceLock = await json("hermes-source-lock.json");
const profileLock = await json("hermes-profile-lock.json");
const SOURCE_LOCK_HASH = await sha256Hex(sourceLock);
const PROFILE_LOCK_HASH = await sha256Hex(profileLock);
const distribution = { name: "hermes-agent", version: "0.20.6", recordHash: H };
const versions = { python: "3.11.16", uv: "0.12.7", package: "0.20.6" };

const hermes = () => ({
  schemaVersion: "1", kind: "hermes-runtime", sourceCommit: "5fc308a70719a83cccdbba4c0e39c23f5a8239d5", sourceTree: "222ec43b5237deb643277bc2f64fa4b873dd7f28",
  sourceLockHash: SOURCE_LOCK_HASH, profileLockHash: PROFILE_LOCK_HASH,
  liveConfigurationHash: profileLock.profiles[0].runtimeModes.live.configurationHash,
  compatibilityConfigurationHash: profileLock.profiles[0].runtimeModes.pinned_runtime.configurationHash,
  liveAttestationHash: H, compatibilityAttestationHash: H, runsContractHash: sourceLock.runsEventContractHash,
  compatibilityStub: { contractHash: profileLock.compatibilityStub.contractHash, sourceHash: H, launcherBundleHash: H, baseUrl: "http://127.0.0.1:8792/v1" },
  catalogs: { remoteCatalogHash: "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a", remoteCatalogPath: "cache/model_catalog.json", modelsDevHash: "0ad75b8d2d416f1a1015ef33b2d3f7da25221314c911bc49e95556ddaa1e02b4", modelsDevPath: "models_dev_cache.json", etagPaths: [], alternateCachePaths: [] },
  launcherHash: H, sbomHash: sourceLock.sbomSha256, installedDistributions: [distribution], installedDistributionsHash: H, recordAggregateHash: H, versions,
});
const bridge = () => ({ schemaVersion: "1", kind: "brain-bridge-runtime", reviewedCommit: "b".repeat(40), reviewedTree: "c".repeat(40), bridgeContractHash: H, configurationHash: H, launcherHash: H, sbomHash: H, installedDistributions: [distribution], installedDistributionsHash: H, recordAggregateHash: H, versions: { ...versions, package: "0.1.0" } });
const services = () => ({
  schemaVersion: "1", kind: "hermes-services", launcherBundleManifestHash: H, launcherBundleHash: H,
  launcherFiles: [
    { path: "launchers/hermes_voice_safe.py", sha256: H },
    { path: "launchers/brain_bridge.py", sha256: H },
    { path: "launchers/openai_compatibility_stub.py", sha256: H },
  ],
  winswSourceHash: H,
  services: [
    { id: "JarvisHermesVoiceSafe", account: "NT AUTHORITY\\LocalService", sidType: "restricted", numericSid: "S-1-5-80-1742186558-4096873844-1667285481-1123814930-730062361", executableHash: H, xmlHash: H },
    { id: "JarvisBrainBridge", account: "NT AUTHORITY\\LocalService", sidType: "restricted", numericSid: "S-1-5-80-2884088767-3501744959-817954129-467440805-2831668990", executableHash: H, xmlHash: H },
  ],
  daclDescriptorHashes: { immutable: H, state: H, secret: H, receipt: H, parentProtection: H }, hermesSbomHash: H, bridgeSbomHash: H, hermesRuntimeReceiptHash: H, brainBridgeRuntimeReceiptHash: H,
});

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
      { ...hermes(), versions: { ...versions, package: "protected-credential-value" } },
      { ...hermes(), installedDistributions: [{ ...distribution, name: "secret-agent" }] },
      { ...hermes(), installedDistributions: [{ ...distribution, name: "protected-helper" }] },
      { ...hermes(), installedDistributions: [{ ...distribution, name: "hostname" }] },
      { ...hermes(), installedDistributions: [{ ...distribution, name: "host-helper" }] },
      { ...hermes(), installedDistributions: [{ ...distribution, name: "user-sid" }] },
      { ...hermes(), reviewedCommit: "b".repeat(40) },
    ]) expect(hermesValidate(drift)).toBe(false);
  });

  it("pins every currently reviewed Hermes source/toolchain/catalog value but leaves future Task 7 identity patterned", async () => {
    const hermesValidate = new Ajv2020({ allErrors: true, strict: true }).compile(await schema("hermes-runtime-receipt-v1.schema.json"));
    const bridgeValidate = new Ajv2020({ allErrors: true, strict: true }).compile(await schema("brain-bridge-runtime-receipt-v1.schema.json"));
    expect(hermesValidate(hermes()), JSON.stringify(hermesValidate.errors)).toBe(true);
    for (const drift of [
      { ...hermes(), sourceCommit: "b".repeat(40) },
      { ...hermes(), sourceTree: "c".repeat(40) },
      { ...hermes(), sourceLockHash: H },
      { ...hermes(), runsContractHash: H },
      { ...hermes(), sbomHash: H },
      { ...hermes(), versions: { ...versions, python: "3.11.17" } },
      { ...hermes(), versions: { ...versions, uv: "0.8.17" } },
      { ...hermes(), versions: { ...versions, package: "0.20.7" } },
      { ...hermes(), catalogs: { ...hermes().catalogs, modelsDevPath: "cache/models_dev_cache.json" } },
    ]) expect(hermesValidate(drift), JSON.stringify(drift)).toBe(false);
    expect(bridgeValidate(bridge()), JSON.stringify(bridgeValidate.errors)).toBe(true);
    expect(bridgeValidate({ ...bridge(), reviewedCommit: "not-a-commit" })).toBe(false);
    expect(bridgeValidate({ ...bridge(), reviewedTree: "not-a-tree" })).toBe(false);
    expect(bridgeValidate({ ...bridge(), versions: { ...bridge().versions, python: "3.11.17" } })).toBe(false);
    expect(bridgeValidate({ ...bridge(), versions: { ...bridge().versions, uv: "0.8.17" } })).toBe(false);
  });

  it("requires the exact two restricted LocalService records and three Task 10 launcher paths", async () => {
    const validate = new Ajv2020({ allErrors: true, strict: true }).compile(await schema("hermes-services-receipt-v1.schema.json"));
    expect(validate(services()), JSON.stringify(validate.errors)).toBe(true);
    const drifts = [
      { ...services(), services: services().services.slice(0, 1) },
      { ...services(), services: [...services().services, services().services[0]] },
      { ...services(), services: services().services.map((service, index) => index ? service : { ...service, account: "NT SERVICE\\JarvisHermesVoiceSafe" }) },
      { ...services(), services: services().services.map((service, index) => index ? service : { ...service, sidType: "unrestricted" }) },
      { ...services(), services: services().services.map((service, index) => index ? service : { ...service, numericSid: "S-1-5-80-1-2-3-4-5" }) },
      { ...services(), launcherFiles: services().launcherFiles.slice(0, 2) },
      { ...services(), launcherFiles: services().launcherFiles.map((entry, index) => index === 2 ? { ...entry, path: "launchers/OpenAICompatibilityStub.py" } : entry) },
    ];
    for (const drift of drifts) expect(validate(drift), JSON.stringify(drift)).toBe(false);
  });

  it("cross-binds receipt hashes to the authoritative Task 1/2/profile locks", async () => {
    const validate = new Ajv2020({ allErrors: true, strict: true }).compile(await schema("hermes-runtime-receipt-v1.schema.json"));
    const value = hermes();
    expect(validate(value), JSON.stringify(validate.errors)).toBe(true);
    expect(value.sourceLockHash).toBe(await sha256Hex(sourceLock));
    expect(value.profileLockHash).toBe(await sha256Hex(profileLock));
    expect(value.liveConfigurationHash).toBe(profileLock.profiles[0].runtimeModes.live.configurationHash);
    expect(value.compatibilityConfigurationHash).toBe(profileLock.profiles[0].runtimeModes.pinned_runtime.configurationHash);
    expect(value.compatibilityStub.contractHash).toBe(profileLock.compatibilityStub.contractHash);
    expect(value.runsContractHash).toBe(sourceLock.runsEventContractHash);
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
