import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { canonicalize, loadCanonicalJsonFile, sha256Hex } from "./canonical-json.mjs";

const H0 = "814535de21df37e6abac1f63e5953d693b78e003";
const CONTRACT_SHA256 = "655b3829a8f5cc41c9f128e05a1375fd0cdfbfe03b0bde611732d71e94e3f44b";
const CONTRACT_FILE_SHA256 = "8c05cf83d48852e314dc78bd29b6d4bd54c844a40024bd41648f538f0badc7d0";
const SBOM_SHA256 = "6d9a89a1d8da27742a16b3c5f30656b6396672dd9869fec746f8eac657241b59";
const SBOM_FILE_SHA256 = "45677f81e6f3a741c4e9074695b37a9b4e46c4a1b64b837b57174459a4e47ae0";
const RUNTIME_LOCK_FILE_SHA256 = "c82f94702c037a0890b8f155cf70a81efb7e82fd213c6cba597cc1ea8a90d2d7";
const THIRD_PARTY_NOTICES_SHA256 = "52e851ebf6bf6844566798c59085dcee17c3ad1226dcb426879443b5a18d1f41";
const CLOSURE_SHA256 = "3de6c3eeb3148f4b49cf48c5e8973487e82acbecd95131b8a50fc141276242a8";
const DISTRIBUTION_RECORDS_SHA256 = "1681f6dba140be455ed15bf9f21d9540541ca8f10c98cc9f22412536a14189e8";
const ARCHIVE_RECORDS_SHA256 = "5433972607296e6ace1155482d1af15575f2aae75821781a67409f60147eb31a";
const DEPENDENCY_RECORDS_SHA256 = "8efcb478f48ae732c7d9f2432599425283c34c4dd972f43de1854f3271618f27";
const SHA256 = /^[a-f0-9]{64}$/;
const GIT = /^[a-f0-9]{40}$/;
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
function compareCanonical(actual, expected, label) {
  const left = canonicalize(actual); const right = canonicalize(expected);
  if (left.length !== right.length || left.some((byte, index) => byte !== right[index])) fail(`${label} drift`);
}
function property(name, value) { return { name, value: String(value) }; }
function provenanceComponent(name, version, properties) { return { type: "file", name, version, properties }; }
function purl(name, version) { return `pkg:pypi/${name}@${version}`; }

const reviewedLicenseHashes = Object.freeze({
  "licenses/CPython-LICENSE": "886a0ead2d89030ee62dbff52b04e47ab91998341295bb9c56fb952b4e081c7a",
  "licenses/Hermes-Agent-LICENSE": "821556e6336796450ab852d375117b48a4887e71d255794fd6318d99982a5ab6",
  "licenses/WinSW-LICENSE": "1cdf703c10a70e5973bf3acf2a5eeabe7746237155b92db2034aeae26fdf7802",
  "licenses/python-build-standalone-licenses.rst": "e43fb936c6655d7996dba480d7ebdea492d6040ec388eb8ed9d1000f72de8cab",
  "licenses/uv-APACHE-LICENSE": "c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4",
  "licenses/uv-LICENSE": "860e3d7a86b84e6a7012c7a635fc64df475cebc6cce34dfeb73a5982ec58176c",
});

async function checkContract(contract) {
  if (await sha256Hex(canonicalize(contract)) !== CONTRACT_SHA256) fail("Runs contract drifted from the closed profile");
}

