import { access, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";
import { canonicalize, sha256Hex, validateHermesManifests, validateRunsWireArtifacts } from "../src/validate-manifests.mjs";
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

async function runPowerShellFile(script, args, timeout = 120_000) {
  return new Promise((resolve, reject) => {
    const child = spawn("pwsh", ["-NoProfile", "-NonInteractive", "-File", script, ...args], { windowsHide: true });
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
    expect(archives.reduce((sum, component) => sum + Number(component.properties[0].value), 0)).toBe(41_363_526);
    const archiveRecords = archives.map((component) => ({ name: component.name, version: component.version, url: component.externalReferences[0].url, size: Number(component.properties[0].value), sha256: component.hashes[0].content })).sort((left, right) => left.name.localeCompare(right.name));
    const byRef = new Map(installed.map((component) => [component.purl, component]));
    const dependencyRecords = sbom.dependencies.map((dependency) => ({ name: byRef.get(dependency.ref).name, version: byRef.get(dependency.ref).version, dependsOn: dependency.dependsOn.map((reference) => byRef.get(reference).name).sort() })).sort((left, right) => left.name.localeCompare(right.name));
    await expect(sha256Hex(canonicalize(installed.map((component) => `${component.name}==${component.version}`).sort()))).resolves.toBe("3de6c3eeb3148f4b49cf48c5e8973487e82acbecd95131b8a50fc141276242a8");
    await expect(sha256Hex(canonicalize(archiveRecords))).resolves.toBe("f3a08e3bf08e9d10d0e79338049028a89aa14b85a3d0120a86187e5578041d52");
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


  it("fails closed for root, escape, and nonempty release paths and isolates every Git config layer", async () => {
    const module = fileURLToPath(new URL("../scripts/HermesRuntime.psm1", import.meta.url)).replace(/'/g, "''");
    const script = await readFile(file("scripts/fetch-hermes.ps1"), "utf8");
    expect(script).toContain("GIT_CONFIG_NOSYSTEM = '1'");
    expect(script).toContain("GIT_CONFIG_GLOBAL = 'NUL'");
    expect(script).toContain("GIT_CONFIG_SYSTEM = 'NUL'");
    expect(script).toContain("GIT_ATTR_NOSYSTEM = '1'");
    const result = await new Promise((resolve, reject) => {
      const program = [
        `Import-Module '${module}' -Force`,
        "if ((@(Get-HermesGitIsolationOptions) -join ';') -ne '-c;core.hooksPath=NUL;-c;core.autocrlf=false;-c;core.safecrlf=true;-c;filter.lfs.smudge=;-c;filter.lfs.process=;-c;filter.lfs.required=false;-c;credential.helper=') { throw 'git_isolation_options_drift' }; foreach ($candidate in @('\\\\server\\share\\x','C:\\','')) { try { Assert-LiteralRuntimeRoot $candidate; throw 'unsafe_root_accepted' } catch { if ($_.Exception.Message -match 'unsafe_root_accepted') { throw } } }",
        "$root = Join-Path ([IO.Path]::GetTempPath()) ('hermes-path-' + [guid]::NewGuid().ToString('N')); New-Item -ItemType Directory -Path $root | Out-Null; try { Assert-ChildPath $root (Join-Path $root '..\\outside'); throw 'escape_accepted' } catch { if ($_.Exception.Message -match 'escape_accepted') { throw } }; $junction=Join-Path $root 'junction'; New-Item -ItemType Junction -Path $junction -Target $root | Out-Null; try { Assert-LiteralRuntimeRoot $junction; throw 'reparse_accepted' } catch { if ($_.Exception.Message -match 'reparse_accepted') { throw } }; $safe=Join-Path $root 'safe';New-Item -ItemType Directory -Path $safe|Out-Null;$toolchain=Join-Path $root 'toolchain';New-Item -ItemType Junction -Path $toolchain -Target $safe|Out-Null;foreach($candidate in @((Join-Path $toolchain 'cpython-3.11.16'),$toolchain)){try{Assert-ChildPath $root $candidate;throw 'ancestor_reparse_accepted'}catch{if($_.Exception.Message -match 'ancestor_reparse_accepted'){throw}}}; 'HOSTILE_PATHS_REJECTED'",
      ].join("; ");
      const child = spawn("pwsh", ["-NoProfile", "-NonInteractive", "-Command", program], { windowsHide: true }); let stdout = ""; let stderr = "";
      child.stdout.on("data", (data) => { stdout += data; }); child.stderr.on("data", (data) => { stderr += data; }); child.on("error", reject); child.on("close", (code) => resolve({ code, stdout, stderr }));
    });
    expect(result.code, result.stderr).toBe(0); expect(result.stdout).toContain("HOSTILE_PATHS_REJECTED"); expect(result.stderr).toBe("");
  });

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

  it("rolls back a faulted multi-directory promotion with no partial runtime targets", async () => {
    const temp = await mkdtemp(join(tmpdir(), "jarvis-hermes-batch-promotion-"));
    const module = fileURLToPath(new URL("../scripts/HermesRuntime.psm1", import.meta.url));
    const escapedRoot = temp.replace(/'/g, "''");
    const escapedModule = module.replace(/'/g, "''");
    try {
      const result = await new Promise((resolve, reject) => {
        const program = [
          `$root = '${escapedRoot}'`, `Import-Module '${escapedModule}' -Force`,
          "foreach ($name in @('one','two','three','four')) { $stage = Join-Path $root ('.s\\' + $name); New-Item -ItemType Directory -Path $stage -Force | Out-Null; Set-Content -LiteralPath (Join-Path $stage 'payload.txt') -Value $name -NoNewline }",
          "$items = @('one','two','three','four' | ForEach-Object { [pscustomobject]@{ StagedDirectory = (Join-Path $root ('.s\\' + $_)); FinalDirectory = (Join-Path $root ('final\\' + $_)) } })",
          "try { Promote-StagedDirectories $root $items 2; throw 'fault_not_injected' } catch { if ($_.Exception.Message -notmatch 'Injected promotion fault') { throw } }",
          "foreach ($name in @('one','two','three','four')) { if (Test-Path -LiteralPath (Join-Path $root ('final\\' + $name))) { throw 'partial_final' }; if (-not (Test-Path -LiteralPath (Join-Path $root ('.s\\' + $name + '\\payload.txt')))) { throw 'staging_not_restored' } }",
          "'BATCH_PROMOTION_ROLLBACK_OK'",
        ].join("; ");
        const child = spawn("pwsh", ["-NoProfile", "-NonInteractive", "-Command", program], { windowsHide: true });
        let stdout = ""; let stderr = "";
        child.stdout.on("data", (data) => { stdout += data; }); child.stderr.on("data", (data) => { stderr += data; });
        child.on("error", reject); child.on("close", (code) => resolve({ code, stdout, stderr }));
      });
      expect(result.code, result.stderr).toBe(0); expect(result.stdout).toContain("BATCH_PROMOTION_ROLLBACK_OK"); expect(result.stderr).toBe("");
    } finally { await rm(temp, { recursive: true, force: true }); }
  });

  it("journals an interrupted runtime publication, rejects it until recovery, and commits only after verification", async () => {
    const temp = await mkdtemp(join(tmpdir(), "jarvis-hermes-publication-"));
    const module = fileURLToPath(new URL("../scripts/HermesRuntime.psm1", import.meta.url)).replace(/'/g, "''");
    const escapedRoot = temp.replace(/'/g, "''");
    try {
      const result = await new Promise((resolve, reject) => {
        const program = [
          `$root='${escapedRoot}'`, `Import-Module '${module}' -Force`,
          "$items=@(); foreach($name in @('one','two','three','four')){$stage=Join-Path $root ('.stage\\\\'+$name);New-Item -ItemType Directory -Path $stage -Force|Out-Null;Set-Content -LiteralPath (Join-Path $stage 'payload.txt') -Value $name -NoNewline;$items += [pscustomobject]@{StagedDirectory=$stage;FinalDirectory=(Join-Path $root ('final\\\\'+$name))}}",
          "try { Promote-StagedDirectories $root $items 0 2; throw 'crash_not_injected' } catch { if ($_.Exception.Message -match 'crash_not_injected') { throw } }",
          "if (-not (Test-Path -LiteralPath (Get-HermesPublicationJournalPath $root))) { throw 'journal_missing_after_crash' }; try { Assert-HermesPublicationReady $root; throw 'partial_ready' } catch { if ($_.Exception.Message -match 'partial_ready') { throw } }",
          "Recover-StagedDirectories $root; foreach($item in $items){if(Test-Path -LiteralPath $item.FinalDirectory){throw 'partial_final_after_recovery'};if(-not(Test-Path -LiteralPath $item.StagedDirectory)){throw 'stage_not_restored'}}",
          "Promote-StagedDirectories $root $items; try { Assert-HermesPublicationReady $root; throw 'unverified_ready' } catch { if ($_.Exception.Message -match 'unverified_ready') { throw } }; Complete-StagedDirectories $root; Assert-HermesPublicationReady $root; 'JOURNALED_PUBLICATION_OK'",
        ].join("; ");
        const child = spawn("pwsh", ["-NoProfile", "-NonInteractive", "-Command", program], { windowsHide: true }); let stdout = ""; let stderr = "";
        child.stdout.on("data", (data) => { stdout += data; }); child.stderr.on("data", (data) => { stderr += data; }); child.on("error", reject); child.on("close", (code) => resolve({ code, stdout, stderr }));
      });
      expect(result.code, result.stderr).toBe(0); expect(result.stdout).toContain("JOURNALED_PUBLICATION_OK"); expect(result.stderr).toBe("");
    } finally { await rm(temp, { recursive: true, force: true }); }
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

  it("rejects hostile HTTPS, archive, and each batch-promotion failure without reading or leaving partial payloads", async () => {
    const temp = await mkdtemp(join(tmpdir(), "jarvis-hermes-hostile-runtime-"));
    const module = fileURLToPath(new URL("../scripts/HermesRuntime.psm1", import.meta.url)).replace(/'/g, "''"); const escapedRoot = temp.replace(/'/g, "''");
    try {
      const result = await new Promise((resolve, reject) => {
        const program = [
          `$root='${escapedRoot}'`, `Import-Module '${module}' -Force`, "$a=@{url='https://github.com/example/a';size=7;sha256=('a'*64)}",
          "foreach($case in @('http','offhost','redirect','length')){try{switch($case){'http'{Assert-ArtifactHttpHop $a ([Uri]'http://github.com/a') 200 $null 7};'offhost'{Assert-ArtifactHttpHop $a ([Uri]'https://github.com/a') 302 ([Uri]'https://evil.invalid/a') $null};'redirect'{Assert-ArtifactHttpHop $a ([Uri]'https://github.com/a') 302 $null $null};'length'{Assert-ArtifactHttpHop $a ([Uri]'https://github.com/a') 200 $null 8}};throw ('accepted_'+$case)}catch{if($_.Exception.Message -match ('accepted_'+$case)){throw}}}",
          "foreach($name in @('../x','/x','C:\\x','\\x','python/../x')){try{Assert-SafeCpythonMembers @([pscustomobject]@{Name=$name;Type='-'});throw 'unsafe_member_accepted'}catch{if($_.Exception.Message -match 'unsafe_member_accepted'){throw}}}; foreach($type in @('l','h','r')){try{Assert-SafeCpythonMembers @([pscustomobject]@{Name='python/link';Type=$type});throw 'link_accepted'}catch{if($_.Exception.Message -match 'link_accepted'){throw}}}; foreach($name in @('../x','/x','C:\\x','dir/uv.exe')){try{Assert-SafeUvMembers @([pscustomobject]@{Name='uv.exe';Link=$false},[pscustomobject]@{Name='uvw.exe';Link=$false},[pscustomobject]@{Name='uvx.exe';Link=$false},[pscustomobject]@{Name=$name;Link=$false});throw 'zip_member_accepted'}catch{if($_.Exception.Message -match 'zip_member_accepted'){throw}}}; try{Assert-SafeUvMembers @([pscustomobject]@{Name='uv.exe';Link=$true},[pscustomobject]@{Name='uvw.exe';Link=$false},[pscustomobject]@{Name='uvx.exe';Link=$false});throw 'zip_link_accepted'}catch{if($_.Exception.Message -match 'zip_link_accepted'){throw}}",
          "foreach($fault in 1..4){$items=@();foreach($n in 1..4){$s=Join-Path $root ('.s\\'+$fault+'-'+$n);New-Item -ItemType Directory -Path $s -Force|Out-Null;Set-Content -LiteralPath (Join-Path $s 'x') -Value $n -NoNewline;$items += [pscustomobject]@{StagedDirectory=$s;FinalDirectory=(Join-Path $root ('final\\'+$fault+'-'+$n))}};try{Promote-StagedDirectories $root $items $fault;throw 'fault_accepted'}catch{if($_.Exception.Message -match 'fault_accepted'){throw}};foreach($i in $items){if(Test-Path -LiteralPath $i.FinalDirectory){throw 'partial_final'}};Promote-StagedDirectories $root $items;Complete-StagedDirectories $root;foreach($i in $items){if(-not(Test-Path -LiteralPath $i.FinalDirectory)){throw 'rerun_failed'}};Remove-Item -LiteralPath (Get-HermesPublicationReadyPath $root) -Force}",
          "'HTTPS_ARCHIVE_PROMOTION_MATRIX_OK'",
        ].join("; ");
        const child=spawn("pwsh",["-NoProfile","-NonInteractive","-Command",program],{windowsHide:true});let stdout="";let stderr="";child.stdout.on("data",d=>{stdout+=d;});child.stderr.on("data",d=>{stderr+=d;});child.on("error",reject);child.on("close",code=>resolve({code,stdout,stderr}));
      });
      expect(result.code, result.stderr).toBe(0); expect(result.stdout).toContain("HTTPS_ARCHIVE_PROMOTION_MATRIX_OK");
    } finally { await rm(temp, { recursive: true, force: true }); }
  });
});
