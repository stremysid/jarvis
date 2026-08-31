import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { canonicalize, sha256Hex } from "./canonical-json.mjs";

const output = new URL("../sbom/hermes-agent-v2026.8.27-windows-x86_64-cpython-3.11.16.cdx.json", import.meta.url);
const sourceLockPath = new URL("../hermes-source-lock.json", import.meta.url);
const defaultSource = "C:/Users/Ksid1/AppData/Local/Jarvis/Hermes-H1-Test/releases/5fc308a70719a83cccdbba4c0e39c23f5a8239d5/source";
const sourceRoot = resolve(process.argv.find((argument) => argument.startsWith("--source-root="))?.slice("--source-root=".length) ?? defaultSource);
const sha256 = /^[a-f0-9]{64}$/;

function normalizedName(name) { return name.toLowerCase().replace(/[_.-]+/g, "-"); }
function textValue(block, key) { return new RegExp(`^${key} = "([^"]+)"`, "m").exec(block)?.[1]; }
function inlineRecords(block, section) {
  const match = new RegExp(`^${section} = \\[([\\s\\S]*?)^\\]`, "m").exec(block);
  return [...(match?.[1] ?? "").matchAll(/\{([^{}]*)\}/g)].map((record) => Object.fromEntries([...record[1].matchAll(/([A-Za-z_-]+) = "([^"]*)"/g)].map(([, key, value]) => [key, value])));
}
function markerApplies(marker = "") {
  if (!marker) return true;
  const value = marker.replace(/\"/g, "'");
  if (/extra\s*==\s*'[^']+'/.test(value) || /extra\s*!=\s*''/.test(value)) return false;
  if (/sys_platform\s*!=\s*'win32'/.test(value) || /platform_system\s*!=\s*'Windows'/.test(value)) return false;
  if (/sys_platform\s*==\s*'[^w]/.test(value) || /platform_system\s*==\s*'[^W]/.test(value)) return false;
  if (/python_full_version\s*[<>]=?\s*'3\.11\.16'/.test(value) || /python_version\s*[<>]=?\s*'3\.11'/.test(value)) return false;
  return true;
}
function parsePackages(lock) {
  const packages = new Map();
  for (const block of lock.split(/^\[\[package\]\]\r?$/m).slice(1)) {
    const name = textValue(block, "name"); const version = textValue(block, "version");
    if (!name || !version) continue;
    const dependencies = inlineRecords(block, "dependencies").filter((dependency) => dependency.name && markerApplies(dependency.marker)).map((dependency) => normalizedName(dependency.name)).sort();
    const wheels = inlineRecords(block, "wheels");
    const sdist = /^sdist = \{([^{}]*)\}/m.exec(block)?.[1];
    const source = sdist ? Object.fromEntries([...sdist.matchAll(/([A-Za-z_-]+) = "([^"]*)"/g)].map(([, key, value]) => [key, value])) : undefined;
    packages.set(normalizedName(name), { name: normalizedName(name), version, dependencies, wheels, sdist: source });
  }
  return packages;
}
function selectArchive(item) {
  const compatible = item.wheels.filter(({ url = "" }) => /-(?:cp311|py3)-(?:cp311|none)-(?:win_amd64|any)\.whl$/i.test(url));
  const exact = compatible.filter(({ url }) => /-cp311-cp311-win_amd64\.whl$/i.test(url));
  const universal = compatible.filter(({ url }) => /-py3-none-any\.whl$/i.test(url));
  const chosen = [...exact, ...universal].sort((left, right) => left.url.localeCompare(right.url))[0] ?? item.sdist;
  if (!chosen || !sha256.test((chosen.hash ?? "").replace("sha256:", ""))) throw new Error(`no pinned Windows x64 CPython 3.11 archive for ${item.name}@${item.version}`);
  return { url: chosen.url, hash: chosen.hash.replace("sha256:", "") };
}
function selectedClosure(packages) {
  const selected = new Set(["hermes-agent"]); const pending = ["hermes-agent"];
  while (pending.length) { const name = pending.pop(); const item = packages.get(name); if (!item) throw new Error(`locked package is absent: ${name}`); for (const dependency of item.dependencies) if (!selected.has(dependency)) { selected.add(dependency); pending.push(dependency); } }
  return [...selected].sort().map((name) => packages.get(name));
}
const sourceLock = JSON.parse(await readFile(sourceLockPath, "utf8"));
const lock = await readFile(resolve(sourceRoot, "uv.lock"), "utf8");
const project = await readFile(resolve(sourceRoot, "pyproject.toml"), "utf8");
if (await sha256Hex(new TextEncoder().encode(lock)) !== sourceLock.rawFileSha256["uv.lock"]) throw new Error("pinned uv.lock drift");
if (await sha256Hex(new TextEncoder().encode(project)) !== sourceLock.rawFileSha256["pyproject.toml"]) throw new Error("pinned pyproject.toml drift");
if (!/^name = "hermes-agent"$/m.test(project) || !/^version = "0\.20\.6"$/m.test(project)) throw new Error("pinned pyproject identity drift");
const packages = selectedClosure(parsePackages(lock)); const purl = (item) => `pkg:pypi/${item.name}@${item.version}`;
const archives = new Map(packages.filter((item) => item.name !== "hermes-agent").map((item) => [item.name, selectArchive(item)]));
const sbom = { bomFormat: "CycloneDX", specVersion: "1.6", serialNumber: "urn:uuid:0af49a54-f5d7-51d2-9f0e-f5906c157e9a", metadata: { component: { type: "application", name: "hermes-agent", version: "0.20.6", purl: purl(packages.find((item) => item.name === "hermes-agent")) }, properties: [{ name: "jarvis:source-commit", value: sourceLock.sourceCommit }, { name: "jarvis:source-tree", value: sourceLock.sourceTree }, { name: "jarvis:target", value: "windows-x86_64-cpython-3.11.16" }, { name: "jarvis:extras", value: "" }] }, components: packages.map((item) => ({ type: item.name === "hermes-agent" ? "application" : "library", name: item.name, version: item.version, purl: purl(item), ...(archives.has(item.name) ? { hashes: [{ alg: "SHA-256", content: archives.get(item.name).hash }], externalReferences: [{ type: "distribution", url: archives.get(item.name).url }] } : {}) })), dependencies: packages.map((item) => ({ ref: purl(item), dependsOn: item.dependencies.filter((dependency) => packages.some((candidate) => candidate.name === dependency)).map((dependency) => purl(packages.find((candidate) => candidate.name === dependency))).sort() })) };
const encoded = canonicalize(sbom); const canonical = `${new TextDecoder().decode(encoded)}\n`; const hash = await sha256Hex(encoded);
if (process.argv.includes("--check")) { if (sourceLock.sbomSha256 !== hash) throw new Error("SBOM hash drift"); if ((await readFile(output, "utf8")) !== canonical) throw new Error("SBOM is not byte-identical canonical output"); } else await writeFile(output, canonical, "utf8");
console.log(hash);
