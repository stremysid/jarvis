import TOML from "@iarna/toml";
import { spawn } from "node:child_process";
import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { canonicalJsonFileBytes, canonicalize, compareOrdinal, loadCanonicalJsonFile, sha256Hex } from "./canonical-json.mjs";

const output = new URL("../sbom/hermes-agent-v2026.8.27-windows-x86_64-cpython-3.11.16.cdx.json", import.meta.url);
const sourceLockPath = new URL("../hermes-source-lock.json", import.meta.url);
const runtimeLockPath = new URL("../runtime-artifacts-lock.json", import.meta.url);
const patchQueuePath = new URL("../patches/series.json", import.meta.url);
const noticesPath = new URL("../THIRD_PARTY_NOTICES.md", import.meta.url);
const sha256 = /^[a-f0-9]{64}$/;
const target = Object.freeze({ implementation_name: "cpython", implementation_version: "3.11.16", os_name: "nt", platform_machine: "AMD64", platform_python_implementation: "CPython", platform_system: "Windows", platform_release: "", python_full_version: "3.11.16", python_version: "3.11", sys_platform: "win32" });
const sourceVerifier = fileURLToPath(new URL("../scripts/fetch-hermes.ps1", import.meta.url));
const trustedPowerShellHost = String.raw`C:\Program Files\PowerShell\7\pwsh.exe`;
const trustedPackageQueryHost = String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`;
const trustedGitHost = String.raw`C:\Program Files\Git\cmd\git.exe`;
const trustedWindowsRoot = String.raw`C:\Windows`;
const trustedTaskkillHost = String.raw`C:\Windows\System32\taskkill.exe`;
const sourceVerifierDeadlineMs = 120_000;
const sourceVerifierMaxOutputBytes = 64 * 1_024;
const taskkillDeadlineMs = 10_000;

async function validateTrustedFile(path, label) {
  const [info, canonical] = await Promise.all([lstat(path), realpath(path)]).catch((cause) => { throw new Error(`${label} is unavailable`, { cause }); });
  if (!info.isFile() || info.isSymbolicLink() || canonical.toLowerCase() !== path.toLowerCase()) throw new Error(`${label} is not the trusted absolute file`);
  return canonical;
}

async function validateTrustedExecutable(path, label) { return validateTrustedFile(path, label); }

async function validateTrustedDirectory(path, label) {
  const [info, canonical] = await Promise.all([lstat(path), realpath(path)]).catch(() => { throw new Error(`${label} is unavailable`); });
  if (!info.isDirectory() || info.isSymbolicLink() || canonical.toLowerCase() !== path.toLowerCase()) throw new Error(`${label} is not the trusted absolute directory`);
  return canonical;
}

function terminateVerifierProcessTree(child, taskkillHost) {
  return new Promise((resolveTermination, rejectTermination) => {
    const killer = spawn(taskkillHost, ["/PID", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
      signal: AbortSignal.timeout(taskkillDeadlineMs),
      env: {
        ComSpec: join(trustedWindowsRoot, "System32", "cmd.exe"),
        Path: join(trustedWindowsRoot, "System32"),
        PATHEXT: ".COM;.EXE",
        SystemRoot: trustedWindowsRoot,
        WINDIR: trustedWindowsRoot,
      },
    });
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      if (error) rejectTermination(error); else resolveTermination();
    };
    killer.once("error", (error) => {
      child.kill("SIGKILL");
      finish(new Error("locked source verifier process-tree termination failed", { cause: error }));
    });
    killer.once("close", (code) => {
      if (code === 0) finish();
      else {
        child.kill("SIGKILL");
        finish(new Error("locked source verifier process-tree termination failed"));
      }
    });
  });
}

export function runVerifierProcess(child, { deadlineMs = sourceVerifierDeadlineMs, maxOutputBytes = sourceVerifierMaxOutputBytes, taskkillHost = trustedTaskkillHost } = {}) {
  return new Promise((resolveChild, rejectChild) => {
    const output = { stdout: [], stderr: [] };
    const outputBytes = { stdout: 0, stderr: 0 };
    let failure;
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (error) rejectChild(error); else resolveChild(result);
    };
    const failClosed = (error) => {
      if (failure || settled) return;
      failure = error;
      child.stdout.pause();
      child.stderr.pause();
      terminateVerifierProcessTree(child, taskkillHost).then(
        () => finish(error),
        (terminationError) => finish(terminationError),
      );
    };
    const capture = (stream) => (value) => {
      if (failure || settled) return;
      const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
      const remaining = maxOutputBytes - outputBytes[stream];
      if (bytes.length > remaining) {
        failClosed(new Error(`locked source verifier ${stream} exceeded its ${maxOutputBytes}-byte limit`));
        return;
      }
      output[stream].push(bytes);
      outputBytes[stream] += bytes.length;
    };
    const deadline = setTimeout(() => failClosed(new Error(`locked source verifier exceeded its ${deadlineMs}ms deadline`)), deadlineMs);
    child.stdout.on("data", capture("stdout"));
    child.stderr.on("data", capture("stderr"));
    child.once("error", (error) => finish(error));
    child.once("close", (code) => {
      if (failure) return;
      finish(undefined, {
        code,
        stdout: Buffer.concat(output.stdout, outputBytes.stdout).toString("utf8"),
        stderr: Buffer.concat(output.stderr, outputBytes.stderr).toString("utf8"),
      });
    });
  });
}

async function queryPowerShellPackages() {
  // PowerShell 7 cannot bootstrap its own trust. Use the OS host and OS modules,
  // never an App Execution Alias, a PATH command, or a user-installed Appx module.
  const host = await validateTrustedExecutable(trustedPackageQueryHost, "PowerShell 7 package discovery host");
  const taskkillHost = await validateTrustedExecutable(trustedTaskkillHost, "trusted taskkill host");
  const hostDirectory = await validateTrustedDirectory(dirname(host), "PowerShell 7 package discovery directory");
  const modules = await validateTrustedDirectory(join(hostDirectory, "Modules"), "PowerShell 7 package discovery modules");
  const manifests = {};
  for (const name of ["Appx", "Microsoft.PowerShell.Utility"]) {
    const directory = await validateTrustedDirectory(join(modules, name), `PowerShell 7 package discovery ${name} directory`);
    manifests[name] = await validateTrustedFile(join(directory, `${name}.psd1`), `PowerShell 7 package discovery ${name} manifest`);
  }
  const environment = {
    APPDATA: hostDirectory,
    ComSpec: join(trustedWindowsRoot, "System32", "cmd.exe"),
    HOME: hostDirectory,
    JARVIS_HERMES_APPX_MODULE: manifests.Appx,
    JARVIS_HERMES_UTILITY_MODULE: manifests["Microsoft.PowerShell.Utility"],
    LOCALAPPDATA: hostDirectory,
    Path: join(trustedWindowsRoot, "System32"),
    PATHEXT: ".COM;.EXE",
    PSDisableModuleAnalysisCacheCleanup: "1",
    PSModuleAnalysisCachePath: "NUL",
    PSModulePath: modules,
    SystemRoot: trustedWindowsRoot,
    TEMP: hostDirectory,
    TMP: hostDirectory,
    USERPROFILE: hostDirectory,
    WINDIR: trustedWindowsRoot,
    XDG_CONFIG_HOME: hostDirectory,
  };
  const bootstrap = String.raw`$ErrorActionPreference = 'Stop'
