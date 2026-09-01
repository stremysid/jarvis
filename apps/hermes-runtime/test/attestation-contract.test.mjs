import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";
import { canonicalJsonFileBytes, sha256Hex } from "../src/canonical-json.mjs";

const file = (path) => new URL(`../${path}`, import.meta.url);
const temporary = [];
const servers = [];
const childProcesses = [];
const SCRIPT = fileURLToPath(file("attestation/inspect_profile.py"));

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
  await Promise.all(childProcesses.splice(0).map((child) => new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
    child.once("exit", resolve);
    child.kill();
  })));
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true, maxRetries: 3 })));
});

async function json(path) { return JSON.parse(await readFile(file(path), "utf8")); }
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const recordDigest = (bytes) => `sha256=${createHash("sha256").update(bytes).digest("base64url")}`;

async function writeBytes(path, bytes) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
  return path;
}

async function writeCanonical(path, value) { return writeBytes(path, canonicalJsonFileBytes(value)); }

async function addDistribution(sitePackages, name, version) {
  const importName = name.replaceAll("-", "_");
  const packageBytes = Buffer.from(`__version__ = "${version}"\n`, "utf8");
  const metadataBytes = Buffer.from(`Metadata-Version: 2.3\nName: ${name}\nVersion: ${version}\n\n`, "utf8");
  const packagePath = `${importName}/__init__.py`;
  const distInfo = `${importName}-${version}.dist-info`;
  await writeBytes(join(sitePackages, ...packagePath.split("/")), packageBytes);
  await writeBytes(join(sitePackages, distInfo, "METADATA"), metadataBytes);
  const recordBytes = Buffer.from([
    `${packagePath},${recordDigest(packageBytes)},${packageBytes.length}`,
    `${distInfo}/METADATA,${recordDigest(metadataBytes)},${metadataBytes.length}`,
    `${distInfo}/RECORD,,`,
    "",
  ].join("\n"), "utf8");
  await writeBytes(join(sitePackages, distInfo, "RECORD"), recordBytes);
}

async function filesUnder(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => entry.isDirectory() ? filesUnder(join(root, entry.name)) : [join(root, entry.name)]));
  return nested.flat();
}

