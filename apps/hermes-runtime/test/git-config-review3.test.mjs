import { access, mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const modulePath = fileURLToPath(new URL("../scripts/HermesRuntime.psm1", import.meta.url));
const fetchScript = fileURLToPath(new URL("../scripts/fetch-hermes.ps1", import.meta.url));
const sourceCommit = "5fc308a70719a83cccdbba4c0e39c23f5a8239d5";
const canonicalGitConfig = [
  "[core]",
  "\trepositoryformatversion = 0",
  "\tfilemode = false",
  "\tbare = false",
  "\tsymlinks = false",
  "\tignorecase = true",
  "\thooksPath = NUL",
  "\tlongpaths = true",
  "\tautocrlf = false",
  "\tsafecrlf = true",
  "[filter \"lfs\"]",
  "\tsmudge = ",
  "\tprocess = ",
  "\trequired = false",
  "[credential]",
  "\thelper = ",
  "[remote \"origin\"]",
  "\turl = https://github.com/NousResearch/hermes-agent.git",
  "\tfetch = +refs/tags/v2026.8.27:refs/tags/v2026.8.27",
  "",
].join("\n");

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
  const result = await run("git", args);
  if (result.code !== 0) throw new Error(`git failed: ${result.stderr}`);
  return result;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

describe("review 3 local Git configuration hardening", () => {
  it("rejects common-directory redirection before Git can load alternate config or attributes", async () => {
    const testRoot = await mkdtemp(join(tmpdir(), "jarvis-hermes-common-dir-review3-"));
    try {
      const gitStore = join(testRoot, "git");
      const runner = join(testRoot, "validate-git-store.ps1");
      await mkdir(gitStore);
      await writeFile(join(gitStore, "config"), canonicalGitConfig, "utf8");
      await writeFile(join(gitStore, "commondir"), "..\\hostile-common\n", "utf8");
      await writeFile(runner, [
        "param([string]$ModulePath,[string]$Root,[string]$GitStore)",
        "Set-StrictMode -Version Latest",
        "$ErrorActionPreference = 'Stop'",
        "Import-Module $ModulePath -Force",
        "Assert-HermesGitConfig $Root $GitStore 'https://github.com/NousResearch/hermes-agent.git'",
        "",
      ].join("\n"), "utf8");
      const result = await run("pwsh", ["-NoProfile", "-NonInteractive", "-File", runner, "-ModulePath", modulePath, "-Root", testRoot, "-GitStore", gitStore]);
      expect(result.code).not.toBe(0);
      expect(result.stderr).toMatch(/local Git (?:configuration|metadata) drift/i);
    } finally {
      await rm(testRoot, { recursive: true, force: true });
    }
  }, 120_000);

  it.each(["--skip-worktree", "--assume-unchanged"])("validates source with a fresh index instead of trusting stored index flag %s", async (indexFlag) => {
    const testRoot = await mkdtemp(join(tmpdir(), "jarvis-hermes-index-review3-"));
    try {
      const source = join(testRoot, "source");
      const gitStore = join(testRoot, "git");
      const runner = join(testRoot, "verify-source.ps1");
      const reviewed = {
        LICENSE: "fixture license\n",
        "pyproject.toml": "[project]\nname='fixture'\n",
        "uv.lock": "version = 1\n",
        "payload.txt": "reviewed payload\n",
      };
      await git(["init", source]);
      await git(["-C", source, "config", "user.name", "Jarvis Test"]);
      await git(["-C", source, "config", "user.email", "jarvis@example.invalid"]);
      await Promise.all(Object.entries(reviewed).map(([name, contents]) => writeFile(join(source, name), contents, "utf8")));
      await git(["-C", source, "add", "."]);
      await git(["-C", source, "commit", "-m", "reviewed"]);
      const commit = (await git(["-C", source, "rev-parse", "HEAD"])).stdout.trim();
      const tree = (await git(["-C", source, "rev-parse", "HEAD^{tree}"])).stdout.trim();
      await git(["-C", source, "update-index", indexFlag, "payload.txt"]);
      await writeFile(join(source, "payload.txt"), "hostile hidden payload\n", "utf8");
      expect((await git(["-C", source, "status", "--porcelain"])).stdout).toBe("");
      await rename(join(source, ".git"), gitStore);
      await writeFile(join(gitStore, "HEAD"), `${commit}\n`, "utf8");

      await writeFile(runner, [
        "param([string]$ModulePath,[string]$Root,[string]$Source,[string]$GitStore,[string]$Commit,[string]$Tree,[string]$LicenseHash,[string]$PyprojectHash,[string]$UvHash)",
        "Set-StrictMode -Version Latest",
        "$ErrorActionPreference = 'Stop'",
        "Import-Module $ModulePath -Force",
        "$lock = @{ sourceCommit = $Commit; sourceTree = $Tree; rawFileSha256 = @{ LICENSE = $LicenseHash; 'pyproject.toml' = $PyprojectHash; 'uv.lock' = $UvHash } }",
        "$workflowLock = Enter-HermesWorkflowLock $Root",
        "$leaseContext = New-HermesWriteContainmentContext $Root $workflowLock",
        "try { Assert-HermesSourceDirectory $Root $Source $lock $GitStore -LeaseContext $leaseContext } finally { try { Exit-HermesWriteContainment $leaseContext } finally { $workflowLock.Dispose() } }",
        "",
      ].join("\n"), "utf8");
      const result = await run("pwsh", [
        "-NoProfile", "-NonInteractive", "-File", runner,
        "-ModulePath", modulePath,
        "-Root", testRoot,
        "-Source", source,
        "-GitStore", gitStore,
        "-Commit", commit,
        "-Tree", tree,
        "-LicenseHash", sha256(reviewed.LICENSE),
        "-PyprojectHash", sha256(reviewed["pyproject.toml"]),
        "-UvHash", sha256(reviewed["uv.lock"]),
      ]);
      expect(result.code).not.toBe(0);
      expect(result.stderr).toMatch(/source Git blob mismatch/i);
    } finally {
      await rm(testRoot, { recursive: true, force: true });
    }
  }, 120_000);

  it("ignores repository replacement refs when reading the locked tree", async () => {
    const testRoot = await mkdtemp(join(tmpdir(), "jarvis-hermes-replace-review3-"));
    try {
      const repo = join(testRoot, "repo");
      const runner = join(testRoot, "read-locked-tree.ps1");
      await git(["init", repo]);
      await git(["-C", repo, "config", "user.name", "Jarvis Test"]);
      await git(["-C", repo, "config", "user.email", "jarvis@example.invalid"]);
      await writeFile(join(repo, "payload.txt"), "reviewed\n", "utf8");
      await git(["-C", repo, "add", "payload.txt"]);
      await git(["-C", repo, "commit", "-m", "reviewed"]);
      const reviewedCommit = (await git(["-C", repo, "rev-parse", "HEAD"])).stdout.trim();
      const reviewedTree = (await git(["-C", repo, "rev-parse", "HEAD^{tree}"])).stdout.trim();
      const reviewedBlob = (await git(["-C", repo, "rev-parse", "HEAD:payload.txt"])).stdout.trim();

      await writeFile(join(repo, "payload.txt"), "replacement\n", "utf8");
      await git(["-C", repo, "add", "payload.txt"]);
      await git(["-C", repo, "commit", "-m", "replacement"]);
      const replacementTree = (await git(["-C", repo, "rev-parse", "HEAD^{tree}"])).stdout.trim();
      await git(["-C", repo, "replace", reviewedTree, replacementTree]);

      await writeFile(runner, [
        "param([string]$ModulePath,[string]$Root,[string]$GitPath,[string]$RepoPath,[string]$Commit)",
        "Set-StrictMode -Version Latest",
        "$ErrorActionPreference = 'Stop'",
        "Import-Module $ModulePath -Force",
        "$workflowLock = Enter-HermesWorkflowLock $Root",
        "$leaseContext = New-HermesWriteContainmentContext $Root $workflowLock",
        "try {",
        "  [void](Add-HermesDirectoryTreeLeases $leaseContext (Join-Path $RepoPath '.git'))",
        "  $entries = @(Get-HermesGitTreePaths $GitPath (Join-Path $RepoPath '.git') $Commit $leaseContext)",
        "  if ($entries.Count -ne 1 -or $entries[0].Path -cne 'payload.txt') { throw 'Unexpected locked tree.' }",
        "  [Console]::Out.WriteLine($entries[0].Object)",
        "} finally { try { Exit-HermesWriteContainment $leaseContext } finally { $workflowLock.Dispose() } }",
        "",
      ].join("\n"), "utf8");
      const gitPath = (await run("where.exe", ["git.exe"])).stdout.split(/\r?\n/u).find(Boolean);
      expect(gitPath).toBeTruthy();
      const result = await run("pwsh", ["-NoProfile", "-NonInteractive", "-File", runner, "-ModulePath", modulePath, "-Root", testRoot, "-GitPath", gitPath, "-RepoPath", repo, "-Commit", reviewedCommit]);
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout.trim().split(/\r?\n/u).at(-1)).toBe(reviewedBlob);
    } finally {
      await rm(testRoot, { recursive: true, force: true });
    }
  }, 120_000);

  it("neutralizes repository-local fsmonitor execution in every closed Git process", async () => {
    const testRoot = await mkdtemp(join(tmpdir(), "jarvis-hermes-fsmonitor-review3-"));
    try {
      const repo = join(testRoot, "repo");
      const marker = join(testRoot, "fsmonitor-invoked.txt");
      const hook = join(testRoot, "hostile-fsmonitor.cmd");
      const runner = join(testRoot, "invoke-closed-git.ps1");
      await git(["init", repo]);
      await git(["-C", repo, "config", "user.name", "Jarvis Test"]);
      await git(["-C", repo, "config", "user.email", "jarvis@example.invalid"]);
      await writeFile(join(repo, "README.md"), "review fixture\n", "utf8");
      await git(["-C", repo, "add", "README.md"]);
      await git(["-C", repo, "commit", "-m", "fixture"]);
      await writeFile(hook, `@echo off\r\n> "${marker}" echo invoked\r\necho /\r\nexit /b 0\r\n`, "utf8");
      await git(["-C", repo, "config", "core.fsmonitor", hook.replaceAll("\\", "/")]);
      await git(["-C", repo, "config", "core.fsmonitorHookVersion", "2"]);
      await writeFile(runner, [
        "param([string]$ModulePath,[string]$Root,[string]$GitPath,[string]$RepoPath)",
        "Set-StrictMode -Version Latest",
        "$ErrorActionPreference = 'Stop'",
        "Import-Module $ModulePath -Force",
        "$workflowLock = Enter-HermesWorkflowLock $Root",
        "$leaseContext = New-HermesWriteContainmentContext $Root $workflowLock",
        "try { [void](Add-HermesDirectoryTreeLeases $leaseContext $RepoPath); [void](Invoke-GitChecked $GitPath @('-C',$RepoPath,'diff','--no-ext-diff','--exit-code','HEAD','--','.') $leaseContext) } finally { try { Exit-HermesWriteContainment $leaseContext } finally { $workflowLock.Dispose() } }",
        "",
      ].join("\n"), "utf8");
      const gitPath = (await run("where.exe", ["git.exe"])).stdout.split(/\r?\n/u).find(Boolean);
      expect(gitPath).toBeTruthy();
      const result = await run("pwsh", ["-NoProfile", "-NonInteractive", "-File", runner, "-ModulePath", modulePath, "-Root", testRoot, "-GitPath", gitPath, "-RepoPath", repo]);
      expect(result.code, result.stderr).toBe(0);
      expect(await exists(marker)).toBe(false);
    } finally {
      await rm(testRoot, { recursive: true, force: true });
    }
  }, 120_000);

  it("fails VerifyOnly before accepting a tampered acquired git/config", async () => {
    const testRoot = await mkdtemp(join(tmpdir(), "jarvis-hermes-workflow-fixture-review3-"));
    try {
      const fixture = join(testRoot, "source-operations.json");
      const effects = join(testRoot, "verify-effects.log");
      const marker = join(testRoot, "verify-fsmonitor-invoked.txt");
      const hook = join(testRoot, "verify-hostile-fsmonitor.cmd");
      await writeFile(fixture, '{"schemaVersion":1,"workflow":"source","scenario":"success"}\n', "utf8");
      const acquired = await run("pwsh", ["-NoProfile", "-NonInteractive", "-File", fetchScript, "-RuntimeRoot", testRoot, "-TestOperationFixture", fixture]);
      expect(acquired.code, acquired.stderr).toBe(0);

      const gitStore = join(testRoot, "releases", sourceCommit, "git");
      await mkdir(gitStore, { recursive: true });
      await writeFile(hook, `@echo off\r\n> "${marker}" echo invoked\r\necho /\r\nexit /b 0\r\n`, "utf8");
      const config = canonicalGitConfig.replace(
        "\tsafecrlf = true\n",
        `\tsafecrlf = true\n\tfsmonitor = ${hook.replaceAll("\\", "/")}\n\tfsmonitorHookVersion = 2\n`,
      );
      await writeFile(join(gitStore, "config"), config, "utf8");

      const verified = await run("pwsh", ["-NoProfile", "-NonInteractive", "-File", fetchScript, "-RuntimeRoot", testRoot, "-VerifyOnly", "-TestOperationFixture", fixture, "-TestEffectLog", effects]);
      expect(verified.code).not.toBe(0);
      expect(verified.stderr).toMatch(/local Git configuration drift/i);
      expect(await exists(marker)).toBe(false);
      expect(await exists(effects) ? await readFile(effects, "utf8") : "").not.toContain("verify-only-start");
    } finally {
      await rm(testRoot, { recursive: true, force: true });
    }
  }, 120_000);

  it("fails VerifyOnly when the persisted locked-tag ref drifts", async () => {
    const testRoot = await mkdtemp(join(tmpdir(), "jarvis-hermes-workflow-fixture-tag-review3-"));
    try {
      const fixture = join(testRoot, "source-operations.json");
      const effects = join(testRoot, "verify-effects.log");
      await writeFile(fixture, '{"schemaVersion":1,"workflow":"source","scenario":"success"}\n', "utf8");
      const acquired = await run("pwsh", ["-NoProfile", "-NonInteractive", "-File", fetchScript, "-RuntimeRoot", testRoot, "-TestOperationFixture", fixture]);
      expect(acquired.code, acquired.stderr).toBe(0);

      const tagRef = join(testRoot, "releases", sourceCommit, "git", "refs", "tags", "v2026.8.27");
      await writeFile(tagRef, `${"0".repeat(40)}\n`, "utf8");

      const verified = await run("pwsh", ["-NoProfile", "-NonInteractive", "-File", fetchScript, "-RuntimeRoot", testRoot, "-VerifyOnly", "-TestOperationFixture", fixture, "-TestEffectLog", effects]);
      expect(verified.code).not.toBe(0);
      expect(verified.stderr).toMatch(/tag|provenance|object|drift/i);
      expect(await exists(effects) ? await readFile(effects, "utf8") : "").not.toContain("verify-only-start");
    } finally {
      await rm(testRoot, { recursive: true, force: true });
    }
  }, 120_000);
});
