import { access, copyFile, link, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";
import { canonicalize, sha256Hex, validateHermesManifests, validateRunsWireArtifacts } from "../src/validate-manifests.mjs";
import { loadCanonicalJsonFile } from "../src/canonical-json.mjs";
import { validateRunsWire } from "../src/validate-runs-wire.mjs";
import { markerApplies, wheelRank } from "../src/generate-sbom.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const file = (path) => new URL(`../${path}`, import.meta.url);

async function loadJson(path) {
  return JSON.parse(await readFile(file(path), "utf8"));
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function runPowerShellFile(script, args, timeout = 120_000, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn("pwsh", ["-NoProfile", "-NonInteractive", "-File", script, ...args], { windowsHide: true, env });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`PowerShell entrypoint timed out: ${script}`));
    }, timeout);
    child.stdout.on("data", (data) => { stdout += data; });
    child.stderr.on("data", (data) => { stderr += data; });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

async function snapshotTree(path, relative = "") {
  const entries = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
    const child = join(path, entry.name);
    const metadata = await stat(child, { bigint: true });
    if (entry.isDirectory()) {
      entries.push({ path: `${childRelative}/`, mtimeNs: metadata.mtimeNs.toString() });
      entries.push(...await snapshotTree(child, childRelative));
    } else {
      const bytes = await readFile(child);
      entries.push({
        path: childRelative,
        size: metadata.size.toString(),
        mtimeNs: metadata.mtimeNs.toString(),
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    }
  }
  return entries;
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

  it("keeps every authoritative notice byte-exact and uses only scoped Git whitespace exceptions", async () => {
    const source = await loadJson("hermes-source-lock.json");
    for (const [path, expected] of Object.entries(source.licenses.files)) {
      const bytes = await readFile(new URL(`../${path}`, import.meta.url));
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(expected);
    }
    const attributes = await readFile(new URL("../../../.gitattributes", import.meta.url), "utf8");
    expect(attributes).toContain("apps/hermes-runtime/licenses/CPython-LICENSE -text whitespace=-trailing-space,-blank-at-eof conflict-marker-size=4096");
    expect(attributes).toContain("apps/hermes-runtime/licenses/python-build-standalone-licenses.rst -text whitespace=-trailing-space,-blank-at-eof conflict-marker-size=4096");
  });

  it("binds the source lock and Task 1 readiness fixture to the canonical Runs event contract", async () => {
    const source = await loadJson("hermes-source-lock.json");
    const contract = await loadJson("contracts/hermes-runs-api-v2026.8.27.json");
    const readinessFile = await loadCanonicalJsonFile(new URL("../../../tests/fixtures/hermes-h1/readiness-golden-v1.json", import.meta.url), "Task 1 readiness fixture");
    const readiness = readinessFile.value;
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

  it("rejects artifact URL, declared size, and content hash drift before acquisition", async () => {
    const source = await loadJson("hermes-source-lock.json"); const artifacts = await loadJson("runtime-artifacts-lock.json"); const contract = await loadJson("contracts/hermes-runs-api-v2026.8.27.json"); const patches = await loadJson("patches/series.json"); const sbom = await loadJson("sbom/hermes-agent-v2026.8.27-windows-x86_64-cpython-3.11.16.cdx.json");
    for (const change of [{ url: "https://evil.invalid/a" }, { size: 1 }, { sha256: "0".repeat(64) }]) { const drift = structuredClone(artifacts); Object.assign(drift.cpython, change); await expect(validateHermesManifests({ source, artifacts: drift, contract, patches, sbom })).rejects.toThrow(); }
  });

  it("keeps both strict schemas valid and rejects non-exact artifact license arrays", async () => {
    const sourceSchema = JSON.parse(await readFile(file("schemas/hermes-source-lock-v1.schema.json"), "utf8"));
    const artifactSchema = JSON.parse(await readFile(file("schemas/runtime-artifacts-lock-v1.schema.json"), "utf8"));
    expect(sourceSchema.properties.rawFileSha256.additionalProperties).toBe(false);
    expect(artifactSchema.$defs.artifact.additionalProperties).toBe(false);
    const source = await loadJson("hermes-source-lock.json"); const artifacts = await loadJson("runtime-artifacts-lock.json"); const contract = await loadJson("contracts/hermes-runs-api-v2026.8.27.json"); const patches = await loadJson("patches/series.json"); const sbom = await loadJson("sbom/hermes-agent-v2026.8.27-windows-x86_64-cpython-3.11.16.cdx.json");
    const ajv = new Ajv2020({ allErrors: true, strict: true }); const validateSource = ajv.compile(sourceSchema); const validateArtifacts = ajv.compile(artifactSchema); expect(validateSource(source), ajv.errors?.toString()).toBe(true); expect(validateArtifacts(artifacts), ajv.errors?.toString()).toBe(true);
    const scalarDrift = structuredClone(source); scalarDrift.sourceCommit = 7; expect(validateSource(scalarDrift)).toBe(false);
    const drift = structuredClone(artifacts); drift.uv.licenses.push("unexpected"); await expect(validateHermesManifests({ source, artifacts: drift, contract, patches, sbom })).rejects.toThrow(/exact array/);
    const attributes = await readFile(new URL("../../../.gitattributes", import.meta.url), "utf8"); expect(attributes).toContain("apps/hermes-runtime/hermes-source-lock.json -text"); expect(attributes).toContain("apps/hermes-runtime/runtime-artifacts-lock.json -text");
  });

  it("requires an explicit source root for deterministic SBOM generation", async () => {
    const generator = fileURLToPath(new URL("../src/generate-sbom.mjs", import.meta.url));
    const result = await new Promise((resolve, reject) => { const child = spawn(process.execPath, [generator], { windowsHide: true }); let stderr = ""; child.stderr.on("data", (data) => { stderr += data; }); child.on("error", reject); child.on("close", (code) => resolve({ code, stderr })); });
    expect(result.code).not.toBe(0); expect(result.stderr).toContain("--source-root");
  });

  it("resolves the complete Windows CPython closure with strict markers, extras, and wheel ranks", async () => {
    const sbom = await loadJson("sbom/hermes-agent-v2026.8.27-windows-x86_64-cpython-3.11.16.cdx.json");
    const installed = sbom.components.filter((component) => component.purl?.startsWith("pkg:pypi/"));
    const archives = installed.filter((component) => component.hashes);
    expect(installed).toHaveLength(66); expect(archives).toHaveLength(65);
    expect(archives.reduce((sum, component) => sum + Number(component.properties[0].value), 0)).toBe(41_417_102);
    const archiveRecords = archives.map((component) => ({ name: component.name, version: component.version, url: component.externalReferences[0].url, size: Number(component.properties[0].value), sha256: component.hashes[0].content })).sort((left, right) => left.name.localeCompare(right.name));
    const byRef = new Map(installed.map((component) => [component.purl, component]));
    const dependencyRecords = sbom.dependencies.map((dependency) => ({ name: byRef.get(dependency.ref).name, version: byRef.get(dependency.ref).version, dependsOn: dependency.dependsOn.map((reference) => byRef.get(reference).name).sort() })).sort((left, right) => left.name.localeCompare(right.name));
    await expect(sha256Hex(canonicalize(installed.map((component) => `${component.name}==${component.version}`).sort()))).resolves.toBe("3de6c3eeb3148f4b49cf48c5e8973487e82acbecd95131b8a50fc141276242a8");
    await expect(sha256Hex(canonicalize(archiveRecords))).resolves.toBe("5433972607296e6ace1155482d1af15575f2aae75821781a67409f60147eb31a");
    await expect(sha256Hex(canonicalize(dependencyRecords))).resolves.toBe("8efcb478f48ae732c7d9f2432599425283c34c4dd972f43de1854f3271618f27");
    for (const name of ["nemo-relay", "socksio", "httptools", "watchfiles"]) expect(installed.some((component) => component.name === name)).toBe(true);
    expect(markerApplies("sys_platform == 'win32' and python_full_version >= '3.11'", new Set())).toBe(true); expect(markerApplies("sys_platform != 'win32' or extra == 'socks'", new Set())).toBe(false); expect(markerApplies("extra == 'socks'", new Set(["socks"]))).toBe(true); expect(() => markerApplies("evil == 'x'", new Set())).toThrow();
    expect(wheelRank("https://example.invalid/x-1-cp311-cp311-win_amd64.whl")).toBe(0); expect(wheelRank("https://example.invalid/x-1-cp37-abi3-win_amd64.whl")).toBe(24); expect(wheelRank("https://example.invalid/x-1-py2.py3-none-any.whl")).toBe(310); expect(wheelRank("https://example.invalid/x-1-cp311-cp311-manylinux.whl")).toBeUndefined();
  });

  it("runs the manifest validator CLI over the committed artifact set", async () => {
    const validator = fileURLToPath(new URL("../src/validate-manifests.mjs", import.meta.url));
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [validator], { windowsHide: true }); let stdout = ""; let stderr = "";
      child.stdout.on("data", (data) => { stdout += data; }); child.stderr.on("data", (data) => { stderr += data; }); child.on("error", reject); child.on("close", (code) => resolve({ code, stdout, stderr }));
    });
    expect(result.code, result.stderr).toBe(0); expect(result.stdout).toBe("Hermes H1 manifests valid\n"); expect(result.stderr).toBe("");
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

  it("freezes every accepted Runs event and GET status union, rejecting one-field and cross-state drift", async () => {
    const source = await loadJson("hermes-source-lock.json"); const artifacts = await loadJson("runtime-artifacts-lock.json"); const patches = await loadJson("patches/series.json"); const sbom = await loadJson("sbom/hermes-agent-v2026.8.27-windows-x86_64-cpython-3.11.16.cdx.json"); const contract = await loadJson("contracts/hermes-runs-api-v2026.8.27.json");
    expect(Object.keys(contract.events.allowed).sort()).toEqual(["message.delta", "reasoning.available", "run.cancelled", "run.completed", "run.failed"]);
    expect(contract.get.statuses).toEqual({ queued: [], running: [[], ["last_event", "reasoning.available"]], stopping: [["last_event", "run.stopping"]], completed: [["last_event", "run.completed", "output", "usage"]], failed: [["last_event", "run.failed", "error"]], cancelled: [["last_event", "run.cancelled"]] });
    for (const event of Object.keys(contract.events.allowed)) { const drift = structuredClone(contract); drift.events.allowed[event] = drift.events.allowed[event].slice(1); await expect(validateHermesManifests({ source, artifacts, patches, sbom, contract: drift })).rejects.toThrow(); }
    for (const status of Object.keys(contract.get.statuses)) { const drift = structuredClone(contract); drift.get.statuses[status] = [["last_event", "tool.called"]]; await expect(validateHermesManifests({ source, artifacts, patches, sbom, contract: drift })).rejects.toThrow(); }
    for (const forbidden of ["pending_steer", "tool.called", "approval.requested", "subagent.started", "steer.received"]) { const drift = structuredClone(contract); drift.events.allowed[forbidden] = ["event"]; await expect(validateHermesManifests({ source, artifacts, patches, sbom, contract: drift })).rejects.toThrow(); }
  });

  it("machine-validates exact Runs request, response, event, and GET golden bodies", async () => {
    const golden = await loadJson("test/fixtures/runs-wire-golden-v1.json"); const schema = await loadJson("schemas/hermes-runs-wire-v2026.8.27.schema.json"); const contract = await loadJson("contracts/hermes-runs-api-v2026.8.27.json");
    const tokenVector = JSON.parse(await readFile(new URL("../../../tests/fixtures/hermes-h1/token-request-golden-v1.json", import.meta.url), "utf8"));
    expect(Buffer.from(golden.request.input, "utf8").toString("hex")).toBe(tokenVector.nativeInputUtf8Hex); expect(golden.request.session_id).toBe(tokenVector.sessionId);
    await expect(validateRunsWireArtifacts({ contract, wireSchema: schema, wireGolden: golden })).resolves.toBeUndefined();
    await expect(validateRunsWireArtifacts({ contract, wireSchema: { ...schema, title: "drift" }, wireGolden: golden })).rejects.toThrow(/wire schema/);
    await expect(validateRunsWireArtifacts({ contract, wireSchema: schema, wireGolden: { ...golden, request: { ...golden.request, provider: "other" } } })).rejects.toThrow(/wire golden/);
    const ajv = new Ajv2020({ allErrors: true, strict: true }); ajv.addSchema({ ...schema, $id: "hermes-runs-wire-v2026.8.27" });
    const whole = ajv.getSchema("hermes-runs-wire-v2026.8.27"); expect(whole, "whole Runs fixture schema missing").toBeTypeOf("function"); expect(whole(golden), `whole fixture: ${whole.errors?.toString()}`).toBe(true);
    expect(whole({ ...golden, events: golden.events.slice(1) })).toBe(false); expect(whole({ ...golden, get: [...golden.get, golden.get[0]] })).toBe(false);
    expect(whole({ ...golden, get: [golden.get[0], golden.get[2], golden.get[1], ...golden.get.slice(3)] })).toBe(false); expect(whole({ ...golden, get: [...golden.get.slice(0, 2), { ...golden.get[2], last_event: undefined }, ...golden.get.slice(3)] })).toBe(false);
    for (const [kind, value] of [["request", golden.request], ["admission", golden.admission], ["stop", golden.stop], ["notFound", golden.notFound], ...golden.events.map((body) => ["event", body]), ...golden.get.map((body) => ["get", body])]) { const validate = ajv.getSchema(`hermes-runs-wire-v2026.8.27#/$defs/${kind}`); expect(validate, `${kind} schema missing`).toBeTypeOf("function"); expect(validate(value), `${kind}: ${validate.errors?.toString()}`).toBe(true); }
    validateRunsWire("request", golden.request); validateRunsWire("admission", golden.admission); validateRunsWire("stop", golden.stop); validateRunsWire("notFound", golden.notFound);
    for (const value of golden.events) validateRunsWire("event", value); for (const value of golden.get) validateRunsWire("get", value);
    for (const model_options of [{ reasoning: { enabled: false } }, { reasoning: { enabled: true, effort: "low" } }, { reasoning: { enabled: true, effort: "high" } }, { reasoning: { enabled: true, effort: "max" } }]) validateRunsWire("request", { ...golden.request, model_options });
    for (const input of ["\ud800", "\udfff"]) expect(() => validateRunsWire("request", { ...golden.request, input })).toThrow(/well-formed Unicode/);
    for (const [kind, value] of [["event", { ...golden.events[0], event: "tool.called" }], ["event", { ...golden.events[2], usage: { input_tokens: -1, output_tokens: 0, total_tokens: 0 } }], ["event", { ...golden.events[0], timestamp: "1700000000" }], ["event", { ...golden.events[0], timestamp: Number.NaN }], ["event", { ...golden.events[0], timestamp: Number.POSITIVE_INFINITY }], ["admission", { ...golden.admission, run_id: "run_ABC" }], ["get", { ...golden.get[3], last_event: "reasoning.available" }], ["get", { ...golden.get[0], pending_steer: true }], ["request", { ...golden.request, profile: "tools" }], ["request", { ...golden.request, provider: "openrouter" }], ["request", { ...golden.request, model_options: { reasoning: { enabled: true, effort: "medium" } } }], ["request", { ...golden.request, model_options: { reasoning: { enabled: false, effort: "low" } } }], ["notFound", { error: { ...golden.notFound.error, message: "Run not found: run_other" } }]]) expect(() => validateRunsWire(kind, value)).toThrow();
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

  it("recovers the real artifact entrypoint after a process-level crash following each individual promotion", async () => {
    const script = fileURLToPath(new URL("../scripts/fetch-runtime-artifacts.ps1", import.meta.url));
    for (const crashAfter of [1, 2, 3, 4]) {
      const runtimeRoot = await mkdtemp(join(tmpdir(), "jarvis-hermes-workflow-fixture-"));
      const fixture = join(runtimeRoot, "artifact-operations.json");
      const effects = join(runtimeRoot, "effects.log");
      await writeFile(fixture, '{"schemaVersion":1,"workflow":"runtime-artifacts","scenario":"success"}\n', "utf8");
      try {
        const crashed = await runPowerShellFile(script, [
          "-RuntimeRoot", runtimeRoot,
          "-TestOperationFixture", fixture,
          "-TestEffectLog", effects,
          "-TestCrashAfterPromotion", String(crashAfter),
        ]);
        expect(crashed.code, `promotion ${crashAfter} did not crash`).not.toBe(0);
        const journalPath = join(runtimeRoot, ".hermes-runtime-publication.json");
        const readyPath = join(runtimeRoot, ".hermes-runtime-publication.ready.json");
        expect(await pathExists(journalPath)).toBe(true);
        expect(await pathExists(readyPath)).toBe(false);
        const journal = JSON.parse(await readFile(journalPath, "utf8"));
        expect(journal.promotions).toHaveLength(4);
        expect((await readFile(effects, "utf8")).trimEnd().split("\n")).toEqual([
          "validated-before-root-effect",
          "filesystem-stage",
          "download-CPython",
          "download-uv",
          "download-WinSW",
          "download-license",
          "staged-full-tree-verified",
          ...Array.from({ length: crashAfter }, (_, index) => `promotion-${index + 1}`),
        ]);
        for (const promotion of journal.promotions) {
          const staged = await pathExists(promotion.staged);
          const final = await pathExists(promotion.final);
          expect(Number(staged) + Number(final), `promotion ${crashAfter}: ${promotion.final}`).toBe(1);
        }

        const recovered = await runPowerShellFile(script, [
          "-RuntimeRoot", runtimeRoot,
          "-TestOperationFixture", fixture,
          "-TestEffectLog", effects,
        ]);
        expect(recovered.code, recovered.stderr).toBe(0);
        expect(await pathExists(journalPath)).toBe(false);
        expect(await pathExists(readyPath)).toBe(true);
        for (const final of [
          "toolchain/cpython-3.11.16",
          "toolchain/uv-0.12.7",
          "service-host/winsw-2.12.0",
          "licenses/python-build-standalone/20260825",
        ]) expect(await pathExists(join(runtimeRoot, final))).toBe(true);
      } finally {
        await rm(runtimeRoot, { recursive: true, force: true });
      }
    }
  }, 120_000);

  it("binds the only recoverable artifact stage to the exact publication journal and rejects unbound residue", async () => {
    const script = fileURLToPath(new URL("../scripts/fetch-runtime-artifacts.ps1", import.meta.url));
    const runtimeRoot = await mkdtemp(join(tmpdir(), "jarvis-hermes-workflow-fixture-"));
    const fixture = join(runtimeRoot, "artifact-operations.json");
    await writeFile(fixture, '{"schemaVersion":1,"workflow":"runtime-artifacts","scenario":"success"}\n', "utf8");
    try {
      const crashed = await runPowerShellFile(script, [
        "-RuntimeRoot", runtimeRoot,
        "-TestOperationFixture", fixture,
        "-TestCrashAfterPromotion", "1",
      ]);
      expect(crashed.code).not.toBe(0);
      expect(await pathExists(join(runtimeRoot, ".hermes-runtime-publication.json")), crashed.stderr).toBe(true);
      const journal = JSON.parse(await readFile(join(runtimeRoot, ".hermes-runtime-publication.json"), "utf8"));
      expect(journal).toEqual(expect.objectContaining({
        schemaVersion: 2,
        state: "promoting",
        transactionId: expect.stringMatching(/^[a-f0-9]{32}$/),
        commonStage: expect.stringMatching(/\\\.artifact-stage-[a-f0-9]{32}$/i),
      }));
      expect(journal.promotions).toHaveLength(4);
      expect(new Set(journal.promotions.map(({ staged }) => staged.slice(0, staged.lastIndexOf("\\"))))).toEqual(new Set([join(journal.commonStage, "promote")]));
      expect((await readdir(runtimeRoot)).filter((name) => name.startsWith(".artifact-stage-"))).toEqual([journal.commonStage.slice(journal.commonStage.lastIndexOf("\\") + 1)]);

      await writeFile(join(runtimeRoot, ".artifact-stage-unbound"), "hostile", "utf8");
      const verify = await runPowerShellFile(script, [
        "-RuntimeRoot", runtimeRoot,
        "-VerifyOnly",
        "-TestOperationFixture", fixture,
      ]);
      expect(verify.code).not.toBe(0);
      expect(verify.stderr).toMatch(/unbound|residue/i);
    } finally {
      await rm(runtimeRoot, { recursive: true, force: true });
    }
  }, 120_000);

  it("serializes simultaneous artifact workflows with an OS-released exclusive lock", async () => {
    const script = fileURLToPath(new URL("../scripts/fetch-runtime-artifacts.ps1", import.meta.url));
    const runtimeRoot = await mkdtemp(join(tmpdir(), "jarvis-hermes-workflow-fixture-"));
    const fixture = join(runtimeRoot, "artifact-operations.json");
    const loserEffects = join(runtimeRoot, "loser-effects.log");
    await writeFile(fixture, '{"schemaVersion":1,"workflow":"runtime-artifacts","scenario":"success"}\n', "utf8");
    try {
      const winner = runPowerShellFile(script, [
        "-RuntimeRoot", runtimeRoot,
        "-TestOperationFixture", fixture,
        "-TestHoldLockMilliseconds", "1500",
      ]);
      for (let index = 0; index < 40 && !await pathExists(join(runtimeRoot, ".hermes-runtime.workflow.lock")); index++) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
      const loser = await runPowerShellFile(script, [
        "-RuntimeRoot", runtimeRoot,
        "-TestOperationFixture", fixture,
        "-TestEffectLog", loserEffects,
      ]);
      expect(loser.code).not.toBe(0);
      expect(loser.stderr).toMatch(/exclusive|workflow lock/i);
      expect(await pathExists(loserEffects)).toBe(false);
      const won = await winner;
      expect(won.code, won.stderr).toBe(0);
      expect(await pathExists(join(runtimeRoot, ".hermes-runtime-publication.ready.json"))).toBe(true);
    } finally {
      await rm(runtimeRoot, { recursive: true, force: true });
    }
  }, 120_000);

  it("rejects nonempty, hardlinked, and ADS-bearing workflow lock files before effects", async () => {
    const script = fileURLToPath(new URL("../scripts/fetch-runtime-artifacts.ps1", import.meta.url));
    for (const mutation of ["nonempty", "hardlink", "ads"]) {
      const runtimeRoot = await mkdtemp(join(tmpdir(), "jarvis-hermes-workflow-fixture-"));
      const fixture = join(runtimeRoot, "artifact-operations.json");
      const effects = join(runtimeRoot, "effects.log");
      const lockPath = join(runtimeRoot, ".hermes-runtime.workflow.lock");
      await writeFile(fixture, '{"schemaVersion":1,"workflow":"runtime-artifacts","scenario":"success"}\n', "utf8");
      try {
        if (mutation === "nonempty") await writeFile(lockPath, "forged", "utf8");
        if (mutation === "hardlink") {
          const origin = join(runtimeRoot, "lock-origin"); await writeFile(origin, "", "utf8"); await link(origin, lockPath);
        }
        if (mutation === "ads") { await writeFile(lockPath, "", "utf8"); await writeFile(`${lockPath}:hostile`, "hostile", "utf8"); }
        const before = await snapshotTree(runtimeRoot);
        const result = await runPowerShellFile(script, ["-RuntimeRoot", runtimeRoot, "-TestOperationFixture", fixture, "-TestEffectLog", effects]);
        expect(result.code, `${mutation} lock accepted`).not.toBe(0);
        expect(result.stderr, mutation).toMatch(/workflow lock|hardlink|alternate stream|identity|exactly empty/i);
        expect(await pathExists(effects)).toBe(false);
        expect(await snapshotTree(runtimeRoot)).toEqual(before);
      } finally {
        await rm(runtimeRoot, { recursive: true, force: true });
      }
    }
  }, 120_000);

  it("rejects hardlinked and ADS-bearing journal and ready state before recovery or verification effects", async () => {
    const script = fileURLToPath(new URL("../scripts/fetch-runtime-artifacts.ps1", import.meta.url));
    for (const [state, mutation] of [["journal", "hardlink"], ["journal", "ads"], ["ready", "hardlink"], ["ready", "ads"]]) {
      const runtimeRoot = await mkdtemp(join(tmpdir(), "jarvis-hermes-workflow-fixture-"));
      const fixture = join(runtimeRoot, "artifact-operations.json");
      const effects = join(runtimeRoot, "effects.log");
      await writeFile(fixture, '{"schemaVersion":1,"workflow":"runtime-artifacts","scenario":"success"}\n', "utf8");
      try {
        if (state === "journal") {
          const crashed = await runPowerShellFile(script, ["-RuntimeRoot", runtimeRoot, "-TestOperationFixture", fixture, "-TestCrashAfterPromotion", "1"]);
          expect(crashed.code).not.toBe(0);
        } else {
          const acquired = await runPowerShellFile(script, ["-RuntimeRoot", runtimeRoot, "-TestOperationFixture", fixture]);
          expect(acquired.code, acquired.stderr).toBe(0);
        }
        const statePath = join(runtimeRoot, state === "journal" ? ".hermes-runtime-publication.json" : ".hermes-runtime-publication.ready.json");
        if (mutation === "hardlink") await link(statePath, `${statePath}.hardlink`);
        else await writeFile(`${statePath}:hostile`, "hostile", "utf8");
        const before = await snapshotTree(runtimeRoot);
        const args = ["-RuntimeRoot", runtimeRoot, "-TestOperationFixture", fixture, "-TestEffectLog", effects];
        if (state === "ready") args.push("-VerifyOnly");
        const result = await runPowerShellFile(script, args);
        expect(result.code, `${state}-${mutation} accepted`).not.toBe(0);
        expect(result.stderr).toMatch(/hardlink|alternate stream|identity|journal|marker/i);
        expect(await pathExists(effects)).toBe(false);
        expect(await snapshotTree(runtimeRoot)).toEqual(before);
      } finally {
        await rm(runtimeRoot, { recursive: true, force: true });
      }
    }
  }, 120_000);

  it("fails closed without state mutation for torn, duplicate-key, forged, reordered, and overlapping journals", async () => {
    const script = fileURLToPath(new URL("../scripts/fetch-runtime-artifacts.ps1", import.meta.url));
    const mutations = [
      ["torn", () => "{\n"],
      ["duplicate-key", (record, raw) => `{"schemaVersion":2,${raw.slice(1)}`],
      ["extra-key", (record) => `${JSON.stringify({ ...record, extra: true })}\n`],
      ["case-key", (record) => { const { schemaVersion, ...rest } = record; return `${JSON.stringify({ SchemaVersion: schemaVersion, ...rest })}\n`; }],
      ["promotion-case-key", (record) => `${JSON.stringify({ ...record, promotions: record.promotions.map((item, index) => index === 0 ? { Staged: item.staged, final: item.final, digest: item.digest } : item) })}\n`],
      ["transaction", (record) => `${JSON.stringify({ ...record, transactionId: "f".repeat(32) })}\n`],
      ["common-stage", (record) => `${JSON.stringify({ ...record, commonStage: join(record.commonStage, "nested") })}\n`],
      ["reordered", (record) => `${JSON.stringify({ ...record, promotions: [...record.promotions].reverse() })}\n`],
      ["overlap", (record) => `${JSON.stringify({ ...record, promotions: record.promotions.map((item, index) => index === 0 ? { ...item, final: record.promotions[1].final } : item) })}\n`],
    ];
    for (const [label, mutate] of mutations) {
      const runtimeRoot = await mkdtemp(join(tmpdir(), "jarvis-hermes-workflow-fixture-"));
      const fixture = join(runtimeRoot, "artifact-operations.json");
      const effects = join(runtimeRoot, "retry-effects.log");
      const journalPath = join(runtimeRoot, ".hermes-runtime-publication.json");
      await writeFile(fixture, '{"schemaVersion":1,"workflow":"runtime-artifacts","scenario":"success"}\n', "utf8");
      try {
        const crashed = await runPowerShellFile(script, ["-RuntimeRoot", runtimeRoot, "-TestOperationFixture", fixture, "-TestCrashAfterPromotion", "1"]);
        expect(crashed.code, label).not.toBe(0);
        const raw = await readFile(journalPath, "utf8");
        const record = JSON.parse(raw);
        await writeFile(journalPath, mutate(record, raw), "utf8");
        const before = await snapshotTree(runtimeRoot);
        const retry = await runPowerShellFile(script, ["-RuntimeRoot", runtimeRoot, "-TestOperationFixture", fixture, "-TestEffectLog", effects]);
        expect(retry.code, `${label} was accepted`).not.toBe(0);
        expect(retry.stderr, label).toMatch(/journal|canonical|duplicate|forged|schema|bound|promotion/i);
        expect(await pathExists(effects), label).toBe(false);
        expect(await snapshotTree(runtimeRoot), label).toEqual(before);
      } finally {
        await rm(runtimeRoot, { recursive: true, force: true });
      }
    }
  }, 120_000);

  it("rejects forged and duplicate-key ready markers before VerifyOnly effects and preserves the full RuntimeRoot", async () => {
    const script = fileURLToPath(new URL("../scripts/fetch-runtime-artifacts.ps1", import.meta.url));
    for (const mutation of [
      (record) => `${JSON.stringify({ ...record, transactionId: "f".repeat(32) })}\n`,
      (record, raw) => `{"schemaVersion":2,${raw.slice(1)}`,
      (record) => { const { schemaVersion, ...rest } = record; return `${JSON.stringify({ SchemaVersion: schemaVersion, ...rest })}\n`; },
      (record) => `${JSON.stringify({ ...record, promotions: record.promotions.map((item, index) => index === 0 ? { Staged: item.staged, final: item.final, digest: item.digest } : item) })}\n`,
      (record) => `${JSON.stringify({ ...record, promotions: record.promotions.map((item, index) => index === 0 ? { ...item, digest: "0".repeat(64) } : item) })}\n`,
    ]) {
      const runtimeRoot = await mkdtemp(join(tmpdir(), "jarvis-hermes-workflow-fixture-"));
      const fixture = join(runtimeRoot, "artifact-operations.json");
      const effects = join(runtimeRoot, "verify-effects.log");
      const readyPath = join(runtimeRoot, ".hermes-runtime-publication.ready.json");
      await writeFile(fixture, '{"schemaVersion":1,"workflow":"runtime-artifacts","scenario":"success"}\n', "utf8");
      try {
        const acquired = await runPowerShellFile(script, ["-RuntimeRoot", runtimeRoot, "-TestOperationFixture", fixture]);
        expect(acquired.code, acquired.stderr).toBe(0);
        const raw = await readFile(readyPath, "utf8");
        const record = JSON.parse(raw);
        await writeFile(readyPath, mutation(record, raw), "utf8");
        const before = await snapshotTree(runtimeRoot);
        const verify = await runPowerShellFile(script, ["-RuntimeRoot", runtimeRoot, "-VerifyOnly", "-TestOperationFixture", fixture, "-TestEffectLog", effects]);
        expect(verify.code).not.toBe(0);
        expect(verify.stderr).toMatch(/marker|canonical|duplicate|forged|digest|schema|bound/i);
        expect(await pathExists(effects)).toBe(false);
        expect(await snapshotTree(runtimeRoot)).toEqual(before);
      } finally {
        await rm(runtimeRoot, { recursive: true, force: true });
      }
    }
  }, 120_000);

  it("keeps two marker-backed VerifyOnly passes bit-for-bit nonmutating across the full RuntimeRoot", async () => {
    const script = fileURLToPath(new URL("../scripts/fetch-runtime-artifacts.ps1", import.meta.url));
    const runtimeRoot = await mkdtemp(join(tmpdir(), "jarvis-hermes-workflow-fixture-"));
    const fixture = join(runtimeRoot, "artifact-operations.json");
    await writeFile(fixture, '{"schemaVersion":1,"workflow":"runtime-artifacts","scenario":"success"}\n', "utf8");
    try {
      const acquired = await runPowerShellFile(script, ["-RuntimeRoot", runtimeRoot, "-TestOperationFixture", fixture]);
      expect(acquired.code, acquired.stderr).toBe(0);
      const before = await snapshotTree(runtimeRoot);
      const scratchBefore = new Set((await readdir(tmpdir())).filter((name) => name.startsWith("jarvis-hermes-verify-")));
      for (let pass = 0; pass < 2; pass++) {
        const verify = await runPowerShellFile(script, ["-RuntimeRoot", runtimeRoot, "-VerifyOnly", "-TestOperationFixture", fixture]);
        expect(verify.code, verify.stderr).toBe(0);
      }
      expect(await snapshotTree(runtimeRoot)).toEqual(before);
      expect(new Set((await readdir(tmpdir())).filter((name) => name.startsWith("jarvis-hermes-verify-")))).toEqual(scratchBefore);
    } finally {
      await rm(runtimeRoot, { recursive: true, force: true });
    }
  }, 120_000);

  it("rolls back every injected promotion fault before a clean real-entrypoint rerun", async () => {
    const script = fileURLToPath(new URL("../scripts/fetch-runtime-artifacts.ps1", import.meta.url));
    const finals = [
      "toolchain/cpython-3.11.16",
      "toolchain/uv-0.12.7",
      "service-host/winsw-2.12.0",
      "licenses/python-build-standalone/20260825",
    ];
    for (const faultAfter of [1, 2, 3, 4]) {
      const runtimeRoot = await mkdtemp(join(tmpdir(), "jarvis-hermes-workflow-fixture-"));
      const fixture = join(runtimeRoot, "artifact-operations.json");
      const effects = join(runtimeRoot, "effects.log");
      await writeFile(fixture, '{"schemaVersion":1,"workflow":"runtime-artifacts","scenario":"success"}\n', "utf8");
      try {
        const faulted = await runPowerShellFile(script, [
          "-RuntimeRoot", runtimeRoot,
          "-TestOperationFixture", fixture,
          "-TestEffectLog", effects,
          "-TestFaultAfterPromotion", String(faultAfter),
        ]);
        expect(faulted.code, `promotion ${faultAfter} did not fault`).not.toBe(0);
        expect(await pathExists(join(runtimeRoot, ".hermes-runtime-publication.json"))).toBe(false);
        expect(await pathExists(join(runtimeRoot, ".hermes-runtime-publication.ready.json"))).toBe(false);
        for (const final of finals) expect(await pathExists(join(runtimeRoot, final))).toBe(false);
        expect((await readdir(runtimeRoot)).filter((name) => name.startsWith(".artifact-stage-"))).toEqual([]);

        const rerun = await runPowerShellFile(script, [
          "-RuntimeRoot", runtimeRoot,
          "-TestOperationFixture", fixture,
          "-TestEffectLog", effects,
        ]);
        expect(rerun.code, rerun.stderr).toBe(0);
        for (const final of finals) expect(await pathExists(join(runtimeRoot, final))).toBe(true);
      } finally {
        await rm(runtimeRoot, { recursive: true, force: true });
      }
    }
  }, 120_000);

  it("fails closed without moving or deleting a crash-bound tree whose recorded digest drifts", async () => {
    const script = fileURLToPath(new URL("../scripts/fetch-runtime-artifacts.ps1", import.meta.url));
    for (const drift of [
      { crashAfter: 1, promotion: 0, relative: ["python", "python.exe"] },
      { crashAfter: 1, promotion: 3, relative: ["python-licenses.rst"] },
      { crashAfter: 4, promotion: 0, relative: ["python", "python.exe"] },
    ]) {
      const runtimeRoot = await mkdtemp(join(tmpdir(), "jarvis-hermes-workflow-fixture-"));
      const fixture = join(runtimeRoot, "artifact-operations.json");
      const effects = join(runtimeRoot, "retry-effects.log");
      const journalPath = join(runtimeRoot, ".hermes-runtime-publication.json");
      await writeFile(fixture, '{"schemaVersion":1,"workflow":"runtime-artifacts","scenario":"success"}\n', "utf8");
      try {
        const crashed = await runPowerShellFile(script, ["-RuntimeRoot", runtimeRoot, "-TestOperationFixture", fixture, "-TestCrashAfterPromotion", String(drift.crashAfter)]);
        expect(crashed.code).not.toBe(0);
        const journal = JSON.parse(await readFile(journalPath, "utf8"));
        const promotion = journal.promotions[drift.promotion];
        const present = await pathExists(promotion.final) ? promotion.final : promotion.staged;
        await writeFile(join(present, ...drift.relative), "drifted-after-crash", "utf8");
        const journalBefore = await readFile(journalPath);
        const before = await snapshotTree(runtimeRoot);

        const retry = await runPowerShellFile(script, ["-RuntimeRoot", runtimeRoot, "-TestOperationFixture", fixture, "-TestEffectLog", effects]);
        expect(retry.code).not.toBe(0);
        expect(retry.stderr).toMatch(/digest|drift/i);
        expect(await pathExists(effects)).toBe(false);
        expect(await readFile(journalPath)).toEqual(journalBefore);
        expect(await snapshotTree(runtimeRoot)).toEqual(before);
      } finally {
        await rm(runtimeRoot, { recursive: true, force: true });
      }
    }
  }, 120_000);

  it("verifies the exact license rollup at staging, post-promotion, ready-rerun, and VerifyOnly boundaries", async () => {
    const script = fileURLToPath(new URL("../scripts/fetch-runtime-artifacts.ps1", import.meta.url));
    for (const scenario of ["license-stage-drift", "license-postmove-drift"]) {
      const runtimeRoot = await mkdtemp(join(tmpdir(), "jarvis-hermes-workflow-fixture-"));
      const fixture = join(runtimeRoot, "artifact-operations.json");
      const effects = join(runtimeRoot, "effects.log");
      await writeFile(fixture, `${JSON.stringify({ schemaVersion: 1, workflow: "runtime-artifacts", scenario })}\n`, "utf8");
      try {
        const result = await runPowerShellFile(script, ["-RuntimeRoot", runtimeRoot, "-TestOperationFixture", fixture, "-TestEffectLog", effects]);
        expect(result.code).not.toBe(0);
        expect(result.stderr).toMatch(/license|digest|drift/i);
        expect(await pathExists(join(runtimeRoot, ".hermes-runtime-publication.ready.json"))).toBe(false);
        if (scenario === "license-stage-drift") {
          expect(await pathExists(join(runtimeRoot, ".hermes-runtime-publication.json"))).toBe(false);
          expect(await readFile(effects, "utf8")).not.toContain("staged-full-tree-verified\n");
        } else {
          expect(await pathExists(join(runtimeRoot, ".hermes-runtime-publication.json"))).toBe(true);
          expect(await readFile(effects, "utf8")).toContain("all-moves-complete\n");
        }
      } finally {
        await rm(runtimeRoot, { recursive: true, force: true });
      }
    }

    for (const mode of ["ready-rerun", "verify-only"]) {
      const runtimeRoot = await mkdtemp(join(tmpdir(), "jarvis-hermes-workflow-fixture-"));
      const fixture = join(runtimeRoot, "artifact-operations.json");
      const effects = join(runtimeRoot, "effects.log");
      await writeFile(fixture, '{"schemaVersion":1,"workflow":"runtime-artifacts","scenario":"success"}\n', "utf8");
      try {
        const acquired = await runPowerShellFile(script, ["-RuntimeRoot", runtimeRoot, "-TestOperationFixture", fixture]);
        expect(acquired.code, acquired.stderr).toBe(0);
        const license = join(runtimeRoot, "licenses", "python-build-standalone", "20260825", "python-licenses.rst");
        await writeFile(license, "drifted-after-ready", "utf8");
        const args = ["-RuntimeRoot", runtimeRoot, "-TestOperationFixture", fixture, "-TestEffectLog", effects];
        if (mode === "verify-only") args.push("-VerifyOnly");
        const rejected = await runPowerShellFile(script, args);
        expect(rejected.code).not.toBe(0);
        expect(rejected.stderr).toMatch(/marker|license|digest|drift/i);
        expect(await pathExists(effects)).toBe(false);
        expect(await readFile(license, "utf8")).toBe("drifted-after-ready");
        expect(await pathExists(join(runtimeRoot, ".hermes-runtime-publication.ready.json"))).toBe(true);
      } finally {
        await rm(runtimeRoot, { recursive: true, force: true });
      }
    }
  }, 120_000);

  it("rolls back an injected postverify fault without publishing a ready marker", async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), "jarvis-hermes-workflow-fixture-"));
    const script = fileURLToPath(new URL("../scripts/fetch-runtime-artifacts.ps1", import.meta.url));
    const fixture = join(runtimeRoot, "artifact-operations.json");
    const effects = join(runtimeRoot, "effects.log");
    await writeFile(fixture, '{"schemaVersion":1,"workflow":"runtime-artifacts","scenario":"success"}\n', "utf8");
    try {
      const faulted = await runPowerShellFile(script, [
        "-RuntimeRoot", runtimeRoot,
        "-TestOperationFixture", fixture,
        "-TestEffectLog", effects,
        "-FailAfterEffect", "postverify-complete",
      ]);
      expect(faulted.code).not.toBe(0);
      expect((await readFile(effects, "utf8")).trimEnd().split("\n")).toEqual([
        "validated-before-root-effect", "filesystem-stage",
        "download-CPython", "download-uv", "download-WinSW", "download-license",
        "staged-full-tree-verified", "promotion-1", "promotion-2", "promotion-3", "promotion-4",
        "all-moves-complete", "postverify-complete",
      ]);
      expect(await pathExists(join(runtimeRoot, ".hermes-runtime-publication.json"))).toBe(false);
      expect(await pathExists(join(runtimeRoot, ".hermes-runtime-publication.ready.json"))).toBe(false);
      for (const final of ["toolchain/cpython-3.11.16", "toolchain/uv-0.12.7", "service-host/winsw-2.12.0", "licenses/python-build-standalone/20260825"]) expect(await pathExists(join(runtimeRoot, final))).toBe(false);
      expect((await readdir(runtimeRoot)).filter((name) => name.startsWith(".artifact-stage-"))).toEqual([]);
    } finally {
      await rm(runtimeRoot, { recursive: true, force: true });
    }
  }, 120_000);

  it("preserves recoverable publication evidence at postverify and marker crash boundaries", async () => {
    const script = fileURLToPath(new URL("../scripts/fetch-runtime-artifacts.ps1", import.meta.url));
    for (const boundary of ["postverify-complete", "marker-written", "marker-validated"]) {
      const runtimeRoot = await mkdtemp(join(tmpdir(), "jarvis-hermes-workflow-fixture-"));
      const fixture = join(runtimeRoot, "artifact-operations.json");
      const effects = join(runtimeRoot, "effects.log");
      await writeFile(fixture, '{"schemaVersion":1,"workflow":"runtime-artifacts","scenario":"success"}\n', "utf8");
      try {
        const crashed = await runPowerShellFile(script, [
          "-RuntimeRoot", runtimeRoot,
          "-TestOperationFixture", fixture,
          "-TestEffectLog", effects,
          "-TestCrashAfterEffect", boundary,
        ]);
        expect(crashed.code, `${boundary} did not crash`).not.toBe(0);
        const journalPath = join(runtimeRoot, ".hermes-runtime-publication.json");
        const readyPath = join(runtimeRoot, ".hermes-runtime-publication.ready.json");
        expect(await pathExists(journalPath), `${boundary} lost its journal`).toBe(true);
        expect(await pathExists(readyPath), `${boundary} ready state`).toBe(boundary !== "postverify-complete");
        const journal = JSON.parse(await readFile(journalPath, "utf8"));
        expect(journal.promotions).toHaveLength(4);
        for (const promotion of journal.promotions) {
          const staged = await pathExists(promotion.staged);
          const final = await pathExists(promotion.final);
          expect(Number(staged) + Number(final), `${boundary}: ${promotion.final}`).toBe(1);
        }

        const recovered = await runPowerShellFile(script, [
          "-RuntimeRoot", runtimeRoot,
          "-TestOperationFixture", fixture,
          "-TestEffectLog", effects,
        ]);
        expect(recovered.code, `${boundary}: ${recovered.stderr}`).toBe(0);
        expect(await pathExists(journalPath)).toBe(false);
        expect(await pathExists(readyPath)).toBe(true);
      } finally {
        await rm(runtimeRoot, { recursive: true, force: true });
      }
    }
  }, 120_000);

  it("keeps a fully committed publication after injected marker write and validation faults", async () => {
    const script = fileURLToPath(new URL("../scripts/fetch-runtime-artifacts.ps1", import.meta.url));
    for (const boundary of ["marker-written", "marker-validated"]) {
      const runtimeRoot = await mkdtemp(join(tmpdir(), "jarvis-hermes-workflow-fixture-"));
      const fixture = join(runtimeRoot, "artifact-operations.json");
      const effects = join(runtimeRoot, "effects.log");
      await writeFile(fixture, '{"schemaVersion":1,"workflow":"runtime-artifacts","scenario":"success"}\n', "utf8");
      try {
        const faulted = await runPowerShellFile(script, [
          "-RuntimeRoot", runtimeRoot,
          "-TestOperationFixture", fixture,
          "-TestEffectLog", effects,
          "-FailAfterEffect", boundary,
        ]);
        expect(faulted.code).not.toBe(0);
        expect(await pathExists(join(runtimeRoot, ".hermes-runtime-publication.json"))).toBe(false);
        expect(await pathExists(join(runtimeRoot, ".hermes-runtime-publication.ready.json"))).toBe(true);
        for (const final of ["toolchain/cpython-3.11.16", "toolchain/uv-0.12.7", "service-host/winsw-2.12.0", "licenses/python-build-standalone/20260825"]) expect(await pathExists(join(runtimeRoot, final))).toBe(true);
        const before = await Promise.all(["toolchain/cpython-3.11.16", "toolchain/uv-0.12.7", "service-host/winsw-2.12.0", "licenses/python-build-standalone/20260825"].map(async (target) => ({ target, tree: await snapshotTree(join(runtimeRoot, target)) })));
        const recovered = await runPowerShellFile(script, ["-RuntimeRoot", runtimeRoot, "-TestOperationFixture", fixture]);
        expect(recovered.code, recovered.stderr).toBe(0);
        const after = await Promise.all(before.map(async ({ target }) => ({ target, tree: await snapshotTree(join(runtimeRoot, target)) })));
        expect(after).toEqual(before);
      } finally {
        await rm(runtimeRoot, { recursive: true, force: true });
      }
    }
  }, 120_000);

  it("retains the journal and fails closed when the ready marker is torn", async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), "jarvis-hermes-workflow-fixture-"));
    const script = fileURLToPath(new URL("../scripts/fetch-runtime-artifacts.ps1", import.meta.url));
    const fixture = join(runtimeRoot, "artifact-operations.json");
    const effects = join(runtimeRoot, "effects.log");
    const journalPath = join(runtimeRoot, ".hermes-runtime-publication.json");
    const readyPath = join(runtimeRoot, ".hermes-runtime-publication.ready.json");
    await writeFile(fixture, '{"schemaVersion":1,"workflow":"runtime-artifacts","scenario":"torn-ready"}\n', "utf8");
    try {
      const torn = await runPowerShellFile(script, [
        "-RuntimeRoot", runtimeRoot,
        "-TestOperationFixture", fixture,
        "-TestEffectLog", effects,
      ]);
      expect(torn.code).not.toBe(0);
      expect(await pathExists(journalPath)).toBe(true);
      expect(await pathExists(readyPath)).toBe(true);
      await expect(readFile(readyPath, "utf8").then((value) => JSON.parse(value))).rejects.toThrow();
      const journalBefore = await readFile(journalPath);
      const effectsBefore = await readFile(effects);

      const retry = await runPowerShellFile(script, [
        "-RuntimeRoot", runtimeRoot,
        "-TestOperationFixture", fixture,
        "-TestEffectLog", effects,
      ]);
      expect(retry.code).not.toBe(0);
      expect(await readFile(journalPath)).toEqual(journalBefore);
      expect(await readFile(effects)).toEqual(effectsBefore);
      expect(await pathExists(readyPath)).toBe(true);
    } finally {
      await rm(runtimeRoot, { recursive: true, force: true });
    }
  }, 120_000);

  it("runs marker-backed VerifyOnly in exact order without changing installed paths, bytes, hashes, or mtimes", async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), "jarvis-hermes-workflow-fixture-"));
    const script = fileURLToPath(new URL("../scripts/fetch-runtime-artifacts.ps1", import.meta.url));
    const fixture = join(runtimeRoot, "artifact-operations.json");
    const acquireEffects = join(runtimeRoot, "acquire-effects.log");
    const verifyEffects = join(runtimeRoot, "verify-effects.log");
    await writeFile(fixture, '{"schemaVersion":1,"workflow":"runtime-artifacts","scenario":"success"}\n', "utf8");
    try {
      const acquired = await runPowerShellFile(script, ["-RuntimeRoot", runtimeRoot, "-TestOperationFixture", fixture, "-TestEffectLog", acquireEffects]);
      expect(acquired.code, acquired.stderr).toBe(0);
      const targets = [
        "toolchain/cpython-3.11.16",
        "toolchain/uv-0.12.7",
        "service-host/winsw-2.12.0",
        "licenses/python-build-standalone/20260825",
      ];
      const before = [];
      for (const target of targets) before.push(...(await snapshotTree(join(runtimeRoot, target))).map((entry) => ({ target, ...entry })));

      const first = await runPowerShellFile(script, ["-RuntimeRoot", runtimeRoot, "-VerifyOnly", "-TestOperationFixture", fixture, "-TestEffectLog", verifyEffects]);
      const second = await runPowerShellFile(script, ["-RuntimeRoot", runtimeRoot, "-VerifyOnly", "-TestOperationFixture", fixture, "-TestEffectLog", verifyEffects]);
      expect(first.code, first.stderr).toBe(0);
      expect(second.code, second.stderr).toBe(0);
      const after = [];
      for (const target of targets) after.push(...(await snapshotTree(join(runtimeRoot, target))).map((entry) => ({ target, ...entry })));
      expect(after).toEqual(before);
      expect(await readFile(verifyEffects, "utf8")).toBe("verify-only-ready\nverify-only-complete\nverify-only-ready\nverify-only-complete\n");
    } finally {
      await rm(runtimeRoot, { recursive: true, force: true });
    }
  }, 120_000);

  it("runs the real source entrypoint through a closed Git fixture and preserves the detached tree during VerifyOnly", async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), "jarvis-hermes-workflow-fixture-"));
    const script = fileURLToPath(new URL("../scripts/fetch-hermes.ps1", import.meta.url));
    const fixture = join(runtimeRoot, "source-operations.json");
    const acquireEffects = join(runtimeRoot, "source-acquire-effects.log");
    const verifyEffects = join(runtimeRoot, "source-verify-effects.log");
    await writeFile(fixture, '{"schemaVersion":1,"workflow":"source","scenario":"success"}\n', "utf8");
    try {
      const acquired = await runPowerShellFile(script, ["-RuntimeRoot", runtimeRoot, "-TestOperationFixture", fixture, "-TestEffectLog", acquireEffects]);
      expect(acquired.code, acquired.stderr).toBe(0);
      expect(await readFile(acquireEffects, "utf8")).toBe([
        "validated-before-root-effect", "git-init", "git-configure", "git-add-remote", "git-fetch",
        "git-tree-list", "git-checkout", "git-verify", "staged-full-tree-verified", "move-complete", "postverify-complete", "",
      ].join("\n"));
      const release = join(runtimeRoot, "releases", "5fc308a70719a83cccdbba4c0e39c23f5a8239d5");
      const source = join(release, "source");
      const git = join(release, "git");
      expect(await pathExists(source)).toBe(true);
      expect(await pathExists(git)).toBe(true);
      const before = await snapshotTree(release);

      const first = await runPowerShellFile(script, ["-RuntimeRoot", runtimeRoot, "-VerifyOnly", "-TestOperationFixture", fixture, "-TestEffectLog", verifyEffects]);
      const second = await runPowerShellFile(script, ["-RuntimeRoot", runtimeRoot, "-VerifyOnly", "-TestOperationFixture", fixture, "-TestEffectLog", verifyEffects]);
      expect(first.code, first.stderr).toBe(0);
      expect(second.code, second.stderr).toBe(0);
      expect(await snapshotTree(release)).toEqual(before);
      expect(await readFile(verifyEffects, "utf8")).toBe("verify-only-start\nverify-only-complete\nverify-only-start\nverify-only-complete\n");
    } finally {
      await rm(runtimeRoot, { recursive: true, force: true });
    }
  }, 120_000);

  it("runs every real Git probe with a closed child environment despite hostile inherited Git controls", async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), "jarvis-hermes-workflow-fixture-"));
    const script = fileURLToPath(new URL("../scripts/fetch-hermes.ps1", import.meta.url));
    const fixture = join(runtimeRoot, "source-operations.json");
    const hostile = join(runtimeRoot, "hostile");
    await writeFile(fixture, '{"schemaVersion":1,"workflow":"source","scenario":"git-hostile-environment"}\n', "utf8");
    await mkdir(hostile, { recursive: true });
    const hostileConfig = join(hostile, "gitconfig");
    await writeFile(hostileConfig, "[core]\n\thooksPath = C:/hostile-hooks\n", "utf8");
    const env = {
      ...process.env,
      GIT_EXEC_PATH: join(hostile, "exec"),
      GIT_OBJECT_DIRECTORY: join(hostile, "objects"),
      GIT_ALTERNATE_OBJECT_DIRECTORIES: join(hostile, "alternates"),
      GIT_INDEX_FILE: join(hostile, "index"),
      GIT_DIR: join(hostile, "gitdir"),
      GIT_WORK_TREE: join(hostile, "worktree"),
      GIT_COMMON_DIR: join(hostile, "common"),
      GIT_TEMPLATE_DIR: join(hostile, "templates"),
      GIT_CONFIG_GLOBAL: hostileConfig,
      GIT_CONFIG_SYSTEM: hostileConfig,
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.hooksPath",
      GIT_CONFIG_VALUE_0: "C:/hostile-hooks",
      GIT_CONFIG_PARAMETERS: "'core.hooksPath'='C:/hostile-hooks'",
      GIT_ASKPASS: join(hostile, "askpass.exe"),
      SSH_ASKPASS: join(hostile, "ssh-askpass.exe"),
    };
    try {
      const result = await runPowerShellFile(script, ["-RuntimeRoot", runtimeRoot, "-TestOperationFixture", fixture], 120_000, env);
      expect(result.code, result.stderr).toBe(0);
      expect(await pathExists(join(runtimeRoot, "releases", "5fc308a70719a83cccdbba4c0e39c23f5a8239d5", "source"))).toBe(true);
      expect(await pathExists(join(hostile, "objects"))).toBe(false);
      expect(await pathExists(join(hostile, "index"))).toBe(false);
    } finally {
      await rm(runtimeRoot, { recursive: true, force: true });
    }
  }, 120_000);

  it("uses one RuntimeRoot lock across source and artifact entrypoints", async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), "jarvis-hermes-workflow-fixture-"));
    const artifactScript = fileURLToPath(new URL("../scripts/fetch-runtime-artifacts.ps1", import.meta.url));
    const sourceScript = fileURLToPath(new URL("../scripts/fetch-hermes.ps1", import.meta.url));
    const artifactFixture = join(runtimeRoot, "artifact-operations.json");
    const sourceFixture = join(runtimeRoot, "source-operations.json");
    const sourceEffects = join(runtimeRoot, "source-effects.log");
    await writeFile(artifactFixture, '{"schemaVersion":1,"workflow":"runtime-artifacts","scenario":"success"}\n', "utf8");
    await writeFile(sourceFixture, '{"schemaVersion":1,"workflow":"source","scenario":"success"}\n', "utf8");
    try {
      const artifact = runPowerShellFile(artifactScript, ["-RuntimeRoot", runtimeRoot, "-TestOperationFixture", artifactFixture, "-TestHoldLockMilliseconds", "1500"]);
      for (let index = 0; index < 40 && !await pathExists(join(runtimeRoot, ".hermes-runtime.workflow.lock")); index++) await new Promise((resolve) => setTimeout(resolve, 25));
      await new Promise((resolve) => setTimeout(resolve, 150));
      const source = await runPowerShellFile(sourceScript, ["-RuntimeRoot", runtimeRoot, "-TestOperationFixture", sourceFixture, "-TestEffectLog", sourceEffects]);
      expect(source.code).not.toBe(0);
      expect(source.stderr).toMatch(/exclusive|workflow lock/i);
      expect(await pathExists(sourceEffects)).toBe(false);
      expect(await pathExists(join(runtimeRoot, "releases"))).toBe(false);
      const acquired = await artifact;
      expect(acquired.code, acquired.stderr).toBe(0);
    } finally {
      await rm(runtimeRoot, { recursive: true, force: true });
    }
  }, 120_000);

  it("rolls back a fault after the source move and removes every source stage", async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), "jarvis-hermes-workflow-fixture-"));
    const script = fileURLToPath(new URL("../scripts/fetch-hermes.ps1", import.meta.url));
    const fixture = join(runtimeRoot, "source-operations.json");
    await writeFile(fixture, '{"schemaVersion":1,"workflow":"source","scenario":"success"}\n', "utf8");
    try {
      const result = await runPowerShellFile(script, ["-RuntimeRoot", runtimeRoot, "-TestOperationFixture", fixture, "-FailAfterEffect", "move-complete"]);
      expect(result.code).not.toBe(0);
      expect(await pathExists(join(runtimeRoot, "releases"))).toBe(true);
      expect(await readdir(join(runtimeRoot, "releases"))).toEqual([]);
      expect(await pathExists(join(runtimeRoot, ".s"))).toBe(false);
      const rerun = await runPowerShellFile(script, ["-RuntimeRoot", runtimeRoot, "-TestOperationFixture", fixture]);
      expect(rerun.code, rerun.stderr).toBe(0);
    } finally {
      await rm(runtimeRoot, { recursive: true, force: true });
    }
  }, 120_000);

  it("rejects unbound source staging before effects and keeps two source VerifyOnly passes fully nonmutating", async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), "jarvis-hermes-workflow-fixture-"));
    const script = fileURLToPath(new URL("../scripts/fetch-hermes.ps1", import.meta.url));
    const fixture = join(runtimeRoot, "source-operations.json");
    const effects = join(runtimeRoot, "effects.log");
    await writeFile(fixture, '{"schemaVersion":1,"workflow":"source","scenario":"success"}\n', "utf8");
    await mkdir(join(runtimeRoot, ".s", "unbound"), { recursive: true });
    await writeFile(join(runtimeRoot, ".s", "unbound", "payload"), "hostile", "utf8");
    try {
      const rejected = await runPowerShellFile(script, ["-RuntimeRoot", runtimeRoot, "-TestOperationFixture", fixture, "-TestEffectLog", effects]);
      expect(rejected.code).not.toBe(0);
      expect(rejected.stderr).toMatch(/unbound|residue/i);
      expect(await pathExists(effects)).toBe(false);
      await rm(join(runtimeRoot, ".s"), { recursive: true, force: true });
      const acquired = await runPowerShellFile(script, ["-RuntimeRoot", runtimeRoot, "-TestOperationFixture", fixture]);
      expect(acquired.code, acquired.stderr).toBe(0);
      const before = await snapshotTree(runtimeRoot);
      for (let pass = 0; pass < 2; pass++) {
        const verified = await runPowerShellFile(script, ["-RuntimeRoot", runtimeRoot, "-VerifyOnly", "-TestOperationFixture", fixture]);
        expect(verified.code, verified.stderr).toBe(0);
      }
      expect(await snapshotTree(runtimeRoot)).toEqual(before);
    } finally {
      await rm(runtimeRoot, { recursive: true, force: true });
    }
  }, 120_000);

  it("rejects case-aliased NTFS workflow residue before either real entrypoint emits an effect", async () => {
    for (const [workflow, residue, child] of [
      ["runtime-artifacts", ".ARTIFACT-STAGE-unbound", "payload"],
      ["runtime-artifacts", ".VERIFY-unbound", "payload"],
      ["source", ".S", "unbound/payload"],
    ]) {
      const runtimeRoot = await mkdtemp(join(tmpdir(), "jarvis-hermes-workflow-fixture-"));
      const fixture = join(runtimeRoot, `${workflow}-operations.json`);
      const effects = join(runtimeRoot, "effects.log");
      const script = fileURLToPath(new URL(workflow === "source" ? "../scripts/fetch-hermes.ps1" : "../scripts/fetch-runtime-artifacts.ps1", import.meta.url));
      await writeFile(fixture, `${JSON.stringify({ schemaVersion: 1, workflow, scenario: "success" })}\n`, "utf8");
      await mkdir(join(runtimeRoot, residue, ...child.split("/").slice(0, -1)), { recursive: true });
      await writeFile(join(runtimeRoot, residue, ...child.split("/")), "hostile", "utf8");
      try {
        const rejected = await runPowerShellFile(script, ["-RuntimeRoot", runtimeRoot, "-TestOperationFixture", fixture, "-TestEffectLog", effects]);
        expect(rejected.code, `${workflow}:${residue} was accepted`).not.toBe(0);
        expect(rejected.stderr).toMatch(/unbound|residue/i);
        expect(await pathExists(effects)).toBe(false);
        expect(await pathExists(join(runtimeRoot, residue, ...child.split("/")))).toBe(true);
      } finally {
        await rm(runtimeRoot, { recursive: true, force: true });
      }
    }
  }, 120_000);

  it("rejects injected source and artifact manifest drift before the first workflow effect", async () => {
    for (const workflow of ["source", "runtime-artifacts"]) {
      const runtimeRoot = await mkdtemp(join(tmpdir(), "jarvis-hermes-workflow-fixture-"));
      const fixture = join(runtimeRoot, `${workflow}-operations.json`);
      const effects = join(runtimeRoot, "effects.log");
      const script = fileURLToPath(new URL(workflow === "source" ? "../scripts/fetch-hermes.ps1" : "../scripts/fetch-runtime-artifacts.ps1", import.meta.url));
      await writeFile(fixture, `${JSON.stringify({ schemaVersion: 1, workflow, scenario: "manifest-drift" })}\n`, "utf8");
      try {
        const result = await runPowerShellFile(script, ["-RuntimeRoot", runtimeRoot, "-TestOperationFixture", fixture, "-TestEffectLog", effects]);
        expect(result.code).not.toBe(0);
        expect(result.stderr).toMatch(/canonical/i);
        expect(await pathExists(effects)).toBe(false);
        expect(await pathExists(join(runtimeRoot, "releases"))).toBe(false);
        expect(await pathExists(join(runtimeRoot, "toolchain"))).toBe(false);
        expect(await pathExists(join(runtimeRoot, ".hermes-runtime-publication.json"))).toBe(false);
        expect(await pathExists(join(runtimeRoot, ".hermes-runtime-publication.ready.json"))).toBe(false);
      } finally {
        await rm(runtimeRoot, { recursive: true, force: true });
      }
    }
  }, 120_000);

  it("keeps synthetic operation hooks closed to exact ephemeral fixture roots and schemas", async () => {
    const artifactScript = fileURLToPath(new URL("../scripts/fetch-runtime-artifacts.ps1", import.meta.url));
    const sourceScript = fileURLToPath(new URL("../scripts/fetch-hermes.ps1", import.meta.url));
    const runtimeRoot = await mkdtemp(join(tmpdir(), "jarvis-hermes-not-a-workflow-fixture-"));
    const artifactFixture = join(runtimeRoot, "artifact-operations.json");
    const sourceFixture = join(runtimeRoot, "source-operations.json");
    const effects = join(runtimeRoot, "effects.log");
    await writeFile(artifactFixture, '{"schemaVersion":1,"workflow":"runtime-artifacts","scenario":"success"}\n', "utf8");
    await writeFile(sourceFixture, '{"schemaVersion":1,"workflow":"source","scenario":"success","extra":true}\n', "utf8");
    try {
      const wrongRoot = await runPowerShellFile(artifactScript, ["-RuntimeRoot", runtimeRoot, "-TestOperationFixture", artifactFixture, "-TestEffectLog", effects]);
      expect(wrongRoot.code).not.toBe(0);
      expect(wrongRoot.stderr).toMatch(/fixture root/i);
      expect(await pathExists(effects)).toBe(false);
      expect(await pathExists(join(runtimeRoot, "toolchain"))).toBe(false);

      const extraField = await runPowerShellFile(sourceScript, ["-RuntimeRoot", runtimeRoot, "-TestOperationFixture", sourceFixture, "-TestEffectLog", effects]);
      expect(extraField.code).not.toBe(0);
      expect(extraField.stderr).toMatch(/closed source fixture/i);

      const ungated = await runPowerShellFile(artifactScript, ["-RuntimeRoot", runtimeRoot, "-TestEffectLog", effects]);
      expect(ungated.code).not.toBe(0);
      expect(ungated.stderr).toMatch(/require a closed operation fixture/i);
      expect(await pathExists(effects)).toBe(false);
    } finally {
      await rm(runtimeRoot, { recursive: true, force: true });
    }
  }, 120_000);

  it("rejects hostile injected Git and checkout outcomes in the real source workflow before promotion", async () => {
    const script = fileURLToPath(new URL("../scripts/fetch-hermes.ps1", import.meta.url));
    const throughCheckout = ["validated-before-root-effect", "git-init", "git-configure", "git-add-remote", "git-fetch", "git-tree-list", "git-checkout"];
    const cases = [
      ["git-remote-drift", /remote/i, [...throughCheckout, "git-verify"]],
      ["git-tag-drift", /tag object/i, [...throughCheckout, "git-verify"]],
      ["git-peeled-drift", /retargeted/i, [...throughCheckout, "git-verify"]],
      ["git-tree-drift", /tree mismatch/i, [...throughCheckout, "git-verify"]],
      ["git-unsafe-member", /forbidden member/i, [...throughCheckout, "git-verify"]],
      ["source-hash-drift", /synthetic content mismatch/i, throughCheckout],
      ["git-dirty", /dirty or untracked/i, [...throughCheckout, "git-verify"]],
    ];
    for (const [scenario, error, expectedEffects] of cases) {
      const runtimeRoot = await mkdtemp(join(tmpdir(), "jarvis-hermes-workflow-fixture-"));
      const fixture = join(runtimeRoot, "source-operations.json");
      const effects = join(runtimeRoot, "effects.log");
      await writeFile(fixture, `${JSON.stringify({ schemaVersion: 1, workflow: "source", scenario })}\n`, "utf8");
      try {
        const result = await runPowerShellFile(script, ["-RuntimeRoot", runtimeRoot, "-TestOperationFixture", fixture, "-TestEffectLog", effects]);
        expect(result.code, `${scenario} passed`).not.toBe(0);
        expect(result.stderr, scenario).toMatch(error);
        expect((await readFile(effects, "utf8")).trimEnd().split("\n")).toEqual(expectedEffects);
        expect(await pathExists(join(runtimeRoot, "releases"))).toBe(false);
        expect(await pathExists(join(runtimeRoot, ".hermes-runtime-publication.json"))).toBe(false);
        expect(await pathExists(join(runtimeRoot, ".hermes-runtime-publication.ready.json"))).toBe(false);
        const staging = join(runtimeRoot, ".s");
        if (await pathExists(staging)) expect(await readdir(staging)).toEqual([]);
      } finally {
        await rm(runtimeRoot, { recursive: true, force: true });
      }
    }
  }, 120_000);

  it("rejects injected HTTP, body, archive-list, extraction, and filesystem failures before artifact promotion", async () => {
    const script = fileURLToPath(new URL("../scripts/fetch-runtime-artifacts.ps1", import.meta.url));
    const cases = [
      ["http-off-host", /approved HTTPS host/i, "validated-before-root-effect\nfilesystem-stage\ndownload-CPython\n"],
      ["http-content-length-drift", /content length drift/i, "validated-before-root-effect\nfilesystem-stage\ndownload-CPython\n"],
      ["body-hash-drift", /body hash mismatch/i, "validated-before-root-effect\nfilesystem-stage\ndownload-CPython\n"],
      ["archive-case-collision", /case-colliding/i, "validated-before-root-effect\nfilesystem-stage\ndownload-CPython\ndownload-uv\ndownload-WinSW\ndownload-license\n"],
      ["archive-ancestor-forward", /ancestor/i, "validated-before-root-effect\nfilesystem-stage\ndownload-CPython\ndownload-uv\ndownload-WinSW\ndownload-license\n"],
      ["archive-ancestor-reverse", /ancestor/i, "validated-before-root-effect\nfilesystem-stage\ndownload-CPython\ndownload-uv\ndownload-WinSW\ndownload-license\n"],
      ["archive-separator-collision", /separator/i, "validated-before-root-effect\nfilesystem-stage\ndownload-CPython\ndownload-uv\ndownload-WinSW\ndownload-license\n"],
      ["archive-extract-reparse", /reparse point/i, "validated-before-root-effect\nfilesystem-stage\ndownload-CPython\ndownload-uv\ndownload-WinSW\ndownload-license\n"],
      ["filesystem-stage-fault", /filesystem fault/i, "validated-before-root-effect\nfilesystem-stage\n"],
    ];
    for (const [scenario, error, expectedEffects] of cases) {
      const runtimeRoot = await mkdtemp(join(tmpdir(), "jarvis-hermes-workflow-fixture-"));
      const fixture = join(runtimeRoot, "artifact-operations.json");
      const effects = join(runtimeRoot, "effects.log");
      await writeFile(fixture, `${JSON.stringify({ schemaVersion: 1, workflow: "runtime-artifacts", scenario })}\n`, "utf8");
      try {
        const result = await runPowerShellFile(script, ["-RuntimeRoot", runtimeRoot, "-TestOperationFixture", fixture, "-TestEffectLog", effects]);
        expect(result.code, `${scenario} passed`).not.toBe(0);
        expect(result.stderr, scenario).toMatch(error);
        expect(await readFile(effects, "utf8"), scenario).toBe(expectedEffects);
        for (const final of [
          "toolchain/cpython-3.11.16",
          "toolchain/uv-0.12.7",
          "service-host/winsw-2.12.0",
          "licenses/python-build-standalone/20260825",
        ]) expect(await pathExists(join(runtimeRoot, final)), `${scenario}: ${final}`).toBe(false);
        expect(await pathExists(join(runtimeRoot, ".hermes-runtime-publication.json"))).toBe(false);
        expect(await pathExists(join(runtimeRoot, ".hermes-runtime-publication.ready.json"))).toBe(false);
        expect((await readdir(runtimeRoot)).filter((name) => name.startsWith(".artifact-stage-"))).toEqual([]);
      } finally {
        await rm(runtimeRoot, { recursive: true, force: true });
      }
    }
  }, 120_000);

  it("rejects real NTFS hardlinks and alternate streams in both staged workflows before promotion", async () => {
    const cases = [
      ["runtime-artifacts", "stage-hardlink", /hardlink|identity/i],
      ["runtime-artifacts", "stage-ads", /alternate stream|identity/i],
      ["source", "source-stage-hardlink", /hardlink|identity/i],
      ["source", "source-stage-ads", /alternate stream|identity/i],
    ];
    for (const [workflow, scenario, error] of cases) {
      const runtimeRoot = await mkdtemp(join(tmpdir(), "jarvis-hermes-workflow-fixture-"));
      const fixture = join(runtimeRoot, `${workflow}-operations.json`);
      const script = fileURLToPath(new URL(workflow === "source" ? "../scripts/fetch-hermes.ps1" : "../scripts/fetch-runtime-artifacts.ps1", import.meta.url));
      await writeFile(fixture, `${JSON.stringify({ schemaVersion: 1, workflow, scenario })}\n`, "utf8");
      try {
        const result = await runPowerShellFile(script, ["-RuntimeRoot", runtimeRoot, "-TestOperationFixture", fixture]);
        expect(result.code, `${scenario} passed`).not.toBe(0);
        expect(result.stderr, scenario).toMatch(error);
        expect(await pathExists(join(runtimeRoot, "releases", "5fc308a70719a83cccdbba4c0e39c23f5a8239d5"))).toBe(false);
        expect(await pathExists(join(runtimeRoot, ".hermes-runtime-publication.json"))).toBe(false);
        expect(await pathExists(join(runtimeRoot, ".hermes-runtime-publication.ready.json"))).toBe(false);
        expect((await readdir(runtimeRoot)).filter((name) => name.startsWith(".artifact-stage-") || name === ".s")).toEqual([]);
      } finally {
        await rm(runtimeRoot, { recursive: true, force: true });
      }
    }
  }, 120_000);

  it("rejects post-publication NTFS hardlinks, ADS, and byte-identical identity replacement before VerifyOnly effects", async () => {
    const script = fileURLToPath(new URL("../scripts/fetch-runtime-artifacts.ps1", import.meta.url));
    for (const mutation of ["hardlink", "ads", "replace"]) {
      const runtimeRoot = await mkdtemp(join(tmpdir(), "jarvis-hermes-workflow-fixture-"));
      const fixture = join(runtimeRoot, "artifact-operations.json");
      const effects = join(runtimeRoot, "effects.log");
      await writeFile(fixture, '{"schemaVersion":1,"workflow":"runtime-artifacts","scenario":"success"}\n', "utf8");
      try {
        const acquired = await runPowerShellFile(script, ["-RuntimeRoot", runtimeRoot, "-TestOperationFixture", fixture]);
        expect(acquired.code, acquired.stderr).toBe(0);
        const python = join(runtimeRoot, "toolchain", "cpython-3.11.16", "python", "python.exe");
        if (mutation === "hardlink") await link(python, join(runtimeRoot, "toolchain", "cpython-3.11.16", "python", "python-hardlink.exe"));
        if (mutation === "ads") await writeFile(`${python}:hostile`, "hostile", "utf8");
        if (mutation === "replace") {
          const replacement = `${python}.replacement`;
          await copyFile(python, replacement); await unlink(python); await rename(replacement, python);
        }
        const before = await snapshotTree(runtimeRoot);
        const verified = await runPowerShellFile(script, ["-RuntimeRoot", runtimeRoot, "-VerifyOnly", "-TestOperationFixture", fixture, "-TestEffectLog", effects]);
        expect(verified.code, `${mutation} passed`).not.toBe(0);
        expect(verified.stderr, mutation).toMatch(/hardlink|alternate stream|identity|digest|drift/i);
        expect(await pathExists(effects)).toBe(false);
        expect(await snapshotTree(runtimeRoot)).toEqual(before);
      } finally {
        await rm(runtimeRoot, { recursive: true, force: true });
      }
    }
  }, 120_000);

  it("fails closed on an injected external VerifyOnly scratch cleanup error and leaves no scratch residue", async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), "jarvis-hermes-workflow-fixture-"));
    const script = fileURLToPath(new URL("../scripts/fetch-runtime-artifacts.ps1", import.meta.url));
    const fixture = join(runtimeRoot, "artifact-operations.json");
    await writeFile(fixture, '{"schemaVersion":1,"workflow":"runtime-artifacts","scenario":"success"}\n', "utf8");
    try {
      const acquired = await runPowerShellFile(script, ["-RuntimeRoot", runtimeRoot, "-TestOperationFixture", fixture]);
      expect(acquired.code, acquired.stderr).toBe(0);
      await writeFile(fixture, '{"schemaVersion":1,"workflow":"runtime-artifacts","scenario":"verify-cleanup-fault"}\n', "utf8");
      const scratchBefore = new Set((await readdir(tmpdir())).filter((name) => name.startsWith("jarvis-hermes-verify-")));
      const verified = await runPowerShellFile(script, ["-RuntimeRoot", runtimeRoot, "-VerifyOnly", "-TestOperationFixture", fixture]);
      expect(verified.code).not.toBe(0);
      expect(verified.stderr).toMatch(/scratch cleanup failed closed/i);
      expect(new Set((await readdir(tmpdir())).filter((name) => name.startsWith("jarvis-hermes-verify-")))).toEqual(scratchBefore);
      expect((await readdir(runtimeRoot)).filter((name) => name.startsWith(".verify-"))).toEqual([]);
    } finally {
      await rm(runtimeRoot, { recursive: true, force: true });
    }
  }, 120_000);

  it("rejects relative, drive-relative, device, alias, and forward-slash RuntimeRoot forms", async () => {
    const script = fileURLToPath(new URL("../scripts/fetch-hermes.ps1", import.meta.url));
    for (const candidate of [".", "relative", "C:relative", "\\\\?\\C:\\Windows\\Temp\\hermes", "\\\\.\\C:\\Windows\\Temp\\hermes", "C:\\Windows\\Temp\\..\\hermes", "C:/Windows/Temp/hermes"]) {
      const result = await runPowerShellFile(script, ["-RuntimeRoot", candidate, "-VerifyOnly"]);
      expect(result.code, `${candidate} accepted`).not.toBe(0);
      expect(result.stderr, candidate).toMatch(/RuntimeRoot|drive-absolute|canonical|device|local path/i);
    }
  }, 120_000);

  it("rejects RuntimeRoot and target-ancestor junctions through the real artifact entrypoint before effects", async () => {
    const script = fileURLToPath(new URL("../scripts/fetch-runtime-artifacts.ps1", import.meta.url));
    const targetRoot = await mkdtemp(join(tmpdir(), "jarvis-hermes-workflow-fixture-"));
    const junctionRoot = join(tmpdir(), `jarvis-hermes-workflow-fixture-${Date.now()}-junction`);
    const fixture = join(targetRoot, "artifact-operations.json");
    await writeFile(fixture, '{"schemaVersion":1,"workflow":"runtime-artifacts","scenario":"success"}\n', "utf8");
    try {
      await symlink(targetRoot, junctionRoot, "junction");
      const rootEffects = join(targetRoot, "root-effects.log");
      const rootResult = await runPowerShellFile(script, ["-RuntimeRoot", junctionRoot, "-TestOperationFixture", join(junctionRoot, "artifact-operations.json"), "-TestEffectLog", join(junctionRoot, "root-effects.log")]);
      expect(rootResult.code).not.toBe(0);
      expect(rootResult.stderr).toMatch(/reparse|junction|RuntimeRoot/i);
      expect(await pathExists(rootEffects)).toBe(false);
      await rm(junctionRoot, { recursive: true, force: true });

      const safe = join(targetRoot, "safe-target"); await mkdir(safe);
      await symlink(safe, join(targetRoot, "toolchain"), "junction");
      const ancestorEffects = join(targetRoot, "ancestor-effects.log");
      const ancestorResult = await runPowerShellFile(script, ["-RuntimeRoot", targetRoot, "-TestOperationFixture", fixture, "-TestEffectLog", ancestorEffects]);
      expect(ancestorResult.code).not.toBe(0);
      expect(ancestorResult.stderr).toMatch(/reparse|junction|traverses/i);
      expect(await pathExists(ancestorEffects)).toBe(false);
    } finally {
      await rm(junctionRoot, { recursive: true, force: true });
      await rm(targetRoot, { recursive: true, force: true });
    }
  }, 120_000);

  it("promotes only complete staging directories and never replaces or creates a partial final target", async () => {
    const temp = await mkdtemp(join(tmpdir(), "jarvis-hermes-promotion-"));
    const module = fileURLToPath(new URL("../scripts/HermesRuntime.psm1", import.meta.url));
    const escapedRoot = temp.replace(/'/g, "''");
    const escapedModule = module.replace(/'/g, "''");
    try {
      const result = await new Promise((resolve, reject) => {
        const program = [
          `$root = '${escapedRoot}'`,
          `Import-Module '${escapedModule}' -Force`,
          "$stage = Join-Path $root '.s\\complete'",
          "New-Item -ItemType Directory -Path $stage -Force | Out-Null",
          "Set-Content -LiteralPath (Join-Path $stage 'payload.txt') -Value 'verified' -NoNewline",
          "$final = Join-Path $root 'releases\\complete'",
          "Promote-StagedDirectory $root $stage $final",
          "if (-not (Test-Path -LiteralPath (Join-Path $final 'payload.txt'))) { throw 'promotion_missing_payload' }",
          "$badStage = Join-Path $root '.s\\bad'",
          "New-Item -ItemType Directory -Path $badStage -Force | Out-Null",
          "Set-Content -LiteralPath (Join-Path $badStage 'payload.txt') -Value 'unverified' -NoNewline",
          "$blocked = Join-Path $root 'releases\\blocked'",
          "try { Assert-ExactHash (Join-Path $badStage 'payload.txt') ('0' * 64) 'fixture'; throw 'unexpected_validation_pass' } catch { }",
          "if (Test-Path -LiteralPath $blocked) { throw 'partial_final_after_validation_failure' }",
          "New-Item -ItemType Directory -Path $blocked -Force | Out-Null",
          "Set-Content -LiteralPath (Join-Path $blocked 'sentinel.txt') -Value 'existing' -NoNewline",
          "try { Promote-StagedDirectory $root $badStage $blocked; throw 'unexpected_replacement' } catch { }",
          "if (-not (Test-Path -LiteralPath $badStage)) { throw 'staging_lost_after_refused_replacement' }",
          "if ((Get-Content -LiteralPath (Join-Path $blocked 'sentinel.txt') -Raw) -ne 'existing') { throw 'existing_final_changed' }",
          "'ATOMIC_PROMOTION_OK'",
        ].join("; ");
        const child = spawn("pwsh", ["-NoProfile", "-NonInteractive", "-Command", program], { windowsHide: true });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (data) => { stdout += data; });
        child.stderr.on("data", (data) => { stderr += data; });
        child.on("error", reject);
        child.on("close", (code) => resolve({ code, stdout, stderr }));
      });
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("ATOMIC_PROMOTION_OK");
      expect(result.stderr).toBe("");
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });

  it("rejects hostile tar members and zip members before runtime extraction", async () => {
    const temp = await mkdtemp(join(tmpdir(), "jarvis-hermes-archive-"));
    const module = fileURLToPath(new URL("../scripts/HermesRuntime.psm1", import.meta.url));
    const escapedRoot = temp.replace(/'/g, "''"); const escapedModule = module.replace(/'/g, "''");
    try {
      const result = await new Promise((resolve, reject) => {
        const program = [
          `$root = '${escapedRoot}'`, `Import-Module '${escapedModule}' -Force`,
          "New-Item -ItemType Directory -Path (Join-Path $root 'python') | Out-Null", "Set-Content -LiteralPath (Join-Path $root 'python\\safe.txt') -Value safe -NoNewline",
          "& tar.exe -cf (Join-Path $root 'safe.tar') -C $root python; Assert-SafeCpythonArchive (Join-Path $root 'safe.tar')",
          "Set-Content -LiteralPath (Join-Path $root 'outside.txt') -Value unsafe -NoNewline; & tar.exe -cf (Join-Path $root 'unexpected-member.tar') -C $root outside.txt; try { Assert-SafeCpythonArchive (Join-Path $root 'unexpected-member.tar'); throw 'tar_unexpected_member_accepted' } catch { if ($_.Exception.Message -match 'tar_unexpected_member_accepted') { throw } }",
          "Add-Type -AssemblyName System.IO.Compression.FileSystem; $z=[IO.Compression.ZipFile]::Open((Join-Path $root 'extra.zip'),[IO.Compression.ZipArchiveMode]::Create); $e=$z.CreateEntry('uv.exe'); $e.Open().Dispose(); $e=$z.CreateEntry('uvw.exe'); $e.Open().Dispose(); $e=$z.CreateEntry('uvx.exe'); $e.Open().Dispose(); $e=$z.CreateEntry('../escape.exe'); $e.Open().Dispose(); $z.Dispose(); try { Assert-SafeUvArchive (Join-Path $root 'extra.zip'); throw 'zip_extra_accepted' } catch { if ($_.Exception.Message -match 'zip_extra_accepted') { throw } }",
          "'HOSTILE_ARCHIVE_REJECTED'",
        ].join("; ");
        const child = spawn("pwsh", ["-NoProfile", "-NonInteractive", "-Command", program], { windowsHide: true }); let stdout = ""; let stderr = "";
        child.stdout.on("data", (data) => { stdout += data; }); child.stderr.on("data", (data) => { stderr += data; }); child.on("error", reject); child.on("close", (code) => resolve({ code, stdout, stderr }));
      });
      expect(result.code, result.stderr).toBe(0); expect(result.stdout).toContain("HOSTILE_ARCHIVE_REJECTED"); expect(result.stderr).toBe("");
    } finally { await rm(temp, { recursive: true, force: true }); }
  });

  it("rejects Windows ADS, device, and case-collision archive members before extraction", async () => {
    const module = fileURLToPath(new URL("../scripts/HermesRuntime.psm1", import.meta.url)).replace(/'/g, "''");
    const program = [
      `Import-Module '${module}' -Force`,
      "foreach($name in @('python/file:stream','python/CON','python/LPT1.txt','python/trailing. ')){try{Assert-SafeCpythonMembers @([pscustomobject]@{Name=$name;Type='-'});throw 'windows_member_accepted'}catch{if($_.Exception.Message -match 'windows_member_accepted'){throw}}}",
      "try{Assert-SafeCpythonMembers @([pscustomobject]@{Name='python/Foo';Type='-'},[pscustomobject]@{Name='python/foo';Type='-'});throw 'case_collision_accepted'}catch{if($_.Exception.Message -match 'case_collision_accepted'){throw}};try{Assert-SafeCpythonMembers @([pscustomobject]@{Name='python/conf';Type='-'},[pscustomobject]@{Name='python/conf/';Type='d'});throw 'file_directory_alias_accepted'}catch{if($_.Exception.Message -match 'file_directory_alias_accepted'){throw}}",
      "try{Assert-SafeUvMembers @([pscustomobject]@{Name='uv.exe';Link=$false},[pscustomobject]@{Name='uvw.exe';Link=$false},[pscustomobject]@{Name='UV.EXE';Link=$false});throw 'zip_case_collision_accepted'}catch{if($_.Exception.Message -match 'zip_case_collision_accepted'){throw}}",
      "'WINDOWS_ARCHIVE_BOUNDARIES_OK'",
    ].join("; ");
    const result = await new Promise((resolve, reject) => {
      const child = spawn("pwsh", ["-NoProfile", "-NonInteractive", "-Command", program], { windowsHide: true }); let stdout = ""; let stderr = "";
      child.stdout.on("data", (data) => { stdout += data; }); child.stderr.on("data", (data) => { stderr += data; }); child.on("error", reject); child.on("close", (code) => resolve({ code, stdout, stderr }));
    });
    expect(result.code, result.stderr).toBe(0); expect(result.stdout).toContain("WINDOWS_ARCHIVE_BOUNDARIES_OK"); expect(result.stderr).toBe("");
  });

  it("rejects every hostile injected Git transcript and source-directory drift before promotion", async () => {
    const temp = await mkdtemp(join(tmpdir(), "jarvis-hermes-git-runner-"));
    const module = fileURLToPath(new URL("../scripts/HermesRuntime.psm1", import.meta.url)).replace(/'/g, "''");
    const escapedRoot = temp.replace(/'/g, "''");
    try {
      const result = await new Promise((resolve, reject) => {
        const program = [
          `$root='${escapedRoot}'`, `Import-Module '${module}' -Force`,
          "$good = @{ tag='v'; tagObject='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'; sourceCommit='bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'; sourceTree='cccccccccccccccccccccccccccccccccccccccc'; rawFileSha256=@{} }",
          "$badCases=@('remote','tag','tagObject','peeled','tree','gitlink','gitmodules','dirty')",
          "foreach($bad in $badCases){ $runner={ param($a); if($a -contains 'cat-file'){if($bad -eq 'tag'){'commit'}else{'tag'};return}; if($a -contains 'rev-parse'){ $x=$a[-1]; if($x -match 'tag}}$'){if($bad -eq 'tagObject'){'0'*40}else{$good.tagObject}}elseif($x -match '}}$'){if($bad -eq 'peeled'){'1'*40}else{$good.sourceCommit}}else{if($bad -eq 'tree'){'2'*40}else{$good.sourceTree}};return}; if($a -contains 'remote'){if($bad -eq 'remote'){@('origin','evil')}else{'origin'};return}; if($a -contains 'status'){if($bad -eq 'dirty'){'?? injected'};return} }; $entry=[pscustomobject]@{Mode='100644';Type='blob';Object=('a'*40);Path='safe.txt'};if($bad -eq 'gitlink'){$entry.Mode='160000';$entry.Type='commit'};if($bad -eq 'gitmodules'){$entry.Path='.gitmodules'}; try { Assert-HermesGitTranscript $good 'g' 'w' $runner @($entry); throw ('accepted_'+$bad) } catch { if($_.Exception.Message -match ('accepted_'+$bad)){throw} } }",
          "New-Item -ItemType Directory -Path (Join-Path $root 'source')|Out-Null; foreach($n in @('LICENSE','pyproject.toml','uv.lock')){[IO.File]::WriteAllText((Join-Path $root ('source\\'+$n)),$n,[Text.UTF8Encoding]::new($false));$good.rawFileSha256[$n]=(Get-FileHash -LiteralPath (Join-Path $root ('source\\'+$n)) -Algorithm SHA256).Hash.ToLower()}; Assert-HermesSourceDirectory $root (Join-Path $root 'source') $good; [IO.File]::WriteAllText((Join-Path $root 'source\\LICENSE'),'LICENSE`r`n',[Text.UTF8Encoding]::new($false)); try { Assert-HermesSourceDirectory $root (Join-Path $root 'source') $good; throw 'crlf_accepted' } catch {if($_.Exception.Message -match 'crlf_accepted'){throw}}",
          "'GIT_TRANSCRIPT_MATRIX_OK'",
        ].join("; ");
        const child = spawn("pwsh", ["-NoProfile", "-NonInteractive", "-Command", program], { windowsHide: true }); let stdout=""; let stderr="";
        child.stdout.on("data", (data)=>{stdout+=data;}); child.stderr.on("data",(data)=>{stderr+=data;}); child.on("error",reject); child.on("close",(code)=>resolve({code,stdout,stderr}));
      });
      expect(result.code, result.stderr).toBe(0); expect(result.stdout).toContain("GIT_TRANSCRIPT_MATRIX_OK");
    } finally { await rm(temp, { recursive: true, force: true }); }
  });

});
