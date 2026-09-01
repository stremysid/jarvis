import { randomUUID } from "node:crypto";
import { access, mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const modulePath = fileURLToPath(new URL("../scripts/HermesRuntime.psm1", import.meta.url));
const fetchScript = fileURLToPath(new URL("../scripts/fetch-hermes.ps1", import.meta.url));

function runPowerShell(args, timeout = 120_000) {
  return new Promise((resolve, reject) => {
    const child = spawn("pwsh", ["-NoProfile", "-NonInteractive", ...args], { windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("PowerShell boundary test timed out"));
    }, timeout);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
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

describe("Hermes review-3 Windows path and residue boundaries", () => {
  it.each(["NativeFileGuard", "NativeProcessRunner"])("rejects a preloaded HermesRuntime.%s before module bootstrap", async (typeName) => {
    const escapedModule = modulePath.replaceAll("'", "''");
    const program = [
      "$ErrorActionPreference = 'Stop'",
      `Add-Type -TypeDefinition 'namespace HermesRuntime { public sealed class ${typeName} {} }'`,
      `Import-Module '${escapedModule}' -Force -ErrorAction Stop`,
      "'HOSTILE_NATIVE_TYPE_ACCEPTED'",
    ].join("; ");

    const result = await runPowerShell(["-Command", program]);

    expect(result.code).not.toBe(0);
    expect(result.stdout).not.toContain("HOSTILE_NATIVE_TYPE_ACCEPTED");
    expect(result.stderr).toMatch(/already loaded|fresh PowerShell/i);
  });

  it("rejects superscript device aliases, console aliases, and every Windows control character", async () => {
    const escapedModule = modulePath.replaceAll("'", "''");
    const program = [
      `Import-Module '${escapedModule}' -Force`,
      "$aliases=@('python/CONIN$','python/CONOUT$');foreach($prefix in @('COM','LPT')){foreach($digit in @(0x00B9,0x00B2,0x00B3)){$aliases+=('python/'+$prefix+[char]$digit+'.txt')}}",
      "foreach($candidate in $aliases){if(-not (Test-UnsafeArchiveMember $candidate)){throw 'reserved_device_alias_accepted'}}",
      "foreach($code in @((0..31)+(127..159))){$candidate='python/safe'+[char]$code+'name';if(-not (Test-UnsafeArchiveMember $candidate)){throw ('control_character_accepted_'+$code)}}",
      "$safe=@('python/COM0.txt','python/LPT0.log','python/COM4x.txt','python/CONINPUT.txt')",
      "foreach($candidate in $safe){if(Test-UnsafeArchiveMember $candidate){throw 'safe_neighbor_rejected'}}",
      "'PATH_BOUNDARIES_OK'",
    ].join("; ");

    const result = await runPowerShell(["-Command", program]);

    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("PATH_BOUNDARIES_OK");
    expect(result.stderr).toBe("");
  });

  it("rejects wrong-case and trailing-separator aliases of an existing RuntimeRoot", async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), "jarvis-hermes-runtime-root-case-"));
    const escapedModule = modulePath.replaceAll("'", "''");
    try {
      for (const candidate of [runtimeRoot.toUpperCase(), `${runtimeRoot}\\`]) {
        const escapedCandidate = candidate.replaceAll("'", "''");
        const program = [
          "$ErrorActionPreference = 'Stop'",
          `Import-Module '${escapedModule}' -Force`,
          `Assert-HermesExactRuntimeRoot '${escapedCandidate}'`,
        ].join("; ");
        const result = await runPowerShell(["-Command", program], 30_000);
        expect(result.code, `${candidate} accepted`).not.toBe(0);
        expect(result.stderr, candidate).toMatch(/RuntimeRoot|case|canonical|separator|local path/i);
      }
    } finally {
      await rm(runtimeRoot, { recursive: true, force: true });
    }
  }, 30_000);

  it("accepts a canonical nonexistent RuntimeRoot directly below the fixed drive root", async () => {
    const driveRoot = tmpdir().match(/^[A-Za-z]:\\/i)?.[0];
    expect(driveRoot).toBeTruthy();
    const candidate = join(driveRoot, `jarvis-hermes-direct-root-${randomUUID()}`);
    const escapedModule = modulePath.replaceAll("'", "''");
    const escapedCandidate = candidate.replaceAll("'", "''");
    expect(await exists(candidate)).toBe(false);
    const result = await runPowerShell(["-Command", [
      "$ErrorActionPreference = 'Stop'",
      `Import-Module '${escapedModule}' -Force`,
      `[void](Assert-HermesExactRuntimeRoot '${escapedCandidate}')`,
      "'DIRECT_ROOT_CANONICAL_OK'",
    ].join("; ")], 30_000);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("DIRECT_ROOT_CANONICAL_OK");
    expect(await exists(candidate)).toBe(false);
  }, 30_000);

  it("rejects an empty unbound .s junction before VerifyOnly can certify the source", async () => {
    const root = await mkdtemp(join(tmpdir(), "jarvis-hermes-workflow-fixture-"));
    const junctionTarget = await mkdtemp(join(tmpdir(), "jarvis-hermes-review3-junction-target-"));
    const fixture = join(root, "source-operations.json");
    const junction = join(root, ".s");
    await writeFile(fixture, '{"schemaVersion":1,"workflow":"source","scenario":"success"}\n', "utf8");

    try {
      const acquired = await runPowerShell(["-File", fetchScript, "-RuntimeRoot", root, "-TestOperationFixture", fixture]);
      expect(acquired.code, acquired.stderr).toBe(0);
      await symlink(junctionTarget, junction, "junction");

      const verified = await runPowerShell(["-File", fetchScript, "-RuntimeRoot", root, "-VerifyOnly", "-TestOperationFixture", fixture]);

      expect(verified.code).not.toBe(0);
      expect(verified.stderr).toMatch(/unbound|residue/i);
      expect(await exists(junction)).toBe(true);
    } finally {
      if (await exists(junction)) await unlink(junction);
      await rm(root, { recursive: true, force: true });
      await rm(junctionTarget, { recursive: true, force: true });
    }
  }, 120_000);
});
