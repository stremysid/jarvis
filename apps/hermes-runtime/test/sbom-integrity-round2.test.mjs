import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { canonicalTmpdir } from "./fixtures/temp-root.mjs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalize, sha256Hex } from "../src/canonical-json.mjs";
import { resolveTrustedPowerShellHost, runVerifierProcess, selectArchive } from "../src/generate-sbom.mjs";
import * as manifestValidation from "../src/validate-manifests.mjs";

const runtimeRoot = fileURLToPath(new URL("..", import.meta.url));
const temporaryRoots = [];

function ordinalCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function runtimeFile(path) {
  return join(runtimeRoot, ...path.split("/"));
}

function extractJavaScriptFunction(source, name) {
  const start = source.search(new RegExp(`^async function\\s+${name}\\s*\\(`, "m"));
  expect(start, `${name} function is missing`).toBeGreaterThanOrEqual(0);
  const bodyStart = source.indexOf("{", start);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`${name} function body is unterminated`);
}

async function loadJson(path, root = runtimeRoot) {
  return JSON.parse(await readFile(join(root, ...path.split("/")), "utf8"));
}

async function copyRuntimeTree() {
  const parent = await mkdtemp(join(canonicalTmpdir, "jarvis-hermes-sbom-round2-"));
  temporaryRoots.push(parent);
  const copy = join(parent, basename(runtimeRoot));
  await cp(runtimeRoot, copy, { recursive: true });
  return copy;
}

async function runValidator(root) {
  const validator = join(root, "src", "validate-manifests.mjs");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [validator], { windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (value) => { stdout += value; });
    child.stderr.on("data", (value) => { stderr += value; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function runGenerator(sourceRoot, generator = runtimeFile("src/generate-sbom.mjs")) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [generator, `--source-root=${sourceRoot}`, "--check"], { windowsHide: true });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (value) => { stdout += value; });
    child.stderr.on("data", (value) => { stderr += value; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function spawnVerifierTreeFixture(pidFile, stream) {
  const descendantProgram = [
    "setTimeout(() => process.exit(0), 1_500);",
  ].join("\n");
  const parentProgram = [
    'import { spawn } from "node:child_process";',
    'import { writeFileSync } from "node:fs";',
    `const descendantProgram = ${JSON.stringify(descendantProgram)};`,
    'const descendant = spawn(process.execPath, ["--input-type=module", "--eval", descendantProgram], { windowsHide: true, stdio: "ignore" });',
    "writeFileSync(process.argv[1], String(descendant.pid));",
    "descendant.unref();",
    stream === "stdout" ? 'process.stdout.write("x".repeat(4_096));' : stream === "stderr" ? 'process.stderr.write("x".repeat(4_096));' : "",
    "setTimeout(() => process.exit(0), 1_500);",
  ].filter(Boolean).join("\n");
  const environment = Object.fromEntries(["ComSpec", "SystemRoot", "WINDIR"].flatMap((name) => process.env[name] === undefined ? [] : [[name, process.env[name]]]));
  return spawn(process.execPath, ["--input-type=module", "--eval", parentProgram, pidFile], { windowsHide: true, env: environment });
}

async function expectVerifierTreeTerminated(pidFile) {
  const pid = Number(await readFile(pidFile, "utf8"));
  expect(pid).toBeGreaterThan(0);
  let running = true;
  try { process.kill(pid, 0); } catch (error) { if (error.code === "ESRCH") running = false; else throw error; }
  expect(running, `verifier descendant ${pid} survived process-tree termination`).toBe(false);
}

function pypiRecords(sbom) {
  const components = [sbom.metadata.component, ...sbom.components.filter((component) => component.purl?.startsWith("pkg:pypi/"))];
  const byRef = new Map(components.map((component) => [component["bom-ref"], component]));
  return {
    closure: components.map((component) => `${component.name}==${component.version}`).sort(ordinalCompare),
    distributions: components.map((component) => ({
      name: component.name,
      version: component.version,
      type: component.type,
      purl: component.purl,
    })).sort((left, right) => ordinalCompare(left.name, right.name) || ordinalCompare(left.version, right.version)),
    archives: components.filter((component) => component.hashes).map((component) => ({
      name: component.name,
      version: component.version,
      url: component.externalReferences[0].url,
      size: Number(component.properties[0].value),
      sha256: component.hashes[0].content,
    })).sort((left, right) => ordinalCompare(left.name, right.name) || ordinalCompare(left.version, right.version)),
    dependencies: sbom.dependencies.map((dependency) => ({
      name: byRef.get(dependency.ref).name,
      version: byRef.get(dependency.ref).version,
      dependsOn: dependency.dependsOn.map((reference) => byRef.get(reference).name).sort(ordinalCompare),
    })).sort((left, right) => ordinalCompare(left.name, right.name) || ordinalCompare(left.version, right.version)),
  };
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })));
});

