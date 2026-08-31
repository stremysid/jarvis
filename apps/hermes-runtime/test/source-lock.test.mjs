import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { canonicalize, sha256Hex, validateHermesManifests } from "../src/validate-manifests.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const file = (path) => new URL(`../${path}`, import.meta.url);

async function loadJson(path) {
  return JSON.parse(await readFile(file(path), "utf8"));
}

describe("Hermes H1 source locks", () => {
  it("accepts the reviewed exact source, artifact, contract, patch, license, and SBOM locks", async () => {
    const source = await loadJson("hermes-source-lock.json");
    const artifacts = await loadJson("runtime-artifacts-lock.json");
    const contract = await loadJson("contracts/hermes-runs-api-v2026.8.27.json");
    const patches = await loadJson("patches/series.json");
    const sbom = await loadJson("sbom/hermes-agent-v2026.8.27-windows-x86_64-cpython-3.11.16.cdx.json");

    await expect(validateHermesManifests({ source, artifacts, contract, patches, sbom })).resolves.toEqual(expect.objectContaining({
      jarvisH0Commit: "814535de21df37e6abac1f63e5953d693b78e003",
      sourceCommit: "5fc308a70719a83cccdbba4c0e39c23f5a8239d5",
      runsEventContractHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    }));
  });

  it("keeps every authoritative notice byte-exact and uses only scoped Git whitespace exceptions", async () => {
    const source = await loadJson("hermes-source-lock.json");
    for (const [path, expected] of Object.entries(source.licenses.files)) {
      const bytes = await readFile(new URL(`../${path}`, import.meta.url));
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(expected);
    }
    const attributes = await readFile(new URL("../../../.gitattributes", import.meta.url), "utf8");
    expect(attributes).toContain("apps/hermes-runtime/licenses/CPython-LICENSE -text whitespace=-trailing-space,-blank-at-eof conflict-marker-size=4096");
    expect(attributes).toContain("apps/hermes-runtime/licenses/python-build-standalone-licenses.rst -text whitespace=-trailing-space,-blank-at-eof conflict-marker-size=4096");
  });

  it("binds the source lock and Task 1 readiness fixture to the canonical Runs event contract", async () => {
    const source = await loadJson("hermes-source-lock.json");
    const contract = await loadJson("contracts/hermes-runs-api-v2026.8.27.json");
    const readiness = JSON.parse(await readFile(new URL("../../../tests/fixtures/hermes-h1/readiness-golden-v1.json", import.meta.url), "utf8"));
    const hash = await sha256Hex(canonicalize(contract));

    expect(source.runsEventContractHash).toBe(hash);
    expect(readiness.runsEventContractHash).toBe(hash);
  });

  it("rejects each reviewed source-lock drift fixture", async () => {
    const valid = await loadJson("hermes-source-lock.json");
    const invalids = await loadJson("test/fixtures/invalid-source-locks.json");
    const artifacts = await loadJson("runtime-artifacts-lock.json");
    const contract = await loadJson("contracts/hermes-runs-api-v2026.8.27.json");
    const patches = await loadJson("patches/series.json");
    const sbom = await loadJson("sbom/hermes-agent-v2026.8.27-windows-x86_64-cpython-3.11.16.cdx.json");

    for (const source of invalids.map((change) => ({ ...valid, ...change }))) {
      await expect(validateHermesManifests({ source, artifacts, contract, patches, sbom })).rejects.toThrow();
    }
  });

  it("rejects artifact URL, declared size, and content hash drift before acquisition", async () => {
    const source = await loadJson("hermes-source-lock.json"); const artifacts = await loadJson("runtime-artifacts-lock.json"); const contract = await loadJson("contracts/hermes-runs-api-v2026.8.27.json"); const patches = await loadJson("patches/series.json"); const sbom = await loadJson("sbom/hermes-agent-v2026.8.27-windows-x86_64-cpython-3.11.16.cdx.json");
    for (const change of [{ url: "https://evil.invalid/a" }, { size: 1 }, { sha256: "0".repeat(64) }]) { const drift = structuredClone(artifacts); Object.assign(drift.cpython, change); await expect(validateHermesManifests({ source, artifacts: drift, contract, patches, sbom })).rejects.toThrow(); }
  });

  it("keeps both strict schemas valid and rejects non-exact artifact license arrays", async () => {
    const sourceSchema = JSON.parse(await readFile(file("schemas/hermes-source-lock-v1.schema.json"), "utf8"));
    const artifactSchema = JSON.parse(await readFile(file("schemas/runtime-artifacts-lock-v1.schema.json"), "utf8"));
    expect(sourceSchema.properties.rawFileSha256.additionalProperties).toBe(false);
    expect(artifactSchema.$defs.artifact.additionalProperties).toBe(false);
    const source = await loadJson("hermes-source-lock.json"); const artifacts = await loadJson("runtime-artifacts-lock.json"); const contract = await loadJson("contracts/hermes-runs-api-v2026.8.27.json"); const patches = await loadJson("patches/series.json"); const sbom = await loadJson("sbom/hermes-agent-v2026.8.27-windows-x86_64-cpython-3.11.16.cdx.json");
    const drift = structuredClone(artifacts); drift.uv.licenses.push("unexpected"); await expect(validateHermesManifests({ source, artifacts: drift, contract, patches, sbom })).rejects.toThrow(/exact array/);
  });

  it("requires an explicit source root for deterministic SBOM generation", async () => {
    const generator = fileURLToPath(new URL("../src/generate-sbom.mjs", import.meta.url));
    const result = await new Promise((resolve, reject) => { const child = spawn(process.execPath, [generator], { windowsHide: true }); let stderr = ""; child.stderr.on("data", (data) => { stderr += data; }); child.on("error", reject); child.on("close", (code) => resolve({ code, stderr })); });
    expect(result.code).not.toBe(0); expect(result.stderr).toContain("--source-root");
  });

  it("rejects noncanonical contract fields, forbidden tool events, and source-lock hash embedding in the SBOM", async () => {
    const source = await loadJson("hermes-source-lock.json");
    const artifacts = await loadJson("runtime-artifacts-lock.json");
    const contract = await loadJson("contracts/hermes-runs-api-v2026.8.27.json");
    const patches = await loadJson("patches/series.json");
    const sbom = await loadJson("sbom/hermes-agent-v2026.8.27-windows-x86_64-cpython-3.11.16.cdx.json");

    await expect(validateHermesManifests({ source, artifacts, patches, sbom, contract: { ...contract, tool_event: "tool.called" } })).rejects.toThrow();
    await expect(validateHermesManifests({ source, artifacts, patches, contract, sbom: { ...sbom, sourceLockHash: source.sbomSha256 } })).rejects.toThrow();
  });

  it("freezes every accepted Runs event and GET status union, rejecting one-field and cross-state drift", async () => {
    const source = await loadJson("hermes-source-lock.json"); const artifacts = await loadJson("runtime-artifacts-lock.json"); const patches = await loadJson("patches/series.json"); const sbom = await loadJson("sbom/hermes-agent-v2026.8.27-windows-x86_64-cpython-3.11.16.cdx.json"); const contract = await loadJson("contracts/hermes-runs-api-v2026.8.27.json");
    expect(Object.keys(contract.events.allowed).sort()).toEqual(["message.delta", "reasoning.available", "run.cancelled", "run.completed", "run.failed"]);
    expect(contract.get.statuses).toEqual({ queued: [], running: [[], ["last_event", "reasoning.available"]], stopping: [["last_event", "run.stopping"]], completed: [["last_event", "run.completed", "output", "usage"]], failed: [["last_event", "run.failed", "error"]], cancelled: [["last_event", "run.cancelled"]] });
    for (const event of Object.keys(contract.events.allowed)) { const drift = structuredClone(contract); drift.events.allowed[event] = drift.events.allowed[event].slice(1); await expect(validateHermesManifests({ source, artifacts, patches, sbom, contract: drift })).rejects.toThrow(); }
    for (const status of Object.keys(contract.get.statuses)) { const drift = structuredClone(contract); drift.get.statuses[status] = [["last_event", "tool.called"]]; await expect(validateHermesManifests({ source, artifacts, patches, sbom, contract: drift })).rejects.toThrow(); }
    for (const forbidden of ["pending_steer", "tool.called", "approval.requested", "subagent.started", "steer.received"]) { const drift = structuredClone(contract); drift.events.allowed[forbidden] = ["event"]; await expect(validateHermesManifests({ source, artifacts, patches, sbom, contract: drift })).rejects.toThrow(); }
  });

  it("refuses an unsafe UNC runtime root before any source acquisition command", async () => {
    const script = new URL("../scripts/fetch-hermes.ps1", import.meta.url);
    const result = await new Promise((resolve, reject) => {
      const child = spawn("pwsh", ["-NoProfile", "-NonInteractive", "-File", fileURLToPath(script), "-RuntimeRoot", "\\\\server\\share\\Hermes", "-VerifyOnly"], { windowsHide: true });
      let stderr = "";
      child.stderr.on("data", (data) => { stderr += data; });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stderr }));
    });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/RuntimeRoot|UNC|unsafe/i);
  });

  it("fails closed for root, escape, and nonempty release paths and isolates every Git config layer", async () => {
    const module = fileURLToPath(new URL("../scripts/HermesRuntime.psm1", import.meta.url)).replace(/'/g, "''");
    const script = await readFile(file("scripts/fetch-hermes.ps1"), "utf8");
    expect(script).toContain("GIT_CONFIG_NOSYSTEM = '1'");
    expect(script).toContain("GIT_CONFIG_GLOBAL = 'NUL'");
    expect(script).toContain("GIT_CONFIG_SYSTEM = 'NUL'");
    expect(script).toContain("GIT_ATTR_NOSYSTEM = '1'");
    const result = await new Promise((resolve, reject) => {
      const program = [
        `Import-Module '${module}' -Force`,
        "if ((@(Get-HermesGitIsolationOptions) -join ';') -ne '-c;core.hooksPath=NUL;-c;core.autocrlf=false;-c;core.safecrlf=true;-c;filter.lfs.smudge=;-c;filter.lfs.process=;-c;filter.lfs.required=false;-c;credential.helper=') { throw 'git_isolation_options_drift' }; foreach ($candidate in @('\\\\server\\share\\x','C:\\','')) { try { Assert-LiteralRuntimeRoot $candidate; throw 'unsafe_root_accepted' } catch { if ($_.Exception.Message -match 'unsafe_root_accepted') { throw } } }",
        "$root = Join-Path ([IO.Path]::GetTempPath()) ('hermes-path-' + [guid]::NewGuid().ToString('N')); New-Item -ItemType Directory -Path $root | Out-Null; try { Assert-ChildPath $root (Join-Path $root '..\\outside'); throw 'escape_accepted' } catch { if ($_.Exception.Message -match 'escape_accepted') { throw } }; $junction=Join-Path $root 'junction'; New-Item -ItemType Junction -Path $junction -Target $root | Out-Null; try { Assert-LiteralRuntimeRoot $junction; throw 'reparse_accepted' } catch { if ($_.Exception.Message -match 'reparse_accepted') { throw } }; 'HOSTILE_PATHS_REJECTED'",
      ].join("; ");
      const child = spawn("pwsh", ["-NoProfile", "-NonInteractive", "-Command", program], { windowsHide: true }); let stdout = ""; let stderr = "";
      child.stdout.on("data", (data) => { stdout += data; }); child.stderr.on("data", (data) => { stderr += data; }); child.on("error", reject); child.on("close", (code) => resolve({ code, stdout, stderr }));
    });
    expect(result.code, result.stderr).toBe(0); expect(result.stdout).toContain("HOSTILE_PATHS_REJECTED"); expect(result.stderr).toBe("");
  });

  it("promotes only complete staging directories and never replaces or creates a partial final target", async () => {
    const temp = await mkdtemp(join(tmpdir(), "jarvis-hermes-promotion-"));
    const module = fileURLToPath(new URL("../scripts/HermesRuntime.psm1", import.meta.url));
    const escapedRoot = temp.replace(/'/g, "''");
    const escapedModule = module.replace(/'/g, "''");
    try {
      const result = await new Promise((resolve, reject) => {
        const program = [
          `$root = '${escapedRoot}'`,
          `Import-Module '${escapedModule}' -Force`,
          "$stage = Join-Path $root '.s\\complete'",
          "New-Item -ItemType Directory -Path $stage -Force | Out-Null",
          "Set-Content -LiteralPath (Join-Path $stage 'payload.txt') -Value 'verified' -NoNewline",
          "$final = Join-Path $root 'releases\\complete'",
          "Promote-StagedDirectory $root $stage $final",
          "if (-not (Test-Path -LiteralPath (Join-Path $final 'payload.txt'))) { throw 'promotion_missing_payload' }",
          "$badStage = Join-Path $root '.s\\bad'",
          "New-Item -ItemType Directory -Path $badStage -Force | Out-Null",
          "Set-Content -LiteralPath (Join-Path $badStage 'payload.txt') -Value 'unverified' -NoNewline",
          "$blocked = Join-Path $root 'releases\\blocked'",
          "try { Assert-ExactHash (Join-Path $badStage 'payload.txt') ('0' * 64) 'fixture'; throw 'unexpected_validation_pass' } catch { }",
          "if (Test-Path -LiteralPath $blocked) { throw 'partial_final_after_validation_failure' }",
          "New-Item -ItemType Directory -Path $blocked -Force | Out-Null",
          "Set-Content -LiteralPath (Join-Path $blocked 'sentinel.txt') -Value 'existing' -NoNewline",
          "try { Promote-StagedDirectory $root $badStage $blocked; throw 'unexpected_replacement' } catch { }",
          "if (-not (Test-Path -LiteralPath $badStage)) { throw 'staging_lost_after_refused_replacement' }",
          "if ((Get-Content -LiteralPath (Join-Path $blocked 'sentinel.txt') -Raw) -ne 'existing') { throw 'existing_final_changed' }",
          "'ATOMIC_PROMOTION_OK'",
        ].join("; ");
        const child = spawn("pwsh", ["-NoProfile", "-NonInteractive", "-Command", program], { windowsHide: true });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (data) => { stdout += data; });
        child.stderr.on("data", (data) => { stderr += data; });
        child.on("error", reject);
        child.on("close", (code) => resolve({ code, stdout, stderr }));
      });
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("ATOMIC_PROMOTION_OK");
      expect(result.stderr).toBe("");
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });

  it("rolls back a faulted multi-directory promotion with no partial runtime targets", async () => {
    const temp = await mkdtemp(join(tmpdir(), "jarvis-hermes-batch-promotion-"));
    const module = fileURLToPath(new URL("../scripts/HermesRuntime.psm1", import.meta.url));
    const escapedRoot = temp.replace(/'/g, "''");
    const escapedModule = module.replace(/'/g, "''");
    try {
      const result = await new Promise((resolve, reject) => {
        const program = [
          `$root = '${escapedRoot}'`, `Import-Module '${escapedModule}' -Force`,
          "foreach ($name in @('one','two','three','four')) { $stage = Join-Path $root ('.s\\' + $name); New-Item -ItemType Directory -Path $stage -Force | Out-Null; Set-Content -LiteralPath (Join-Path $stage 'payload.txt') -Value $name -NoNewline }",
          "$items = @('one','two','three','four' | ForEach-Object { [pscustomobject]@{ StagedDirectory = (Join-Path $root ('.s\\' + $_)); FinalDirectory = (Join-Path $root ('final\\' + $_)) } })",
          "try { Promote-StagedDirectories $root $items 2; throw 'fault_not_injected' } catch { if ($_.Exception.Message -notmatch 'Injected promotion fault') { throw } }",
          "foreach ($name in @('one','two','three','four')) { if (Test-Path -LiteralPath (Join-Path $root ('final\\' + $name))) { throw 'partial_final' }; if (-not (Test-Path -LiteralPath (Join-Path $root ('.s\\' + $name + '\\payload.txt')))) { throw 'staging_not_restored' } }",
          "'BATCH_PROMOTION_ROLLBACK_OK'",
        ].join("; ");
        const child = spawn("pwsh", ["-NoProfile", "-NonInteractive", "-Command", program], { windowsHide: true });
        let stdout = ""; let stderr = "";
        child.stdout.on("data", (data) => { stdout += data; }); child.stderr.on("data", (data) => { stderr += data; });
        child.on("error", reject); child.on("close", (code) => resolve({ code, stdout, stderr }));
      });
      expect(result.code, result.stderr).toBe(0); expect(result.stdout).toContain("BATCH_PROMOTION_ROLLBACK_OK"); expect(result.stderr).toBe("");
    } finally { await rm(temp, { recursive: true, force: true }); }
  });

  it("rejects hostile tar members and zip members before runtime extraction", async () => {
    const temp = await mkdtemp(join(tmpdir(), "jarvis-hermes-archive-"));
    const module = fileURLToPath(new URL("../scripts/HermesRuntime.psm1", import.meta.url));
    const escapedRoot = temp.replace(/'/g, "''"); const escapedModule = module.replace(/'/g, "''");
    try {
      const result = await new Promise((resolve, reject) => {
        const program = [
          `$root = '${escapedRoot}'`, `Import-Module '${escapedModule}' -Force`,
          "New-Item -ItemType Directory -Path (Join-Path $root 'python') | Out-Null", "Set-Content -LiteralPath (Join-Path $root 'python\\safe.txt') -Value safe -NoNewline",
          "& tar.exe -cf (Join-Path $root 'safe.tar') -C $root python; Assert-SafeCpythonArchive (Join-Path $root 'safe.tar')",
          "Set-Content -LiteralPath (Join-Path $root 'outside.txt') -Value unsafe -NoNewline; & tar.exe -cf (Join-Path $root 'unexpected-member.tar') -C $root outside.txt; try { Assert-SafeCpythonArchive (Join-Path $root 'unexpected-member.tar'); throw 'tar_unexpected_member_accepted' } catch { if ($_.Exception.Message -match 'tar_unexpected_member_accepted') { throw } }",
          "Add-Type -AssemblyName System.IO.Compression.FileSystem; $z=[IO.Compression.ZipFile]::Open((Join-Path $root 'extra.zip'),[IO.Compression.ZipArchiveMode]::Create); $e=$z.CreateEntry('uv.exe'); $e.Open().Dispose(); $e=$z.CreateEntry('uvw.exe'); $e.Open().Dispose(); $e=$z.CreateEntry('uvx.exe'); $e.Open().Dispose(); $e=$z.CreateEntry('../escape.exe'); $e.Open().Dispose(); $z.Dispose(); try { Assert-SafeUvArchive (Join-Path $root 'extra.zip'); throw 'zip_extra_accepted' } catch { if ($_.Exception.Message -match 'zip_extra_accepted') { throw } }",
          "'HOSTILE_ARCHIVE_REJECTED'",
        ].join("; ");
        const child = spawn("pwsh", ["-NoProfile", "-NonInteractive", "-Command", program], { windowsHide: true }); let stdout = ""; let stderr = "";
        child.stdout.on("data", (data) => { stdout += data; }); child.stderr.on("data", (data) => { stderr += data; }); child.on("error", reject); child.on("close", (code) => resolve({ code, stdout, stderr }));
      });
      expect(result.code, result.stderr).toBe(0); expect(result.stdout).toContain("HOSTILE_ARCHIVE_REJECTED"); expect(result.stderr).toBe("");
    } finally { await rm(temp, { recursive: true, force: true }); }
  });

  it("rejects every hostile injected Git transcript and source-directory drift before promotion", async () => {
    const temp = await mkdtemp(join(tmpdir(), "jarvis-hermes-git-runner-"));
    const module = fileURLToPath(new URL("../scripts/HermesRuntime.psm1", import.meta.url)).replace(/'/g, "''");
    const escapedRoot = temp.replace(/'/g, "''");
    try {
      const result = await new Promise((resolve, reject) => {
        const program = [
          `$root='${escapedRoot}'`, `Import-Module '${module}' -Force`,
          "$good = @{ tag='v'; tagObject='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'; sourceCommit='bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'; sourceTree='cccccccccccccccccccccccccccccccccccccccc'; rawFileSha256=@{} }",
          "$badCases=@('remote','tag','tagObject','peeled','tree','gitlink','gitmodules','dirty')",
          "foreach($bad in $badCases){ $runner={ param($a); if($a -contains 'cat-file'){if($bad -eq 'tag'){'commit'}else{'tag'};return}; if($a -contains 'rev-parse'){ $x=$a[-1]; if($x -match 'tag}}$'){if($bad -eq 'tagObject'){'0'*40}else{$good.tagObject}}elseif($x -match '}}$'){if($bad -eq 'peeled'){'1'*40}else{$good.sourceCommit}}else{if($bad -eq 'tree'){'2'*40}else{$good.sourceTree}};return}; if($a -contains 'remote'){if($bad -eq 'remote'){@('origin','evil')}else{'origin'};return}; if($a -contains 'ls-tree'){if($bad -eq 'gitlink'){'160000 commit x evil'}elseif($bad -eq 'gitmodules'){'100644 blob x .gitmodules'}else{'100644 blob x safe.txt'};return}; if($a -contains 'status'){if($bad -eq 'dirty'){'?? injected'};return} }; try { Assert-HermesGitTranscript $good 'g' 'w' $runner; throw ('accepted_'+$bad) } catch { if($_.Exception.Message -match ('accepted_'+$bad)){throw} } }",
          "New-Item -ItemType Directory -Path (Join-Path $root 'source')|Out-Null; foreach($n in @('LICENSE','pyproject.toml','uv.lock')){[IO.File]::WriteAllText((Join-Path $root ('source\\'+$n)),$n,[Text.UTF8Encoding]::new($false));$good.rawFileSha256[$n]=(Get-FileHash -LiteralPath (Join-Path $root ('source\\'+$n)) -Algorithm SHA256).Hash.ToLower()}; Assert-HermesSourceDirectory $root (Join-Path $root 'source') $good; [IO.File]::WriteAllText((Join-Path $root 'source\\LICENSE'),'LICENSE`r`n',[Text.UTF8Encoding]::new($false)); try { Assert-HermesSourceDirectory $root (Join-Path $root 'source') $good; throw 'crlf_accepted' } catch {if($_.Exception.Message -match 'crlf_accepted'){throw}}",
          "'GIT_TRANSCRIPT_MATRIX_OK'",
        ].join("; ");
        const child = spawn("pwsh", ["-NoProfile", "-NonInteractive", "-Command", program], { windowsHide: true }); let stdout=""; let stderr="";
        child.stdout.on("data", (data)=>{stdout+=data;}); child.stderr.on("data",(data)=>{stderr+=data;}); child.on("error",reject); child.on("close",(code)=>resolve({code,stdout,stderr}));
      });
      expect(result.code, result.stderr).toBe(0); expect(result.stdout).toContain("GIT_TRANSCRIPT_MATRIX_OK");
    } finally { await rm(temp, { recursive: true, force: true }); }
  });

  it("rejects hostile HTTPS, archive, and each batch-promotion failure without reading or leaving partial payloads", async () => {
    const temp = await mkdtemp(join(tmpdir(), "jarvis-hermes-hostile-runtime-"));
    const module = fileURLToPath(new URL("../scripts/HermesRuntime.psm1", import.meta.url)).replace(/'/g, "''"); const escapedRoot = temp.replace(/'/g, "''");
    try {
      const result = await new Promise((resolve, reject) => {
        const program = [
          `$root='${escapedRoot}'`, `Import-Module '${module}' -Force`, "$a=@{url='https://github.com/example/a';size=7;sha256=('a'*64)}",
          "foreach($case in @('http','offhost','redirect','length')){try{switch($case){'http'{Assert-ArtifactHttpHop $a ([Uri]'http://github.com/a') 200 $null 7};'offhost'{Assert-ArtifactHttpHop $a ([Uri]'https://github.com/a') 302 ([Uri]'https://evil.invalid/a') $null};'redirect'{Assert-ArtifactHttpHop $a ([Uri]'https://github.com/a') 302 $null $null};'length'{Assert-ArtifactHttpHop $a ([Uri]'https://github.com/a') 200 $null 8}};throw ('accepted_'+$case)}catch{if($_.Exception.Message -match ('accepted_'+$case)){throw}}}",
          "foreach($name in @('../x','/x','C:\\x','\\x','python/../x')){try{Assert-SafeCpythonMembers @([pscustomobject]@{Name=$name;Type='-'});throw 'unsafe_member_accepted'}catch{if($_.Exception.Message -match 'unsafe_member_accepted'){throw}}}; foreach($type in @('l','h','r')){try{Assert-SafeCpythonMembers @([pscustomobject]@{Name='python/link';Type=$type});throw 'link_accepted'}catch{if($_.Exception.Message -match 'link_accepted'){throw}}}; foreach($name in @('../x','/x','C:\\x','dir/uv.exe')){try{Assert-SafeUvMembers @([pscustomobject]@{Name='uv.exe';Link=$false},[pscustomobject]@{Name='uvw.exe';Link=$false},[pscustomobject]@{Name='uvx.exe';Link=$false},[pscustomobject]@{Name=$name;Link=$false});throw 'zip_member_accepted'}catch{if($_.Exception.Message -match 'zip_member_accepted'){throw}}}; try{Assert-SafeUvMembers @([pscustomobject]@{Name='uv.exe';Link=$true},[pscustomobject]@{Name='uvw.exe';Link=$false},[pscustomobject]@{Name='uvx.exe';Link=$false});throw 'zip_link_accepted'}catch{if($_.Exception.Message -match 'zip_link_accepted'){throw}}",
          "foreach($fault in 1..4){$items=@();foreach($n in 1..4){$s=Join-Path $root ('.s\\'+$fault+'-'+$n);New-Item -ItemType Directory -Path $s -Force|Out-Null;Set-Content -LiteralPath (Join-Path $s 'x') -Value $n -NoNewline;$items += [pscustomobject]@{StagedDirectory=$s;FinalDirectory=(Join-Path $root ('final\\'+$fault+'-'+$n))}};try{Promote-StagedDirectories $root $items $fault;throw 'fault_accepted'}catch{if($_.Exception.Message -match 'fault_accepted'){throw}};foreach($i in $items){if(Test-Path -LiteralPath $i.FinalDirectory){throw 'partial_final'}};Promote-StagedDirectories $root $items;foreach($i in $items){if(-not(Test-Path -LiteralPath $i.FinalDirectory)){throw 'rerun_failed'}}}",
          "'HTTPS_ARCHIVE_PROMOTION_MATRIX_OK'",
        ].join("; ");
        const child=spawn("pwsh",["-NoProfile","-NonInteractive","-Command",program],{windowsHide:true});let stdout="";let stderr="";child.stdout.on("data",d=>{stdout+=d;});child.stderr.on("data",d=>{stderr+=d;});child.on("error",reject);child.on("close",code=>resolve({code,stdout,stderr}));
      });
      expect(result.code, result.stderr).toBe(0); expect(result.stdout).toContain("HTTPS_ARCHIVE_PROMOTION_MATRIX_OK");
    } finally { await rm(temp, { recursive: true, force: true }); }
  });
});