async function buildRuntime(mode, { distributionName = "hermes-agent" } = {}) {
  const root = await mkdtemp(join(tmpdir(), "jarvis-runtime-attestation-"));
  temporary.push(root);
  const lock = await json("hermes-profile-lock.json");
  const source = await json("hermes-source-lock.json");
  const artifacts = await json("runtime-artifacts-lock.json");
  const profile = lock.profiles[0];
  const route = profile.runtimeModes[mode];
  const profileRoot = join(root, "profiles", profile.id);
  const home = join(profileRoot, "home");
  const immutableFiles = [];

  immutableFiles.push(await writeBytes(join(home, "config.yaml"), await readFile(file("profiles/jarvis-voice-safe/config.yaml"))));
  immutableFiles.push(await writeBytes(join(home, "config.compatibility.yaml"), await readFile(file("profiles/jarvis-voice-safe/config.compatibility.yaml"))));
  immutableFiles.push(await writeBytes(join(home, "cache", "model_catalog.json"), await readFile(file("profiles/jarvis-voice-safe/model_catalog.json"))));
  immutableFiles.push(await writeBytes(join(home, "models_dev_cache.json"), await readFile(file("profiles/jarvis-voice-safe/models_dev_cache.json"))));
  await mkdir(join(home, "plugins"), { recursive: true });
  for (const provider of profile.providerInventory) immutableFiles.push(await writeBytes(join(home, "providers", `${provider}.provider`), Buffer.from(`${provider}\n`, "utf8")));
  immutableFiles.push(await writeCanonical(join(home, "runtime", "effective-tools.json"), []));
  immutableFiles.push(await writeCanonical(join(home, "runtime", "catalog-activity.json"), { backgroundRefresh: false, networkRequests: 0 }));
  for (const path of profile.writablePaths) await mkdir(join(home, ...path.split("/")), { recursive: true });
  immutableFiles.push(await writeCanonical(join(profileRoot, "mode.json"), { configurationHash: route.configurationHash, mode }));

  immutableFiles.push(await writeCanonical(join(root, "locks", "hermes-source-lock.json"), source));
  immutableFiles.push(await writeCanonical(join(root, "locks", "runtime-artifacts-lock.json"), artifacts));
  immutableFiles.push(await writeCanonical(join(root, "locks", "hermes-profile-lock.json"), lock));
  immutableFiles.push(await writeBytes(join(root, "contracts", "hermes-runs-api-v2026.8.27.json"), await readFile(file("contracts/hermes-runs-api-v2026.8.27.json"))));
  const sbom = await json(source.sbom.file);
  immutableFiles.push(await writeBytes(join(root, "sbom", "hermes-agent.cdx.json"), await readFile(file(source.sbom.file))));

  const launcherSources = {
    "brain_bridge.py": Buffer.from("raise SystemExit('fixture-only')\n", "utf8"),
    "hermes_voice_safe.py": Buffer.from("raise SystemExit('fixture-only')\n", "utf8"),
    "openai_compatibility_stub.py": Buffer.from("raise SystemExit('fixture-only')\n", "utf8"),
  };
  const launcherManifest = { files: Object.entries(launcherSources).map(([path, bytes]) => ({ path, sha256: digest(bytes) })), schemaVersion: "1" };
  const bundleHash = await sha256Hex(launcherManifest);
  const bundleRoot = join(root, "service-host", "launchers", `sha256-${bundleHash}`);
  immutableFiles.push(await writeCanonical(join(bundleRoot, "manifest.json"), launcherManifest));
  for (const [path, bytes] of Object.entries(launcherSources)) immutableFiles.push(await writeBytes(join(bundleRoot, path), bytes));

  const sitePackages = join(root, "releases", source.sourceCommit, "venvs", profile.id, "Lib", "site-packages");
  await addDistribution(sitePackages, distributionName, source.packageVersion);
  for (const component of sbom.components) if (component.name !== distributionName || component.version !== source.packageVersion) await addDistribution(sitePackages, component.name, component.version);
  immutableFiles.push(...await filesUnder(sitePackages));
  immutableFiles.push(await writeBytes(join(root, "toolchain", `uv-${artifacts.uv.version}`, "uv.exe"), Buffer.alloc(0)));
  immutableFiles.push(await writeBytes(join(root, "service-host", `winsw-${artifacts.winsw.version}`, "WinSW-x64.exe"), Buffer.alloc(0)));

  for (const path of immutableFiles) await chmod(path, 0o444);
  return { root, lock, source, profile, route, profileRoot, home };
}

function inspect(runtime, mode, expectedAttestation) {
  const args = ["-V:Astral/CPython3.11.16", "-I", SCRIPT, "--runtime-root", runtime.root, "--mode", mode];
  if (expectedAttestation) args.push("--expected-attestation", expectedAttestation);
  return spawnSync("py", args, { encoding: "utf8", windowsHide: true });
}

async function listen(port, handler) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise((resolve, reject) => server.once("error", reject).listen(port, "127.0.0.1", resolve));
  return server;
}

async function startHermesListener() {
  return listen(8791, (_request, response) => { response.writeHead(405, { "content-type": "application/json; charset=utf-8" }); response.end("{}\n"); });
}

async function startCompatibilityListener(contract) {
  const script = String.raw`
    const { createServer } = require("node:http");
    const [readinessJson, authorization, unauthorizedJson] = process.argv.slice(1);
    const readiness = JSON.parse(readinessJson);
    const unauthorized = JSON.parse(unauthorizedJson);
    const server = createServer((request, response) => {
      if (request.method !== readiness.method || request.url !== readiness.route || request.headers.authorization !== authorization) {
        response.writeHead(unauthorized.status, { "content-type": unauthorized.contentType });
        response.end(unauthorized.utf8);
        return;
      }
      response.writeHead(readiness.status, { "content-type": readiness.contentType });
      response.end(readiness.utf8);
    });
    server.listen(8792, "127.0.0.1", () => process.stdout.write("ready\n"));
    process.on("SIGTERM", () => server.close(() => process.exit(0)));
  `;
  const child = spawn(process.execPath, [
    "-e", script,
    JSON.stringify(contract.readiness),
    `Bearer ${contract.authorization.fixedPublicValue}`,
    JSON.stringify(contract.errors.unauthorized),
  ], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  childProcesses.push(child);
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`compatibility listener exited before ready: ${code}`)));
    child.stdout.once("data", (chunk) => chunk.toString("utf8") === "ready\n" ? resolve() : reject(new Error("unexpected compatibility listener output")));
  });
  return child;
}

