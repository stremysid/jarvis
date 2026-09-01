import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const fetchScript = fileURLToPath(new URL("../scripts/fetch-hermes.ps1", import.meta.url));
const modulePath = fileURLToPath(new URL("../scripts/HermesRuntime.psm1", import.meta.url));
const sourceCommit = "5fc308a70719a83cccdbba4c0e39c23f5a8239d5";
const trustedGit = String.raw`C:\Program Files\Git\cmd\git.exe`;

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, ...options });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function git(args) {
  const result = await run(trustedGit, args);
  if (result.code !== 0) throw new Error(`trusted Git fixture command failed: ${result.stderr}`);
  return result.stdout.trim();
}

async function compileMarkerExecutable(executable, marker) {
  const escapedMarker = marker.replaceAll('"', '""');
  const sourceFile = `${executable}.cs`;
  const source = [
    "using System.IO;",
    "public static class HostileGit {",
    "  public static int Main() {",
    `    File.WriteAllText(@"${escapedMarker}", "ambient Git executed");`,
    "    return 93;",
    "  }",
    "}",
  ].join("\n");
  await writeFile(sourceFile, source, "utf8");
  const result = await run(String.raw`C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe`, ["/nologo", "/target:exe", `/out:${executable}`, sourceFile]);
  if (result.code !== 0) throw new Error(`hostile Git fixture compilation failed: ${result.stderr}`);
}

describe("review 3 trusted Git host", () => {
  it("never executes a PATH-shadowed git.exe during the direct source acquisition entrypoint", async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), "jarvis-hermes-workflow-fixture-"));
    const hostileDirectory = join(runtimeRoot, "hostile-bin");
    const hostileGit = join(hostileDirectory, "git.exe");
    const marker = join(runtimeRoot, "ambient-git-executed.txt");
    const fixture = join(runtimeRoot, "source-operations.json");
    try {
      await mkdir(hostileDirectory);
      await compileMarkerExecutable(hostileGit, marker);
      await writeFile(fixture, '{"schemaVersion":1,"workflow":"source","scenario":"git-hostile-environment"}\n', "utf8");
      const inheritedPath = process.env.Path ?? process.env.PATH ?? "";
      const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toLowerCase() !== "path"));
      environment.Path = `${hostileDirectory};${inheritedPath}`;

      const result = await run("pwsh", [
        "-NoProfile", "-NonInteractive", "-File", fetchScript,
        "-RuntimeRoot", runtimeRoot,
        "-TestOperationFixture", fixture,
      ], { env: environment });

      expect(await exists(marker), await exists(marker) ? await readFile(marker, "utf8") : "").toBe(false);
      expect(result.code, result.stderr).toBe(0);
      expect(await exists(join(runtimeRoot, "releases", sourceCommit, "source"))).toBe(true);
    } finally {
      await rm(runtimeRoot, { recursive: true, force: true });
    }
  }, 120_000);

  it("never resolves PATH git.exe in the default locked-source verifier", async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), "jarvis-hermes-trusted-git-review3-"));
    const source = join(runtimeRoot, "source");
    const gitStore = join(runtimeRoot, "git");
    const hostileDirectory = join(runtimeRoot, "hostile-bin");
    const hostileGit = join(hostileDirectory, "git.exe");
    const marker = join(runtimeRoot, "ambient-git-executed.txt");
    const runner = join(runtimeRoot, "verify-source.ps1");
    try {
      await mkdir(source);
      await mkdir(hostileDirectory);
      await git(["init", source]);
      await git(["-C", source, "config", "user.name", "Jarvis Test"]);
      await git(["-C", source, "config", "user.email", "jarvis@example.invalid"]);
      await git(["-C", source, "config", "core.autocrlf", "false"]);
      await Promise.all([
        writeFile(join(source, "LICENSE"), "fixture license\n", "utf8"),
        writeFile(join(source, "pyproject.toml"), "[project]\nname='fixture'\n", "utf8"),
        writeFile(join(source, "uv.lock"), "version = 1\n", "utf8"),
        writeFile(join(source, "payload.txt"), "reviewed payload\n", "utf8"),
      ]);
      await git(["-C", source, "add", "."]);
      await git(["-C", source, "commit", "-m", "reviewed"]);
      const commit = await git(["-C", source, "rev-parse", "HEAD"]);
      const tree = await git(["-C", source, "rev-parse", "HEAD^{tree}"]);
      await rename(join(source, ".git"), gitStore);
      await writeFile(join(gitStore, "HEAD"), `${commit}\n`, "utf8");
      await compileMarkerExecutable(hostileGit, marker);
      await writeFile(runner, [
        "param([string]$ModulePath,[string]$Root,[string]$Source,[string]$GitStore,[string]$Commit,[string]$Tree)",
        "Set-StrictMode -Version Latest",
        "$ErrorActionPreference = 'Stop'",
        "Import-Module $ModulePath -Force",
        "$hashes = @{}",
        "foreach ($name in @('LICENSE','pyproject.toml','uv.lock')) { $hashes[$name] = (Get-FileHash -LiteralPath (Join-Path $Source $name) -Algorithm SHA256).Hash.ToLowerInvariant() }",
        "$lock = @{ sourceCommit = $Commit; sourceTree = $Tree; rawFileSha256 = $hashes }",
        "$workflowLock = Enter-HermesWorkflowLock $Root",
        "$leaseContext = New-HermesWriteContainmentContext $Root $workflowLock",
        "try { Assert-HermesSourceDirectory $Root $Source $lock $GitStore -LeaseContext $leaseContext } finally { try { Exit-HermesWriteContainment $leaseContext } finally { $workflowLock.Dispose() } }",
        "",
      ].join("\n"), "utf8");
      const inheritedPath = process.env.Path ?? process.env.PATH ?? "";
      const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toLowerCase() !== "path"));
      environment.Path = `${hostileDirectory};${inheritedPath}`;

      const result = await run("pwsh", [
        "-NoProfile", "-NonInteractive", "-File", runner,
        "-ModulePath", modulePath,
        "-Root", runtimeRoot,
        "-Source", source,
        "-GitStore", gitStore,
        "-Commit", commit,
        "-Tree", tree,
      ], { env: environment });

      expect(await exists(marker), await exists(marker) ? await readFile(marker, "utf8") : "").toBe(false);
      expect(result.code, result.stderr).toBe(0);
    } finally {
      await rm(runtimeRoot, { recursive: true, force: true });
    }
  }, 120_000);
});