function checkSource(source) {
  record(source, ["schemaVersion", "jarvisH0Commit", "remote", "tag", "tagObject", "sourceCommit", "sourceTree", "packageVersion", "rawFileSha256", "acquisitionMethod", "submodules", "model", "pythonVersion", "runsEventContractHash", "runsEventContractFileSha256", "patchQueue", "licenses", "thirdPartyNotices", "sbom", "sbomSha256", "sbomFileSha256"], "source lock");
  literal(source.schemaVersion, "1", "source lock schemaVersion"); literal(source.jarvisH0Commit, H0, "jarvisH0Commit"); url(source.remote, "source remote"); literal(source.tag, "v2026.8.27", "source tag"); literal(git(source.tagObject, "tagObject"), "fcebd62163497e77e5de00d26d2ed86cb4ef8761", "tagObject"); literal(git(source.sourceCommit, "sourceCommit"), "5fc308a70719a83cccdbba4c0e39c23f5a8239d5", "sourceCommit"); literal(git(source.sourceTree, "sourceTree"), "222ec43b5237deb643277bc2f64fa4b873dd7f28", "sourceTree"); literal(source.packageVersion, "0.20.6", "packageVersion");
  record(source.rawFileSha256, ["LICENSE", "pyproject.toml", "uv.lock"], "rawFileSha256"); literal(hash(source.rawFileSha256.LICENSE, "LICENSE"), "821556e6336796450ab852d375117b48a4887e71d255794fd6318d99982a5ab6", "LICENSE"); literal(hash(source.rawFileSha256["pyproject.toml"], "pyproject.toml"), "9b6d41aca6d908e5af2f90a335b1c2b7eeaf8e3ce667b5a823a73e8643c56c75", "pyproject.toml"); literal(hash(source.rawFileSha256["uv.lock"], "uv.lock"), "5a9276183671e997c2213ede18b9cda4920e1cf57616219a3b08ddebda3281ab", "uv.lock");
  literal(source.acquisitionMethod, "git-detached", "acquisitionMethod"); if (array(source.submodules, "submodules").length) fail("submodules must be empty"); literal(source.model, "deepseek-v4-pro", "model"); literal(source.pythonVersion, "3.11.16", "pythonVersion"); literal(hash(source.runsEventContractHash, "runsEventContractHash"), CONTRACT_SHA256, "runsEventContractHash"); literal(hash(source.runsEventContractFileSha256, "runsEventContractFileSha256"), CONTRACT_FILE_SHA256, "runsEventContractFileSha256");
  record(source.patchQueue, ["file", "sha256"], "patchQueue"); literal(source.patchQueue.file, "patches/series.json", "patch queue file"); literal(hash(source.patchQueue.sha256, "patch queue hash"), "1d4737670634f5e39a497e9784c06a3179261cc00f8bf4dbbe49f0404c0ec456", "patch queue hash");
  record(source.licenses, ["files"], "licenses"); record(source.licenses.files, Object.keys(reviewedLicenseHashes), "licenses.files"); for (const [path, expected] of Object.entries(reviewedLicenseHashes)) literal(hash(source.licenses.files[path], path), expected, path);
  record(source.thirdPartyNotices, ["file", "sha256"], "thirdPartyNotices"); literal(source.thirdPartyNotices.file, "THIRD_PARTY_NOTICES.md", "third party notice file"); literal(hash(source.thirdPartyNotices.sha256, "third party notices hash"), THIRD_PARTY_NOTICES_SHA256, "third party notices hash");
  record(source.sbom, ["file", "format"], "sbom"); literal(source.sbom.file, "sbom/hermes-agent-v2026.8.27-windows-x86_64-cpython-3.11.16.cdx.json", "SBOM file"); literal(source.sbom.format, "CycloneDX-1.6", "SBOM format"); literal(hash(source.sbomSha256, "sbomSha256"), SBOM_SHA256, "sbomSha256"); literal(hash(source.sbomFileSha256, "sbomFileSha256"), SBOM_FILE_SHA256, "sbomFileSha256");
}

function checkArtifact(artifact, name, expected) {
  record(artifact, ["version", "fileName", "url", "architecture", "size", "sha256", "licenses"], name);
  literal(artifact.version, expected.version, `${name}.version`); literal(artifact.fileName, expected.fileName, `${name}.fileName`); url(artifact.url, `${name}.url`); literal(artifact.url, expected.url, `${name}.url`); literal(artifact.architecture, expected.architecture, `${name}.architecture`); literal(artifact.size, expected.size, `${name}.size`); literal(hash(artifact.sha256, `${name}.sha256`), expected.sha256, `${name}.sha256`);
  const licenses = array(artifact.licenses, `${name}.licenses`); if (licenses.length !== expected.licenses.length || licenses.some((license, index) => license !== expected.licenses[index])) fail(`${name}.licenses is not the reviewed exact array`);
}

