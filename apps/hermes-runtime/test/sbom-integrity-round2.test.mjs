import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalize, sha256Hex } from "../src/canonical-json.mjs";
import { selectArchive } from "../src/generate-sbom.mjs";
import * as manifestValidation from "../src/validate-manifests.mjs";

const runtimeRoot = fileURLToPath(new URL("..", import.meta.url));
const temporaryRoots = [];

function runtimeFile(path) {
  return join(runtimeRoot, ...path.split("/"));
}

async function loadJson(path, root = runtimeRoot) {
  return JSON.parse(await readFile(join(root, ...path.split("/")), "utf8"));
}

async function copyRuntimeTree() {
  const parent = await mkdtemp(join(tmpdir(), "jarvis-hermes-sbom-round2-"));
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

async function runGenerator(sourceRoot) {
  const generator = runtimeFile("src/generate-sbom.mjs");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [generator, `--source-root=${sourceRoot}`, "--check"], { windowsHide: true });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (value) => { stdout += value; });
    child.stderr.on("data", (value) => { stderr += value; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function pypiRecords(sbom) {
  const components = sbom.components.filter((component) => component.purl?.startsWith("pkg:pypi/"));
  const byRef = new Map(components.map((component) => [component.purl, component]));
  return {
    closure: components.map((component) => `${component.name}==${component.version}`).sort(),
    distributions: components.map((component) => ({
      name: component.name,
      version: component.version,
      type: component.type,
      purl: component.purl,
    })).sort((left, right) => left.name.localeCompare(right.name) || left.version.localeCompare(right.version)),
    archives: components.filter((component) => component.hashes).map((component) => ({
      name: component.name,
      version: component.version,
      url: component.externalReferences[0].url,
      size: Number(component.properties[0].value),
      sha256: component.hashes[0].content,
    })).sort((left, right) => left.name.localeCompare(right.name) || left.version.localeCompare(right.version)),
    dependencies: sbom.dependencies.map((dependency) => ({
      name: byRef.get(dependency.ref).name,
      version: byRef.get(dependency.ref).version,
      dependsOn: dependency.dependsOn.map((reference) => byRef.get(reference).name).sort(),
    })).sort((left, right) => left.name.localeCompare(right.name) || left.version.localeCompare(right.version)),
  };
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Task 2 round-2 SBOM and committed-manifest integrity", () => {
  it("rejects a fabricated release-shaped source root through the real generator before reading lock inputs", async () => {
    const root = await mkdtemp(join(tmpdir(), "jarvis-hermes-sbom-source-root-"));
    temporaryRoots.push(root);
    const source = join(root, "releases", "5fc308a70719a83cccdbba4c0e39c23f5a8239d5", "source");
    await mkdir(source, { recursive: true });
    await mkdir(join(root, "releases", "5fc308a70719a83cccdbba4c0e39c23f5a8239d5", "git"));
    await writeFile(join(root, ".hermes-runtime.workflow.lock"), "");
    await writeFile(join(source, "uv.lock"), "version = 1\n");
    await writeFile(join(source, "pyproject.toml"), '[project]\nname = "hermes-agent"\nversion = "0.20.6"\n');
    await writeFile(join(source, "LICENSE"), "fabricated\n");
    const result = await runGenerator(source);
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("--source-root failed the complete locked source VerifyOnly boundary\n");
  });

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
    for (const dependencyRecord of distribution.dependencies) {
      if (dependencyRecord.ref === originalIdnaPurl) dependencyRecord.ref = driftedIdnaPurl;
      dependencyRecord.dependsOn = dependencyRecord.dependsOn.map((reference) => reference === originalIdnaPurl ? driftedIdnaPurl : reference).sort();
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
