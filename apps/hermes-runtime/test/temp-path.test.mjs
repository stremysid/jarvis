import { mkdtemp, rm } from "node:fs/promises";
import { realpath } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it, vi } from "vitest";
import { createClosedFixture } from "./fixtures/closed-workflow.mjs";

const nativeRealpath = promisify(realpath.native);
const runtimeModule = fileURLToPath(new URL("../scripts/HermesRuntime.psm1", import.meta.url));

function runPowerShellCommand(command) {
  const encoded = Buffer.from(command, "utf16le").toString("base64");
  return spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
    encoding: "utf8", windowsHide: true, timeout: 15_000,
  });
}

it("canonicalizes an 8.3 temporary path while the raw RuntimeRoot stays rejected", async () => {
  const base = await nativeRealpath(tmpdir());
  const sandbox = await mkdtemp(join(base, "jarvis-hermes-short-temp-"));
  let context;
  try {
    const shortProbe = runPowerShellCommand(`$fso = New-Object -ComObject Scripting.FileSystemObject; [Console]::Write($fso.GetFolder('${sandbox.replaceAll("'", "''")}').ShortPath)`);
    expect(shortProbe.status, shortProbe.stderr).toBe(0);
    const short = shortProbe.stdout.trim();
    expect(short).not.toBe(sandbox);
    expect(await nativeRealpath(short)).toBe(sandbox);
    vi.stubEnv("TEMP", short);
    vi.stubEnv("TMP", short);
    expect(tmpdir()).toBe(short);

    context = await createClosedFixture("runtime-artifacts", "short-temp");
    const rawRoot = join(short, relative(sandbox, await nativeRealpath(context.runtimeRoot)));
    for (const [candidate, expected] of [[rawRoot, 1], [context.runtimeRoot, 0]]) {
      const result = runPowerShellCommand(`Import-Module '${runtimeModule.replaceAll("'", "''")}' -Force; try { Assert-LiteralRuntimeRoot '${candidate.replaceAll("'", "''")}' | Out-Null; exit 0 } catch { [Console]::Error.Write($_.Exception.Message); exit 1 }`);
      expect(result.status, result.stderr).toBe(expected);
      if (expected === 1) expect(result.stderr).toContain("without relative or alias segments");
    }
  } finally {
    vi.unstubAllEnvs();
    if (context) {
      expect(dirname(await nativeRealpath(context.parent))).toBe(sandbox);
      await rm(context.parent, { recursive: true, force: true });
    }
    expect(dirname(await nativeRealpath(sandbox))).toBe(base);
    await rm(sandbox, { recursive: true, force: true });
  }
}, 30_000);