function checkArtifacts(artifacts) {
  record(artifacts, ["schemaVersion", "cpython", "uv", "winsw", "pythonBuildStandaloneLicenses"], "artifact lock"); literal(artifacts.schemaVersion, "1", "artifact lock schemaVersion");
  checkArtifact(artifacts.cpython, "cpython", { version: "3.11.16+20260825", fileName: "cpython-3.11.16+20260825-x86_64-pc-windows-msvc-install_only_stripped.tar.gz", url: "https://github.com/astral-sh/python-build-standalone/releases/download/20260825/cpython-3.11.16%2B20260825-x86_64-pc-windows-msvc-install_only_stripped.tar.gz", architecture: "x86_64-pc-windows-msvc", size: 25723669, sha256: "f91242b07e318d2540f9da71162b92d494c39745abde9b994d7d906756453fc9", licenses: ["Python-2.0", "CNRI-Python", "bundled-component-licenses"] });
  checkArtifact(artifacts.uv, "uv", { version: "0.12.7", fileName: "uv-x86_64-pc-windows-msvc.zip", url: "https://github.com/astral-sh/uv/releases/download/0.12.7/uv-x86_64-pc-windows-msvc.zip", architecture: "x86_64-pc-windows-msvc", size: 16979508, sha256: "bf1518af459a3915511a11fdc6e2f43ef9a2afa138b9d498eeb9642fe9d85218", licenses: ["MIT", "Apache-2.0"] });
  checkArtifact(artifacts.winsw, "winsw", { version: "2.12.0", fileName: "WinSW-x64.exe", url: "https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW-x64.exe", architecture: "amd64-pe", size: 18243033, sha256: "05b82d46ad331cc16bdc00de5c6332c1ef818df8ceefcd49c726553209b3a0da", licenses: ["MIT"] });
  record(artifacts.pythonBuildStandaloneLicenses, ["url", "size", "sha256"], "python-build-standalone licenses"); url(artifacts.pythonBuildStandaloneLicenses.url, "python-build-standalone license URL"); literal(artifacts.pythonBuildStandaloneLicenses.size, 105875, "python-build-standalone license size"); literal(hash(artifacts.pythonBuildStandaloneLicenses.sha256, "python-build-standalone license hash"), "e43fb936c6655d7996dba480d7ebdea492d6040ec388eb8ed9d1000f72de8cab", "python-build-standalone license hash");
}

function checkPatches(patches) {
  record(patches, ["schemaVersion", "baseCommit", "patches"], "patch queue"); literal(patches.schemaVersion, "1", "patch queue schema"); literal(git(patches.baseCommit, "patch queue base"), "5fc308a70719a83cccdbba4c0e39c23f5a8239d5", "patch queue base"); if (array(patches.patches, "patches").length) fail("H1 patch queue must be empty");
}

function runtimeProperties(source) {
  return [
    property("jarvis:source-remote", source.remote), property("jarvis:source-tag", source.tag), property("jarvis:source-tag-object", source.tagObject), property("jarvis:source-commit", source.sourceCommit), property("jarvis:source-tree", source.sourceTree), property("jarvis:source-acquisition", source.acquisitionMethod), property("jarvis:source-license-sha256", source.rawFileSha256.LICENSE), property("jarvis:source-pyproject-sha256", source.rawFileSha256["pyproject.toml"]), property("jarvis:source-uv-lock-sha256", source.rawFileSha256["uv.lock"]), property("jarvis:target", "windows-x86_64-cpython-3.11.16"), property("jarvis:extras", ""), property("jarvis:dev-mode", "false"), property("jarvis:install-mode", "runtime"), property("jarvis:closure-name-version-sha256", CLOSURE_SHA256), property("jarvis:archive-records-sha256", ARCHIVE_RECORDS_SHA256), property("jarvis:dependency-records-sha256", DEPENDENCY_RECORDS_SHA256),
  ];
}

