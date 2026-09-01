import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const modulePath = fileURLToPath(new URL("../scripts/HermesRuntime.psm1", import.meta.url));

function runPowerShell(command, env) {
  return new Promise((resolve, reject) => {
    const child = spawn("pwsh", ["-NoProfile", "-NonInteractive", "-Command", command], { windowsHide: true, env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (value) => { stdout += value; });
    child.stderr.on("data", (value) => { stderr += value; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("Task 2 publication security review 4", () => {
  it("produces the same publication digest under English and Czech cultures", async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), "jarvis-hermes-publication-locale-"));
    const payload = join(runtimeRoot, "payload");
    await mkdir(payload);
    try {
      for (const name of ["ch", "ci", "ha", "ia"]) await writeFile(join(payload, name), name, "utf8");
      const command = [
        "Import-Module $env:JARVIS_TEST_HERMES_MODULE -Force -DisableNameChecking -WarningAction SilentlyContinue",
        "$priorCulture = [Threading.Thread]::CurrentThread.CurrentCulture",
        "$priorUiCulture = [Threading.Thread]::CurrentThread.CurrentUICulture",
        "function Get-CultureDigest([string]$Name) {",
        "  $culture = [Globalization.CultureInfo]::GetCultureInfo($Name)",
        "  [Threading.Thread]::CurrentThread.CurrentCulture = $culture",
        "  [Threading.Thread]::CurrentThread.CurrentUICulture = $culture",
        "  return Get-HermesDirectoryDigest $env:JARVIS_TEST_RUNTIME_ROOT (Join-Path $env:JARVIS_TEST_RUNTIME_ROOT 'payload')",
        "}",
        "try {",
        "  $english = Get-CultureDigest 'en-US'",
        "  $czech = Get-CultureDigest 'cs-CZ'",
        "  ConvertTo-Json -Compress -InputObject @($english, $czech)",
        "} finally {",
        "  [Threading.Thread]::CurrentThread.CurrentCulture = $priorCulture",
        "  [Threading.Thread]::CurrentThread.CurrentUICulture = $priorUiCulture",
        "}",
      ].join("\n");
      const result = await runPowerShell(command, {
        ...process.env,
        JARVIS_TEST_HERMES_MODULE: modulePath,
        JARVIS_TEST_RUNTIME_ROOT: runtimeRoot,
      });

      expect(result.code, result.stderr || result.stdout).toBe(0);
      const [english, czech] = JSON.parse(result.stdout.trim());
      expect(czech, "publication digest changed with process culture").toBe(english);
    } finally {
      await rm(runtimeRoot, { recursive: true, force: true });
    }
  }, 30_000);

  it("rejects coercive or case-folded publication record scalars", async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), "jarvis-hermes-publication-schema-"));
    try {
      const command = [
        "$module = Import-Module $env:JARVIS_TEST_HERMES_MODULE -Force -PassThru -DisableNameChecking -WarningAction SilentlyContinue",
        "$results = & $module {",
        "  param([string]$Root)",
        "  function Test-Record([string]$Mutation) {",
        "    $transactionId = if ($Mutation -ceq 'transaction-case') { 'A' * 32 } else { 'a' * 32 }",
        "    $commonStage = Join-Path $Root ('.artifact-stage-' + $transactionId)",
        "    $expected = Get-HermesExpectedPromotions $Root $commonStage",
        "    $record = [ordered]@{",
        "      schemaVersion = 2",
        "      state = 'committed'",
        "      transactionId = $transactionId",
        "      commonStage = $commonStage",
        "      promotions = @($expected | ForEach-Object { [ordered]@{ staged = $_.staged; final = $_.final; digest = ('b' * 64) } })",
        "    }",
        "    switch ($Mutation) {",
        "      'schema-string' { $record.schemaVersion = '2' }",
        "      'state-case' { $record.state = 'COMMITTED' }",
        "      'transaction-case' { }",
        "      'digest-case' { $record.promotions[0].digest = 'B' * 64 }",
        "    }",
        "    try { [void](Assert-HermesPublicationRecord $Root $record 'committed'); return $true } catch { return $false }",
        "  }",
        "  [ordered]@{",
        "    valid = (Test-Record 'valid')",
        "    schemaString = (Test-Record 'schema-string')",
        "    stateCase = (Test-Record 'state-case')",
        "    transactionCase = (Test-Record 'transaction-case')",
        "    digestCase = (Test-Record 'digest-case')",
        "  }",
        "} $env:JARVIS_TEST_RUNTIME_ROOT",
        "ConvertTo-Json -Compress -InputObject $results",
      ].join("\n");
      const result = await runPowerShell(command, {
        ...process.env,
        JARVIS_TEST_HERMES_MODULE: modulePath,
        JARVIS_TEST_RUNTIME_ROOT: runtimeRoot,
      });

      expect(result.code, result.stderr || result.stdout).toBe(0);
      expect(JSON.parse(result.stdout.trim())).toEqual({
        valid: true,
        schemaString: false,
        stateCase: false,
        transactionCase: false,
        digestCase: false,
      });
    } finally {
      await rm(runtimeRoot, { recursive: true, force: true });
    }
  }, 30_000);

  it("never leaves a same-size pathname replacement as reusable publication state", async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), "jarvis-hermes-publication-state-race-"));
    try {
      const command = [
        "$module = Import-Module $env:JARVIS_TEST_HERMES_MODULE -Force -PassThru -DisableNameChecking -WarningAction SilentlyContinue",
        "$result = & $module {",
        "  param([string]$Root)",
        "  $workflowLock = Enter-HermesWorkflowLock $Root",
        "  $context = New-HermesWriteContainmentContext $Root $workflowLock",
        "  try {",
        "    $destination = Join-Path $Root '.state-race.json'",
        "    $quarantine = Join-Path $Root '.state-race.original.json'",
        "    $record = [ordered]@{ mode = 'safe'; padding = ('x' * 128) }",
        "    $forgedRecord = [ordered]@{ mode = 'evil'; padding = ('x' * 128) }",
        "    $legitimateBytes = [Text.UTF8Encoding]::new($false).GetBytes((ConvertTo-HermesStateJson $record))",
        "    $forgedBytes = [Text.UTF8Encoding]::new($false).GetBytes((ConvertTo-HermesStateJson $forgedRecord))",
        "    if ($legitimateBytes.Length -ne $forgedBytes.Length) { throw 'Race fixture records must have the same byte count.' }",
        "    $attack = [pscustomobject]@{ Called = $false; Applied = $false }",
        "    $moveBoundary = {",
        "      param([string]$Temporary, [string]$StateDestination)",
        "      $attack.Called = $true",
        "      try {",
        "        [IO.File]::Move($Temporary, $quarantine)",
        "        [IO.File]::WriteAllBytes($Temporary, $forgedBytes)",
        "        $attack.Applied = $true",
        "      } catch { }",
        "    }.GetNewClosure()",
        "    $helperSucceeded = $false",
        "    try {",
        "      Write-HermesAtomicStateRecord $Root $destination $record '.state-race-' $context -MoveBoundary $moveBoundary",
        "      $helperSucceeded = $true",
        "    } catch { }",
        "    $destinationExists = Test-Path -LiteralPath $destination -PathType Leaf",
        "    $destinationBytes = if ($destinationExists) { [IO.File]::ReadAllBytes($destination) } else { [byte[]]::new(0) }",
        "    [ordered]@{",
        "      boundaryCalled = [bool]$attack.Called",
        "      attackApplied = [bool]$attack.Applied",
        "      helperSucceeded = $helperSucceeded",
        "      destinationExists = $destinationExists",
        "      destinationIsLegitimate = $destinationExists -and [Convert]::ToBase64String($destinationBytes) -ceq [Convert]::ToBase64String($legitimateBytes)",
        "      destinationIsForged = $destinationExists -and [Convert]::ToBase64String($destinationBytes) -ceq [Convert]::ToBase64String($forgedBytes)",
        "    }",
        "  } finally {",
        "    try { Exit-HermesWriteContainment $context } finally { $workflowLock.Dispose() }",
        "  }",
        "} $env:JARVIS_TEST_RUNTIME_ROOT",
        "ConvertTo-Json -Compress -InputObject $result",
      ].join("\n");
      const result = await runPowerShell(command, {
        ...process.env,
        JARVIS_TEST_HERMES_MODULE: modulePath,
        JARVIS_TEST_RUNTIME_ROOT: runtimeRoot,
      });

      expect(result.code, result.stderr || result.stdout).toBe(0);
      const outcome = JSON.parse(result.stdout.trim());
      expect(outcome.boundaryCalled, "the deterministic replacement boundary did not execute").toBe(true);
      expect(outcome.attackApplied, "the retained state handle did not block replacement").toBe(false);
      expect(outcome.helperSucceeded, "the legitimate state write failed while the attack was blocked").toBe(true);
      expect(outcome.destinationIsForged, "the forged state record remained reusable").toBe(false);
      expect(outcome.destinationIsLegitimate, "the state destination did not preserve the caller's exact bytes").toBe(true);
    } finally {
      await rm(runtimeRoot, { recursive: true, force: true });
    }
  }, 30_000);

  it("never accepts a same-size replacement before establishing its move baseline", async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), "jarvis-hermes-publication-state-baseline-race-"));
    try {
      const command = [
        "$module = Import-Module $env:JARVIS_TEST_HERMES_MODULE -Force -PassThru -DisableNameChecking -WarningAction SilentlyContinue",
        "$result = & $module {",
        "  param([string]$Root)",
        "  $workflowLock = Enter-HermesWorkflowLock $Root",
        "  $context = New-HermesWriteContainmentContext $Root $workflowLock",
        "  try {",
        "    $destination = Join-Path $Root '.state-baseline-race.json'",
        "    $quarantine = Join-Path $Root '.state-baseline-race.original.json'",
        "    $record = [ordered]@{ mode = 'safe'; padding = ('x' * 128) }",
        "    $forgedRecord = [ordered]@{ mode = 'evil'; padding = ('x' * 128) }",
        "    $legitimateBytes = [Text.UTF8Encoding]::new($false).GetBytes((ConvertTo-HermesStateJson $record))",
        "    $forgedBytes = [Text.UTF8Encoding]::new($false).GetBytes((ConvertTo-HermesStateJson $forgedRecord))",
        "    if ($legitimateBytes.Length -ne $forgedBytes.Length) { throw 'Race fixture records must have the same byte count.' }",
        "    $attack = [pscustomobject]@{ Called = $false; Applied = $false }",
        "    $temporaryWrittenBoundary = {",
        "      param([string]$Temporary, [string]$StateDestination)",
        "      $attack.Called = $true",
        "      try {",
        "        [IO.File]::Move($Temporary, $quarantine)",
        "        [IO.File]::WriteAllBytes($Temporary, $forgedBytes)",
        "        $attack.Applied = $true",
        "      } catch { }",
        "    }.GetNewClosure()",
        "    $helperSucceeded = $false",
        "    try {",
        "      Write-HermesAtomicStateRecord $Root $destination $record '.state-baseline-race-' $context -TemporaryWrittenBoundary $temporaryWrittenBoundary",
        "      $helperSucceeded = $true",
        "    } catch { }",
        "    $destinationExists = Test-Path -LiteralPath $destination -PathType Leaf",
        "    $destinationBytes = if ($destinationExists) { [IO.File]::ReadAllBytes($destination) } else { [byte[]]::new(0) }",
        "    [ordered]@{",
        "      boundaryCalled = [bool]$attack.Called",
        "      attackApplied = [bool]$attack.Applied",
        "      helperSucceeded = $helperSucceeded",
        "      destinationExists = $destinationExists",
        "      destinationIsLegitimate = $destinationExists -and [Convert]::ToBase64String($destinationBytes) -ceq [Convert]::ToBase64String($legitimateBytes)",
        "      destinationIsForged = $destinationExists -and [Convert]::ToBase64String($destinationBytes) -ceq [Convert]::ToBase64String($forgedBytes)",
        "    }",
        "  } finally {",
        "    try { Exit-HermesWriteContainment $context } finally { $workflowLock.Dispose() }",
        "  }",
        "} $env:JARVIS_TEST_RUNTIME_ROOT",
        "ConvertTo-Json -Compress -InputObject $result",
      ].join("\n");
      const result = await runPowerShell(command, {
        ...process.env,
        JARVIS_TEST_HERMES_MODULE: modulePath,
        JARVIS_TEST_RUNTIME_ROOT: runtimeRoot,
      });

      expect(result.code, result.stderr || result.stdout).toBe(0);
      const outcome = JSON.parse(result.stdout.trim());
      expect(outcome.boundaryCalled, "the deterministic pre-baseline replacement boundary did not execute").toBe(true);
      expect(outcome.attackApplied, "the retained state handle did not block the pre-baseline replacement").toBe(false);
      expect(outcome.helperSucceeded, "the legitimate state write failed while the pre-baseline attack was blocked").toBe(true);
      expect(outcome.destinationIsForged, "the pre-baseline forged state record was accepted").toBe(false);
      expect(outcome.destinationIsLegitimate, "the state destination did not preserve the caller's exact bytes").toBe(true);
    } finally {
      await rm(runtimeRoot, { recursive: true, force: true });
    }
  }, 30_000);

  it("never deletes a pathname replacement after releasing the exact state handle", async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), "jarvis-hermes-publication-cleanup-race-"));
    try {
      const command = [
        "$module = Import-Module $env:JARVIS_TEST_HERMES_MODULE -Force -PassThru -DisableNameChecking -WarningAction SilentlyContinue",
        "$result = & $module {",
        "  param([string]$Root)",
        "  $workflowLock = Enter-HermesWorkflowLock $Root",
        "  $context = New-HermesWriteContainmentContext $Root $workflowLock",
        "  try {",
        "    $destination = Join-Path $Root '.state-cleanup-race.json'",
        "    $quarantine = Join-Path $Root '.state-cleanup-race.original.json'",
        "    $replacementBytes = [Text.UTF8Encoding]::new($false).GetBytes('attacker-replacement')",
        "    $attack = [pscustomobject]@{ BoundaryCalled = $false; Applied = $false; Temporary = $null }",
        "    $moveBoundary = {",
        "      param([string]$Temporary, [string]$StateDestination)",
        "      $attack.Temporary = $Temporary",
        "      throw 'injected-pre-move-failure'",
        "    }.GetNewClosure()",
        "    $afterStateHandleDisposedBoundary = {",
        "      param([string]$Temporary, [string]$StateDestination)",
        "      $attack.BoundaryCalled = $true",
        "      if (Test-Path -LiteralPath $Temporary -PathType Leaf) { [IO.File]::Move($Temporary, $quarantine) }",
        "      [IO.File]::WriteAllBytes($Temporary, $replacementBytes)",
        "      $attack.Applied = $true",
        "    }.GetNewClosure()",
        "    $helperSucceeded = $false",
        "    try {",
        "      Write-HermesAtomicStateRecord $Root $destination ([ordered]@{ mode = 'safe' }) '.state-cleanup-race-' $context -MoveBoundary $moveBoundary -AfterStateHandleDisposedBoundary $afterStateHandleDisposedBoundary",
        "      $helperSucceeded = $true",
        "    } catch { }",
        "    $replacementExists = $null -ne $attack.Temporary -and (Test-Path -LiteralPath $attack.Temporary -PathType Leaf)",
        "    $actualBytes = if ($replacementExists) { [IO.File]::ReadAllBytes($attack.Temporary) } else { [byte[]]::new(0) }",
        "    [ordered]@{",
        "      boundaryCalled = [bool]$attack.BoundaryCalled",
        "      attackApplied = [bool]$attack.Applied",
        "      helperSucceeded = $helperSucceeded",
        "      destinationExists = (Test-Path -LiteralPath $destination -PathType Leaf)",
        "      replacementExists = $replacementExists",
        "      replacementIsExact = $replacementExists -and [Convert]::ToBase64String($actualBytes) -ceq [Convert]::ToBase64String($replacementBytes)",
        "      originalQuarantined = (Test-Path -LiteralPath $quarantine -PathType Leaf)",
        "    }",
        "  } finally {",
        "    try { Exit-HermesWriteContainment $context } finally { $workflowLock.Dispose() }",
        "  }",
        "} $env:JARVIS_TEST_RUNTIME_ROOT",
        "ConvertTo-Json -Compress -InputObject $result",
      ].join("\n");
      const result = await runPowerShell(command, {
        ...process.env,
        JARVIS_TEST_HERMES_MODULE: modulePath,
        JARVIS_TEST_RUNTIME_ROOT: runtimeRoot,
      });

      expect(result.code, result.stderr || result.stdout).toBe(0);
      const outcome = JSON.parse(result.stdout.trim());
      expect(outcome.boundaryCalled, "the deterministic post-handle cleanup boundary did not execute").toBe(true);
      expect(outcome.attackApplied, "the cleanup replacement fixture was not installed").toBe(true);
      expect(outcome.helperSucceeded, "the injected pre-move failure was not propagated").toBe(false);
      expect(outcome.destinationExists, "failed state was promoted to the authoritative destination").toBe(false);
      expect(outcome.replacementExists, "cleanup deleted an identity it no longer owned").toBe(true);
      expect(outcome.replacementIsExact, "the foreign pathname replacement was altered").toBe(true);
      expect(outcome.originalQuarantined, "the original state identity escaped handle-bound cleanup").toBe(false);
    } finally {
      await rm(runtimeRoot, { recursive: true, force: true });
    }
  }, 30_000);
});
