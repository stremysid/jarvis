import { access, chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const artifactEntrypoint = fileURLToPath(new URL("../scripts/fetch-runtime-artifacts.ps1", import.meta.url));
const sourceEntrypoint = fileURLToPath(new URL("../scripts/fetch-hermes.ps1", import.meta.url));
const runtimeModule = fileURLToPath(new URL("../scripts/HermesRuntime.psm1", import.meta.url));
const sourceCommit = "5fc308a70719a83cccdbba4c0e39c23f5a8239d5";

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function capturePowerShellChild(child, label, timeout) {
  let stdout = "";
  let stderr = "";
  const result = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`PowerShell containment probe timed out: ${label}`));
    }, timeout);
    child.stdout.on("data", (data) => { stdout += data; });
    child.stderr.on("data", (data) => { stderr += data; });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
  return { child, result };
}

function launchPowerShellFile(script, args, timeout = 120_000, env = process.env) {
  const child = spawn("pwsh", ["-NoProfile", "-NonInteractive", "-File", script, ...args], { windowsHide: true, env });
  return capturePowerShellChild(child, script, timeout);
}

function launchPowerShellCommand(command, env = process.env, timeout = 120_000) {
  const encoded = Buffer.from(command, "utf16le").toString("base64");
  const child = spawn("pwsh", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], { windowsHide: true, env });
  return capturePowerShellChild(child, "closed encoded command", timeout);
}

function runPowerShellFile(script, args, timeout = 120_000) {
  return launchPowerShellFile(script, args, timeout).result;
}

function runCommand(executable, args, cwd, env = process.env, timeout = 30_000) {
  const child = spawn(executable, args, { cwd, env, windowsHide: true });
  let stdout = "";
  let stderr = "";
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Command timed out: ${executable}`)); }, timeout);
    child.stdout.on("data", (data) => { stdout += data; });
    child.stderr.on("data", (data) => { stderr += data; });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function getDescendantProcesses(parentPid) {
  const command = `$ErrorActionPreference = 'Stop'
$all = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name)
$known = [Collections.Generic.HashSet[uint32]]::new()
[void]$known.Add([uint32]${parentPid})
$found = [Collections.Generic.List[object]]::new()
do {
  $added = $false
  foreach ($candidate in $all) {
    if ($known.Contains([uint32]$candidate.ParentProcessId) -and $known.Add([uint32]$candidate.ProcessId)) {
      $found.Add($candidate)
      $added = $true
    }
  }
} while ($added)
foreach ($candidate in $found) { [Console]::Out.WriteLine(('{0}|{1}|{2}' -f $candidate.ProcessId, $candidate.ParentProcessId, $candidate.Name)) }`;
  const result = await runCommand("pwsh", ["-NoProfile", "-NonInteractive", "-Command", command], undefined, process.env, 15_000);
  expect(result.code, result.stderr).toBe(0);
  return result.stdout.trim().split(/\r?\n/).filter(Boolean).map((line) => {
    const [pid, parent, name] = line.split("|");
    return { pid: Number(pid), parentPid: Number(parent), name };
  });
}

async function waitForGitProcessTree(parentPid, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const descendants = await getDescendantProcesses(parentPid);
    if (descendants.some(({ name }) => name.toLowerCase() === "git.exe") && descendants.some(({ name }) => ["cmd.exe", "ping.exe"].includes(name.toLowerCase()))) return descendants;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for the real Git descendant tree of ${parentPid}`);
}

async function runGitChecked(args, cwd, env) {
  const result = await runCommand("git", args, cwd, env);
  expect(result.code, `git ${args.join(" ")}\n${result.stderr}`).toBe(0);
  return result;
}

function extractPowerShellFunction(source, name) {
  const start = source.search(new RegExp(`^function\\s+${name}\\s*\\{`, "im"));
  expect(start, `${name} function is missing`).toBeGreaterThanOrEqual(0);
  let depth = 0;
  let bodyStarted = false;
  for (let index = start; index < source.length; index += 1) {
    if (source[index] === "{") { depth += 1; bodyStarted = true; }
    if (source[index] === "}") depth -= 1;
    if (bodyStarted && depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`${name} function body is unterminated`);
}

function extractCSharpMethod(source, signature) {
  const start = source.indexOf(signature);
  expect(start, `${signature} method is missing`).toBeGreaterThanOrEqual(0);
  let depth = 0;
  let bodyStarted = false;
  for (let index = start; index < source.length; index += 1) {
    if (source[index] === "{") { depth += 1; bodyStarted = true; }
    if (source[index] === "}") depth -= 1;
    if (bodyStarted && depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`${signature} method body is unterminated`);
}

const directoryReparseAttacker = String.raw`
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

public static class Review5DirectoryReparseAttacker
{
    private const uint GENERIC_WRITE = 0x40000000;
    private const uint FILE_SHARE_READ = 0x00000001;
    private const uint FILE_SHARE_WRITE = 0x00000002;
    private const uint FILE_SHARE_DELETE = 0x00000004;
    private const uint OPEN_EXISTING = 3;
    private const uint FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
    private const uint FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;
    private const uint FSCTL_SET_REPARSE_POINT = 0x000900A4;
    private const uint FSCTL_DELETE_REPARSE_POINT = 0x000900AC;
    private const uint IO_REPARSE_TAG_MOUNT_POINT = 0xA0000003;

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFileW(
        string fileName,
        uint desiredAccess,
        uint shareMode,
        IntPtr securityAttributes,
        uint creationDisposition,
        uint flagsAndAttributes,
        IntPtr templateFile);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool DeviceIoControl(
        SafeFileHandle device,
        uint controlCode,
        byte[] input,
        int inputSize,
        IntPtr output,
        int outputSize,
        out int bytesReturned,
        IntPtr overlapped);

    private static SafeFileHandle OpenDirectory(string path)
    {
        SafeFileHandle handle = CreateFileW(
            path,
            GENERIC_WRITE,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            IntPtr.Zero,
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
            IntPtr.Zero);
        if (handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateFileW directory attacker failed.");
        return handle;
    }

    public static void SetMountPoint(string path, string target)
    {
        string substitute = @"\??\" + Path.GetFullPath(target);
        string print = Path.GetFullPath(target);
        byte[] substituteBytes = Encoding.Unicode.GetBytes(substitute);
        byte[] printBytes = Encoding.Unicode.GetBytes(print);
        byte[] buffer = new byte[16 + substituteBytes.Length + 2 + printBytes.Length + 2];
        Buffer.BlockCopy(BitConverter.GetBytes(IO_REPARSE_TAG_MOUNT_POINT), 0, buffer, 0, 4);
        Buffer.BlockCopy(BitConverter.GetBytes((ushort)(buffer.Length - 8)), 0, buffer, 4, 2);
        Buffer.BlockCopy(BitConverter.GetBytes((ushort)0), 0, buffer, 8, 2);
        Buffer.BlockCopy(BitConverter.GetBytes((ushort)substituteBytes.Length), 0, buffer, 10, 2);
        Buffer.BlockCopy(BitConverter.GetBytes((ushort)(substituteBytes.Length + 2)), 0, buffer, 12, 2);
        Buffer.BlockCopy(BitConverter.GetBytes((ushort)printBytes.Length), 0, buffer, 14, 2);
        Buffer.BlockCopy(substituteBytes, 0, buffer, 16, substituteBytes.Length);
        Buffer.BlockCopy(printBytes, 0, buffer, 16 + substituteBytes.Length + 2, printBytes.Length);

        using (SafeFileHandle handle = OpenDirectory(path))
        {
            int returned;
            if (!DeviceIoControl(handle, FSCTL_SET_REPARSE_POINT, buffer, buffer.Length, IntPtr.Zero, 0, out returned, IntPtr.Zero))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "FSCTL_SET_REPARSE_POINT failed.");
        }
    }

    public static void ClearMountPoint(string path)
    {
        byte[] buffer = new byte[8];
        Buffer.BlockCopy(BitConverter.GetBytes(IO_REPARSE_TAG_MOUNT_POINT), 0, buffer, 0, 4);
        using (SafeFileHandle handle = OpenDirectory(path))
        {
            int returned;
            if (!DeviceIoControl(handle, FSCTL_DELETE_REPARSE_POINT, buffer, buffer.Length, IntPtr.Zero, 0, out returned, IntPtr.Zero))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "FSCTL_DELETE_REPARSE_POINT failed.");
        }
    }
}`;

async function invokeDirectoryReparseAttacker(operation, path, target = "") {
  const command = `$ErrorActionPreference = 'Stop'\nAdd-Type -TypeDefinition $env:JARVIS_REVIEW5_REPARSE_SOURCE\ntry {\n  [Review5DirectoryReparseAttacker]::${operation}($env:JARVIS_REVIEW5_REPARSE_PATH${operation === "SetMountPoint" ? ", $env:JARVIS_REVIEW5_REPARSE_TARGET" : ""})\n  [Console]::Out.WriteLine('success')\n  exit 0\n} catch {\n  $exception = $_.Exception\n  $native = -1\n  while ($null -ne $exception) {\n    if ($exception -is [System.ComponentModel.Win32Exception]) { $native = $exception.NativeErrorCode; break }\n    $exception = $exception.InnerException\n  }\n  [Console]::Error.WriteLine(('NativeErrorCode={0}; {1}' -f $native, $_.Exception.Message))\n  exit 17\n}`;
  const encoded = Buffer.from(command, "utf16le").toString("base64");
  const child = spawn("pwsh", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
    windowsHide: true,
    env: {
      ...process.env,
      JARVIS_REVIEW5_REPARSE_SOURCE: directoryReparseAttacker,
      JARVIS_REVIEW5_REPARSE_PATH: path,
      JARVIS_REVIEW5_REPARSE_TARGET: target,
    },
  });
  let stdout = "";
  let stderr = "";
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Directory reparse attacker timed out during ${operation}`)); }, 15_000);
    child.stdout.on("data", (data) => { stdout += data; });
    child.stderr.on("data", (data) => { stderr += data; });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (exitCode) => { clearTimeout(timer); resolve(exitCode); });
  });
  const nativeErrorCode = Number.parseInt(/NativeErrorCode=(-?\d+)/.exec(stderr)?.[1] ?? "-1", 10);
  return { code, stdout, stderr, nativeErrorCode };
}

async function waitForEffect(effectLog, expected, running, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (running.child.exitCode !== null) {
      const effects = await readFile(effectLog, "utf8").catch(() => "");
      const result = await running.result;
      throw new Error(`Entrypoint exited before ${expected}; effects=${JSON.stringify(effects)}; stderr=${JSON.stringify(result.stderr)}`);
    }
    const effects = await readFile(effectLog, "utf8").catch(() => "");
    if (effects.split("\n").includes(expected)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for deterministic containment boundary ${expected}`);
}

async function waitForPath(path, child, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await pathExists(path)) return;
    if (child.exitCode !== null) throw new Error(`Entrypoint exited before creating ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${path}`);
}

async function waitForPathGone(path, timeout = 5_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (!await pathExists(path)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${path} to disappear`);
}

async function waitForProcessGone(pid, timeout = 5_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for process ${pid} to exit`);
}

async function waitForOptionalPath(path, timeout = 5_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await pathExists(path)) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

async function removeCreatedJunctions(paths) {
  for (const path of paths.reverse()) {
    try {
      if ((await lstat(path)).isSymbolicLink()) await unlink(path);
    } catch {
      // The workflow may already have removed the junction without following it.
    }
  }
}

async function clearConvertedDirectoryJunctions(paths) {
  for (const path of paths.reverse()) {
    const metadata = await lstat(path).catch(() => undefined);
    if (!metadata?.isSymbolicLink()) continue;
    const cleared = await invokeDirectoryReparseAttacker("ClearMountPoint", path);
    if (cleared.code !== 0) throw new Error(`Failed to clear controlled directory junction ${path}: ${cleared.stderr}`);
  }
}

async function removeJunctionsNoFollow(root) {
  for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    const child = join(root, entry.name);
    const metadata = await lstat(child).catch(() => undefined);
    if (!metadata) continue;
    if (metadata.isSymbolicLink()) await unlink(child);
    else if (metadata.isDirectory()) await removeJunctionsNoFollow(child);
  }
}

async function getTreeManifestNoFollow(root, relative = "") {
  const manifest = [];
  for (const entry of await readdir(join(root, relative), { withFileTypes: true }).catch(() => [])) {
    const relativeChild = relative ? join(relative, entry.name) : entry.name;
    const metadata = await lstat(join(root, relativeChild));
    if (metadata.isSymbolicLink()) manifest.push(`reparse:${relativeChild}`);
    else if (metadata.isDirectory()) {
      manifest.push(`directory:${relativeChild}`);
      manifest.push(...await getTreeManifestNoFollow(root, relativeChild));
    } else manifest.push(`file:${relativeChild}:${metadata.size}`);
  }
  return manifest.sort();
}