async function expectedProvenance(source, artifacts, patches) {
  return [
    provenanceComponent("hermes-source", source.tag, runtimeProperties(source).slice(0, 8)),
    ...["cpython", "uv", "winsw"].map((name) => provenanceComponent(`runtime-${name}`, artifacts[name].version, [property("jarvis:file", artifacts[name].fileName), property("jarvis:url", artifacts[name].url), property("jarvis:sha256", artifacts[name].sha256), property("jarvis:size", artifacts[name].size), property("jarvis:licenses", artifacts[name].licenses.join(","))])),
    provenanceComponent("python-build-standalone-license-rollup", "20260825", [property("jarvis:url", artifacts.pythonBuildStandaloneLicenses.url), property("jarvis:sha256", artifacts.pythonBuildStandaloneLicenses.sha256), property("jarvis:size", artifacts.pythonBuildStandaloneLicenses.size)]),
    provenanceComponent("runtime-artifacts-lock", "1", [property("jarvis:canonical-sha256", await sha256Hex(canonicalize(artifacts))), property("jarvis:file-sha256", RUNTIME_LOCK_FILE_SHA256)]),
    provenanceComponent("patch-queue", "1", [property("jarvis:canonical-sha256", await sha256Hex(canonicalize(patches))), property("jarvis:patch-count", patches.patches.length)]),
    provenanceComponent("third-party-notices", "1", [property("jarvis:file-sha256", THIRD_PARTY_NOTICES_SHA256)]),
    ...Object.entries(source.licenses.files).sort(([left], [right]) => left.localeCompare(right)).map(([path, digest]) => provenanceComponent(`notice-${path.split("/").at(-1)}`, "pinned", [property("jarvis:path", path), property("jarvis:sha256", digest)])),
  ];
}

