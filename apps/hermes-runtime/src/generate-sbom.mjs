import TOML from "@iarna/toml";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalize, sha256Hex } from "./canonical-json.mjs";

const output = new URL("../sbom/hermes-agent-v2026.8.27-windows-x86_64-cpython-3.11.16.cdx.json", import.meta.url);
const sourceLockPath = new URL("../hermes-source-lock.json", import.meta.url);
const runtimeLockPath = new URL("../runtime-artifacts-lock.json", import.meta.url);
const patchQueuePath = new URL("../patches/series.json", import.meta.url);
const noticesPath = new URL("../THIRD_PARTY_NOTICES.md", import.meta.url);
const sha256 = /^[a-f0-9]{64}$/;
const target = Object.freeze({ implementation_name: "cpython", implementation_version: "3.11.16", os_name: "nt", platform_machine: "AMD64", platform_python_implementation: "CPython", platform_system: "Windows", platform_release: "", python_full_version: "3.11.16", python_version: "3.11", sys_platform: "win32" });

export function normalizedName(name) { if (typeof name !== "string" || !/^[A-Za-z0-9_.-]+$/.test(name)) throw new TypeError("invalid normalized package name"); return name.toLowerCase().replace(/[_.-]+/g, "-"); }

// Parser rather than regex heuristics: lock markers are PEP 508 expressions.
function markerTokens(expression) {
  const tokens = []; let index = 0;
  while (index < expression.length) {
    if (/\s/.test(expression[index])) { index += 1; continue; }
    if (expression[index] === "'" || expression[index] === '"') { const quote = expression[index++]; let value = ""; while (index < expression.length && expression[index] !== quote) { if (expression[index] === "\\" && index + 1 < expression.length) index += 1; value += expression[index++]; } if (expression[index++] !== quote) throw new TypeError("unterminated PEP 508 marker string"); tokens.push({ kind: "string", value }); continue; }
    const match = /^(not\s+in|===|==|!=|<=|>=|<|>|\(|\)|[A-Za-z_][A-Za-z0-9_]*)/.exec(expression.slice(index));
    if (!match) throw new TypeError(`invalid PEP 508 marker near ${expression.slice(index, index + 16)}`);
    index += match[0].length; const value = match[0].replace(/\s+/g, " "); tokens.push({ kind: /^(?:===|==|!=|<=|>=|<|>|not in)$/.test(value) ? "operator" : /^(?:and|or|in)$/.test(value) ? "keyword" : value === "(" || value === ")" ? value : "identifier", value });
  }
  return tokens;
}
function pep440Parts(value) {
  const match = /^(?:v)?(?:(\d+)!)?(\d+(?:\.\d+)*)(?:(a|b|rc)(\d+))?(?:\.post(\d+))?(?:\.dev(\d+))?(?:\+([a-z0-9]+(?:[._-][a-z0-9]+)*))?$/i.exec(value);
  if (!match) throw new TypeError(`unsupported PEP 440 marker version: ${value}`);
  const release = match[2].split(".").map(Number); while (release.length > 1 && release.at(-1) === 0) release.pop();
  return { epoch: Number(match[1] ?? 0), release, pre: match[3] ? [({ a: 0, b: 1, rc: 2 })[match[3].toLowerCase()], Number(match[4])] : [3, 0], post: Number(match[5] ?? -1), dev: match[6] === undefined ? Number.POSITIVE_INFINITY : Number(match[6]), local: match[7] ?? "" };
}
function comparePep440(left, right) {
  const a = pep440Parts(left); const b = pep440Parts(right); const compare = (x, y) => x < y ? -1 : x > y ? 1 : 0; let result = compare(a.epoch, b.epoch); if (result) return result;
  for (let i = 0; i < Math.max(a.release.length, b.release.length); i += 1) { result = compare(a.release[i] ?? 0, b.release[i] ?? 0); if (result) return result; }
  for (const [av, bv] of [[a.pre, b.pre]]) for (let i = 0; i < 2; i += 1) { result = compare(av[i], bv[i]); if (result) return result; }
  for (const key of ["post", "dev"]) { result = compare(a[key], b[key]); if (result) return result; }
  return a.local.localeCompare(b.local);
}
function markerCompare(left, operator, right) {
  if (operator === "in" || operator === "not in") { const found = right.value.split(",").map((item) => item.trim()).includes(left.value); return operator === "in" ? found : !found; }
  if (right.value.endsWith(".*")) {
    if (operator !== "==" && operator !== "!=") throw new TypeError("PEP 440 wildcard only supports equality markers");
    const equal = left.value === right.value.slice(0, -2) || left.value.startsWith(`${right.value.slice(0, -2)}.`);
    return operator === "==" ? equal : !equal;
  }
  const comparison = /version/.test(left.kind) || /version/.test(right.kind) ? comparePep440(left.value, right.value) : left.value.localeCompare(right.value);
  return ({ "===": left.value === right.value, "==": comparison === 0, "!=": comparison !== 0, "<": comparison < 0, "<=": comparison <= 0, ">": comparison > 0, ">=": comparison >= 0 })[operator];
}
export function markerApplies(expression = "", extras = new Set()) {
  if (typeof expression !== "string" || expression === "") return true;
  const tokens = markerTokens(expression); let cursor = 0;
  const consume = (kind, value) => { const token = tokens[cursor]; if (!token || token.kind !== kind || (value && token.value !== value)) return undefined; cursor += 1; return token; };
  const value = () => { const token = consume("string") ?? consume("identifier"); if (!token) throw new TypeError("expected marker value"); if (token.kind === "identifier") { if (token.value === "extra") return { kind: "extra", value: [...extras].sort().join(",") }; if (!(token.value in target)) throw new TypeError(`unknown PEP 508 marker variable: ${token.value}`); return { kind: token.value, value: target[token.value] }; } return { kind: "literal", value: token.value }; };
  const atom = () => { if (consume("(")) { const result = disjunction(); if (!consume(")")) throw new TypeError("unclosed PEP 508 marker parentheses"); return result; } const left = value(); let operator = consume("operator") ?? consume("keyword", "in"); if (!operator && consume("identifier", "not")) { const inToken = consume("keyword", "in"); if (inToken) operator = { kind: "operator", value: "not in" }; } if (!operator) throw new TypeError("expected PEP 508 marker comparison"); const right = value(); if (left.kind === "extra") return [...extras].some((extra) => markerCompare({ kind: "extra", value: extra }, operator.value, right)); return markerCompare(left, operator.value, right); };
  const conjunction = () => { let result = atom(); while (consume("keyword", "and")) result = atom() && result; return result; };
  const disjunction = () => { let result = conjunction(); while (consume("keyword", "or")) result = conjunction() || result; return result; };
  const result = disjunction(); if (cursor !== tokens.length) throw new TypeError("trailing PEP 508 marker expression"); return result;
}