async function createClosedFixture(workflow, label, scenario = "success") {
  const parent = await mkdtemp(join(tmpdir(), "jarvis-hermes-containment-review5-"));
  const externalTemp = join(parent, "t");
  const runtimeRoot = join(externalTemp, `jarvis-hermes-workflow-fixture-${label}`);
  const outside = join(parent, `outside-${label}`);
  const fixture = join(runtimeRoot, `${workflow}-operations.json`);
  const effects = join(runtimeRoot, "effects.log");
  const ack = join(runtimeRoot, "containment.ack");
  await mkdir(externalTemp);
  await mkdir(runtimeRoot);
  await mkdir(outside);
  await writeFile(fixture, `${JSON.stringify({ schemaVersion: 1, workflow, scenario })}\n`, "utf8");
  return { parent, runtimeRoot, outside, externalTemp, fixture, effects, ack, createdJunctions: [], convertedJunctions: [], running: undefined };
}

async function cleanupFixture(context) {
  if (context.running?.child.exitCode === null) {
    context.running.child.kill();
    await context.running.result.catch(() => {});
  }
  await clearConvertedDirectoryJunctions(context.convertedJunctions);
  await removeCreatedJunctions(context.createdJunctions);
  await removeJunctionsNoFollow(context.parent);
  await rm(context.parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

async function singleScratchDirectory(parent, prefix) {
  const candidates = (await readdir(parent, { withFileTypes: true }))
    .filter((entry) => entry.name.startsWith(prefix) && entry.isDirectory())
    .map((entry) => join(parent, entry.name));
  expect(candidates, `expected one live ${prefix} scratch directory`).toHaveLength(1);
  return candidates[0];
}

async function attemptDirectoryJunctionSwap(context, target, junctionTarget) {
  const displaced = `${target}.review5-displaced`;
  let renamed = false;
  let renameErrorCode;
  try {
    await rename(target, displaced);
    renamed = true;
    await symlink(junctionTarget, target, "junction");
    context.createdJunctions.push(target);
  } catch (error) {
    if (!renamed && ["EACCES", "EBUSY", "EPERM"].includes(error?.code)) renameErrorCode = error.code;
    else throw error;
  }
  return { displaced, renamed, renameErrorCode };
}

async function runPausedDirectoryReparseConversion(context, script, boundary, locateTarget, extraArgs = [], retainedAnchor = "") {
  context.running = launchPowerShellFile(script, [
    "-RuntimeRoot", context.runtimeRoot,
    "-TestOperationFixture", context.fixture,
    "-TestEffectLog", context.effects,
    "-TestPauseAfterEffect", boundary,
    "-TestEffectAck", context.ack,
    ...extraArgs,
  ]);

  await waitForEffect(context.effects, boundary, context.running);
  const outsideBefore = await getTreeManifestNoFollow(context.outside);
  const target = await locateTarget(context);
  const targetEntriesBefore = (await readdir(target)).sort();
  let anchorUnlinked = false;
  let anchorUnlinkErrorCode;
  if (retainedAnchor) {
    try {
      await unlink(join(target, retainedAnchor));
      anchorUnlinked = true;
    } catch (error) {
      anchorUnlinkErrorCode = error?.code;
    }
  }
  const conversion = await invokeDirectoryReparseAttacker("SetMountPoint", target, context.outside);
  let attackError;
  if (conversion.code === 0) {
    context.convertedJunctions.push(target);
    try {
      await writeFile(join(target, "outside-sentinel.txt"), "outside-write", "utf8");
    } catch (error) {
      attackError = error;
    }
  }
  const outsideAfterAttack = await getTreeManifestNoFollow(context.outside);
  await writeFile(context.ack, "continue\n", "utf8");
  const result = await context.running.result;
  const outsideAfter = await getTreeManifestNoFollow(context.outside);
  if (attackError) throw attackError;
  return { conversion, outsideBefore, outsideAfterAttack, outsideAfter, targetEntriesBefore, anchorUnlinked, anchorUnlinkErrorCode, result };
}

async function runPausedDirectorySwap(context, script, boundary, locateTarget, extraArgs = []) {
  context.running = launchPowerShellFile(script, [
    "-RuntimeRoot", context.runtimeRoot,
    "-TestOperationFixture", context.fixture,
    "-TestEffectLog", context.effects,
    "-TestPauseAfterEffect", boundary,
    "-TestEffectAck", context.ack,
    ...extraArgs,
  ]);

  await waitForEffect(context.effects, boundary, context.running);
  let renamed = false;
  let renameErrorCode;
  let attackError;
  try {
    const target = await locateTarget(context);
    await rename(target, `${target}.review5-displaced`);
    renamed = true;
    await symlink(context.outside, target, "junction");
    context.createdJunctions.push(target);
    await writeFile(join(target, "outside-sentinel.txt"), "outside-write", "utf8");
  } catch (error) {
    if (!renamed && ["EACCES", "EBUSY", "EPERM"].includes(error?.code)) renameErrorCode = error.code;
    else attackError = error;
  } finally {
    await writeFile(context.ack, "continue\n", "utf8");
  }

  const outsideWriteObserved = await pathExists(join(context.outside, "outside-sentinel.txt"));
  const result = await context.running.result;
  if (attackError) throw attackError;
  return { outsideWriteObserved, renamed, renameErrorCode, result };
}

function expectSwapBlocked(outcome, label) {
  expect(outcome.outsideWriteObserved, `${label} was redirected outside RuntimeRoot`).toBe(false);
  expect(outcome.renamed, `${label} was not protected by a DELETE-denying workflow lease`).toBe(false);
  expect(outcome.renameErrorCode, `${label} rename did not fail with a sharing violation`).toMatch(/^(EACCES|EBUSY|EPERM)$/);
}

function expectContained(outcome, label) {
  expectSwapBlocked(outcome, label);
  expect(outcome.result.code, outcome.result.stderr).toBe(0);
}

function expectReparseConversionDenied(outcome, label, expectedNativeErrors = [5, 32, 33]) {
  expect.soft(outcome.conversion.code, `${label} was converted in place to a junction: ${outcome.conversion.stderr}`).not.toBe(0);
  if (outcome.conversion.code !== 0) {
    expect(expectedNativeErrors, `${label} conversion did not fail closed with the expected native error`).toContain(outcome.conversion.nativeErrorCode);
  }
  expect(outcome.outsideBefore, `${label} outside fixture was not initially empty`).toEqual([]);
  expect.soft(outcome.outsideAfterAttack, `${label} allowed the attacker to redirect its sentinel outside RuntimeRoot`).toEqual([]);
  expect.soft(outcome.outsideAfter, `${label} redirected writes outside RuntimeRoot`).toEqual([]);
}

function expectReparseConversionBlocked(outcome, label, expectedNativeErrors = [5, 32, 33]) {
  expectReparseConversionDenied(outcome, label, expectedNativeErrors);
  expect(outcome.result.code, outcome.result.stderr).toBe(0);
}

function expectRetainedAnchor(outcome, label) {
  expect(outcome.targetEntriesBefore, `${label} must contain only its private containment anchor while relaxed`).toEqual([".hermes-containment.anchor"]);
  expect(outcome.anchorUnlinked, `${label} containment anchor was removable while the workflow was paused`).toBe(false);
  expect(["EACCES", "EBUSY", "EPERM"], `${label} anchor unlink did not fail with a sharing violation`).toContain(outcome.anchorUnlinkErrorCode);
}

async function singleArtifactStage(runtimeRoot) {
  const stages = (await readdir(runtimeRoot)).filter((name) => name.startsWith(".artifact-stage-"));
  expect(stages).toHaveLength(1);
  return join(runtimeRoot, stages[0]);
}

async function expectSyntheticArtifactsInstalled(runtimeRoot) {
  expect(await readFile(join(runtimeRoot, "toolchain", "cpython-3.11.16", "python", "python.exe"), "utf8")).toBe("synthetic-cpython-payload");
  expect(await readFile(join(runtimeRoot, "toolchain", "uv-0.12.7", "payload", "uv.exe"), "utf8")).toBe("synthetic-uv.exe");
  const serviceHost = await readFile(join(runtimeRoot, "service-host", "winsw-2.12.0", "payload", "WinSW-x64.exe"));
  expect(serviceHost).toHaveLength(128);
  expect([...serviceHost.subarray(0, 2)]).toEqual([0x4d, 0x5a]);
  expect(await readFile(join(runtimeRoot, "licenses", "python-build-standalone", "20260825", "python-licenses.rst"), "utf8")).toBe("synthetic-license-rollup");
  expect(await pathExists(join(runtimeRoot, ".hermes-runtime-publication.ready.json"))).toBe(true);
  expect((await readdir(runtimeRoot)).some((name) => name.startsWith(".artifact-stage-"))).toBe(false);
}

async function singleSourceStage(runtimeRoot) {
  const stagingParent = join(runtimeRoot, ".s");
  const stages = await readdir(stagingParent);
  expect(stages).toHaveLength(1);
  expect(stages[0]).toMatch(/^[a-f0-9]{32}$/);
  return join(stagingParent, stages[0]);
}

async function expectSyntheticSourceInstalled(runtimeRoot) {
  expect(await readFile(join(runtimeRoot, "releases", sourceCommit, "source", "hermes.txt"), "utf8")).toBe("synthetic-source-tree");
  expect(await pathExists(join(runtimeRoot, ".s"))).toBe(false);
}

describe("Hermes H1 workflow write containment review 5", () => {
  it("blocks a downloads rename-and-junction substitution before the first real artifact write", async () => {
    const context = await createClosedFixture("runtime-artifacts", "artifact-downloads");
    try {
      const outcome = await runPausedDirectorySwap(context, artifactEntrypoint, "before-first-download", async ({ runtimeRoot }) => {
        return join(await singleArtifactStage(runtimeRoot), "downloads");
      });
      expectContained(outcome, "artifact downloads directory");
      await expectSyntheticArtifactsInstalled(context.runtimeRoot);
    } finally {
      await cleanupFixture(context);
    }
  }, 120_000);

  it("blocks in-place junction conversion of the empty artifact downloads directory", async () => {
    const context = await createClosedFixture("runtime-artifacts", "artifact-downloads-direct-reparse");
    try {
      const outcome = await runPausedDirectoryReparseConversion(context, artifactEntrypoint, "before-first-download", async ({ runtimeRoot }) => {
        return join(await singleArtifactStage(runtimeRoot), "downloads");
      });
      expectReparseConversionBlocked(outcome, "artifact downloads directory");
      await expectSyntheticArtifactsInstalled(context.runtimeRoot);
    } finally {
      await cleanupFixture(context);
    }
  }, 120_000);

  for (const [boundary, relativeTarget, label] of [
    ["after-cpython-extraction", "cpython", "post-extraction CPython stage before the borrowed uv extraction"],
    ["before-raw-copies", join("promote", "cpython-3.11.16"), "raw-copy destination parent"],
  ]) {
    it(`blocks ${label} substitution at ${boundary}`, async () => {
      const context = await createClosedFixture("runtime-artifacts", `artifact-${boundary}`);
      try {
        const outcome = await runPausedDirectorySwap(context, artifactEntrypoint, boundary, async ({ runtimeRoot }) => join(await singleArtifactStage(runtimeRoot), relativeTarget));
        expectContained(outcome, label);
        await expectSyntheticArtifactsInstalled(context.runtimeRoot);
      } finally {
        await cleanupFixture(context);
      }
    }, 120_000);
  }

  it("refuses a hardlinked raw-copy destination without overwriting its outside bytes", async () => {
    const context = await createClosedFixture("runtime-artifacts", "artifact-raw-copy-hardlink");
    const outsideVictim = join(context.outside, "raw-copy-victim.bin");
    await writeFile(outsideVictim, "outside-original", "utf8");
    try {
      context.running = launchPowerShellFile(artifactEntrypoint, [
        "-RuntimeRoot", context.runtimeRoot,
        "-TestOperationFixture", context.fixture,
        "-TestEffectLog", context.effects,
        "-TestPauseAfterEffect", "before-raw-copies",
        "-TestEffectAck", context.ack,
      ]);
      await waitForEffect(context.effects, "before-raw-copies", context.running);
      const stage = await singleArtifactStage(context.runtimeRoot);
      const destination = join(stage, "promote", "cpython-3.11.16", "cpython-3.11.16+20260825-x86_64-pc-windows-msvc-install_only_stripped.tar.gz");
      let hardlinkCreated = false;
      let hardlinkErrorCode;
      try {
        await link(outsideVictim, destination);
        hardlinkCreated = true;
      } catch (error) {
        if (["EACCES", "EBUSY", "EPERM"].includes(error?.code)) hardlinkErrorCode = error.code;
        else throw error;
      } finally {
        await writeFile(context.ack, "continue\n", "utf8");
      }

      const result = await context.running.result;
      expect(await readFile(outsideVictim, "utf8"), "raw artifact copy followed a preexisting hardlink outside its stage").toBe("outside-original");
      if (hardlinkCreated) {
        expect(result.code).not.toBe(0);
        expect(result.stderr).toMatch(/already exists|CreateNew|destination|hardlink|safe regular/i);
        expect(await pathExists(join(context.runtimeRoot, ".hermes-runtime-publication.ready.json"))).toBe(false);
        expect(await pathExists(join(context.runtimeRoot, "toolchain", "cpython-3.11.16"))).toBe(false);
      } else {
        expect(hardlinkErrorCode, "strict raw-copy parent did not deny hardlink creation with a sharing violation").toMatch(/^(EACCES|EBUSY|EPERM)$/);
        expect(result.code, result.stderr).toBe(0);
        await expectSyntheticArtifactsInstalled(context.runtimeRoot);
      }
    } finally {
      await cleanupFixture(context);
    }
  }, 120_000);

  it("keeps every invoked publication, recovery, verification, and Git helper free of generic pathname operations", async () => {
    const artifactSource = await readFile(artifactEntrypoint, "utf8");
    const sourceSource = await readFile(sourceEntrypoint, "utf8");
    const moduleSource = await readFile(runtimeModule, "utf8");
    const scopedTail = (source, marker, label) => {
      const markerIndex = source.indexOf(marker);
      expect(markerIndex, `${label} scope marker is missing`).toBeGreaterThanOrEqual(0);
      return source.slice(markerIndex);
    };
    const scopes = [
      ["artifact workflow", scopedTail(artifactSource, "$workflowLock = Enter-HermesWorkflowLock", "artifact workflow")],
      ["source workflow", scopedTail(sourceSource, "$workflowLock = Enter-HermesWorkflowLock", "source workflow")],
      ["publication and recovery module", scopedTail(moduleSource, "function Promote-StagedDirectory", "publication and recovery module")],
      ["artifact installed-payload verifier", extractPowerShellFunction(artifactSource, "Assert-InstalledPayloads")],
      ["closed Git process helper", extractPowerShellFunction(moduleSource, "Invoke-HermesGitProcess")],
      ["Git work-tree verifier", extractPowerShellFunction(moduleSource, "Assert-HermesGitWorkTreeMatchesCommit")],
    ];

    for (const [label, containmentScope] of scopes) {
      expect.soft(containmentScope, `${label} must use identity-preserving contained operations`).not.toMatch(/\b(?:Copy-Item|Move-Item)\b/i);
      expect.soft(containmentScope, `${label} must not recursively traverse hostile staged trees`).not.toMatch(/\bRemove-Item\b[^\r\n]*-Recurse\b/i);
    }
  });

  it("brackets a write-through exact rename with strict source and destination snapshots", async () => {
    const moduleSource = await readFile(runtimeModule, "utf8");
    const movableOpen = extractCSharpMethod(moduleSource, "public static NativeFileGuard OpenMovableDirectoryLease(");
    const snapshotOpen = extractCSharpMethod(moduleSource, "public static NativeFileGuard OpenReadOnlySnapshot(");
    const moveHelper = extractPowerShellFunction(moduleSource, "Move-HermesLeasedDirectoryNoReplace");
    expect(movableOpen).toMatch(/FILE_FLAG_WRITE_THROUGH\s*=\s*0x80000000/i);
    expect(movableOpen).toMatch(/new NativeFileGuard\([^;]+FILE_FLAG_WRITE_THROUGH\)/s);
    expect(snapshotOpen).toMatch(/GENERIC_READ\s*=\s*0x80000000/i);
    expect(snapshotOpen).toMatch(/new NativeFileGuard\([^;]+GENERIC_READ[^;]+FILE_SHARE_READ/s);
    expect(snapshotOpen).not.toMatch(/FILE_SHARE_(?:WRITE|DELETE)/);
    expect(moveHelper.match(/Enter-HermesReadOnlyTreeSnapshot/g)).toHaveLength(2);
    const sourceSnapshotAssert = moveHelper.indexOf("Assert-HermesReadOnlyTreeSnapshot $sourceSnapshot");
    const sourceSnapshotExit = moveHelper.indexOf("Exit-HermesReadOnlyTreeSnapshot $sourceSnapshot");
    const descendantRelease = moveHelper.indexOf("Release-HermesDirectoryLeaseSubtree $Context $sourceFull -RetainRootLease");
    const exactRename = moveHelper.indexOf("$sourceMoveLease.MoveToNoReplace($destinationFull)");
    const destinationSnapshotEntry = moveHelper.indexOf("$destinationSnapshot = Enter-HermesReadOnlyTreeSnapshot");
    const postMoveDigest = moveHelper.indexOf("Get-HermesDirectoryDigest $root $destinationFull");
    const destinationSnapshotAssert = moveHelper.indexOf("Assert-HermesReadOnlyTreeSnapshot $destinationSnapshot");
    const destinationSnapshotExit = moveHelper.indexOf("Exit-HermesReadOnlyTreeSnapshot $destinationSnapshot");
    const rollbackDescendantRelease = moveHelper.indexOf("Release-HermesDirectoryLeaseSubtree $Context $destinationFull -RetainRootLease");
    const successfulSnapshotExit = moveHelper.lastIndexOf("Exit-HermesReadOnlyTreeSnapshot $destinationSnapshot");
    expect(sourceSnapshotAssert).toBeGreaterThanOrEqual(0);
    expect(sourceSnapshotExit).toBeGreaterThan(sourceSnapshotAssert);
    expect(descendantRelease).toBeGreaterThan(sourceSnapshotExit);
    expect(exactRename).toBeGreaterThan(descendantRelease);
    expect(destinationSnapshotEntry).toBeGreaterThan(exactRename);
    expect(postMoveDigest).toBeGreaterThan(destinationSnapshotEntry);
    expect(destinationSnapshotAssert).toBeGreaterThan(postMoveDigest);
    expect(destinationSnapshotExit).toBeGreaterThan(destinationSnapshotAssert);
    expect(rollbackDescendantRelease).toBeGreaterThan(destinationSnapshotExit);
    expect(successfulSnapshotExit).toBeGreaterThan(rollbackDescendantRelease);
  });

  it("creates every Git process inside an atomic kill-on-close job before its first instruction", async () => {
    const moduleSource = await readFile(runtimeModule, "utf8");
    const gitProcess = extractPowerShellFunction(moduleSource, "Invoke-HermesGitProcess");
    const nativeRun = extractCSharpMethod(moduleSource, "public static NativeProcessResult Run(");
    for (const primitive of [
      "STARTUPINFOEX",
      "PROC_THREAD_ATTRIBUTE_JOB_LIST",
      "PROC_THREAD_ATTRIBUTE_HANDLE_LIST",
      "JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE",
      "EXTENDED_STARTUPINFO_PRESENT",
      "CREATE_UNICODE_ENVIRONMENT",
      "InitializeProcThreadAttributeList",
      "UpdateProcThreadAttribute",
    ]) expect(moduleSource, `native Git launcher is missing ${primitive}`).toContain(primitive);
    expect(gitProcess, "Git still uses Process.Start and permits an uncontained post-start window").not.toMatch(/\[Diagnostics\.Process\]|\.Start\(\)/);
    const jobAttribute = nativeRun.indexOf("new IntPtr(PROC_THREAD_ATTRIBUTE_JOB_LIST)");
    const handleAttribute = nativeRun.indexOf("new IntPtr(PROC_THREAD_ATTRIBUTE_HANDLE_LIST)");
    const createProcess = nativeRun.indexOf("if (!CreateProcessW(");
    expect(jobAttribute, "native launch method does not install the atomic job-list attribute").toBeGreaterThanOrEqual(0);
    expect(handleAttribute, "native launch method does not install the exact inherited-handle list").toBeGreaterThan(jobAttribute);
    expect(createProcess, "native launch method does not call CreateProcessW").toBeGreaterThan(handleAttribute);
    expect(nativeRun, "native child is not created suspended inside its preconfigured job").toMatch(/creationFlags\s*=\s*CREATE_SUSPENDED\s*\|[\s\S]*?EXTENDED_STARTUPINFO_PRESENT/);
    expect(nativeRun, "native launcher does not restrict inheritance to its three standard handles").toMatch(/handleList\s*=\s*Marshal\.AllocHGlobal\(IntPtr\.Size\s*\*\s*3\)[\s\S]*?stdinNull[\s\S]*?stdoutWrite[\s\S]*?stderrWrite[\s\S]*?PROC_THREAD_ATTRIBUTE_HANDLE_LIST/);
    expect(nativeRun, "job handle must not be inherited by the child").not.toMatch(/WriteIntPtr\(handleList[^;\r\n]*job/i);
    expect(nativeRun, "native launcher does not use its explicit Unicode environment block").toMatch(/CreateProcessW\([^;]*true,\s*creationFlags,\s*environmentBlock,/);
    expect(moduleSource, "kill-on-close job flag is not exact").toMatch(/JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE\s*=\s*0x00002000/i);
    expect(moduleSource, "Unicode child environment flag is not exact").toMatch(/CREATE_UNICODE_ENVIRONMENT\s*=\s*0x00000400/i);
  });

  it("kills the real Git descendant tree when its owning PowerShell workflow terminates abruptly", async () => {
    const parent = await mkdtemp(join(tmpdir(), "jarvis-hermes-containment-review5-process-tree-"));
    const runtimeRoot = join(parent, "jarvis-hermes-workflow-fixture-process-tree");
    const outside = join(parent, "outside");
    const marker = join(runtimeRoot, "git-start.marker");
    const releaseSignal = join(parent, "release-child.signal");
    const childStarted = join(parent, "child-started.signal");
    const delayedCommand = join(parent, "delayed-git-child.cmd");
    const pingOutput = join(parent, "ping-output.txt");
    const stageId = "e".repeat(32);
    const anchor = join(runtimeRoot, ".s", stageId, "git", ".hermes-containment.anchor");
    const displaced = `${runtimeRoot}.review5-displaced`;
    let parentRun;
    let descendants = [];
    let runtimeJunctionCreated = false;
    await mkdir(runtimeRoot);
    await mkdir(outside);
    await writeFile(join(outside, "outside-sentinel.txt"), "outside-original", "utf8");
    await writeFile(delayedCommand, `@echo off\r\n> "${childStarted}" echo started\r\n:wait\r\nif exist "${releaseSignal}" goto released\r\nC:\\Windows\\System32\\ping.exe -n 2 127.0.0.1 > "${pingOutput}"\r\ngoto wait\r\n:released\r\n> "%TEMP%\\escaped.txt" echo escaped\r\n`, "utf8");
    const parentCommand = String.raw`$ErrorActionPreference = 'Stop'
Import-Module $env:JARVIS_REVIEW5_RUNTIME_MODULE -Force
$root = Assert-LiteralRuntimeRoot $env:JARVIS_REVIEW5_RUNTIME_ROOT
$lock = Enter-HermesWorkflowLock $root
$context = New-HermesWriteContainmentContext $root $lock
$stagingParent = Join-Path $root '.s'
[void](New-HermesLeasedDirectory $context $stagingParent -FreshLeaf)
$stage = Join-Path $stagingParent $env:JARVIS_REVIEW5_STAGE_ID
[void](New-HermesLeasedDirectory $context $stage -FreshLeaf)
$gitDirectory = Join-Path $stage 'git'
[void](New-HermesLeasedDirectory $context $gitDirectory -FreshLeaf)
[void](Enter-HermesGitWritableDirectoryTree $context $gitDirectory)
$boundary = {
  param([string]$Name)
  if ($Name -ceq 'before-git-workspace-process-start') {
    [IO.File]::WriteAllText($env:JARVIS_REVIEW5_PROCESS_MARKER, [string]$PID, [Text.UTF8Encoding]::new($false))
  }
}
$alias = $env:JARVIS_REVIEW5_GIT_ALIAS
[void](Invoke-GitChecked -Git (Get-HermesTrustedGitExecutable) -Arguments @('-c', $alias, 'review5hold') -LeaseContext $context -Boundary $boundary)
throw 'Long-running Git descendant probe returned unexpectedly.'`;
    try {
      parentRun = launchPowerShellCommand(parentCommand, {
        ...process.env,
        JARVIS_REVIEW5_RUNTIME_MODULE: runtimeModule,
        JARVIS_REVIEW5_RUNTIME_ROOT: runtimeRoot,
        JARVIS_REVIEW5_PROCESS_MARKER: marker,
        JARVIS_REVIEW5_STAGE_ID: stageId,
        JARVIS_REVIEW5_GIT_ALIAS: `alias.review5hold=!C:/Windows/System32/cmd.exe //d //c ${delayedCommand.replaceAll("\\", "/")}`,
      }, 120_000);
      await waitForPath(marker, parentRun.child);
      expect(Number((await readFile(marker, "utf8")).trim())).toBe(parentRun.child.pid);
      const workspace = await singleScratchDirectory(runtimeRoot, ".verify-git-");
      const workspaceName = workspace.slice(workspace.lastIndexOf("\\") + 1);
      const temporary = join(workspace, "tmp");
      await waitForPath(childStarted, parentRun.child);
      descendants = await waitForGitProcessTree(parentRun.child.pid);
      expect(parentRun.child.exitCode, "owning PowerShell exited before the process-tree termination probe").toBeNull();
      expect(await pathExists(anchor), "writable Git anchor was absent before abrupt owner termination").toBe(true);

      let tmpRenamedWhileLive = false;
      let liveTmpRenameErrorCode;
      try {
        await rename(temporary, `${temporary}.review5-displaced`);
        tmpRenamedWhileLive = true;
        await rename(`${temporary}.review5-displaced`, temporary);
      } catch (error) {
        liveTmpRenameErrorCode = error?.code;
      }
      expect(tmpRenamedWhileLive, "Git TEMP was renameable while the owning containment process was live").toBe(false);
      expect(["EACCES", "EBUSY", "EPERM"]).toContain(liveTmpRenameErrorCode);

      expect(parentRun.child.kill(), "failed to terminate the owning PowerShell workflow").toBe(true);
      await waitForProcessGone(parentRun.child.pid);
      await waitForPathGone(anchor);
      await new Promise((resolve) => setTimeout(resolve, 250));
      const postDeathDescendants = await getDescendantProcesses(parentRun.child.pid);
      for (const descendant of postDeathDescendants) if (!descendants.some(({ pid }) => pid === descendant.pid)) descendants.push(descendant);
      const survivors = descendants.filter(({ pid }) => isProcessAlive(pid));
      await rename(runtimeRoot, displaced);
      const outsideTemporary = join(outside, workspaceName, "tmp");
      await mkdir(outsideTemporary, { recursive: true });
      const outsideBeforeSwap = await getTreeManifestNoFollow(outside);
      await symlink(outside, runtimeRoot, "junction");
      runtimeJunctionCreated = true;
      await writeFile(releaseSignal, "continue", "utf8");
      const escaped = await waitForOptionalPath(join(outsideTemporary, "escaped.txt"), 15_000);
      const terminatedParent = await parentRun.result;
      const outsideAfter = await getTreeManifestNoFollow(outside);
      expect(terminatedParent.code).not.toBe(0);
      expect.soft(survivors, `Git descendants survived owner termination: ${JSON.stringify(descendants)}`).toEqual([]);
      expect.soft(outsideAfter, "a surviving Git descendant wrote through the post-death RuntimeRoot substitution").toEqual(outsideBeforeSwap);
      expect.soft(escaped, "delayed real-Git descendant demonstrated a bounded outside write after owner death").toBe(false);
    } finally {
      if (parentRun?.child.exitCode === null && parentRun?.child.signalCode === null) {
        parentRun.child.kill();
        await parentRun.result.catch(() => {});
      }
      for (const { pid } of [...descendants].reverse()) {
        if (isProcessAlive(pid)) {
          try { process.kill(pid); } catch {}
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
      if (runtimeJunctionCreated) await unlink(runtimeRoot).catch(() => {});
      await removeJunctionsNoFollow(parent);
      await rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  }, 120_000);

  for (const [kind, suffix] of [["git", "a"], ["index", "b"], ["payload", "c"]]) {
    it(`removes a safe exact ${kind} scratch crash residue before the next same-root workflow`, async () => {
      const context = await createClosedFixture("runtime-artifacts", `safe-${kind}-scratch-residue`);
      const residue = join(context.runtimeRoot, `.verify-${kind}-${suffix.repeat(32)}`);
      try {
        await mkdir(join(residue, "nested"), { recursive: true });
        await writeFile(join(residue, "nested", "crash-residue.bin"), "bounded residue", "utf8");
        const outsideBefore = await getTreeManifestNoFollow(context.outside);
        const childEnv = { ...process.env, TEMP: context.externalTemp, TMP: context.externalTemp };
        const result = await launchPowerShellFile(artifactEntrypoint, [
          "-RuntimeRoot", context.runtimeRoot,
          "-TestOperationFixture", context.fixture,
        ], 120_000, childEnv).result;
        const outsideAfter = await getTreeManifestNoFollow(context.outside);
        const oldAmbientScratch = (await readdir(context.externalTemp))
          .filter((name) => /^jarvis-hermes-(?:git|index|verify)-/.test(name));

        expect(result.code, result.stderr).toBe(0);
        expect(await pathExists(residue), `safe ${kind} scratch residue survived startup recovery`).toBe(false);
        expect(outsideAfter, `safe ${kind} scratch recovery changed the bounded outside tree`).toEqual(outsideBefore);
        expect(oldAmbientScratch, "workflow recreated a legacy scratch root in caller TEMP").toEqual([]);
        await expectSyntheticArtifactsInstalled(context.runtimeRoot);
      } finally {
        await cleanupFixture(context);
      }
    }, 120_000);
  }

  it("fails closed on an exact scratch crash-residue junction without traversing or deleting it", async () => {
    const context = await createClosedFixture("runtime-artifacts", "hostile-scratch-residue");
    const residue = join(context.runtimeRoot, `.verify-payload-${"d".repeat(32)}`);
    await writeFile(join(context.outside, "outside-sentinel.txt"), "outside-original", "utf8");
    try {
      await symlink(context.outside, residue, "junction");
      context.createdJunctions.push(residue);
      const outsideBefore = await getTreeManifestNoFollow(context.outside);
      const result = await runPowerShellFile(artifactEntrypoint, [
        "-RuntimeRoot", context.runtimeRoot,
        "-TestOperationFixture", context.fixture,
        "-TestEffectLog", context.effects,
      ]);
      const outsideAfter = await getTreeManifestNoFollow(context.outside);
      const residueMetadata = await lstat(residue);

      expect(result.code).not.toBe(0);
      expect(result.stderr).toMatch(/reparse|safe directory|scratch residue|contained/i);
      expect(await pathExists(context.effects), "hostile scratch recovery reached a normal workflow effect").toBe(false);
      expect(residueMetadata.isSymbolicLink(), "hostile scratch junction was deleted or replaced through its pathname").toBe(true);
      expect(outsideAfter, "hostile scratch recovery traversed or changed the bounded outside tree").toEqual(outsideBefore);
      expect(await readFile(join(context.outside, "outside-sentinel.txt"), "utf8")).toBe("outside-original");
    } finally {
      await cleanupFixture(context);
    }
  }, 120_000);

  for (const [boundary, label] of [
    ["before-installed-payload-scratch-write", "first installed-payload extraction"],
    ["before-installed-payload-scratch-copy", "first installed-payload archive copy"],
  ]) {
    it(`anchors the contained payload scratch before its ${label}`, async () => {
      const context = await createClosedFixture("runtime-artifacts", boundary.endsWith("write") ? "avw" : "avc");
      try {
        const childEnv = { ...process.env, TEMP: context.externalTemp, TMP: context.externalTemp };
        context.running = launchPowerShellFile(artifactEntrypoint, [
          "-RuntimeRoot", context.runtimeRoot,
          "-TestOperationFixture", context.fixture,
          "-TestEffectLog", context.effects,
          "-TestPauseAfterEffect", boundary,
          "-TestEffectAck", context.ack,
        ], 120_000, childEnv);
        await waitForEffect(context.effects, boundary, context.running);

        const scratch = await singleScratchDirectory(context.runtimeRoot, ".verify-payload-");
        const outsideBefore = await getTreeManifestNoFollow(context.outside);
        const attack = await attemptDirectoryJunctionSwap(context, join(scratch, "cpython"), context.outside);
        await writeFile(context.ack, "continue\n", "utf8");
        const result = await context.running.result;
        const outsideAfter = await getTreeManifestNoFollow(context.outside);

        expect.soft(outsideAfter, `${label} wrote through a substituted payload scratch child`).toEqual(outsideBefore);
        expect.soft(attack.renamed, "contained payload scratch child was not protected by a DELETE-denying lease").toBe(false);
        expect.soft(["EACCES", "EBUSY", "EPERM"], "payload scratch-child rename did not fail with a sharing violation").toContain(attack.renameErrorCode);
        expect(result.code, result.stderr).toBe(0);
      } finally {
        await cleanupFixture(context);
      }
    }, 120_000);
  }

  it("anchors the closed Git workspace tmp child while the real local Git process is held", async () => {
    const context = await createClosedFixture("source", "gwt", "git-hostile-environment");
    const redirectedTmp = join(context.outside, "redirected-tmp");
    await mkdir(redirectedTmp);
    await writeFile(join(redirectedTmp, "outside-sentinel.txt"), "outside-original", "utf8");
    try {
      const childEnv = { ...process.env, TEMP: context.externalTemp, TMP: context.externalTemp };
      context.running = launchPowerShellFile(sourceEntrypoint, [
        "-RuntimeRoot", context.runtimeRoot,
        "-TestOperationFixture", context.fixture,
        "-TestEffectLog", context.effects,
        "-TestPauseAfterEffect", "before-git-workspace-process-start",
        "-TestEffectAck", context.ack,
      ], 120_000, childEnv);
      await waitForEffect(context.effects, "before-git-workspace-process-start", context.running);

      const workspace = await singleScratchDirectory(context.runtimeRoot, ".verify-git-");
      const outsideBefore = await getTreeManifestNoFollow(context.outside);
      const attack = await attemptDirectoryJunctionSwap(context, join(workspace, "tmp"), redirectedTmp);
      await writeFile(context.ack, "continue\n", "utf8");
      const result = await context.running.result;
      const outsideAfter = await getTreeManifestNoFollow(context.outside);

      expect.soft(outsideAfter, "real Git or cleanup changed the redirected tmp target").toEqual(outsideBefore);
      expect.soft(attack.renamed, "real Git tmp was not protected by a DELETE-denying lease").toBe(false);
      expect.soft(["EACCES", "EBUSY", "EPERM"], "real Git tmp rename did not fail with a sharing violation").toContain(attack.renameErrorCode);
      expect(result.code, result.stderr).toBe(0);
    } finally {
      await cleanupFixture(context);
    }
  }, 120_000);

  it("holds real Git config against replacement and never writes through a hardlinked substitute", async () => {
    const context = await createClosedFixture("source", "git-config-hardlink", "git-hostile-environment");
    const outsideVictim = join(context.outside, "git-config-victim.txt");
    await writeFile(outsideVictim, "outside-original", "utf8");
    try {
      context.running = launchPowerShellFile(sourceEntrypoint, [
        "-RuntimeRoot", context.runtimeRoot,
        "-TestOperationFixture", context.fixture,
        "-TestEffectLog", context.effects,
        "-TestPauseAfterEffect", "before-git-workspace-process-start",
        "-TestEffectAck", context.ack,
      ]);
      await waitForEffect(context.effects, "before-git-workspace-process-start", context.running);

      const stage = await singleSourceStage(context.runtimeRoot);
      const config = join(stage, "closed-environment-probe.git", "config");
      let replacementSucceeded = false;
      let replacementErrorCode;
      try {
        if (await pathExists(config)) await unlink(config);
        await link(outsideVictim, config);
        replacementSucceeded = true;
      } catch (error) {
        replacementErrorCode = error?.code;
      } finally {
        await writeFile(context.ack, "continue\n", "utf8");
      }
      const result = await context.running.result;

      expect(await readFile(outsideVictim, "utf8"), "real Git wrote through a hardlinked repository config").toBe("outside-original");
      if (result.code !== 0) {
        expect(result.stderr).toMatch(/config|hardlink|identity|Git/i);
      } else {
        expect(replacementSucceeded, "real Git accepted a replaced hardlinked config").toBe(false);
        expect(replacementErrorCode).toMatch(/^(EACCES|EBUSY|EPERM)$/);
      }
    } finally {
      await cleanupFixture(context);
    }
  }, 120_000);

  it("uses a non-writing fetch head and managed no-clobber blob export instead of Git init or checkout", async () => {
    const source = await readFile(sourceEntrypoint, "utf8");
    expect(source).toContain("--no-write-fetch-head");
    expect(source).toContain("Export-HermesGitBlobsNoClobber");
    expect(source).not.toMatch(/@\('init',\s*'--bare'/);
    expect(source).not.toMatch(/'checkout',\s*'--detach'/);
  });

  it("materializes and verifies raw Git blobs without executing hostile clean or smudge filters", async () => {
    const parent = await mkdtemp(join(tmpdir(), "jarvis-hermes-filter-proof-"));
    const runtimeRoot = join(parent, "runtime");
    const seed = join(runtimeRoot, "seed");
    const gitStore = join(runtimeRoot, "git");
    const source = join(runtimeRoot, "source");
    const marker = join(parent, "filter-executed.txt");
    const filterProgram = join(parent, "hostile-filter.mjs");
    const runner = join(parent, "safe-export.ps1");
    const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "NUL" };
    const shellQuote = (value) => `"${value.replaceAll("\\", "/").replaceAll("\"", "\\\"")}"`;
    try {
      await mkdir(seed, { recursive: true });
      await runGitChecked(["init", "--quiet", seed], parent, gitEnv);
      await Promise.all([
        writeFile(join(seed, "LICENSE"), "fixture license\n", "utf8"),
        writeFile(join(seed, "pyproject.toml"), "[project]\nname='fixture'\n", "utf8"),
        writeFile(join(seed, "uv.lock"), "version = 1\n", "utf8"),
        writeFile(join(seed, "payload.txt"), "raw payload\n", "utf8"),
        writeFile(join(seed, ".gitattributes"), "*.txt filter=hostile\n", "utf8"),
        writeFile(filterProgram, "import { writeFileSync } from 'node:fs';\nwriteFileSync(process.argv[2], 'executed');\nprocess.stdin.pipe(process.stdout);\n", "utf8"),
      ]);
      await runGitChecked(["-C", seed, "add", "."], parent, gitEnv);
      await runGitChecked(["-c", "user.name=Review5", "-c", "user.email=review5@example.invalid", "-C", seed, "commit", "--quiet", "-m", "hostile filter fixture"], parent, gitEnv);
      const commit = (await runGitChecked(["-C", seed, "rev-parse", "HEAD"], parent, gitEnv)).stdout.trim();
      const tree = (await runGitChecked(["-C", seed, "rev-parse", "HEAD^{tree}"], parent, gitEnv)).stdout.trim();
      const filterCommand = `${shellQuote(process.execPath)} ${shellQuote(filterProgram)} ${shellQuote(marker)}`;
      await runGitChecked(["-C", seed, "config", "filter.hostile.smudge", filterCommand], parent, gitEnv);
      await runGitChecked(["-C", seed, "cat-file", "--filters", "HEAD:payload.txt"], parent, gitEnv);
      expect(await pathExists(marker), "negative control did not execute the configured hostile filter").toBe(true);
      await rm(marker, { force: true });

      await rename(join(seed, ".git"), gitStore);
      await writeFile(join(gitStore, "HEAD"), `${commit}\n`, "utf8");
      await rm(seed, { recursive: true, force: true });
      await mkdir(source);
      await writeFile(runner, [
        "param([string]$ModulePath,[string]$Root,[string]$GitStore,[string]$Source,[string]$Commit,[string]$Tree)",
        "$ErrorActionPreference = 'Stop'",
        "Import-Module $ModulePath -Force -DisableNameChecking -WarningAction SilentlyContinue",
        "$workflowLock = Enter-HermesWorkflowLock $Root",
        "$context = New-HermesWriteContainmentContext $Root $workflowLock",
        "try {",
        "  [void](Add-HermesDirectoryTreeLeases $context $GitStore)",
        "  [void](Add-HermesDirectoryTreeLeases $context $Source)",
        "  $git = Get-HermesTrustedGitExecutable",
        "  $entries = @(Get-HermesGitTreePaths $git $GitStore $Commit $context)",
        "  [void](Enter-HermesGitWritableDirectoryTree $context $Source)",
        "  try { Export-HermesGitBlobsNoClobber $git $GitStore $Source $entries $context } finally { [void](Exit-HermesGitWritableDirectoryTree $context $Source) }",
        "  [void](Add-HermesDirectoryTreeLeases $context $Source)",
        "  $hashes = @{}",
        "  foreach ($name in @('LICENSE','pyproject.toml','uv.lock')) { $hashes[$name] = (Get-FileHash -LiteralPath (Join-Path $Source $name) -Algorithm SHA256).Hash.ToLowerInvariant() }",
        "  $lock = @{ sourceCommit = $Commit; sourceTree = $Tree; rawFileSha256 = $hashes }",
        "  Assert-HermesSourceDirectory $Root $Source $lock $GitStore -LeaseContext $context",
        "  $raceDetected = $false",
        "  try {",
        "    Assert-HermesSourceDirectory $Root $Source $lock $GitStore -LeaseContext $context -Boundary { param([string]$Name) [IO.File]::WriteAllText((Join-Path $Source 'inserted-after-hash.txt'), 'hostile') }",
        "  } catch { if ($_.Exception.Message -match 'changed during.*read-only verification') { $raceDetected = $true } else { throw } }",
        "  if (-not $raceDetected) { throw 'Post-hash source insertion was not detected.' }",
        "  [IO.File]::Delete((Join-Path $Source 'inserted-after-hash.txt'))",
        "} finally { try { Exit-HermesWriteContainment $context } finally { $workflowLock.Dispose() } }",
        "",
      ].join("\n"), "utf8");

      const result = await runPowerShellFile(runner, [
        "-ModulePath", runtimeModule,
        "-Root", runtimeRoot,
        "-GitStore", gitStore,
        "-Source", source,
        "-Commit", commit,
        "-Tree", tree,
      ], 120_000);

      expect(result.code, result.stderr).toBe(0);
      expect(await pathExists(marker), "managed export or verification executed the hostile filter").toBe(false);
      expect(await readFile(join(source, "payload.txt"), "utf8")).toBe("raw payload\n");
    } finally {
      await rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  }, 120_000);

  it("does not report closed Git workspace cleanup after its live root was substituted", async () => {
    const context = await createClosedFixture("source", "gwr", "git-hostile-environment");
    const redirectedWorkspace = join(context.outside, "redirected-workspace");
    await mkdir(join(redirectedWorkspace, "home"), { recursive: true });
    await mkdir(join(redirectedWorkspace, "templates"));
    await mkdir(join(redirectedWorkspace, "tmp"));
    await writeFile(join(redirectedWorkspace, "outside-sentinel.txt"), "outside-original", "utf8");
    try {
      const childEnv = { ...process.env, TEMP: context.externalTemp, TMP: context.externalTemp };
      context.running = launchPowerShellFile(sourceEntrypoint, [
        "-RuntimeRoot", context.runtimeRoot,
        "-TestOperationFixture", context.fixture,
        "-TestEffectLog", context.effects,
        "-TestPauseAfterEffect", "before-git-workspace-process-start",
        "-TestEffectAck", context.ack,
      ], 120_000, childEnv);
      await waitForEffect(context.effects, "before-git-workspace-process-start", context.running);

      const workspace = await singleScratchDirectory(context.runtimeRoot, ".verify-git-");
      const outsideBefore = await getTreeManifestNoFollow(context.outside);
      const attack = await attemptDirectoryJunctionSwap(context, workspace, redirectedWorkspace);
      await writeFile(context.ack, "continue\n", "utf8");
      const result = await context.running.result;
      const outsideAfter = await getTreeManifestNoFollow(context.outside);

      expect.soft(outsideAfter, "real Git or cleanup changed the substituted workspace target").toEqual(outsideBefore);
      expect.soft(attack.renamed, "real Git workspace root was not protected by a DELETE-denying lease").toBe(false);
      expect.soft(["EACCES", "EBUSY", "EPERM"], "workspace-root rename did not fail with a sharing violation").toContain(attack.renameErrorCode);
      expect.soft(await pathExists(attack.displaced), "cleanup reported success while the real workspace survived under its displaced name").toBe(false);
      expect(result.code, result.stderr).toBe(0);
    } finally {
      await cleanupFixture(context);
    }
  }, 120_000);

  it("reports both a Git failure and a separate closed-workspace cleanup failure", async () => {
    const context = await createClosedFixture("source", "git-primary-workspace-cleanup");
    const command = String.raw`$ErrorActionPreference = 'Stop'
Import-Module $env:JARVIS_REVIEW5_MODULE -Force
$root = Assert-LiteralRuntimeRoot $env:JARVIS_REVIEW5_RUNTIME_ROOT
$workflow = Enter-HermesWorkflowLock $root
$containment = New-HermesWriteContainmentContext $root $workflow
$held = [Collections.Generic.List[IDisposable]]::new()
$observed = $null
try {
  $boundary = {
    param([string]$Name)
    if ($Name -cne 'before-git-workspace-process-start') { return }
    $workspaces = @(Get-ChildItem -LiteralPath $root -Force -Directory | Where-Object { $_.Name -cmatch '^\.verify-git-[a-f0-9]{32}$' })
    if ($workspaces.Count -ne 1) { throw 'Expected one exact closed Git workspace.' }
    $heldPath = Join-Path $workspaces[0].FullName 'tmp\cleanup-held.tmp'
    Write-HermesContainedTextCreateNew $containment $heldPath 'held-for-cleanup'
    $held.Add([IO.File]::Open($heldPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None))
  }.GetNewClosure()
  try {
    Invoke-GitChecked -Git (Get-HermesTrustedGitExecutable) -Arguments @('--review5-primary-git-failure-sentinel') -LeaseContext $containment -Boundary $boundary
    throw 'Invalid Git command unexpectedly succeeded.'
  } catch {
    $observed = $_
  }
} finally {
  for ($index = $held.Count - 1; $index -ge 0; $index--) { $held[$index].Dispose() }
  Exit-HermesWriteContainment $containment
  $workflow.Dispose()
}
if ($null -eq $observed) { throw 'Git failure was not observed.' }
throw $observed
`;
    try {
      const result = await launchPowerShellCommand(command, {
        ...process.env,
        JARVIS_REVIEW5_MODULE: runtimeModule,
        JARVIS_REVIEW5_RUNTIME_ROOT: context.runtimeRoot,
      }).result;
      expect(result.code).not.toBe(0);
      expect(result.stderr).toMatch(/review5-primary-git-failure-sentinel.*Closed Git workspace cleanup also failed closed\./is);
      expect(result.stderr).not.toContain(context.runtimeRoot);
      expect(result.stderr).not.toContain("cleanup-held.tmp");
      const workspaces = (await readdir(context.runtimeRoot, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && /^\.verify-git-[a-f0-9]{32}$/.test(entry.name));
      expect(workspaces).toHaveLength(1);
      expect(await pathExists(join(context.runtimeRoot, workspaces[0].name, "tmp", "cleanup-held.tmp")), "failed cleanup discarded its retained evidence").toBe(true);
      expect(await getTreeManifestNoFollow(context.outside)).toEqual([]);
    } finally {
      await cleanupFixture(context);
    }
  }, 120_000);

  it("anchors the actual Git index root before read-tree can create index.lock outside", async () => {
    const context = await createClosedFixture("source", "gix");
    const repository = join(context.runtimeRoot, "closed-local-index-repository");
    const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "NUL" };
    await mkdir(repository);
    try {
      await runGitChecked(["init", "--quiet", repository], context.parent, gitEnv);
      await writeFile(join(repository, "payload.txt"), "closed-local-index-payload\n", "utf8");
      await runGitChecked(["-C", repository, "add", "payload.txt"], context.parent, gitEnv);
      await runGitChecked(["-c", "user.name=Review5", "-c", "user.email=review5@example.invalid", "-C", repository, "commit", "--quiet", "-m", "closed index fixture"], context.parent, gitEnv);
      const revision = (await runGitChecked(["-C", repository, "rev-parse", "HEAD"], context.parent, gitEnv)).stdout.trim();
      expect(revision).toMatch(/^[a-f0-9]{40}$/);

      const command = String.raw`$ErrorActionPreference = 'Stop'
Import-Module $env:JARVIS_REVIEW5_MODULE -Force
$boundary = {
  param([string]$Name)
  if ($Name -cne 'before-git-index-process-start') { return }
  [IO.File]::AppendAllText($env:JARVIS_REVIEW5_EFFECTS, ($Name + [char]10), [Text.UTF8Encoding]::new($false))
  $deadline = [DateTime]::UtcNow.AddSeconds(10)
  while (-not (Test-Path -LiteralPath $env:JARVIS_REVIEW5_ACK -PathType Leaf)) {
    if ([DateTime]::UtcNow -ge $deadline) { throw 'Timed out waiting for closed Git index acknowledgement.' }
    Start-Sleep -Milliseconds 20
  }
  if ([IO.File]::ReadAllText($env:JARVIS_REVIEW5_ACK, [Text.UTF8Encoding]::new($false)) -cne ("continue" + [char]10)) { throw 'Closed Git index acknowledgement has invalid content.' }
}
$git = (Get-Command git.exe -ErrorAction Stop).Source
$workflowLock = Enter-HermesWorkflowLock $env:JARVIS_REVIEW5_RUNTIME_ROOT
$leaseContext = New-HermesWriteContainmentContext $env:JARVIS_REVIEW5_RUNTIME_ROOT $workflowLock
try {
  Assert-HermesGitWorkTreeMatchesCommit -Git $git -GitDirectory $env:JARVIS_REVIEW5_GIT_DIR -WorkTree $env:JARVIS_REVIEW5_WORK_TREE -Commit $env:JARVIS_REVIEW5_COMMIT -LeaseContext $leaseContext -Boundary $boundary
} finally {
  try { Exit-HermesWriteContainment $leaseContext } finally { $workflowLock.Dispose() }
}`;
      context.running = launchPowerShellCommand(command, {
        ...process.env,
        TEMP: context.externalTemp,
        TMP: context.externalTemp,
        JARVIS_REVIEW5_MODULE: runtimeModule,
        JARVIS_REVIEW5_EFFECTS: context.effects,
        JARVIS_REVIEW5_ACK: context.ack,
        JARVIS_REVIEW5_RUNTIME_ROOT: context.runtimeRoot,
        JARVIS_REVIEW5_GIT_DIR: join(repository, ".git"),
        JARVIS_REVIEW5_WORK_TREE: repository,
        JARVIS_REVIEW5_COMMIT: revision,
      });
      await waitForEffect(context.effects, "before-git-index-process-start", context.running);

      const indexRoot = await singleScratchDirectory(context.runtimeRoot, ".verify-index-");
      const outsideBefore = await getTreeManifestNoFollow(context.outside);
      const attack = await attemptDirectoryJunctionSwap(context, indexRoot, context.outside);
      await writeFile(context.ack, "continue\n", "utf8");
      const result = await context.running.result;
      const outsideAfter = await getTreeManifestNoFollow(context.outside);

      expect.soft(outsideAfter, "read-tree created an index or index.lock through a substituted external index root").toEqual(outsideBefore);
      expect.soft(attack.renamed, "Git index root was not protected by a DELETE-denying lease").toBe(false);
      expect.soft(["EACCES", "EBUSY", "EPERM"], "Git index-root rename did not fail with a sharing violation").toContain(attack.renameErrorCode);
      expect.soft(await pathExists(attack.displaced), "Git index cleanup reported success while its original root survived displaced").toBe(false);
      expect(result.code, result.stderr).toBe(0);
    } finally {
      await cleanupFixture(context);
    }
  }, 120_000);

  it("pins source fetches to pack-only object storage without dynamic fanout directories", async () => {
    const source = await readFile(sourceEntrypoint, "utf8");
    const fetchInvocation = source.split(/\r?\n/).find((line) => line.includes("$fetchArguments") && line.includes("'fetch'"));
    expect(fetchInvocation, "real source fetch invocation is missing").toBeTypeOf("string");
    expect(fetchInvocation).toContain("'-c','http.lowSpeedLimit=1','-c','http.lowSpeedTime=30'");
    expect(fetchInvocation).toContain("'-c','fetch.unpackLimit=1','-c','transfer.unpackLimit=1','-c','gc.auto=0'");
    expect(fetchInvocation).toContain("'--no-write-fetch-head','--no-recurse-submodules','--refmap='");
    expect(fetchInvocation).not.toContain("--depth");

    const parent = await mkdtemp(join(tmpdir(), "jarvis-hermes-containment-review5-pack-fetch-"));
    const origin = join(parent, "origin");
    const control = join(parent, "control.git");
    const hardened = join(parent, "hardened.git");
    const gitEnv = {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "NUL",
      GIT_TERMINAL_PROMPT: "0",
      GIT_ALLOW_PROTOCOL: "file",
    };
    const fetchRefspec = "refs/tags/review5-annotated:refs/tags/review5-annotated";
    try {
      await runGitChecked(["init", "--quiet", origin], parent, gitEnv);
      await writeFile(join(origin, "payload.txt"), "closed-local-fetch-payload\n", "utf8");
      await runGitChecked(["-C", origin, "add", "payload.txt"], parent, gitEnv);
      await runGitChecked(["-c", "user.name=Review5", "-c", "user.email=review5@example.invalid", "-C", origin, "commit", "--quiet", "-m", "closed fixture"], parent, gitEnv);
      await runGitChecked(["-c", "user.name=Review5", "-c", "user.email=review5@example.invalid", "-C", origin, "tag", "-a", "review5-annotated", "-m", "closed tag"], parent, gitEnv);
      const tagObject = (await runGitChecked(["-C", origin, "rev-parse", "review5-annotated^{tag}"], parent, gitEnv)).stdout.trim();

      await runGitChecked(["init", "--bare", "--quiet", control], parent, gitEnv);
      await runGitChecked(["--git-dir", control, "fetch", "--no-tags", "--depth=1", origin, fetchRefspec], parent, gitEnv);
      const controlFanout = (await readdir(join(control, "objects"))).filter((name) => /^[0-9a-f]{2}$/.test(name));
      expect(controlFanout.length, "negative-control fetch did not exercise loose-object fanout").toBeGreaterThan(0);

      await runGitChecked(["init", "--bare", "--quiet", hardened], parent, gitEnv);
      await runGitChecked(["--git-dir", hardened, "remote", "add", "origin", origin], parent, gitEnv);
      await runGitChecked(["--git-dir", hardened, "config", "remote.origin.fetch", fetchRefspec], parent, gitEnv);
      await runGitChecked([
        "-c", "fetch.unpackLimit=1",
        "-c", "transfer.unpackLimit=1",
        "--git-dir", hardened,
        "fetch", "--no-tags", "--no-write-fetch-head", "--refmap=", "origin", "refs/tags/review5-annotated",
      ], parent, gitEnv);
      const hardenedFanout = (await readdir(join(hardened, "objects"))).filter((name) => /^[0-9a-f]{2}$/.test(name));
      expect(hardenedFanout, "pack-only fetch created dynamically unleased fanout directories").toEqual([]);
      const packFiles = await readdir(join(hardened, "objects", "pack"));
      expect(packFiles.some((name) => name.endsWith(".pack"))).toBe(true);
      expect(packFiles.some((name) => name.endsWith(".idx"))).toBe(true);
      expect((await runGitChecked(["--git-dir", hardened, "cat-file", "-t", tagObject], parent, gitEnv)).stdout.trim()).toBe("tag");
      const refProbe = await runCommand("git", ["--git-dir", hardened, "show-ref", "--verify", "refs/tags/review5-annotated"], parent, gitEnv);
      expect(refProbe.code, "--refmap= allowed configured remote.origin.fetch to create the managed tag ref").not.toBe(0);
      expect(await pathExists(join(hardened, "refs", "tags", "review5-annotated"))).toBe(false);
    } finally {
      await rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  }, 120_000);

  it("blocks in-place junction conversion of the empty first artifact final parent", async () => {
    const context = await createClosedFixture("runtime-artifacts", "artifact-first-final-parent-direct-reparse");
    try {
      const outcome = await runPausedDirectoryReparseConversion(context, artifactEntrypoint, "before-promotion-1", async ({ runtimeRoot }) => {
        const journal = JSON.parse(await readFile(join(runtimeRoot, ".hermes-runtime-publication.json"), "utf8"));
        return dirname(journal.promotions[0].final);
      });
      expectReparseConversionBlocked(outcome, "empty first artifact final parent");
      await expectSyntheticArtifactsInstalled(context.runtimeRoot);
    } finally {
      await cleanupFixture(context);
    }
  }, 120_000);

  it("retains an undeletable anchor during the first artifact promotion parent move window", async () => {
    const context = await createClosedFixture("runtime-artifacts", "artifact-first-final-parent-move-window");
    try {
      const outcome = await runPausedDirectoryReparseConversion(context, artifactEntrypoint, "during-promotion-1-parent-window", async ({ runtimeRoot }) => {
        const journal = JSON.parse(await readFile(join(runtimeRoot, ".hermes-runtime-publication.json"), "utf8"));
        return dirname(journal.promotions[0].final);
      }, [], ".hermes-containment.anchor");
      expectRetainedAnchor(outcome, "first artifact promotion destination parent");
      expectReparseConversionBlocked(outcome, "first artifact promotion destination parent", [145]);
      await expectSyntheticArtifactsInstalled(context.runtimeRoot);
    } finally {
      await cleanupFixture(context);
    }
  }, 120_000);

  it("holds the exact first artifact stage through its promotion move window", async () => {
    const context = await createClosedFixture("runtime-artifacts", "artifact-first-exact-move-window");
    try {
      const outcome = await runPausedDirectorySwap(context, artifactEntrypoint, "during-promotion-1-parent-window", async ({ runtimeRoot }) => {
        const journal = JSON.parse(await readFile(join(runtimeRoot, ".hermes-runtime-publication.json"), "utf8"));
        return journal.promotions[0].staged;
      });
      expectSwapBlocked(outcome, "exact first artifact stage during promotion");
      await expectSyntheticArtifactsInstalled(context.runtimeRoot);
    } finally {
      await cleanupFixture(context);
    }
  }, 120_000);

  it("holds the exact promoted artifact through its rollback move window", async () => {
    const context = await createClosedFixture("runtime-artifacts", "artifact-exact-rollback-window");
    try {
      const outcome = await runPausedDirectorySwap(
        context,
        artifactEntrypoint,
        "during-promotion-rollback-1-parent-window",
        async ({ runtimeRoot }) => {
          const journal = JSON.parse(await readFile(join(runtimeRoot, ".hermes-runtime-publication.json"), "utf8"));
          return journal.promotions[0].final;
        },
        ["-TestFaultAfterPromotion", "1"],
      );
      expectSwapBlocked(outcome, "exact promoted artifact during rollback");
      expect(outcome.result.code).not.toBe(0);
      expect(outcome.result.stderr).toMatch(/Injected promotion fault/i);

      const retry = await runPowerShellFile(artifactEntrypoint, ["-RuntimeRoot", context.runtimeRoot, "-TestOperationFixture", context.fixture]);
      expect(retry.code, retry.stderr).toBe(0);
      await expectSyntheticArtifactsInstalled(context.runtimeRoot);
    } finally {
      await cleanupFixture(context);
    }
  }, 120_000);

  for (const [number, targetKind, label] of [
    [1, "staged", "first staged promotion root"],
    [2, "final-parent", "toolchain final parent"],
    [3, "final-parent", "service-host final parent"],
    [4, "final-parent", "license final parent"],
  ]) {
    it(`holds ${label} through artifact promotion ${number}`, async () => {
      const context = await createClosedFixture("runtime-artifacts", `artifact-promotion-${number}-${targetKind}`);
      try {
        const outcome = await runPausedDirectorySwap(context, artifactEntrypoint, `before-promotion-${number}`, async ({ runtimeRoot }) => {
          const journal = JSON.parse(await readFile(join(runtimeRoot, ".hermes-runtime-publication.json"), "utf8"));
          const promotion = journal.promotions[number - 1];
          return targetKind === "staged" ? promotion.staged : dirname(promotion.final);
        });
        expectContained(outcome, label);
        await expectSyntheticArtifactsInstalled(context.runtimeRoot);
      } finally {
        await cleanupFixture(context);
      }
    }, 120_000);
  }

  it("holds the first recovery final directory through its reverse move", async () => {
    const context = await createClosedFixture("runtime-artifacts", "artifact-recovery-reverse");
    try {
      const crashed = await runPowerShellFile(artifactEntrypoint, [
        "-RuntimeRoot", context.runtimeRoot,
        "-TestOperationFixture", context.fixture,
        "-TestCrashAfterPromotion", "4",
      ]);
      expect(crashed.code).not.toBe(0);
      const journalPath = join(context.runtimeRoot, ".hermes-runtime-publication.json");
      const journal = JSON.parse(await readFile(journalPath, "utf8"));
      expect(journal.promotions).toHaveLength(4);

      const outcome = await runPausedDirectorySwap(context, artifactEntrypoint, "before-recovery-1", () => journal.promotions[3].final);
      expectContained(outcome, "first recovery reverse-move final directory");
      await expectSyntheticArtifactsInstalled(context.runtimeRoot);
      expect(await pathExists(journalPath)).toBe(false);
    } finally {
      await cleanupFixture(context);
    }
  }, 120_000);

  it("holds the exact first recovery source through its reverse-move window", async () => {
    const context = await createClosedFixture("runtime-artifacts", "artifact-recovery-exact-reverse");
    try {
      const crashed = await runPowerShellFile(artifactEntrypoint, [
        "-RuntimeRoot", context.runtimeRoot,
        "-TestOperationFixture", context.fixture,
        "-TestCrashAfterPromotion", "4",
      ]);
      expect(crashed.code).not.toBe(0);
      const journalPath = join(context.runtimeRoot, ".hermes-runtime-publication.json");
      const journal = JSON.parse(await readFile(journalPath, "utf8"));

      const outcome = await runPausedDirectorySwap(context, artifactEntrypoint, "during-recovery-1-parent-window", () => journal.promotions[3].final);
      expectSwapBlocked(outcome, "exact first recovery source during reverse move");
      await expectSyntheticArtifactsInstalled(context.runtimeRoot);
      expect(await pathExists(journalPath)).toBe(false);
    } finally {
      await cleanupFixture(context);
    }
  }, 120_000);

  it("blocks in-place junction conversion of the empty artifact recovery destination parent", async () => {
    const context = await createClosedFixture("runtime-artifacts", "artifact-recovery-parent-direct-reparse");
    try {
      const crashed = await runPowerShellFile(artifactEntrypoint, [
        "-RuntimeRoot", context.runtimeRoot,
        "-TestOperationFixture", context.fixture,
        "-TestCrashAfterPromotion", "4",
      ]);
      expect(crashed.code).not.toBe(0);
      const journalPath = join(context.runtimeRoot, ".hermes-runtime-publication.json");
      const journal = JSON.parse(await readFile(journalPath, "utf8"));

      const outcome = await runPausedDirectoryReparseConversion(context, artifactEntrypoint, "before-recovery-1", () => dirname(journal.promotions[3].staged));
      expectReparseConversionBlocked(outcome, "empty artifact recovery destination parent");
      await expectSyntheticArtifactsInstalled(context.runtimeRoot);
      expect(await pathExists(journalPath)).toBe(false);
    } finally {
      await cleanupFixture(context);
    }
  }, 120_000);

  it("blocks a source .s rename-and-junction substitution before the GUID staging write", async () => {
    const context = await createClosedFixture("source", "source-staging-parent");
    try {
      const outcome = await runPausedDirectorySwap(context, sourceEntrypoint, "before-stage-create", ({ runtimeRoot }) => join(runtimeRoot, ".s"));
      expectContained(outcome, "source .s staging parent");
      await expectSyntheticSourceInstalled(context.runtimeRoot);
    } finally {
      await cleanupFixture(context);
    }
  }, 120_000);

  it("blocks in-place junction conversion of the empty source staging parent", async () => {
    const context = await createClosedFixture("source", "source-staging-parent-direct-reparse");
    try {
      const outcome = await runPausedDirectoryReparseConversion(context, sourceEntrypoint, "before-stage-create", ({ runtimeRoot }) => join(runtimeRoot, ".s"));
      expectReparseConversionBlocked(outcome, "empty source .s staging parent");
      await expectSyntheticSourceInstalled(context.runtimeRoot);
    } finally {
      await cleanupFixture(context);
    }
  }, 120_000);

  for (const [boundary, locateTarget, label] of [
    ["during-git-fetch-writable-window", async ({ runtimeRoot }) => join(await singleSourceStage(runtimeRoot), "git", "objects", "pack"), "empty Git pack store"],
    ["before-checkout", async ({ runtimeRoot }) => join(await singleSourceStage(runtimeRoot), "source"), "empty source checkout root"],
  ]) {
    it(`blocks in-place junction conversion of the ${label}`, async () => {
      const context = await createClosedFixture("source", `source-direct-reparse-${boundary}`);
      try {
        const outcome = await runPausedDirectoryReparseConversion(context, sourceEntrypoint, boundary, locateTarget, [], ".hermes-containment.anchor");
        expectRetainedAnchor(outcome, label);
        expectReparseConversionBlocked(outcome, label, [145]);
        await expectSyntheticSourceInstalled(context.runtimeRoot);
      } finally {
        await cleanupFixture(context);
      }
    }, 120_000);
  }

  it("deletes retained Git anchors on abrupt process termination and permits a clean same-root rerun", async () => {
    const context = await createClosedFixture("source", "source-anchor-delete-on-close");
    try {
      context.running = launchPowerShellFile(sourceEntrypoint, [
        "-RuntimeRoot", context.runtimeRoot,
        "-TestOperationFixture", context.fixture,
        "-TestEffectLog", context.effects,
        "-TestPauseAfterEffect", "before-checkout",
        "-TestEffectAck", context.ack,
      ]);
      await waitForEffect(context.effects, "before-checkout", context.running);
      const stage = await singleSourceStage(context.runtimeRoot);
      const workTree = join(stage, "source");
      expect((await readdir(workTree)).sort()).toEqual([".hermes-containment.anchor"]);

      expect(context.running.child.kill(), "failed to terminate the paused source child").toBe(true);
      const terminated = await context.running.result;
      expect(terminated.code).not.toBe(0);
      expect(await pathExists(join(workTree, ".hermes-containment.anchor")), "delete-on-close anchor survived process termination").toBe(false);
      const postCrashManifest = await getTreeManifestNoFollow(context.runtimeRoot);
      expect(postCrashManifest.filter((entry) => entry.includes(".hermes-containment.anchor")), "containment anchor residue survived process termination").toEqual([]);
      expect(await getTreeManifestNoFollow(context.outside), "abrupt termination redirected state outside RuntimeRoot").toEqual([]);

      const stagingParent = join(context.runtimeRoot, ".s");
      const stagingResidue = await getTreeManifestNoFollow(stagingParent);
      expect(stagingResidue.filter((entry) => entry.startsWith("reparse:")), "closed crash fixture left unsafe reparse residue").toEqual([]);
      await rm(stagingParent, { recursive: true, force: false, maxRetries: 10, retryDelay: 50 });

      const retry = await runPowerShellFile(sourceEntrypoint, ["-RuntimeRoot", context.runtimeRoot, "-TestOperationFixture", context.fixture]);
      expect(retry.code, retry.stderr).toBe(0);
      await expectSyntheticSourceInstalled(context.runtimeRoot);
      expect((await getTreeManifestNoFollow(context.runtimeRoot)).filter((entry) => entry.includes(".hermes-containment.anchor"))).toEqual([]);
      expect(await getTreeManifestNoFollow(context.outside)).toEqual([]);
    } finally {
      await cleanupFixture(context);
    }
  }, 120_000);

  it("preserves the source failure while deleting read-only Git temporary residue", async () => {
    const context = await createClosedFixture("source", "source-readonly-git-cleanup");
    try {
      context.running = launchPowerShellFile(sourceEntrypoint, [
        "-RuntimeRoot", context.runtimeRoot,
        "-TestOperationFixture", context.fixture,
        "-TestEffectLog", context.effects,
        "-TestPauseAfterEffect", "during-git-fetch-writable-window",
        "-TestEffectAck", context.ack,
        "-FailAfterEffect", "staged-full-tree-verified",
      ]);
      await waitForEffect(context.effects, "during-git-fetch-writable-window", context.running);
      const stage = await singleSourceStage(context.runtimeRoot);
      const temporaryPack = join(stage, "git", "objects", "pack", "tmp_pack_review5");
      await writeFile(temporaryPack, "partial-pack", "utf8");
      await chmod(temporaryPack, 0o444);
      const escapedPack = temporaryPack.replaceAll("'", "''");
      const attributeProbe = await launchPowerShellCommand(`if ((((Get-Item -LiteralPath '${escapedPack}' -Force).Attributes) -band [IO.FileAttributes]::ReadOnly) -eq 0) { throw 'temporary pack is not read-only' }`).result;
      expect(attributeProbe.code, attributeProbe.stderr).toBe(0);
      await writeFile(context.ack, "continue\n", "utf8");

      const result = await context.running.result;
      expect(result.code).not.toBe(0);
      expect(result.stderr).toMatch(/Injected workflow failure: staged-full-tree-verified/i);
      expect(result.stderr).not.toMatch(/No-follow filesystem deletion failed/i);
      expect(await pathExists(join(context.runtimeRoot, ".s")), "read-only Git residue survived cleanup").toBe(false);
      expect(await getTreeManifestNoFollow(context.outside)).toEqual([]);
    } finally {
      await cleanupFixture(context);
    }
  }, 120_000);

  it("reports both the source failure and a separate staging cleanup failure", async () => {
    const context = await createClosedFixture("source", "source-primary-and-cleanup-failure");
    const holderScript = join(context.parent, "hold-exclusive-file.ps1");
    const holderReady = join(context.parent, "holder.ready");
    const holderRelease = join(context.parent, "holder.release");
    let holder;
    await writeFile(holderScript, `param([string]$Path,[string]$Ready,[string]$Release)
$ErrorActionPreference = 'Stop'
$stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None)
try {
  [IO.File]::WriteAllText($Ready, "ready\\n", [Text.UTF8Encoding]::new($false))
  $deadline = [DateTime]::UtcNow.AddSeconds(30)
  while (-not (Test-Path -LiteralPath $Release -PathType Leaf)) {
    if ([DateTime]::UtcNow -ge $deadline) { throw 'Exclusive file holder timed out.' }
    Start-Sleep -Milliseconds 20
  }
} finally { $stream.Dispose() }
`, "utf8");
    try {
      context.running = launchPowerShellFile(sourceEntrypoint, [
        "-RuntimeRoot", context.runtimeRoot,
        "-TestOperationFixture", context.fixture,
        "-TestEffectLog", context.effects,
        "-TestPauseAfterEffect", "before-git-init",
        "-TestEffectAck", context.ack,
        "-FailAfterEffect", "git-init",
      ]);
      await waitForEffect(context.effects, "before-git-init", context.running);
      const stage = await singleSourceStage(context.runtimeRoot);
      const lockedPack = join(stage, "git", "objects", "pack", "tmp_pack_locked_review5");
      await writeFile(lockedPack, "partial-pack", "utf8");
      holder = launchPowerShellFile(holderScript, [lockedPack, holderReady, holderRelease], 60_000);
      await waitForPath(holderReady, holder.child);
      await writeFile(context.ack, "continue\n", "utf8");

      const result = await context.running.result;
      await writeFile(holderRelease, "release\n", "utf8");
      const holderResult = await holder.result;
      expect(holderResult.code, holderResult.stderr).toBe(0);
      expect(result.code).not.toBe(0);
      expect(result.stderr).toMatch(/Source acquisition failed:.*Injected workflow failure: git-init/i);
      expect(result.stderr).toMatch(/Source staging cleanup also failed closed\./i);
      expect(result.stderr).not.toContain(context.runtimeRoot);
      expect(result.stderr).not.toContain(lockedPack);
      expect(await pathExists(join(context.runtimeRoot, ".s")), "failed cleanup silently discarded retained staging evidence").toBe(true);
      expect(await getTreeManifestNoFollow(context.outside)).toEqual([]);
    } finally {
      if (holder?.child.exitCode === null) {
        await writeFile(holderRelease, "release\n", "utf8").catch(() => {});
        await holder.result.catch(() => {});
      }
      await cleanupFixture(context);
    }
  }, 120_000);

  it("refuses a hardlinked checkout leaf without overwriting its outside bytes", async () => {
    const context = await createClosedFixture("source", "source-checkout-hardlink-leaf");
    const outsideVictim = join(context.outside, "checkout-victim.txt");
    await writeFile(outsideVictim, "outside-original", "utf8");
    try {
      context.running = launchPowerShellFile(sourceEntrypoint, [
        "-RuntimeRoot", context.runtimeRoot,
        "-TestOperationFixture", context.fixture,
        "-TestEffectLog", context.effects,
        "-TestPauseAfterEffect", "before-checkout",
        "-TestEffectAck", context.ack,
      ]);
      await waitForEffect(context.effects, "before-checkout", context.running);
      const stage = await singleSourceStage(context.runtimeRoot);
      const checkoutLeaf = join(stage, "source", "hermes.txt");
      try {
        await link(outsideVictim, checkoutLeaf);
      } finally {
        await writeFile(context.ack, "continue\n", "utf8");
      }

      const result = await context.running.result;
      expect(await readFile(outsideVictim, "utf8"), "checkout followed a hardlinked leaf and overwrote outside bytes").toBe("outside-original");
      expect(result.code).not.toBe(0);
      expect(result.stderr).toMatch(/already exists|CreateNew|hardlink|safe regular|link count/i);
      expect(await pathExists(join(context.runtimeRoot, "releases", sourceCommit))).toBe(false);
    } finally {
      await cleanupFixture(context);
    }
  }, 120_000);

  for (const [boundary, relativeTarget, label] of [
    ["before-git-init", "git", "source Git object-store root"],
    ["before-checkout", "source", "source checkout root"],
    ["before-internal-source-move", "source", "source checkout before its internal move"],
    ["before-internal-git-move", "git", "Git object store before its internal move"],
    ["before-final-promotion", "release", "staged source release root"],
  ]) {
    it(`holds ${label} at ${boundary}`, async () => {
      const context = await createClosedFixture("source", `source-${boundary}-${relativeTarget}`);
      try {
        const outcome = await runPausedDirectorySwap(context, sourceEntrypoint, boundary, async ({ runtimeRoot }) => join(await singleSourceStage(runtimeRoot), relativeTarget));
        expectContained(outcome, label);
        await expectSyntheticSourceInstalled(context.runtimeRoot);
      } finally {
        await cleanupFixture(context);
      }
    }, 120_000);
  }

  it("holds the releases parent through final source promotion", async () => {
    const context = await createClosedFixture("source", "source-final-parent");
    try {
      const outcome = await runPausedDirectorySwap(context, sourceEntrypoint, "before-final-promotion", ({ runtimeRoot }) => join(runtimeRoot, "releases"));
      expectContained(outcome, "source releases final parent");
      await expectSyntheticSourceInstalled(context.runtimeRoot);
    } finally {
      await cleanupFixture(context);
    }
  }, 120_000);

  it("blocks in-place junction conversion of the empty source releases parent", async () => {
    const context = await createClosedFixture("source", "source-final-parent-direct-reparse");
    try {
      const outcome = await runPausedDirectoryReparseConversion(context, sourceEntrypoint, "before-final-promotion", ({ runtimeRoot }) => join(runtimeRoot, "releases"));
      expectReparseConversionBlocked(outcome, "empty source releases parent");
      await expectSyntheticSourceInstalled(context.runtimeRoot);
    } finally {
      await cleanupFixture(context);
    }
  }, 120_000);

  it("retains an undeletable anchor during the final source promotion parent move window", async () => {
    const context = await createClosedFixture("source", "source-final-parent-move-window");
    try {
      const outcome = await runPausedDirectoryReparseConversion(
        context,
        sourceEntrypoint,
        "during-final-promotion-parent-window",
        ({ runtimeRoot }) => join(runtimeRoot, "releases"),
        [],
        ".hermes-containment.anchor",
      );
      expectRetainedAnchor(outcome, "final source promotion destination parent");
      expectReparseConversionBlocked(outcome, "final source promotion destination parent", [145]);
      await expectSyntheticSourceInstalled(context.runtimeRoot);
    } finally {
      await cleanupFixture(context);
    }
  }, 120_000);

  it("holds the exact staged release through the final source promotion move window", async () => {
    const context = await createClosedFixture("source", "source-final-exact-move-window");
    try {
      const outcome = await runPausedDirectorySwap(
        context,
        sourceEntrypoint,
        "during-final-promotion-parent-window",
        async ({ runtimeRoot }) => join(await singleSourceStage(runtimeRoot), "release"),
      );
      expectSwapBlocked(outcome, "exact staged source release during final promotion");
      await expectSyntheticSourceInstalled(context.runtimeRoot);
    } finally {
      await cleanupFixture(context);
    }
  }, 120_000);

  it("holds the exact promoted source through its rollback move window", async () => {
    const context = await createClosedFixture("source", "source-exact-rollback-window");
    try {
      const release = join(context.runtimeRoot, "releases", sourceCommit);
      const outcome = await runPausedDirectorySwap(
        context,
        sourceEntrypoint,
        "during-source-rollback-parent-window",
        () => release,
        ["-FailAfterEffect", "move-complete"],
      );
      expectSwapBlocked(outcome, "exact promoted source during rollback");
      expect(outcome.result.code).not.toBe(0);
      expect(outcome.result.stderr).toMatch(/Injected workflow failure: move-complete/i);

      const retry = await runPowerShellFile(sourceEntrypoint, ["-RuntimeRoot", context.runtimeRoot, "-TestOperationFixture", context.fixture]);
      expect(retry.code, retry.stderr).toBe(0);
      await expectSyntheticSourceInstalled(context.runtimeRoot);
    } finally {
      await cleanupFixture(context);
    }
  }, 120_000);

  it("holds a promoted source release through rollback and permits a clean retry", async () => {
    const context = await createClosedFixture("source", "source-rollback");
    try {
      const release = join(context.runtimeRoot, "releases", sourceCommit);
      const outcome = await runPausedDirectorySwap(
        context,
        sourceEntrypoint,
        "before-source-rollback",
        () => release,
        ["-FailAfterEffect", "move-complete"],
      );
      expectSwapBlocked(outcome, "promoted source rollback directory");
      expect(outcome.result.code).not.toBe(0);
      expect(outcome.result.stderr).toMatch(/Injected workflow failure: move-complete/i);
      expect(await pathExists(release)).toBe(false);
      expect(await pathExists(join(context.runtimeRoot, ".s"))).toBe(false);

      const retry = await runPowerShellFile(sourceEntrypoint, ["-RuntimeRoot", context.runtimeRoot, "-TestOperationFixture", context.fixture]);
      expect(retry.code, retry.stderr).toBe(0);
      await expectSyntheticSourceInstalled(context.runtimeRoot);
    } finally {
      await cleanupFixture(context);
    }
  }, 120_000);

  it("reports both the source failure and an exact outer rollback failure", async () => {
    const context = await createClosedFixture("source", "source-primary-and-rollback-failure");
    try {
      context.running = launchPowerShellFile(sourceEntrypoint, [
        "-RuntimeRoot", context.runtimeRoot,
        "-TestOperationFixture", context.fixture,
        "-TestEffectLog", context.effects,
        "-TestPauseAfterEffect", "before-source-rollback",
        "-TestEffectAck", context.ack,
        "-FailAfterEffect", "move-complete",
      ]);
      await waitForEffect(context.effects, "before-source-rollback", context.running);
      const stage = await singleSourceStage(context.runtimeRoot);
      await mkdir(join(stage, "release"));
      await writeFile(context.ack, "continue\n", "utf8");

      const result = await context.running.result;
      expect(result.code).not.toBe(0);
      expect(result.stderr).toMatch(/Source acquisition failed:.*Injected workflow failure: move-complete/i);
      expect(result.stderr).toMatch(/Exact source rollback also failed closed\./i);
      expect(result.stderr).not.toContain(context.runtimeRoot);
      expect(await pathExists(join(context.runtimeRoot, "releases", sourceCommit)), "uncertain promoted release was discarded").toBe(true);
      expect(await pathExists(join(context.runtimeRoot, ".s")), "uncertain rollback destination was discarded").toBe(true);
      expect(await getTreeManifestNoFollow(context.outside)).toEqual([]);
    } finally {
      await cleanupFixture(context);
    }
  }, 120_000);

  it("blocks in-place junction conversion of the empty source rollback destination parent", async () => {
    const context = await createClosedFixture("source", "source-rollback-parent-direct-reparse");
    try {
      const release = join(context.runtimeRoot, "releases", sourceCommit);
      const outcome = await runPausedDirectoryReparseConversion(
        context,
        sourceEntrypoint,
        "before-source-rollback",
        async ({ runtimeRoot }) => singleSourceStage(runtimeRoot),
        ["-FailAfterEffect", "move-complete"],
      );
      expectReparseConversionDenied(outcome, "empty source rollback destination parent");
      expect(outcome.result.code).not.toBe(0);
      expect(outcome.result.stderr).toMatch(/Injected workflow failure: move-complete/i);
      expect(await pathExists(release)).toBe(false);
      expect(await pathExists(join(context.runtimeRoot, ".s"))).toBe(false);

      const retry = await runPowerShellFile(sourceEntrypoint, ["-RuntimeRoot", context.runtimeRoot, "-TestOperationFixture", context.fixture]);
      expect(retry.code, retry.stderr).toBe(0);
      await expectSyntheticSourceInstalled(context.runtimeRoot);
    } finally {
      await cleanupFixture(context);
    }
  }, 120_000);

  it("keeps the RuntimeRoot name anchored while a workflow is paused", async () => {
    const context = await createClosedFixture("runtime-artifacts", "anchored-runtime-root");
    try {
      const outcome = await runPausedDirectorySwap(context, artifactEntrypoint, "before-first-download", ({ runtimeRoot }) => runtimeRoot);
      expectContained(outcome, "active RuntimeRoot");
      await expectSyntheticArtifactsInstalled(context.runtimeRoot);
    } finally {
      await cleanupFixture(context);
    }
  }, 120_000);

  it("keeps the RuntimeRoot parent anchored while a workflow is paused", async () => {
    const container = await mkdtemp(join(tmpdir(), "jarvis-hermes-containment-review5-ancestor-"));
    const ancestor = join(container, "runtime-parent");
    const displaced = join(container, "runtime-parent.review5-displaced");
    const runtimeRoot = join(ancestor, "jarvis-hermes-workflow-fixture-anchored-runtime-parent");
    const fixture = join(runtimeRoot, "artifact-operations.json");
    const effects = join(runtimeRoot, "effects.log");
    const ack = join(runtimeRoot, "containment.ack");
    const sentinel = join(displaced, "ancestor-redirect-sentinel.txt");
    let running;
    let junctionCreated = false;
    await mkdir(runtimeRoot, { recursive: true });
    await writeFile(fixture, '{"schemaVersion":1,"workflow":"runtime-artifacts","scenario":"success"}\n', "utf8");
    try {
      running = launchPowerShellFile(artifactEntrypoint, [
        "-RuntimeRoot", runtimeRoot,
        "-TestOperationFixture", fixture,
        "-TestEffectLog", effects,
        "-TestPauseAfterEffect", "before-first-download",
        "-TestEffectAck", ack,
      ]);
      await waitForEffect(effects, "before-first-download", running);

      let renamed = false;
      let renameErrorCode;
      try {
        await rename(ancestor, displaced);
        renamed = true;
        await symlink(displaced, ancestor, "junction");
        junctionCreated = true;
        await writeFile(join(ancestor, "ancestor-redirect-sentinel.txt"), "outside-write", "utf8");
      } catch (error) {
        if (!renamed && ["EACCES", "EBUSY", "EPERM"].includes(error?.code)) renameErrorCode = error.code;
        else throw error;
      } finally {
        await writeFile(ack, "continue\n", "utf8");
      }

      const result = await running.result;
      expect(await pathExists(sentinel), "an ancestor substitution redirected a write outside its original name").toBe(false);
      expect(renamed, "the workflow lock did not anchor RuntimeRoot's parent").toBe(false);
      expect(renameErrorCode, "the ancestor rename did not fail with a sharing violation").toMatch(/^(EACCES|EBUSY|EPERM)$/);
      expect(result.code, result.stderr).toBe(0);
      await expectSyntheticArtifactsInstalled(runtimeRoot);
    } finally {
      if (running?.child.exitCode === null) {
        running.child.kill();
        await running.result.catch(() => {});
      }
      if (junctionCreated) await unlink(ancestor).catch(() => {});
      await removeJunctionsNoFollow(container);
      await rm(container, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  }, 120_000);

  it("rejects a file-symlink workflow lock without following it before any staged effect", async () => {
    const context = await createClosedFixture("runtime-artifacts", "reparse-workflow-lock");
    const lockPath = join(context.runtimeRoot, ".hermes-runtime.workflow.lock");
    const outsideLockTarget = join(context.outside, "outside-workflow-lock");
    try {
      await writeFile(outsideLockTarget, "", "utf8");
      await symlink(outsideLockTarget, lockPath, "file");
      context.createdJunctions.push(lockPath);
      const result = await runPowerShellFile(artifactEntrypoint, [
        "-RuntimeRoot", context.runtimeRoot,
        "-TestOperationFixture", context.fixture,
        "-TestEffectLog", context.effects,
      ]);
      expect(result.code).not.toBe(0);
      expect(result.stderr).toMatch(/workflow lock|reparse|identity|symbolic/i);
      expect(await pathExists(context.effects)).toBe(false);
      expect(await readFile(outsideLockTarget, "utf8"), "workflow lock acquisition followed and mutated an outside symlink target").toBe("");
    } finally {
      await cleanupFixture(context);
    }
  }, 120_000);

  it("rejects a hardlinked workflow lock before any staged effect", async () => {
    const context = await createClosedFixture("runtime-artifacts", "hardlinked-workflow-lock");
    const lockPath = join(context.runtimeRoot, ".hermes-runtime.workflow.lock");
    const outsideLockTarget = join(context.outside, "outside-workflow-lock");
    try {
      await writeFile(outsideLockTarget, "", "utf8");
      await link(outsideLockTarget, lockPath);
      const result = await runPowerShellFile(artifactEntrypoint, [
        "-RuntimeRoot", context.runtimeRoot,
        "-TestOperationFixture", context.fixture,
        "-TestEffectLog", context.effects,
      ]);
      expect(result.code).not.toBe(0);
      expect(result.stderr).toMatch(/workflow lock|hardlink|link count|identity/i);
      expect(await pathExists(context.effects)).toBe(false);
      expect(await readFile(outsideLockTarget, "utf8"), "workflow lock acquisition mutated an outside hardlink target").toBe("");
    } finally {
      await cleanupFixture(context);
    }
  }, 120_000);

  it("serializes artifact and source workflows that share one RuntimeRoot", async () => {
    const context = await createClosedFixture("runtime-artifacts", "same-root-cross-workflow");
    const sourceFixture = join(context.runtimeRoot, "source-operations.json");
    const sourceEffects = join(context.runtimeRoot, "source-effects.log");
    await writeFile(sourceFixture, '{"schemaVersion":1,"workflow":"source","scenario":"success"}\n', "utf8");
    try {
      context.running = launchPowerShellFile(artifactEntrypoint, [
        "-RuntimeRoot", context.runtimeRoot,
        "-TestOperationFixture", context.fixture,
        "-TestHoldLockMilliseconds", "5000",
      ]);
      await waitForPath(join(context.runtimeRoot, ".hermes-runtime.workflow.lock"), context.running.child);

      const rejected = await runPowerShellFile(sourceEntrypoint, [
        "-RuntimeRoot", context.runtimeRoot,
        "-TestOperationFixture", sourceFixture,
        "-TestEffectLog", sourceEffects,
      ]);
      expect(rejected.code).not.toBe(0);
      expect(rejected.stderr).toMatch(/exclusive|workflow lock|sharing violation/i);
      expect(await pathExists(sourceEffects)).toBe(false);

      const acquired = await context.running.result;
      expect(acquired.code, acquired.stderr).toBe(0);
      await expectSyntheticArtifactsInstalled(context.runtimeRoot);
    } finally {
      await cleanupFixture(context);
    }
  }, 120_000);

  it("allows sibling RuntimeRoots to progress while one workflow is intentionally paused", async () => {
    const parent = await mkdtemp(join(tmpdir(), "jarvis-hermes-containment-review5-siblings-"));
    const artifactRoot = join(parent, "jarvis-hermes-workflow-fixture-sibling-artifact");
    const sourceRoot = join(parent, "jarvis-hermes-workflow-fixture-sibling-source");
    const artifactFixture = join(artifactRoot, "artifact-operations.json");
    const sourceFixture = join(sourceRoot, "source-operations.json");
    const effects = join(artifactRoot, "effects.log");
    const sourceEffects = join(sourceRoot, "effects.log");
    const ack = join(artifactRoot, "containment.ack");
    let artifactRun;
    let sourceRun;
    await mkdir(artifactRoot);
    await mkdir(sourceRoot);
    await writeFile(artifactFixture, '{"schemaVersion":1,"workflow":"runtime-artifacts","scenario":"success"}\n', "utf8");
    await writeFile(sourceFixture, '{"schemaVersion":1,"workflow":"source","scenario":"success"}\n', "utf8");
    try {
      artifactRun = launchPowerShellFile(artifactEntrypoint, [
        "-RuntimeRoot", artifactRoot,
        "-TestOperationFixture", artifactFixture,
        "-TestEffectLog", effects,
        "-TestPauseAfterEffect", "before-first-download",
        "-TestEffectAck", ack,
      ]);
      await waitForEffect(effects, "before-first-download", artifactRun);

      sourceRun = launchPowerShellFile(sourceEntrypoint, [
        "-RuntimeRoot", sourceRoot,
        "-TestOperationFixture", sourceFixture,
        "-TestEffectLog", sourceEffects,
      ]);
      await waitForEffect(sourceEffects, "validated-before-root-effect", sourceRun);
      expect(artifactRun.child.exitCode).toBeNull();

      await writeFile(ack, "continue\n", "utf8");
      const [artifactResult, sourceResult] = await Promise.all([artifactRun.result, sourceRun.result]);
      expect(artifactResult.code, artifactResult.stderr).toBe(0);
      expect(sourceResult.code, sourceResult.stderr).toBe(0);
      await expectSyntheticArtifactsInstalled(artifactRoot);
      await expectSyntheticSourceInstalled(sourceRoot);
    } finally {
      if (artifactRun?.child.exitCode === null) {
        artifactRun.child.kill();
        await artifactRun.result.catch(() => {});
      }
      if (sourceRun?.child.exitCode === null) {
        sourceRun.child.kill();
        await sourceRun.result.catch(() => {});
      }
      await rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  }, 120_000);
});