export async function validateSbomIntegrity({ source, artifacts, patches, sbom }) {
  checkSource(source); checkArtifacts(artifacts); checkPatches(patches);
  record(sbom, ["bomFormat", "specVersion", "serialNumber", "metadata", "components", "dependencies"], "SBOM"); literal(sbom.bomFormat, "CycloneDX", "SBOM bomFormat"); literal(sbom.specVersion, "1.6", "SBOM specVersion"); literal(sbom.serialNumber, "urn:uuid:0af49a54-f5d7-51d2-9f0e-f5906c157e9a", "SBOM serialNumber");
  const serialized = JSON.stringify(sbom); if (serialized.includes(source.sbomSha256) || /sourceLockHash|timestamp|[A-Za-z]:\\|\/Users\//.test(serialized)) fail("SBOM contains a forbidden digest, timestamp, or host path");
  record(sbom.metadata, ["component", "properties"], "SBOM metadata"); compareCanonical(sbom.metadata.component, { type: "application", name: "hermes-agent", version: "0.20.6", purl: "pkg:pypi/hermes-agent@0.20.6" }, "SBOM metadata component"); compareCanonical(array(sbom.metadata.properties, "SBOM metadata properties"), runtimeProperties(source), "SBOM metadata properties");

  const components = array(sbom.components, "SBOM components"); const dependencies = array(sbom.dependencies, "SBOM dependencies");
  const distributions = components.filter((component) => typeof component?.purl === "string" && component.purl.startsWith("pkg:pypi/"));
  const provenance = components.filter((component) => !(typeof component?.purl === "string" && component.purl.startsWith("pkg:pypi/")));
  if (distributions.length !== 66 || provenance.length !== 14 || components.length !== 80 || dependencies.length !== 66) fail("SBOM does not contain the complete selected Windows closure and provenance");
  const byRef = new Map(); const distributionRecords = []; const archiveRecords = [];
  for (const component of distributions) {
    const isApplication = component.name === "hermes-agent";
    record(component, isApplication ? ["name", "purl", "type", "version"] : ["externalReferences", "hashes", "name", "properties", "purl", "type", "version"], "SBOM distribution component");
    if (typeof component.name !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(component.name) || typeof component.version !== "string" || component.version.length === 0) fail("SBOM distribution identity drift");
    literal(component.purl, purl(component.name, component.version), `SBOM ${component.name} purl`); literal(component.type, isApplication ? "application" : "library", `SBOM ${component.name} type`); if (byRef.has(component.purl)) fail("SBOM has a duplicate component"); byRef.set(component.purl, component);
    distributionRecords.push({ name: component.name, version: component.version, type: component.type, purl: component.purl });
    if (!isApplication) {
      const hashes = array(component.hashes, `SBOM ${component.name} hashes`); const references = array(component.externalReferences, `SBOM ${component.name} externalReferences`); const properties = array(component.properties, `SBOM ${component.name} properties`);
      if (hashes.length !== 1 || references.length !== 1 || properties.length !== 1) fail(`SBOM ${component.name} archive cardinality drift`);
      record(hashes[0], ["alg", "content"], `SBOM ${component.name} hash`); literal(hashes[0].alg, "SHA-256", `SBOM ${component.name} hash algorithm`); hash(hashes[0].content, `SBOM ${component.name} archive hash`);
      record(references[0], ["type", "url"], `SBOM ${component.name} reference`); literal(references[0].type, "distribution", `SBOM ${component.name} reference type`); if (typeof references[0].url !== "string" || !references[0].url.startsWith("https://files.pythonhosted.org/packages/")) fail(`SBOM ${component.name} archive URL drift`);
      record(properties[0], ["name", "value"], `SBOM ${component.name} archive property`); literal(properties[0].name, "jarvis:archive-size", `SBOM ${component.name} archive property`); if (!/^[1-9][0-9]*$/.test(properties[0].value ?? "") || !Number.isSafeInteger(Number(properties[0].value))) fail(`SBOM ${component.name} archive size drift`);
      archiveRecords.push({ name: component.name, version: component.version, url: references[0].url, size: Number(properties[0].value), sha256: hashes[0].content });
    }
  }
  distributionRecords.sort((left, right) => left.name.localeCompare(right.name) || left.version.localeCompare(right.version)); archiveRecords.sort((left, right) => left.name.localeCompare(right.name) || left.version.localeCompare(right.version));
  const closure = distributionRecords.map((component) => `${component.name}==${component.version}`).sort();
  literal(await sha256Hex(canonicalize(closure)), CLOSURE_SHA256, "SBOM closure record hash"); literal(await sha256Hex(canonicalize(distributionRecords)), DISTRIBUTION_RECORDS_SHA256, "SBOM distribution record hash"); literal(await sha256Hex(canonicalize(archiveRecords)), ARCHIVE_RECORDS_SHA256, "SBOM archive record hash"); literal(archiveRecords.reduce((sum, archive) => sum + archive.size, 0), 41417102, "SBOM selected archive bytes");

  const seenDependencies = new Set(); const dependencyRecords = [];
  for (const dependency of dependencies) {
    record(dependency, ["dependsOn", "ref"], "SBOM dependency"); if (typeof dependency.ref !== "string" || !byRef.has(dependency.ref) || seenDependencies.has(dependency.ref)) fail("SBOM has duplicate or unknown dependency references"); seenDependencies.add(dependency.ref);
    const dependsOn = array(dependency.dependsOn, "SBOM dependsOn"); if (dependsOn.some((reference) => typeof reference !== "string" || !byRef.has(reference)) || new Set(dependsOn).size !== dependsOn.length || dependsOn.some((reference, index) => index > 0 && dependsOn[index - 1].localeCompare(reference) >= 0)) fail("SBOM dependency edge drift");
    const component = byRef.get(dependency.ref); dependencyRecords.push({ name: component.name, version: component.version, dependsOn: dependsOn.map((reference) => byRef.get(reference).name).sort() });
  }
  if (seenDependencies.size !== byRef.size) fail("SBOM dependency coverage drift"); dependencyRecords.sort((left, right) => left.name.localeCompare(right.name) || left.version.localeCompare(right.version)); literal(await sha256Hex(canonicalize(dependencyRecords)), DEPENDENCY_RECORDS_SHA256, "SBOM dependency record hash");

  const expected = await expectedProvenance(source, artifacts, patches); const expectedByName = new Map(expected.map((component) => [component.name, component]));
  if (expectedByName.size !== provenance.length) fail("SBOM provenance component set drift");
  for (const component of provenance) {
    record(component, ["name", "properties", "type", "version"], "SBOM provenance component"); if (typeof component.name !== "string" || !expectedByName.has(component.name)) fail("SBOM provenance component set drift"); compareCanonical(component, expectedByName.get(component.name), `SBOM provenance ${component.name}`); expectedByName.delete(component.name);
  }
  if (expectedByName.size) fail("SBOM provenance component set drift");
}

export async function validateHermesManifests({ source, artifacts, contract, patches, sbom }) {
  checkSource(source); checkArtifacts(artifacts); await checkContract(contract); checkPatches(patches); await validateSbomIntegrity({ source, artifacts, patches, sbom });
  const contractHash = await sha256Hex(canonicalize(contract)); if (source.runsEventContractHash !== contractHash) fail("Runs contract hash does not bind source lock");
  const patchHash = await sha256Hex(canonicalize(patches)); if (source.patchQueue.sha256 !== patchHash) fail("patch queue hash does not bind source lock");
  const sbomHash = await sha256Hex(canonicalize(sbom)); if (source.sbomSha256 !== sbomHash) fail("SBOM hash does not bind source lock");
  return Object.freeze({ jarvisH0Commit: source.jarvisH0Commit, sourceCommit: source.sourceCommit, runsEventContractHash: contractHash });
}

export async function validateRunsWireArtifacts({ contract, wireSchema, wireGolden }) {
  await checkContract(contract); record(contract.wireArtifacts, ["schema", "golden"], "Runs wire artifact bindings");
  for (const [name, value] of Object.entries({ schema: wireSchema, golden: wireGolden })) {
    const binding = contract.wireArtifacts[name]; record(binding, ["file", "canonicalSha256", "fileSha256"], `Runs wire ${name} binding`); hash(binding.canonicalSha256, `Runs wire ${name} canonical hash`); hash(binding.fileSha256, `Runs wire ${name} file hash`); if (await sha256Hex(canonicalize(value)) !== binding.canonicalSha256) fail(`Runs wire ${name} does not match its contract binding`);
  }
}

export { canonicalize, sha256Hex };

async function fileSha256(url) { return sha256Hex(await readFile(url)); }

async function runCli() {
  const [sourceFile, artifactsFile, contractFile, patchesFile, sbomFile, wireSchemaFile, wireGoldenFile, sourceSchemaFile, artifactsSchemaFile] = await Promise.all([
    loadCanonicalJsonFile(new URL("../hermes-source-lock.json", import.meta.url), "Hermes source lock"),
    loadCanonicalJsonFile(new URL("../runtime-artifacts-lock.json", import.meta.url), "runtime artifacts lock"),
    loadCanonicalJsonFile(new URL("../contracts/hermes-runs-api-v2026.8.27.json", import.meta.url), "Runs contract"),
    loadCanonicalJsonFile(new URL("../patches/series.json", import.meta.url), "patch queue"),
    loadCanonicalJsonFile(new URL("../sbom/hermes-agent-v2026.8.27-windows-x86_64-cpython-3.11.16.cdx.json", import.meta.url), "Hermes SBOM"),
    loadCanonicalJsonFile(new URL("../schemas/hermes-runs-wire-v2026.8.27.schema.json", import.meta.url), "Runs wire schema"),
    loadCanonicalJsonFile(new URL("../test/fixtures/runs-wire-golden-v1.json", import.meta.url), "Runs wire golden"),
    loadCanonicalJsonFile(new URL("../schemas/hermes-source-lock-v1.schema.json", import.meta.url), "Hermes source-lock schema"),
    loadCanonicalJsonFile(new URL("../schemas/runtime-artifacts-lock-v1.schema.json", import.meta.url), "runtime artifacts-lock schema"),
  ]);
  const source = sourceFile.value; const artifacts = artifactsFile.value; const contract = contractFile.value; const patches = patchesFile.value; const sbom = sbomFile.value;
  await validateHermesManifests({ source, artifacts, contract, patches, sbom }); await validateRunsWireArtifacts({ contract, wireSchema: wireSchemaFile.value, wireGolden: wireGoldenFile.value });
  literal(contractFile.fileSha256, source.runsEventContractFileSha256, "Runs contract raw file binding"); literal(wireSchemaFile.fileSha256, contract.wireArtifacts.schema.fileSha256, "Runs schema raw file binding"); literal(wireGoldenFile.fileSha256, contract.wireArtifacts.golden.fileSha256, "Runs golden raw file binding"); literal(sbomFile.fileSha256, source.sbomFileSha256, "SBOM raw file binding");
  compareCanonical(sourceSchemaFile.value.const, source, "source schema exact pin"); compareCanonical(artifactsSchemaFile.value.const, artifacts, "runtime schema exact pin");
  literal(await fileSha256(new URL("../THIRD_PARTY_NOTICES.md", import.meta.url)), source.thirdPartyNotices.sha256, "THIRD_PARTY_NOTICES raw bytes");
  for (const [path, expected] of Object.entries(source.licenses.files)) literal(await fileSha256(new URL(`../${path}`, import.meta.url)), expected, `${path} raw bytes`);
  process.stdout.write("Hermes H1 manifests valid\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().catch(() => { process.stderr.write("Hermes H1 manifest validation failed\n"); process.exitCode = 1; });
}
