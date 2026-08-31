import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { canonicalize, sha256Hex } from "./canonical-json.mjs";

const H0 = "814535de21df37e6abac1f63e5953d693b78e003";
const SHA256 = /^[a-f0-9]{64}$/;
const GIT = /^[a-f0-9]{40}$/;
const CONTRACT_SHA256 = "b4878d91425e21f7ee212df2808644c18801b754674e8c2ab1a6c44e70c745c0";
const OFFICIAL = new Set([
  "https://github.com/NousResearch/hermes-agent.git",
  "https://github.com/astral-sh/python-build-standalone/releases/download/20260825/cpython-3.11.16%2B20260825-x86_64-pc-windows-msvc-install_only_stripped.tar.gz",
  "https://github.com/astral-sh/uv/releases/download/0.12.7/uv-x86_64-pc-windows-msvc.zip",
  "https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW-x64.exe",
  "https://raw.githubusercontent.com/astral-sh/python-build-standalone/20260825/python-licenses.rst",
]);

function fail(message) { throw new TypeError(`invalid Hermes H1 manifest: ${message}`); }
function record(value, keys, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length !== 0) fail(`${label} must be a plain record`);
  const actual = Object.getOwnPropertyNames(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail(`${label} has unknown, missing, or non-enumerable fields`);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) fail(`${label}.${key} must be an enumerable data field`);
  }
  return value;
}
function array(value, label) { if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || Object.getOwnPropertySymbols(value).length) fail(`${label} must be a plain array`); return value; }
function hash(value, label) { if (typeof value !== "string" || !SHA256.test(value)) fail(`${label} must be a lowercase SHA-256 hash`); return value; }
function git(value, label) { if (typeof value !== "string" || !GIT.test(value)) fail(`${label} must be a 40-character lowercase Git hash`); return value; }
function literal(value, expected, label) { if (value !== expected) fail(`${label} is not the reviewed value`); }
function url(value, label) { if (typeof value !== "string" || !value.startsWith("https://") || !OFFICIAL.has(value)) fail(`${label} must be an exact official HTTPS URL`); }
function positiveInteger(value, label) { if (!Number.isSafeInteger(value) || value < 1) fail(`${label} must be a positive integer`); }