function setPath(value, dottedPath, replacement) {
  const parts = dottedPath.split("."); let target = value;
  for (const part of parts.slice(0, -1)) target = target[part];
  target[parts.at(-1)] = replacement;
}

describe("Hermes runtime attestation", () => {
  it("derives canonical attestations from actual live and pinned-runtime trees", async () => {
    const validate = new Ajv2020({ allErrors: true, strict: true }).compile(await json("schemas/hermes-runtime-attestation-v1.schema.json"));
    await startHermesListener();
    const live = await buildRuntime("live");
    const liveResult = inspect(live, "live");
    expect(liveResult.status, liveResult.stderr).toBe(0);
    expect(liveResult.stderr).toBe("");
    const liveAttestation = JSON.parse(liveResult.stdout);
    expect(validate(liveAttestation), JSON.stringify(validate.errors)).toBe(true);
    expect(liveAttestation).toMatchObject({ mode: "live", configurationHash: live.route.configurationHash, managedConfigHash: live.route.managedConfigHash, compatibilityStub: null });
    expect(liveAttestation.installedDistributions).toContainEqual({ name: "hermes-agent", recordHash: expect.stringMatching(/^[a-f0-9]{64}$/), version: "0.20.6" });
    const expectedClosure = await json(live.source.sbom.file);
    expect(liveAttestation.installedDistributions).toHaveLength(new Set([`${expectedClosure.metadata.component.name}@${expectedClosure.metadata.component.version}`, ...expectedClosure.components.map((component) => `${component.name}@${component.version}`)]).size);
    expect(Buffer.from(liveResult.stdout)).toEqual(Buffer.from(canonicalJsonFileBytes(liveAttestation)));

    await new Promise((resolve) => servers.shift().close(resolve));
    await startHermesListener();
    const contract = await json("contracts/openai-compatibility-stub-v1.json");
    await startCompatibilityListener(contract);
    const pinned = await buildRuntime("pinned_runtime");
    const pinnedResult = inspect(pinned, "pinned_runtime");
    expect(pinnedResult.status, pinnedResult.stderr).toBe(0);
    const pinnedAttestation = JSON.parse(pinnedResult.stdout);
    expect(validate(pinnedAttestation), JSON.stringify(validate.errors)).toBe(true);
    expect(pinnedAttestation).toMatchObject({ mode: "pinned_runtime", configurationHash: pinned.route.configurationHash, managedConfigHash: pinned.route.managedConfigHash });
    expect(pinnedAttestation.compatibilityStub).toMatchObject({ baseUrl: "http://127.0.0.1:8792/v1", contractHash: pinned.lock.compatibilityStub.contractHash, credentialMode: "nonsecret-test-token", processRunning: true });
  }, 30_000);

  it("uses an expected attestation only for byte comparison after runtime derivation", async () => {
    await startHermesListener();
    const runtime = await buildRuntime("live");
    const initial = inspect(runtime, "live");
    expect(initial.status, initial.stderr).toBe(0);
    const expectedPath = join(runtime.root, "expected-attestation.json");
    await writeFile(expectedPath, initial.stdout, "utf8");
    expect(inspect(runtime, "live", expectedPath).status).toBe(0);
    const claimed = JSON.parse(initial.stdout); claimed.selectedModel = "caller-selected-model";
    await writeFile(expectedPath, canonicalJsonFileBytes(claimed));
    const mismatch = inspect(runtime, "live", expectedPath);
    expect(mismatch.status).not.toBe(0);
    expect(mismatch.stdout).toBe("");
    expect(mismatch.stderr.replaceAll("\r\n", "\n")).toBe("Hermes runtime attestation invalid\n");
  }, 30_000);

  it("rejects config and cross-mode drift even when supplied expected bytes claim success", async () => {
    await startHermesListener();
    const runtime = await buildRuntime("live");
    const initial = inspect(runtime, "live");
    expect(initial.status, initial.stderr).toBe(0);
    const expectedPath = join(runtime.root, "expected-attestation.json");
    await writeFile(expectedPath, initial.stdout, "utf8");
    const configPath = join(runtime.home, "config.yaml");
    await chmod(configPath, 0o666);
    const config = JSON.parse(await readFile(configPath, "utf8")); config.model.provider = "openrouter";
    await writeFile(configPath, canonicalJsonFileBytes(config));
    const drift = inspect(runtime, "live", expectedPath);
    expect(drift.status).not.toBe(0);
    expect(drift.stdout).toBe("");
    expect(drift.stderr.replaceAll("\r\n", "\n")).toBe("Hermes runtime attestation invalid\n");
    expect(inspect(runtime, "pinned_runtime", expectedPath).status).not.toBe(0);
  }, 30_000);

  it("rejects unregistered files in the protected provider capability registry", async () => {
    await startHermesListener();
    const runtime = await buildRuntime("live");
    const injected = join(runtime.home, "providers", "unregistered-capability.txt");
    await writeFile(injected, "unregistered\n", "utf8");
    await chmod(injected, 0o444);
    const result = inspect(runtime, "live");
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr.replaceAll("\r\n", "\n")).toBe("Hermes runtime attestation invalid\n");
  }, 30_000);

  it("recursively rejects protected/secret/identity/host-shaped distribution data before serialization", async () => {
    await startHermesListener();
    const runtime = await buildRuntime("live", { distributionName: "secret-agent" });
    const result = inspect(runtime, "live");
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr.replaceAll("\r\n", "\n")).toBe("Hermes runtime attestation invalid\n");
    const validate = new Ajv2020({ allErrors: true, strict: true }).compile(await json("schemas/hermes-runtime-attestation-v1.schema.json"));
    const ordinary = await buildRuntime("live");
    const ordinaryResult = inspect(ordinary, "live");
    expect(ordinaryResult.status, ordinaryResult.stderr).toBe(0);
    for (const name of ["secret-agent", "protected-helper", "credential-helper", "hostname", "host-helper", "user-sid"]) {
      const claimed = JSON.parse(ordinaryResult.stdout); claimed.installedDistributions[0].name = name;
      expect(validate(claimed), `${name} passed the attestation schema`).toBe(false);
    }
  }, 30_000);

  it("schema-rejects every reviewed emitted-attestation drift class", async () => {
    await startHermesListener();
    const runtime = await buildRuntime("live");
    const result = inspect(runtime, "live");
    expect(result.status, result.stderr).toBe(0);
    const validate = new Ajv2020({ allErrors: true, strict: true }).compile(await json("schemas/hermes-runtime-attestation-v1.schema.json"));
    const valid = JSON.parse(result.stdout);
    for (const fixture of await json("test/fixtures/invalid-attestations.json")) {
      if (fixture.mode && fixture.mode !== "live") continue;
      const drift = structuredClone(valid);
      if (fixture.add) Object.assign(drift, fixture.add); else setPath(drift, fixture.path, fixture.value);
      expect(validate(drift), `${fixture.name} passed: ${JSON.stringify(validate.errors)}`).toBe(false);
    }
  }, 30_000);

  it("refuses a live attestation while the compatibility listener is present", async () => {
    await startHermesListener();
    await startCompatibilityListener(await json("contracts/openai-compatibility-stub-v1.json"));
    const runtime = await buildRuntime("live");
    const result = inspect(runtime, "live");
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr.replaceAll("\r\n", "\n")).toBe("Hermes runtime attestation invalid\n");
  }, 30_000);
});