describe("Task 2 round-2 SBOM and committed-manifest integrity", () => {
  it("validates the reviewed SBOM with ordinal records even when the host comparison locale is Czech", async () => {
    const [source, artifacts, patches, sbom] = await Promise.all([
      loadJson("hermes-source-lock.json"),
      loadJson("runtime-artifacts-lock.json"),
      loadJson("patches/series.json"),
      loadJson("sbom/hermes-agent-v2026.8.27-windows-x86_64-cpython-3.11.16.cdx.json"),
    ]);
    const original = String.prototype.localeCompare;
    const czech = new Intl.Collator("cs");
    String.prototype.localeCompare = function localeCompare(other) { return czech.compare(String(this), String(other)); };
    try {
      await expect(manifestValidation.validateSbomIntegrity({ source, artifacts, patches, sbom })).resolves.toBeUndefined();
    } finally {
      String.prototype.localeCompare = original;
    }
  });

  it("selects equal-rank archives by ordinal URL even when the host comparison locale is Czech", () => {
    const charset = "https://files.pythonhosted.org/packages/charset-1.0-py3-none-any.whl";
    const click = "https://files.pythonhosted.org/packages/click-1.0-py3-none-any.whl";
    const original = String.prototype.localeCompare;
    const czech = new Intl.Collator("cs");
    String.prototype.localeCompare = function localeCompare(other) { return czech.compare(String(this), String(other)); };
    try {
      const hash = `sha256:${"0".repeat(64)}`;
      expect(selectArchive({ name: "fixture", version: "1.0", wheels: [{ url: click, hash, size: 1 }, { url: charset, hash, size: 1 }] }).url).toBe(charset);
    } finally {
      String.prototype.localeCompare = original;
    }
  });

  it("rejects a stalled real verifier by its deadline and terminates its descendant process", async () => {
    const root = await mkdtemp(join(canonicalTmpdir, "jarvis-hermes-verifier-deadline-"));
    temporaryRoots.push(root);
    const pidFile = join(root, "descendant.pid");
    const child = spawnVerifierTreeFixture(pidFile, "none");

    await expect(runVerifierProcess(child, { deadlineMs: 500, maxOutputBytes: 1_024 })).rejects.toThrow("locked source verifier exceeded its 500ms deadline");
    await expectVerifierTreeTerminated(pidFile);
  }, 10_000);

  it.each(["stdout", "stderr"])("rejects real verifier %s overflow and terminates its descendant process", async (stream) => {
    const root = await mkdtemp(join(canonicalTmpdir, `jarvis-hermes-verifier-${stream}-`));
    temporaryRoots.push(root);
    const pidFile = join(root, "descendant.pid");
    const child = spawnVerifierTreeFixture(pidFile, stream);

    await expect(runVerifierProcess(child, { deadlineMs: 5_000, maxOutputBytes: 1_024 })).rejects.toThrow(`locked source verifier ${stream} exceeded its 1024-byte limit`);
    await expectVerifierTreeTerminated(pidFile);
  }, 10_000);

  it("runs the locked source verifier without an unanchored sibling workspace", async () => {
    const source = await readFile(runtimeFile("src/generate-sbom.mjs"), "utf8");
    const verifier = extractJavaScriptFunction(source, "runLockedSourceVerifier");
    expect(verifier, "locked verifier must not create a pathname-only sibling workspace").not.toMatch(/\bmkdtemp\s*\(/);
    expect(verifier, "locked verifier must not create unleased child directories").not.toMatch(/\bmkdir\s*\(/);
    expect(verifier, "locked verifier must not recursively clean an unleased sibling pathname").not.toMatch(/\brm\s*\([^\r\n]*recursive\s*:\s*true/);
    expect(verifier).not.toContain(".jarvis-hermes-sbom-verify-");
    expect(verifier, "closed verifier must still execute the trusted PowerShell host").toContain("spawn(powerShellHost");
    expect(verifier, "closed verifier must not use the reconstructing PowerShell -File startup route").not.toMatch(/spawn\(powerShellHost,[\s\S]*?"-File"/);
    expect(verifier, "closed verifier must use its fixed bootstrap command").toContain('"-Command", bootstrap');
    expect(verifier, "closed verifier must pass RuntimeRoot without command interpolation").toContain("JARVIS_HERMES_RUNTIME_ROOT: runtimeRoot");
    expect(verifier, "closed verifier must pass the verifier path without command interpolation").toContain("JARVIS_HERMES_SOURCE_VERIFIER: sourceVerifier");
    expect(verifier, "bootstrap must close module discovery before invoking the verifier").toContain("$env:PSModulePath = 'NUL'");
    expect(verifier, "bootstrap must invoke only the environment-bound verifier and RuntimeRoot").toContain("& $env:JARVIS_HERMES_SOURCE_VERIFIER -RuntimeRoot $env:JARVIS_HERMES_RUNTIME_ROOT -VerifyOnly");
    expect(verifier, "closed verifier must validate and bind the trusted module tree before startup").toContain("PSModulePath: closedModulesDirectory");
    expect(verifier).toContain('PSModuleAnalysisCachePath: "NUL"');
    expect(verifier).toContain('PSDisableModuleAnalysisCacheCleanup: "1"');
    expect(verifier).toContain('POWERSHELL_UPDATECHECK: "Off"');
    expect(verifier).toContain("APPDATA: closedHostDirectory");
    expect(verifier).toContain("LOCALAPPDATA: closedHostDirectory");
    expect(verifier, "closed verifier child cwd must be the validated host directory").toContain("cwd: closedHostDirectory");
  });

  it("rejects a fabricated release-shaped source root through the real generator before reading lock inputs", async () => {
    const container = await mkdtemp(join(canonicalTmpdir, "jarvis-hermes-sbom-source-root-"));
    temporaryRoots.push(container);
    const root = join(container, "runtime");
    await mkdir(root);
    const source = join(root, "releases", "5fc308a70719a83cccdbba4c0e39c23f5a8239d5", "source");
    await mkdir(source, { recursive: true });
    await mkdir(join(root, "releases", "5fc308a70719a83cccdbba4c0e39c23f5a8239d5", "git"));
    await writeFile(join(root, ".hermes-runtime.workflow.lock"), "");
    await writeFile(join(source, "uv.lock"), "version = 1\n");
    await writeFile(join(source, "pyproject.toml"), '[project]\nname = "hermes-agent"\nversion = "0.20.6"\n');
    await writeFile(join(source, "LICENSE"), "fabricated\n");
    const siblingsBefore = (await readdir(container)).filter((name) => name.startsWith(".jarvis-hermes-sbom-verify-"));
    const result = await runGenerator(source);
    const siblingsAfter = (await readdir(container)).filter((name) => name.startsWith(".jarvis-hermes-sbom-verify-"));
    expect(siblingsBefore).toEqual([]);
    expect(siblingsAfter, "real closed-host verification left a sibling scratch workspace").toEqual([]);
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("--source-root failed the complete locked source VerifyOnly boundary\n");
    // The real generator starts the trusted PowerShell host and the real
    // verifier, which measured 2.8 s on this PC and 5.0 s on the Windows CI
    // runner -- over Vitest's 5 s default, so the run was killed mid-flight.
    // The bound is on the process pair, not on any assertion: every expectation
    // above is unchanged.
  }, 30_000);

  it("closes PowerShell module discovery inside the real locked-source verifier child", async () => {
    const copy = await copyRuntimeTree();
    const closedHostDirectory = dirname(await resolveTrustedPowerShellHost());
    const closedHostEntriesBefore = (await readdir(closedHostDirectory)).sort(ordinalCompare);
    const sourceLock = await loadJson("hermes-source-lock.json", copy);
    const release = join(copy, "releases", sourceLock.sourceCommit);
    const source = join(release, "source");
    const probe = join(copy, "scripts", "closed-module-environment.txt");
    await mkdir(source, { recursive: true });
    await mkdir(join(release, "git"));
    await writeFile(join(copy, ".hermes-runtime.workflow.lock"), "");
    await writeFile(join(copy, "scripts", "fetch-hermes.ps1"), String.raw`param([string]$RuntimeRoot, [switch]$VerifyOnly)
$values = @(
  [string]$env:PSModulePath,
  [string]$env:PSModuleAnalysisCachePath,
  [string]$env:PSDisableModuleAnalysisCacheCleanup,
  [string]$env:POWERSHELL_UPDATECHECK,
  [IO.Directory]::GetCurrentDirectory(),
  [string]$env:APPDATA,
  [string]$env:LOCALAPPDATA
)
[IO.File]::WriteAllLines([IO.Path]::Combine($PSScriptRoot, 'closed-module-environment.txt'), $values, [Text.UTF8Encoding]::new($false))
exit 23
`, "utf8");

    const result = await runGenerator(source, join(copy, "src", "generate-sbom.mjs"));
    const [modulePath, analysisCachePath, disableCacheCleanup, updateCheck, childCwd, appData, localAppData] = (await readFile(probe, "utf8")).trimEnd().split(/\r?\n/);
    const closedHostEntriesAfter = (await readdir(closedHostDirectory)).sort(ordinalCompare);
    expect(result.code).not.toBe(0);
    expect(modulePath, "PowerShell reconstructed user or all-users module discovery before the verifier script").toBe("NUL");
    expect(analysisCachePath, "PowerShell module-analysis cache was not disabled inside the closed verifier child").toBe("NUL");
    expect(disableCacheCleanup, "PowerShell module-analysis cache cleanup was not disabled").toBe("1");
    expect(updateCheck, "PowerShell update checks were not disabled").toBe("Off");
    expect(childCwd.toLowerCase(), "closed verifier child inherited an untrusted working directory").toBe(closedHostDirectory.toLowerCase());
    expect(appData.toLowerCase(), "closed verifier child retained user APPDATA").toBe(closedHostDirectory.toLowerCase());
    expect(localAppData.toLowerCase(), "closed verifier child retained user LOCALAPPDATA").toBe(closedHostDirectory.toLowerCase());
    expect(closedHostEntriesAfter, "closed verifier startup left module-analysis or profile residue in its bounded host directory").toEqual(closedHostEntriesBefore);
    // Same real-generator cost as the test above: the copy of the runtime tree
    // plus the trusted PowerShell host. Measured 1.5 s here; the Windows CI
    // runner is slower and shared, so the default 5 s is not a real bound.
  }, 30_000);

  it("uses the uv-compatible CPython 3.11 Windows wheel for charset-normalizer", async () => {
    const selected = selectArchive({
      name: "charset-normalizer",
      version: "3.4.4",
      wheels: [
        {
          url: "https://files.pythonhosted.org/packages/0a/4c/charset_normalizer-3.4.4-py3-none-any.whl",
          hash: `sha256:${"7".repeat(64)}`,
          size: 53_402,
        },
        {
          url: "https://files.pythonhosted.org/packages/65/f6/charset_normalizer-3.4.4-cp311-cp311-win_amd64.whl",
          hash: "sha256:5ae497466c7901d54b639cf42d5b8c1b6a4fead55215500d2f486d34db48d016",
          size: 106_978,
        },
      ],
    });
    expect(selected).toEqual({
      url: "https://files.pythonhosted.org/packages/65/f6/charset_normalizer-3.4.4-cp311-cp311-win_amd64.whl",
      hash: "5ae497466c7901d54b639cf42d5b8c1b6a4fead55215500d2f486d34db48d016",
      size: 106_978,
    });

    const sbom = await loadJson("sbom/hermes-agent-v2026.8.27-windows-x86_64-cpython-3.11.16.cdx.json");
    const charset = sbom.components.find((component) => component.name === "charset-normalizer");
    expect(charset.externalReferences[0].url).toMatch(/charset_normalizer-3\.4\.4-cp311-cp311-win_amd64\.whl$/);
    expect(charset.hashes[0].content).toBe("5ae497466c7901d54b639cf42d5b8c1b6a4fead55215500d2f486d34db48d016");
    expect(charset.properties).toEqual([{ name: "jarvis:archive-size", value: "106978" }]);

    const records = pypiRecords(sbom);
    await expect(sha256Hex(canonicalize(records.closure))).resolves.toBe("3de6c3eeb3148f4b49cf48c5e8973487e82acbecd95131b8a50fc141276242a8");
    await expect(sha256Hex(canonicalize(records.distributions))).resolves.toBe("1681f6dba140be455ed15bf9f21d9540541ca8f10c98cc9f22412536a14189e8");
    await expect(sha256Hex(canonicalize(records.archives))).resolves.toBe("5433972607296e6ace1155482d1af15575f2aae75821781a67409f60147eb31a");
    await expect(sha256Hex(canonicalize(records.dependencies))).resolves.toBe("8efcb478f48ae732c7d9f2432599425283c34c4dd972f43de1854f3271618f27");
    expect(records.archives.reduce((sum, record) => sum + record.size, 0)).toBe(41_417_102);
  });

  it("independently rejects coherent distribution, archive, dependency, provenance, and metadata drift", async () => {
    expect(manifestValidation.validateSbomIntegrity).toBeTypeOf("function");
    const source = await loadJson("hermes-source-lock.json");
    const artifacts = await loadJson("runtime-artifacts-lock.json");
    const patches = await loadJson("patches/series.json");
    const baseline = await loadJson("sbom/hermes-agent-v2026.8.27-windows-x86_64-cpython-3.11.16.cdx.json");
    const drifts = [];

    const distribution = structuredClone(baseline);
    const originalIdnaPurl = "pkg:pypi/idna@3.11";
    const driftedIdnaPurl = "pkg:pypi/idna@3.17";
    distribution.components.find((component) => component.name === "idna").version = "3.17";
    distribution.components.find((component) => component.name === "idna").purl = driftedIdnaPurl;
    distribution.components.find((component) => component.name === "idna")["bom-ref"] = driftedIdnaPurl;
    for (const dependencyRecord of distribution.dependencies) {
      if (dependencyRecord.ref === originalIdnaPurl) dependencyRecord.ref = driftedIdnaPurl;
      dependencyRecord.dependsOn = dependencyRecord.dependsOn.map((reference) => reference === originalIdnaPurl ? driftedIdnaPurl : reference).sort(ordinalCompare);
    }
    drifts.push([distribution, /closure record hash/]);

    const archive = structuredClone(baseline);
    const archiveComponent = archive.components.find((component) => component.name === "idna");
    archiveComponent.hashes[0].content = "0".repeat(64);
    drifts.push([archive, /archive record hash/]);

    const dependency = structuredClone(baseline);
    dependency.dependencies.find((record) => record.ref === "pkg:pypi/requests@2.33.0").dependsOn = [];
    drifts.push([dependency, /dependency record hash/]);

    const provenance = structuredClone(baseline);
    provenance.components.find((component) => component.name === "runtime-cpython").properties.find((entry) => entry.name === "jarvis:size").value = "25723670";
    drifts.push([provenance, /provenance runtime-cpython drift/]);

    const metadata = structuredClone(baseline);
    metadata.metadata.component.type = "library";
    drifts.push([metadata, /metadata component drift/]);

    for (const [sbom, message] of drifts) {
      await expect(manifestValidation.validateSbomIntegrity({ source, artifacts, patches, sbom })).rejects.toThrow(message);
    }
  });

  it("makes the source and runtime JSON Schemas reject every reviewed-pin drift directly", async () => {
    const source = await loadJson("hermes-source-lock.json");
    const artifacts = await loadJson("runtime-artifacts-lock.json");
    const sourceSchema = await loadJson("schemas/hermes-source-lock-v1.schema.json");
    const artifactsSchema = await loadJson("schemas/runtime-artifacts-lock-v1.schema.json");
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    const validateSource = ajv.compile(sourceSchema);
    const validateArtifacts = ajv.compile(artifactsSchema);
    expect(validateSource(source), JSON.stringify(validateSource.errors)).toBe(true);
    expect(validateArtifacts(artifacts), JSON.stringify(validateArtifacts.errors)).toBe(true);

    for (const mutate of [
      (value) => { value.jarvisH0Commit = "0".repeat(40); },
      (value) => { value.tagObject = "0".repeat(40); },
      (value) => { value.sourceTree = "0".repeat(40); },
      (value) => { value.rawFileSha256.LICENSE = "0".repeat(64); },
      (value) => { value.runsEventContractHash = "0".repeat(64); },
      (value) => { value.submodules.push("unexpected"); },
      (value) => { value.licenses.files["licenses/CPython-LICENSE"] = "0".repeat(64); },
      (value) => { value.sbomSha256 = "0".repeat(64); },
    ]) {
      const drift = structuredClone(source);
      mutate(drift);
      expect(validateSource(drift)).toBe(false);
    }

    for (const mutate of [
      (value) => { value.cpython.size += 1; },
      (value) => { value.uv.url = "https://github.com/astral-sh/uv/releases/download/0.12.7/other.zip"; },
      (value) => { value.winsw.sha256 = "0".repeat(64); },
      (value) => { value.uv.licenses.reverse(); },
      (value) => { value.pythonBuildStandaloneLicenses.size += 1; },
    ]) {
      const drift = structuredClone(artifacts);
      mutate(drift);
      expect(validateArtifacts(drift)).toBe(false);
    }
  });

  it("binds raw canonical Runs contract, schema, and golden file bytes", async () => {
    const source = await loadJson("hermes-source-lock.json");
    const contract = await loadJson("contracts/hermes-runs-api-v2026.8.27.json");
    await expect(sha256Hex(await readFile(runtimeFile("contracts/hermes-runs-api-v2026.8.27.json")))).resolves.toBe(source.runsEventContractFileSha256);
    await expect(sha256Hex(await readFile(runtimeFile(contract.wireArtifacts.schema.file)))).resolves.toBe(contract.wireArtifacts.schema.fileSha256);
    await expect(sha256Hex(await readFile(runtimeFile(contract.wireArtifacts.golden.file)))).resolves.toBe(contract.wireArtifacts.golden.fileSha256);
  });

  it("rejects duplicate-key and noncanonical raw committed JSON through the real CLI", async () => {
    const duplicateRoot = await copyRuntimeTree();
    const duplicatePath = join(duplicateRoot, "contracts", "hermes-runs-api-v2026.8.27.json");
    const duplicate = await readFile(duplicatePath, "utf8");
    await writeFile(duplicatePath, duplicate.replace("{", '{"schemaVersion":"2026.8.27",'));
    const duplicateResult = await runValidator(duplicateRoot);
    expect(duplicateResult.code).not.toBe(0);
    expect(duplicateResult.stdout).toBe("");
    expect(duplicateResult.stderr).toBe("Hermes H1 manifest validation failed\n");

    const whitespaceRoot = await copyRuntimeTree();
    const schemaPath = join(whitespaceRoot, "schemas", "hermes-runs-wire-v2026.8.27.schema.json");
    await writeFile(schemaPath, ` ${await readFile(schemaPath, "utf8")}`);
    const whitespaceResult = await runValidator(whitespaceRoot);
    expect(whitespaceResult.code).not.toBe(0);
    expect(whitespaceResult.stdout).toBe("");
    expect(whitespaceResult.stderr).toBe("Hermes H1 manifest validation failed\n");
  });

  it("hashes the actual THIRD_PARTY_NOTICES bytes in the executable validator", async () => {
    const copiedRoot = await copyRuntimeTree();
    const notices = join(copiedRoot, "THIRD_PARTY_NOTICES.md");
    await writeFile(notices, Buffer.concat([await readFile(notices), Buffer.from("drift\n")]));
    const result = await runValidator(copiedRoot);
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe("");

    const source = await loadJson("hermes-source-lock.json");
    const actual = createHash("sha256").update(await readFile(runtimeFile("THIRD_PARTY_NOTICES.md"))).digest("hex");
    expect(source.thirdPartyNotices.sha256).toBe(actual);
    expect(await readFile(fileURLToPath(new URL("../../../.gitattributes", import.meta.url)), "utf8")).toContain("apps/hermes-runtime/THIRD_PARTY_NOTICES.md -text");
  });
});