async function checkContract(contract) {
  if (await sha256Hex(canonicalize(contract)) !== CONTRACT_SHA256) fail("Runs contract drifted from the closed profile");
}
function checkSource(source) {
  record(source, ["schemaVersion", "jarvisH0Commit", "remote", "tag", "tagObject", "sourceCommit", "sourceTree", "packageVersion", "rawFileSha256", "acquisitionMethod", "submodules", "model", "pythonVersion", "runsEventContractHash", "patchQueue", "licenses", "thirdPartyNotices", "sbom", "sbomSha256", "sbomFileSha256"], "source lock");
  literal(source.schemaVersion, "1", "source lock schemaVersion"); literal(source.jarvisH0Commit, H0, "jarvisH0Commit"); url(source.remote, "source remote"); literal(source.tag, "v2026.8.27", "source tag"); literal(git(source.tagObject, "tagObject"), "fcebd62163497e77e5de00d26d2ed86cb4ef8761", "tagObject"); literal(git(source.sourceCommit, "sourceCommit"), "5fc308a70719a83cccdbba4c0e39c23f5a8239d5", "sourceCommit"); literal(git(source.sourceTree, "sourceTree"), "222ec43b5237deb643277bc2f64fa4b873dd7f28", "sourceTree"); literal(source.packageVersion, "0.20.6", "packageVersion");
  record(source.rawFileSha256, ["LICENSE", "pyproject.toml", "uv.lock"], "rawFileSha256"); literal(hash(source.rawFileSha256.LICENSE, "LICENSE"), "821556e6336796450ab852d375117b48a4887e71d255794fd6318d99982a5ab6", "LICENSE"); literal(hash(source.rawFileSha256["pyproject.toml"], "pyproject.toml"), "9b6d41aca6d908e5af2f90a335b1c2b7eeaf8e3ce667b5a823a73e8643c56c75", "pyproject.toml"); literal(hash(source.rawFileSha256["uv.lock"], "uv.lock"), "5a9276183671e997c2213ede18b9cda4920e1cf57616219a3b08ddebda3281ab", "uv.lock");
  literal(source.acquisitionMethod, "git-detached", "acquisitionMethod"); if (array(source.submodules, "submodules").length) fail("submodules must be empty"); literal(source.model, "deepseek-v4-pro", "model"); literal(source.pythonVersion, "3.11.16", "pythonVersion"); hash(source.runsEventContractHash, "runsEventContractHash");
  record(source.patchQueue, ["file", "sha256"], "patchQueue"); literal(source.patchQueue.file, "patches/series.json", "patch queue file"); hash(source.patchQueue.sha256, "patch queue hash");
  record(source.licenses, ["files"], "licenses");
  record(source.licenses.files, ["licenses/CPython-LICENSE", "licenses/Hermes-Agent-LICENSE", "licenses/WinSW-LICENSE", "licenses/python-build-standalone-licenses.rst", "licenses/uv-APACHE-LICENSE", "licenses/uv-LICENSE"], "licenses.files");
  const reviewedLicenseHashes = {
    "licenses/CPython-LICENSE": "886a0ead2d89030ee62dbff52b04e47ab91998341295bb9c56fb952b4e081c7a",
    "licenses/Hermes-Agent-LICENSE": "821556e6336796450ab852d375117b48a4887e71d255794fd6318d99982a5ab6",
    "licenses/WinSW-LICENSE": "1cdf703c10a70e5973bf3acf2a5eeabe7746237155b92db2034aeae26fdf7802",
    "licenses/python-build-standalone-licenses.rst": "e43fb936c6655d7996dba480d7ebdea492d6040ec388eb8ed9d1000f72de8cab",
    "licenses/uv-APACHE-LICENSE": "c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4",
    "licenses/uv-LICENSE": "860e3d7a86b84e6a7012c7a635fc64df475cebc6cce34dfeb73a5982ec58176c",
  };
  for (const [path, expected] of Object.entries(reviewedLicenseHashes)) literal(hash(source.licenses.files[path], path), expected, path);
  record(source.thirdPartyNotices, ["file", "sha256"], "thirdPartyNotices"); literal(source.thirdPartyNotices.file, "THIRD_PARTY_NOTICES.md", "third party notice file"); literal(hash(source.thirdPartyNotices.sha256, "third party notices hash"), "52e851ebf6bf6844566798c59085dcee17c3ad1226dcb426879443b5a18d1f41", "third party notices hash");
  record(source.sbom, ["file", "format"], "sbom"); literal(source.sbom.file, "sbom/hermes-agent-v2026.8.27-windows-x86_64-cpython-3.11.16.cdx.json", "SBOM file"); literal(source.sbom.format, "CycloneDX-1.6", "SBOM format"); hash(source.sbomSha256, "sbomSha256"); hash(source.sbomFileSha256, "sbomFileSha256");
}
function checkArtifact(artifact, name, expected) {
  record(artifact, ["version", "fileName", "url", "architecture", "size", "sha256", "licenses"], name); literal(artifact.version, expected.version, `${name}.version`); literal(artifact.fileName, expected.fileName, `${name}.fileName`); url(artifact.url, `${name}.url`); literal(artifact.architecture, expected.architecture, `${name}.architecture`); literal(artifact.size, expected.size, `${name}.size`); literal(hash(artifact.sha256, `${name}.sha256`), expected.sha256, `${name}.sha256`); const licenses = array(artifact.licenses, `${name}.licenses`); if (licenses.length !== expected.licenses.length || licenses.some((license, index) => license !== expected.licenses[index])) fail(`${name}.licenses is not the reviewed exact array`);
}
function checkArtifacts(artifacts) {
  record(artifacts, ["schemaVersion", "cpython", "uv", "winsw", "pythonBuildStandaloneLicenses"], "artifact lock"); literal(artifacts.schemaVersion, "1", "artifact lock schemaVersion");
  checkArtifact(artifacts.cpython, "cpython", { version: "3.11.16+20260825", fileName: "cpython-3.11.16+20260825-x86_64-pc-windows-msvc-install_only_stripped.tar.gz", architecture: "x86_64-pc-windows-msvc", size: 25723669, sha256: "f91242b07e318d2540f9da71162b92d494c39745abde9b994d7d906756453fc9", licenses: ["Python-2.0", "CNRI-Python", "bundled-component-licenses"] });
  checkArtifact(artifacts.uv, "uv", { version: "0.12.7", fileName: "uv-x86_64-pc-windows-msvc.zip", architecture: "x86_64-pc-windows-msvc", size: 16979508, sha256: "bf1518af459a3915511a11fdc6e2f43ef9a2afa138b9d498eeb9642fe9d85218", licenses: ["MIT", "Apache-2.0"] });
  checkArtifact(artifacts.winsw, "winsw", { version: "2.12.0", fileName: "WinSW-x64.exe", architecture: "amd64-pe", size: 18243033, sha256: "05b82d46ad331cc16bdc00de5c6332c1ef818df8ceefcd49c726553209b3a0da", licenses: ["MIT"] });
  record(artifacts.pythonBuildStandaloneLicenses, ["url", "size", "sha256"], "python-build-standalone licenses"); url(artifacts.pythonBuildStandaloneLicenses.url, "python-build-standalone license URL"); literal(artifacts.pythonBuildStandaloneLicenses.size, 105875, "python-build-standalone license size"); literal(hash(artifacts.pythonBuildStandaloneLicenses.sha256, "python-build-standalone license hash"), "e43fb936c6655d7996dba480d7ebdea492d6040ec388eb8ed9d1000f72de8cab", "python-build-standalone license hash");
}
function checkPatches(patches) { record(patches, ["schemaVersion", "baseCommit", "patches"], "patch queue"); literal(patches.schemaVersion, "1", "patch queue schema"); literal(git(patches.baseCommit, "patch queue base"), "5fc308a70719a83cccdbba4c0e39c23f5a8239d5", "patch queue base"); if (array(patches.patches, "patches").length) fail("H1 patch queue must be empty"); }
function checkSbom(sbom, source) {
  record(sbom, ["bomFormat", "specVersion", "serialNumber", "metadata", "components", "dependencies"], "SBOM"); literal(sbom.bomFormat, "CycloneDX", "SBOM bomFormat"); literal(sbom.specVersion, "1.6", "SBOM specVersion");
  const serialized = JSON.stringify(sbom);
  if (serialized.includes(source.sbomSha256) || /sourceLockHash|timestamp|[A-Za-z]:\\|\/Users\//.test(serialized)) fail("SBOM contains a forbidden digest, timestamp, or host path");
  record(sbom.metadata, ["component", "properties"], "SBOM metadata");
  const properties = array(sbom.metadata.properties, "SBOM metadata properties");
  const propertyMap = new Map(properties.map((property) => [property?.name, property?.value]));
  const expectedProperties = {
    "jarvis:source-remote": source.remote, "jarvis:source-tag": source.tag, "jarvis:source-tag-object": source.tagObject, "jarvis:source-commit": source.sourceCommit, "jarvis:source-tree": source.sourceTree, "jarvis:source-acquisition": source.acquisitionMethod,
    "jarvis:source-license-sha256": source.rawFileSha256.LICENSE, "jarvis:source-pyproject-sha256": source.rawFileSha256["pyproject.toml"], "jarvis:source-uv-lock-sha256": source.rawFileSha256["uv.lock"],
    "jarvis:target": "windows-x86_64-cpython-3.11.16", "jarvis:extras": "", "jarvis:dev-mode": "false", "jarvis:install-mode": "runtime",
    "jarvis:closure-name-version-sha256": "3de6c3eeb3148f4b49cf48c5e8973487e82acbecd95131b8a50fc141276242a8", "jarvis:archive-records-sha256": "f3a08e3bf08e9d10d0e79338049028a89aa14b85a3d0120a86187e5578041d52", "jarvis:dependency-records-sha256": "8efcb478f48ae732c7d9f2432599425283c34c4dd972f43de1854f3271618f27",
  };
  if (properties.length !== Object.keys(expectedProperties).length || Object.entries(expectedProperties).some(([name, value]) => propertyMap.get(name) !== value)) fail("SBOM target provenance drift");
  const components = array(sbom.components, "SBOM components"); const dependencies = array(sbom.dependencies, "SBOM dependencies");
  const pypi = components.filter((component) => typeof component?.purl === "string" && component.purl.startsWith("pkg:pypi/"));
  if (pypi.length !== 66 || components.length !== 80 || dependencies.length !== 66) fail("SBOM does not contain the complete selected Windows closure and provenance");
  const refs = new Set();
  for (const component of pypi) {
    record(component, component.name === "hermes-agent" ? ["name", "purl", "type", "version"] : ["externalReferences", "hashes", "name", "properties", "purl", "type", "version"], "SBOM component");
    if (typeof component.purl !== "string" || !component.purl.startsWith("pkg:pypi/") || refs.has(component.purl)) fail("SBOM has a duplicate or invalid component"); refs.add(component.purl);
    if (component.name !== "hermes-agent") { if (array(component.hashes, "SBOM archive hashes").length !== 1 || component.hashes[0]?.alg !== "SHA-256" || !SHA256.test(component.hashes[0]?.content) || array(component.externalReferences, "SBOM archive reference").length !== 1 || component.externalReferences[0]?.type !== "distribution" || !String(component.externalReferences[0]?.url).startsWith("https://files.pythonhosted.org/") || array(component.properties, "SBOM archive properties").length !== 1 || component.properties[0]?.name !== "jarvis:archive-size" || !/^[1-9][0-9]*$/.test(component.properties[0]?.value ?? "")) fail("SBOM archive selection drift"); }
  }
  const seenDependencies = new Set();
  for (const dependency of dependencies) { record(dependency, ["dependsOn", "ref"], "SBOM dependency"); if (!refs.has(dependency.ref) || seenDependencies.has(dependency.ref)) fail("SBOM has duplicate or unknown dependency references"); seenDependencies.add(dependency.ref); for (const ref of array(dependency.dependsOn, "SBOM dependsOn")) if (!refs.has(ref)) fail("SBOM dependency escapes selected closure"); }
  if (seenDependencies.size !== refs.size || !refs.has("pkg:pypi/hermes-agent@0.20.6")) fail("SBOM closure is incomplete");
  const provenanceNames = components.filter((component) => !component?.purl).map((component) => component?.name).sort();
  const expectedProvenance = ["hermes-source", "patch-queue", "python-build-standalone-license-rollup", "runtime-artifacts-lock", "runtime-cpython", "runtime-uv", "runtime-winsw", "third-party-notices", "notice-CPython-LICENSE", "notice-Hermes-Agent-LICENSE", "notice-WinSW-LICENSE", "notice-python-build-standalone-licenses.rst", "notice-uv-APACHE-LICENSE", "notice-uv-LICENSE"].sort();
  if (provenanceNames.length !== expectedProvenance.length || provenanceNames.some((name, index) => name !== expectedProvenance[index])) fail("SBOM provenance component set drift");
  for (const component of components.filter((component) => !component?.purl)) { record(component, ["name", "properties", "type", "version"], "SBOM provenance component"); if (component.type !== "file" || !Array.isArray(component.properties) || component.properties.some((entry) => typeof entry?.name !== "string" || typeof entry?.value !== "string")) fail("SBOM provenance shape drift"); }
}

export async function validateHermesManifests({ source, artifacts, contract, patches, sbom }) {
  checkSource(source); checkArtifacts(artifacts); await checkContract(contract); checkPatches(patches); checkSbom(sbom, source);
  const contractHash = await sha256Hex(canonicalize(contract));
  if (source.runsEventContractHash !== contractHash) fail("Runs contract hash does not bind source lock");
  const patchHash = await sha256Hex(canonicalize(patches));
  if (source.patchQueue.sha256 !== patchHash) fail("patch queue hash does not bind source lock");
  const sbomHash = await sha256Hex(canonicalize(sbom));
  if (source.sbomSha256 !== sbomHash) fail("SBOM hash does not bind source lock");
  return Object.freeze({ jarvisH0Commit: source.jarvisH0Commit, sourceCommit: source.sourceCommit, runsEventContractHash: contractHash });
}

export async function validateRunsWireArtifacts({ contract, wireSchema, wireGolden }) {
  await checkContract(contract);
  record(contract.wireArtifacts, ["schema", "golden"], "Runs wire artifact bindings");
  for (const [name, value] of Object.entries({ schema: wireSchema, golden: wireGolden })) {
    const binding = contract.wireArtifacts[name];
    record(binding, ["file", "canonicalSha256"], `Runs wire ${name} binding`);
    hash(binding.canonicalSha256, `Runs wire ${name} canonical hash`);
    if (await sha256Hex(canonicalize(value)) !== binding.canonicalSha256) fail(`Runs wire ${name} does not match its contract binding`);
  }
}

export { canonicalize, sha256Hex };

async function loadCommittedJson(relativePath) {
  return JSON.parse(await readFile(new URL(relativePath, import.meta.url), "utf8"));
}

async function runCli() {
  const [source, artifacts, contract, patches, sbom, wireSchema, wireGolden] = await Promise.all([
    loadCommittedJson("../hermes-source-lock.json"),
    loadCommittedJson("../runtime-artifacts-lock.json"),
    loadCommittedJson("../contracts/hermes-runs-api-v2026.8.27.json"),
    loadCommittedJson("../patches/series.json"),
    loadCommittedJson("../sbom/hermes-agent-v2026.8.27-windows-x86_64-cpython-3.11.16.cdx.json"),
    loadCommittedJson("../schemas/hermes-runs-wire-v2026.8.27.schema.json"),
    loadCommittedJson("../test/fixtures/runs-wire-golden-v1.json"),
  ]);
  await validateHermesManifests({ source, artifacts, contract, patches, sbom });
  await validateRunsWireArtifacts({ contract, wireSchema, wireGolden });
  if (await sha256Hex(await readFile(new URL("../sbom/hermes-agent-v2026.8.27-windows-x86_64-cpython-3.11.16.cdx.json", import.meta.url))) !== source.sbomFileSha256) fail("SBOM LF file digest does not bind source lock");
  process.stdout.write("Hermes H1 manifests valid\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().catch(() => { process.stderr.write("Hermes H1 manifest validation failed\n"); process.exitCode = 1; });
}