$env:PSModulePath = 'NUL'
$PSModuleAutoLoadingPreference = 'None'
Import-Module -Name $env:JARVIS_HERMES_UTILITY_MODULE -Force
# Appx's localized manifest uses Utility's ConvertFrom-StringData. Autoloading
# stays disabled, so that dependency must already be imported from the OS tree.
Import-Module -Name $env:JARVIS_HERMES_APPX_MODULE -Force
$packages = @(Appx\Get-AppxPackage -Name Microsoft.PowerShell -PackageTypeFilter Main | ForEach-Object {
  [pscustomobject]@{
    PackageFamilyName = $_.PackageFamilyName
    Publisher = $_.Publisher
    SignatureKind = [string]$_.SignatureKind
    IsDevelopmentMode = $_.IsDevelopmentMode
    InstallLocation = $_.InstallLocation
  }
})
Microsoft.PowerShell.Utility\ConvertTo-Json -InputObject $packages -Compress`;
  try {
    const child = spawn(host, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", bootstrap], { windowsHide: true, cwd: hostDirectory, env: environment });
    const result = await runVerifierProcess(child, { taskkillHost });
    if (result.code !== 0) throw new Error("Windows Appx query exited unsuccessfully");
    return JSON.parse(result.stdout);
  } catch (cause) {
    throw new Error("PowerShell 7 package discovery failed: Windows Appx query did not return usable evidence", { cause });
  }
}

export async function resolveTrustedPowerShellHost() {
  try {
    return await validateTrustedExecutable(trustedPowerShellHost, "trusted PowerShell 7 MSI host");
  } catch (error) {
    // Only absence permits fallback. A redirected or unreadable MSI host must
    // still refuse, rather than conceal a broken trust boundary behind Store.
    if (error.cause?.code !== "ENOENT") throw error;
  }
  const packages = await queryPowerShellPackages();
  if (!Array.isArray(packages) || packages.length !== 1) throw new Error("trusted PowerShell 7 host is unavailable: expected one registered Microsoft.PowerShell Store package after the MSI host was absent");
  const installed = packages[0];
  if (installed?.PackageFamilyName !== "Microsoft.PowerShell_8wekyb3d8bbwe") throw new Error("PowerShell 7 Store package family is not trusted");
  if (installed.Publisher !== "CN=Microsoft Corporation, O=Microsoft Corporation, L=Redmond, S=Washington, C=US") throw new Error("PowerShell 7 Store package publisher is not trusted");
  // A manifest can copy Microsoft's identity in a developer registration. The
  // OS-reported Store signature and non-development registration bind it to a
  // deployed, protected package, rather than a user-controlled loose layout.
  if (installed.SignatureKind !== "Store") throw new Error("PowerShell 7 package is not signed by the Windows Store");
  if (installed.IsDevelopmentMode !== false) throw new Error("PowerShell 7 Store package is a development registration");
  const location = installed.InstallLocation;
  if (typeof location !== "string" || !/^[A-Za-z]:\\/.test(location) || resolve(location) !== location) throw new Error("PowerShell 7 Store install location is not an exact drive-absolute directory");
  const directory = await validateTrustedDirectory(location, "PowerShell 7 Store install location");
  return validateTrustedExecutable(join(directory, "pwsh.exe"), "trusted PowerShell 7 Store host");
}

async function runLockedSourceVerifier(runtimeRoot) {
  const [powerShellHost, gitHost, taskkillHost] = await Promise.all([
    resolveTrustedPowerShellHost(),
    validateTrustedExecutable(trustedGitHost, "trusted Git host"),
    validateTrustedExecutable(trustedTaskkillHost, "trusted taskkill host"),
  ]);
  const closedHostDirectory = await validateTrustedDirectory(dirname(powerShellHost), "trusted PowerShell host directory");
  const closedModulesDirectory = await validateTrustedDirectory(join(closedHostDirectory, "Modules"), "trusted PowerShell modules directory");
  const managementDirectory = await validateTrustedDirectory(join(closedModulesDirectory, "Microsoft.PowerShell.Management"), "trusted PowerShell Management module directory");
  const utilityDirectory = await validateTrustedDirectory(join(closedModulesDirectory, "Microsoft.PowerShell.Utility"), "trusted PowerShell Utility module directory");
  const [managementModule, utilityModule] = await Promise.all([
    validateTrustedFile(join(managementDirectory, "Microsoft.PowerShell.Management.psd1"), "trusted PowerShell Management module manifest"),
    validateTrustedFile(join(utilityDirectory, "Microsoft.PowerShell.Utility.psd1"), "trusted PowerShell Utility module manifest"),
  ]);
  const environment = {
    APPDATA: closedHostDirectory,
    ComSpec: join(trustedWindowsRoot, "System32", "cmd.exe"),
    DOTNET_CLI_TELEMETRY_OPTOUT: "1",
    HOME: closedHostDirectory,
    JARVIS_HERMES_MANAGEMENT_MODULE: managementModule,
    JARVIS_HERMES_RUNTIME_ROOT: runtimeRoot,
    JARVIS_HERMES_SOURCE_VERIFIER: sourceVerifier,
    JARVIS_HERMES_UTILITY_MODULE: utilityModule,
    LOCALAPPDATA: closedHostDirectory,
    Path: [dirname(gitHost), dirname(powerShellHost), join(trustedWindowsRoot, "System32"), trustedWindowsRoot].join(";"),
    PATHEXT: ".COM;.EXE",
    POWERSHELL_UPDATECHECK: "Off",
    POWERSHELL_TELEMETRY_OPTOUT: "1",
    PSDisableModuleAnalysisCacheCleanup: "1",
    PSModuleAnalysisCachePath: "NUL",
    PSModulePath: closedModulesDirectory,
    SystemRoot: trustedWindowsRoot,
    TEMP: closedHostDirectory,
    TMP: closedHostDirectory,
    USERPROFILE: closedHostDirectory,
    WINDIR: trustedWindowsRoot,
    XDG_CONFIG_HOME: closedHostDirectory,
  };
  const bootstrap = String.raw`$ErrorActionPreference = 'Stop'