function packageMap(lock) {
  if (!lock || !Array.isArray(lock.package)) throw new TypeError("uv.lock must contain a package array");
  const candidates = new Map();
  for (const item of lock.package) {
    if (!item || typeof item !== "object" || typeof item.name !== "string" || typeof item.version !== "string") throw new TypeError("invalid uv.lock package");
    const name = normalizedName(item.name); candidates.set(name, [...(candidates.get(name) ?? []), { ...item, name }]);
  }
  const packages = new Map();
  for (const [name, variants] of candidates) {
    const selected = variants.filter((item) => {
      const markers = item["resolution-markers"];
      return markers === undefined || (Array.isArray(markers) && markers.some((marker) => typeof marker === "string" && markerApplies(marker)));
    });
    if (selected.length !== 1) throw new TypeError(`ambiguous or missing target uv.lock package: ${name}`);
    packages.set(name, selected[0]);
  }
  return packages;
}
function dependenciesFor(item, extras) { const direct = Array.isArray(item.dependencies) ? item.dependencies : []; const optional = item["optional-dependencies"] ?? {}; if (!optional || typeof optional !== "object" || Array.isArray(optional)) throw new TypeError(`invalid optional dependencies: ${item.name}`); return [...direct, ...[...extras].sort().flatMap((extra) => optional[extra] ?? [])].filter((dependency) => { if (!dependency || typeof dependency.name !== "string" || (dependency.marker !== undefined && typeof dependency.marker !== "string")) throw new TypeError(`invalid dependency: ${item.name}`); return markerApplies(dependency.marker, extras); }); }
function parseWheel(url) { const file = new URL(url).pathname.split("/").at(-1); if (!file.endsWith(".whl")) return undefined; const values = file.slice(0, -4).split("-"); if (values.length < 5) return undefined; const [python, abi, platform] = values.slice(-3); return { python: python.split("."), abi: abi.split("."), platform: platform.split(".") }; }
export function wheelRank(url) { const tags = parseWheel(url); if (!tags) return undefined; const platform = tags.platform.includes("win_amd64") ? 0 : tags.platform.includes("any") ? 100 : undefined; if (platform === undefined) return undefined; if (platform === 100) return tags.abi.includes("none") && tags.python.includes("py2") && tags.python.includes("py3") ? 310 : tags.abi.includes("none") && tags.python.includes("py3") ? 300 : undefined; if (tags.python.includes("cp311") && tags.abi.includes("cp311")) return 0; if (tags.python.includes("cp311") && tags.abi.includes("abi3")) return 10; const abi3 = tags.abi.includes("abi3") && tags.python.map((tag) => /^cp3(\d+)$/.exec(tag)?.[1]).filter(Boolean).map(Number).filter((minor) => minor <= 11).sort((a, b) => b - a)[0]; return abi3 ? 20 + (11 - abi3) : undefined; }
export function selectArchive(item) {
  const candidates = (Array.isArray(item.wheels) ? item.wheels : []).map((wheel) => ({ ...wheel, rank: wheelRank(wheel.url) })).filter((wheel) => wheel.rank !== undefined);
  // charset-normalizer's reviewed lock selection is its portable py3 wheel;
  // the platform wheel is optional acceleration, not a runtime requirement.
  if (item.name === "charset-normalizer") for (const wheel of candidates) if (/-py3-none-any\.whl$/i.test(wheel.url)) wheel.rank = -1;
  candidates.sort((left, right) => left.rank - right.rank || left.url.localeCompare(right.url)); const chosen = candidates[0] ?? item.sdist;
  if (!chosen || typeof chosen.url !== "string" || !sha256.test(String(chosen.hash ?? "").replace("sha256:", "")) || !Number.isSafeInteger(chosen.size) || chosen.size < 1) throw new TypeError(`no pinned Windows x64 CPython 3.11 archive for ${item.name}@${item.version}`);
  return { url: chosen.url, hash: chosen.hash.replace("sha256:", ""), size: chosen.size };
}
export function selectedClosure(lock) { const packages = packageMap(lock); const selected = new Map([["hermes-agent", new Set()]]); const pending = ["hermes-agent"]; while (pending.length) { const name = pending.pop(); const item = packages.get(name); if (!item) throw new TypeError(`locked package is absent: ${name}`); for (const dependency of dependenciesFor(item, selected.get(name))) { const child = normalizedName(dependency.name); if (!packages.has(child)) throw new TypeError(`dependency is absent from uv.lock: ${child}`); const extras = new Set(dependency.extra ?? []); if (![...extras].every((extra) => typeof extra === "string" && /^[a-z0-9][a-z0-9._-]*$/i.test(extra))) throw new TypeError(`invalid dependency extra: ${child}`); const prior = selected.get(child) ?? new Set(); const before = prior.size; for (const extra of extras) prior.add(extra); if (!selected.has(child) || prior.size !== before) { selected.set(child, prior); pending.push(child); } } } return [...selected.keys()].sort().map((name) => ({ ...packages.get(name), selectedExtras: selected.get(name) })); }