$env:PSModulePath = 'NUL'
Import-Module -Name $env:JARVIS_HERMES_MANAGEMENT_MODULE -Force
Import-Module -Name $env:JARVIS_HERMES_UTILITY_MODULE -Force
& $env:JARVIS_HERMES_SOURCE_VERIFIER -RuntimeRoot $env:JARVIS_HERMES_RUNTIME_ROOT -VerifyOnly`;
  const child = spawn(powerShellHost, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", bootstrap], { windowsHide: true, cwd: closedHostDirectory, env: environment });
  return await runVerifierProcess(child, { taskkillHost });
}

export async function verifyAcquiredSourceRoot(inputRoot) {
  if (typeof inputRoot !== "string" || inputRoot.length === 0 || !isAbsolute(inputRoot) || inputRoot.startsWith("\\\\") || inputRoot.startsWith("\\\\?\\") || inputRoot.startsWith("\\\\.\\") || inputRoot.includes("/")) throw new Error("--source-root must be an exact drive-absolute acquired source path");
  const sourceRoot = resolve(inputRoot);
  if (sourceRoot !== inputRoot || basename(sourceRoot) !== "source") throw new Error("--source-root must be the canonical acquired release source path");
  const release = dirname(sourceRoot);
  const sourceLock = (await loadCanonicalJsonFile(sourceLockPath, "Hermes source lock")).value;
  if (basename(release) !== sourceLock.sourceCommit || basename(dirname(release)) !== "releases") throw new Error("--source-root is not bound to the pinned acquired release");
  const runtimeRoot = dirname(dirname(release));
  const [sourceInfo, gitInfo, lockInfo, sourceReal, runtimeReal] = await Promise.all([
    lstat(sourceRoot),
    lstat(join(release, "git")),
    lstat(join(runtimeRoot, ".hermes-runtime.workflow.lock")),
    realpath(sourceRoot),
    realpath(runtimeRoot),
  ]).catch(() => { throw new Error("--source-root is not a complete acquired release"); });
  const expectedRealSource = join(runtimeReal, "releases", sourceLock.sourceCommit, "source");
  if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink() || !gitInfo.isDirectory() || gitInfo.isSymbolicLink() || !lockInfo.isFile() || lockInfo.isSymbolicLink() || lockInfo.size !== 0 || sourceReal !== expectedRealSource) throw new Error("--source-root is not a literal complete acquired release");
  const result = await runLockedSourceVerifier(runtimeRoot);
  if (result.code !== 0) throw new Error("--source-root failed the complete locked source VerifyOnly boundary");
  return Object.freeze({ sourceRoot, runtimeRoot });
}

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
  return compareOrdinal(a.local, b.local);
}
function markerCompare(left, operator, right) {
  if (operator === "in" || operator === "not in") { const found = right.value.split(",").map((item) => item.trim()).includes(left.value); return operator === "in" ? found : !found; }
  if (right.value.endsWith(".*")) {
    if (operator !== "==" && operator !== "!=") throw new TypeError("PEP 440 wildcard only supports equality markers");
    const equal = left.value === right.value.slice(0, -2) || left.value.startsWith(`${right.value.slice(0, -2)}.`);
    return operator === "==" ? equal : !equal;
  }
  const comparison = /version/.test(left.kind) || /version/.test(right.kind) ? comparePep440(left.value, right.value) : compareOrdinal(left.value, right.value);
  return ({ "===": left.value === right.value, "==": comparison === 0, "!=": comparison !== 0, "<": comparison < 0, "<=": comparison <= 0, ">": comparison > 0, ">=": comparison >= 0 })[operator];
}
export function markerApplies(expression = "", extras = new Set()) {
  if (typeof expression !== "string" || expression === "") return true;
  const tokens = markerTokens(expression); let cursor = 0;
  const consume = (kind, value) => { const token = tokens[cursor]; if (!token || token.kind !== kind || (value && token.value !== value)) return undefined; cursor += 1; return token; };
  const value = () => { const token = consume("string") ?? consume("identifier"); if (!token) throw new TypeError("expected marker value"); if (token.kind === "identifier") { if (token.value === "extra") return { kind: "extra", value: [...extras].sort(compareOrdinal).join(",") }; if (!(token.value in target)) throw new TypeError(`unknown PEP 508 marker variable: ${token.value}`); return { kind: token.value, value: target[token.value] }; } return { kind: "literal", value: token.value }; };
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
function dependenciesFor(item, extras) { const direct = Array.isArray(item.dependencies) ? item.dependencies : []; const optional = item["optional-dependencies"] ?? {}; if (!optional || typeof optional !== "object" || Array.isArray(optional)) throw new TypeError(`invalid optional dependencies: ${item.name}`); return [...direct, ...[...extras].sort(compareOrdinal).flatMap((extra) => optional[extra] ?? [])].filter((dependency) => { if (!dependency || typeof dependency.name !== "string" || (dependency.marker !== undefined && typeof dependency.marker !== "string")) throw new TypeError(`invalid dependency: ${item.name}`); return markerApplies(dependency.marker, extras); }); }
function parseWheel(url) { const file = new URL(url).pathname.split("/").at(-1); if (!file.endsWith(".whl")) return undefined; const values = file.slice(0, -4).split("-"); if (values.length < 5) return undefined; const [python, abi, platform] = values.slice(-3); return { python: python.split("."), abi: abi.split("."), platform: platform.split(".") }; }
export function wheelRank(url) { const tags = parseWheel(url); if (!tags) return undefined; const platform = tags.platform.includes("win_amd64") ? 0 : tags.platform.includes("any") ? 100 : undefined; if (platform === undefined) return undefined; if (platform === 100) return tags.abi.includes("none") && tags.python.includes("py2") && tags.python.includes("py3") ? 310 : tags.abi.includes("none") && tags.python.includes("py3") ? 300 : undefined; if (tags.python.includes("cp311") && tags.abi.includes("cp311")) return 0; if (tags.python.includes("cp311") && tags.abi.includes("abi3")) return 10; const abi3 = tags.abi.includes("abi3") && tags.python.map((tag) => /^cp3(\d+)$/.exec(tag)?.[1]).filter(Boolean).map(Number).filter((minor) => minor <= 11).sort((a, b) => b - a)[0]; return abi3 ? 20 + (11 - abi3) : undefined; }
export function selectArchive(item) {
  const candidates = (Array.isArray(item.wheels) ? item.wheels : []).map((wheel) => ({ ...wheel, rank: wheelRank(wheel.url) })).filter((wheel) => wheel.rank !== undefined);
  candidates.sort((left, right) => left.rank - right.rank || compareOrdinal(left.url, right.url)); const chosen = candidates[0] ?? item.sdist;
  if (!chosen || typeof chosen.url !== "string" || !sha256.test(String(chosen.hash ?? "").replace("sha256:", "")) || !Number.isSafeInteger(chosen.size) || chosen.size < 1) throw new TypeError(`no pinned Windows x64 CPython 3.11 archive for ${item.name}@${item.version}`);
  return { url: chosen.url, hash: chosen.hash.replace("sha256:", ""), size: chosen.size };
}
export function selectedClosure(lock) { const packages = packageMap(lock); const selected = new Map([["hermes-agent", new Set()]]); const pending = ["hermes-agent"]; while (pending.length) { const name = pending.pop(); const item = packages.get(name); if (!item) throw new TypeError(`locked package is absent: ${name}`); for (const dependency of dependenciesFor(item, selected.get(name))) { const child = normalizedName(dependency.name); if (!packages.has(child)) throw new TypeError(`dependency is absent from uv.lock: ${child}`); const extras = new Set(dependency.extra ?? []); if (![...extras].every((extra) => typeof extra === "string" && /^[a-z0-9][a-z0-9._-]*$/i.test(extra))) throw new TypeError(`invalid dependency extra: ${child}`); const prior = selected.get(child) ?? new Set(); const before = prior.size; for (const extra of extras) prior.add(extra); if (!selected.has(child) || prior.size !== before) { selected.set(child, prior); pending.push(child); } } } return [...selected.keys()].sort(compareOrdinal).map((name) => ({ ...packages.get(name), selectedExtras: selected.get(name) })); }

function purl(item) { return `pkg:pypi/${item.name}@${item.version}`; }
function property(name, value) { return { name, value: String(value) }; }
async function fileDigest(url) { return sha256Hex(await readFile(url)); }
function provenanceRef(name, version) { return `urn:jarvis:hermes-runtime:provenance:${name}@${version}`; }
function provenanceComponent(name, version, properties) { return { type: "file", "bom-ref": provenanceRef(name, version), name, version, properties }; }

export async function generateSbom({ sourceRoot: inputRoot, check = false, outputUrl = output }) {
  if (typeof inputRoot !== "string" || inputRoot.length === 0) throw new Error("--source-root must name a verified acquired source directory");
  const { sourceRoot } = await verifyAcquiredSourceRoot(inputRoot);
const [sourceManifest, artifactManifest, patchManifest, lockBytes, projectBytes, licenseBytes, noticeBytes] = await Promise.all([loadCanonicalJsonFile(sourceLockPath, "Hermes source lock"), loadCanonicalJsonFile(runtimeLockPath, "runtime artifacts lock"), loadCanonicalJsonFile(patchQueuePath, "patch queue"), readFile(resolve(sourceRoot, "uv.lock")), readFile(resolve(sourceRoot, "pyproject.toml")), readFile(resolve(sourceRoot, "LICENSE")), readFile(noticesPath)]);
const sourceLock = sourceManifest.value; const artifacts = artifactManifest.value; const patches = patchManifest.value;
if (await sha256Hex(lockBytes) !== sourceLock.rawFileSha256["uv.lock"]) throw new Error("pinned uv.lock drift"); if (await sha256Hex(projectBytes) !== sourceLock.rawFileSha256["pyproject.toml"]) throw new Error("pinned pyproject.toml drift"); if (await sha256Hex(licenseBytes) !== sourceLock.rawFileSha256.LICENSE) throw new Error("pinned LICENSE drift");
const project = TOML.parse(new TextDecoder().decode(projectBytes)); if (project.project?.name !== "hermes-agent" || project.project?.version !== sourceLock.packageVersion) throw new Error("pinned pyproject identity drift");
const packages = selectedClosure(TOML.parse(new TextDecoder().decode(lockBytes))); const byName = new Map(packages.map((item) => [item.name, item])); const archives = new Map(packages.filter((item) => item.name !== "hermes-agent").map((item) => [item.name, selectArchive(item)]));
const archiveRecords = packages.filter((item) => archives.has(item.name)).map((item) => ({ name: item.name, version: item.version, url: archives.get(item.name).url, size: archives.get(item.name).size, sha256: archives.get(item.name).hash })).sort((left, right) => compareOrdinal(left.name, right.name) || compareOrdinal(left.version, right.version));
const dependencyRecords = packages.map((item) => ({ name: item.name, version: item.version, dependsOn: [...new Set(dependenciesFor(item, item.selectedExtras).map((dependency) => normalizedName(dependency.name)).filter((name) => byName.has(name)))].sort(compareOrdinal) })).sort((left, right) => compareOrdinal(left.name, right.name) || compareOrdinal(left.version, right.version));
const runtimeProperties = [property("jarvis:source-remote", sourceLock.remote), property("jarvis:source-tag", sourceLock.tag), property("jarvis:source-tag-object", sourceLock.tagObject), property("jarvis:source-commit", sourceLock.sourceCommit), property("jarvis:source-tree", sourceLock.sourceTree), property("jarvis:source-acquisition", sourceLock.acquisitionMethod), property("jarvis:source-license-sha256", sourceLock.rawFileSha256.LICENSE), property("jarvis:source-pyproject-sha256", sourceLock.rawFileSha256["pyproject.toml"]), property("jarvis:source-uv-lock-sha256", sourceLock.rawFileSha256["uv.lock"]), property("jarvis:target", "windows-x86_64-cpython-3.11.16"), property("jarvis:extras", ""), property("jarvis:dev-mode", "false"), property("jarvis:install-mode", "runtime"), property("jarvis:closure-name-version-sha256", await sha256Hex(canonicalize(packages.map((item) => `${item.name}==${item.version}`).sort(compareOrdinal)))), property("jarvis:archive-records-sha256", await sha256Hex(canonicalize(archiveRecords))), property("jarvis:dependency-records-sha256", await sha256Hex(canonicalize(dependencyRecords)))];
const provenance = [provenanceComponent("hermes-source", sourceLock.tag, runtimeProperties.slice(0, 8)), ...["cpython", "uv", "winsw"].map((name) => provenanceComponent(`runtime-${name}`, artifacts[name].version, [property("jarvis:file", artifacts[name].fileName), property("jarvis:url", artifacts[name].url), property("jarvis:sha256", artifacts[name].sha256), property("jarvis:size", artifacts[name].size), property("jarvis:licenses", artifacts[name].licenses.join(","))])), provenanceComponent("python-build-standalone-license-rollup", "20260825", [property("jarvis:url", artifacts.pythonBuildStandaloneLicenses.url), property("jarvis:sha256", artifacts.pythonBuildStandaloneLicenses.sha256), property("jarvis:size", artifacts.pythonBuildStandaloneLicenses.size)]), provenanceComponent("runtime-artifacts-lock", "1", [property("jarvis:canonical-sha256", await sha256Hex(canonicalize(artifacts))), property("jarvis:file-sha256", await fileDigest(runtimeLockPath))]), provenanceComponent("patch-queue", "1", [property("jarvis:canonical-sha256", await sha256Hex(canonicalize(patches))), property("jarvis:patch-count", patches.patches.length)]), provenanceComponent("third-party-notices", "1", [property("jarvis:file-sha256", await sha256Hex(noticeBytes))]), ...Object.entries(sourceLock.licenses.files).sort(([left], [right]) => compareOrdinal(left, right)).map(([path, hash]) => provenanceComponent(`notice-${path.split("/").at(-1)}`, "pinned", [property("jarvis:path", path), property("jarvis:sha256", hash)]))];
const root = byName.get("hermes-agent");
const sbom = {
  bomFormat: "CycloneDX",
  specVersion: "1.6",
  serialNumber: "urn:uuid:0af49a54-f5d7-51d2-9f0e-f5906c157e9a",
  metadata: {
    component: { type: "application", "bom-ref": purl(root), name: root.name, version: root.version, purl: purl(root) },
    properties: runtimeProperties,
  },
  components: [
    ...packages.filter((item) => item.name !== root.name).map((item) => ({
      type: "library",
      "bom-ref": purl(item),
      name: item.name,
      version: item.version,
      purl: purl(item),
      hashes: [{ alg: "SHA-256", content: archives.get(item.name).hash }],
      externalReferences: [{ type: "distribution", url: archives.get(item.name).url }],
      properties: [property("jarvis:archive-size", archives.get(item.name).size)],
    })),
    ...provenance,
  ],
  dependencies: dependencyRecords.map((item) => ({ ref: purl(byName.get(item.name)), dependsOn: item.dependsOn.map((name) => purl(byName.get(name))) })),
};
const encoded = canonicalize(sbom); const fileBytes = canonicalJsonFileBytes(sbom); const canonical = new TextDecoder().decode(fileBytes); const hash = await sha256Hex(encoded);
if (check) { if (sourceLock.sbomSha256 !== hash) throw new Error("SBOM hash drift"); if ((await readFile(outputUrl, "utf8")) !== canonical) throw new Error("SBOM is not byte-identical canonical output"); } else await writeFile(outputUrl, canonical, "utf8");
return Object.freeze({ hash, canonical, sbom, packages, archives });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const sourceArgument = process.argv.find((argument) => argument.startsWith("--source-root="))?.slice("--source-root=".length);
  generateSbom({ sourceRoot: sourceArgument, check: process.argv.includes("--check") }).then((result) => { console.log(result.hash); }).catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