function purl(item) { return `pkg:pypi/${item.name}@${item.version}`; }
function property(name, value) { return { name, value: String(value) }; }
async function fileDigest(url) { return sha256Hex(await readFile(url)); }
function provenanceComponent(name, version, properties) { return { type: "file", name, version, properties }; }

export async function generateSbom({ sourceRoot: inputRoot, check = false, outputUrl = output }) {
  if (typeof inputRoot !== "string" || inputRoot.length === 0) throw new Error("--source-root must name a verified acquired source directory");
  const sourceRoot = resolve(inputRoot);
const [sourceLock, artifacts, patches, lockBytes, projectBytes, noticeBytes] = await Promise.all([readFile(sourceLockPath, "utf8").then(JSON.parse), readFile(runtimeLockPath, "utf8").then(JSON.parse), readFile(patchQueuePath, "utf8").then(JSON.parse), readFile(resolve(sourceRoot, "uv.lock")), readFile(resolve(sourceRoot, "pyproject.toml")), readFile(noticesPath)]);
if (await sha256Hex(lockBytes) !== sourceLock.rawFileSha256["uv.lock"]) throw new Error("pinned uv.lock drift"); if (await sha256Hex(projectBytes) !== sourceLock.rawFileSha256["pyproject.toml"]) throw new Error("pinned pyproject.toml drift");
const project = TOML.parse(new TextDecoder().decode(projectBytes)); if (project.project?.name !== "hermes-agent" || project.project?.version !== sourceLock.packageVersion) throw new Error("pinned pyproject identity drift");
const packages = selectedClosure(TOML.parse(new TextDecoder().decode(lockBytes))); const byName = new Map(packages.map((item) => [item.name, item])); const archives = new Map(packages.filter((item) => item.name !== "hermes-agent").map((item) => [item.name, selectArchive(item)]));
const archiveRecords = packages.filter((item) => archives.has(item.name)).map((item) => ({ name: item.name, version: item.version, url: archives.get(item.name).url, size: archives.get(item.name).size, sha256: archives.get(item.name).hash })).sort((left, right) => left.name.localeCompare(right.name) || left.version.localeCompare(right.version));
const dependencyRecords = packages.map((item) => ({ name: item.name, version: item.version, dependsOn: [...new Set(dependenciesFor(item, item.selectedExtras).map((dependency) => normalizedName(dependency.name)).filter((name) => byName.has(name)))].sort() })).sort((left, right) => left.name.localeCompare(right.name) || left.version.localeCompare(right.version));
const runtimeProperties = [property("jarvis:source-remote", sourceLock.remote), property("jarvis:source-tag", sourceLock.tag), property("jarvis:source-tag-object", sourceLock.tagObject), property("jarvis:source-commit", sourceLock.sourceCommit), property("jarvis:source-tree", sourceLock.sourceTree), property("jarvis:source-acquisition", sourceLock.acquisitionMethod), property("jarvis:source-license-sha256", sourceLock.rawFileSha256.LICENSE), property("jarvis:source-pyproject-sha256", sourceLock.rawFileSha256["pyproject.toml"]), property("jarvis:source-uv-lock-sha256", sourceLock.rawFileSha256["uv.lock"]), property("jarvis:target", "windows-x86_64-cpython-3.11.16"), property("jarvis:extras", ""), property("jarvis:dev-mode", "false"), property("jarvis:install-mode", "runtime"), property("jarvis:closure-name-version-sha256", await sha256Hex(canonicalize(packages.map((item) => `${item.name}==${item.version}`).sort()))), property("jarvis:archive-records-sha256", await sha256Hex(canonicalize(archiveRecords))), property("jarvis:dependency-records-sha256", await sha256Hex(canonicalize(dependencyRecords)))];
const provenance = [provenanceComponent("hermes-source", sourceLock.tag, runtimeProperties.slice(0, 8)), ...["cpython", "uv", "winsw"].map((name) => provenanceComponent(`runtime-${name}`, artifacts[name].version, [property("jarvis:file", artifacts[name].fileName), property("jarvis:url", artifacts[name].url), property("jarvis:sha256", artifacts[name].sha256), property("jarvis:size", artifacts[name].size), property("jarvis:licenses", artifacts[name].licenses.join(","))])), provenanceComponent("python-build-standalone-license-rollup", "20260825", [property("jarvis:url", artifacts.pythonBuildStandaloneLicenses.url), property("jarvis:sha256", artifacts.pythonBuildStandaloneLicenses.sha256), property("jarvis:size", artifacts.pythonBuildStandaloneLicenses.size)]), provenanceComponent("runtime-artifacts-lock", "1", [property("jarvis:canonical-sha256", await sha256Hex(canonicalize(artifacts))), property("jarvis:file-sha256", await fileDigest(runtimeLockPath))]), provenanceComponent("patch-queue", "1", [property("jarvis:canonical-sha256", await sha256Hex(canonicalize(patches))), property("jarvis:patch-count", patches.patches.length)]), provenanceComponent("third-party-notices", "1", [property("jarvis:file-sha256", await sha256Hex(noticeBytes))]), ...Object.entries(sourceLock.licenses.files).sort(([left], [right]) => left.localeCompare(right)).map(([path, hash]) => provenanceComponent(`notice-${path.split("/").at(-1)}`, "pinned", [property("jarvis:path", path), property("jarvis:sha256", hash)]))];
const sbom = { bomFormat: "CycloneDX", specVersion: "1.6", serialNumber: "urn:uuid:0af49a54-f5d7-51d2-9f0e-f5906c157e9a", metadata: { component: { type: "application", name: "hermes-agent", version: sourceLock.packageVersion, purl: purl(byName.get("hermes-agent")) }, properties: runtimeProperties }, components: [...packages.map((item) => ({ type: item.name === "hermes-agent" ? "application" : "library", name: item.name, version: item.version, purl: purl(item), ...(archives.has(item.name) ? { hashes: [{ alg: "SHA-256", content: archives.get(item.name).hash }], externalReferences: [{ type: "distribution", url: archives.get(item.name).url }], properties: [property("jarvis:archive-size", archives.get(item.name).size)] } : {}) })), ...provenance], dependencies: dependencyRecords.map((item) => ({ ref: purl(byName.get(item.name)), dependsOn: item.dependsOn.map((name) => purl(byName.get(name))) })) };
const encoded = canonicalize(sbom); const canonical = `${new TextDecoder().decode(encoded)}\n`; const hash = await sha256Hex(encoded);
if (check) { if (sourceLock.sbomSha256 !== hash) throw new Error("SBOM hash drift"); if ((await readFile(outputUrl, "utf8")) !== canonical) throw new Error("SBOM is not byte-identical canonical output"); } else await writeFile(outputUrl, canonical, "utf8");
return Object.freeze({ hash, canonical, sbom, packages, archives });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const sourceArgument = process.argv.find((argument) => argument.startsWith("--source-root="))?.slice("--source-root=".length);
  generateSbom({ sourceRoot: sourceArgument, check: process.argv.includes("--check") }).then((result) => { console.log(result.hash); }).catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
