import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { canonicalTmpdir } from "./fixtures/temp-root.mjs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const runtimeRoot = fileURLToPath(new URL("..", import.meta.url));
const modulePath = join(runtimeRoot, "scripts", "HermesRuntime.psm1");
const artifactScriptPath = join(runtimeRoot, "scripts", "fetch-runtime-artifacts.ps1");

function psLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function runPowerShell(command, timeout = 120_000) {
  return new Promise((resolve, reject) => {
    const child = spawn("pwsh", ["-NoProfile", "-NonInteractive", "-Command", command], { windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("PowerShell artifact-security probe timed out."));
    }, timeout);
    child.stdout.on("data", (data) => { stdout += data; });
    child.stderr.on("data", (data) => { stderr += data; });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

async function runPowerShellFile(script, args, timeout = 120_000) {
  return new Promise((resolve, reject) => {
    const child = spawn("pwsh", ["-NoProfile", "-NonInteractive", "-File", script, ...args], { windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("PowerShell artifact workflow timed out."));
    }, timeout);
    child.stdout.on("data", (data) => { stdout += data; });
    child.stderr.on("data", (data) => { stderr += data; });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
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

describe("Hermes H1 artifact security review 3", () => {
  it("uses one absolute cancellation deadline for HTTP headers, body reads, output writes, and output flush", async () => {
    const scriptSource = await readFile(artifactScriptPath, "utf8");
    const transferFunction = extractPowerShellFunction(scriptSource, "Invoke-PinnedHttpTransfer");
    for (const requiredCall of [
      /GetAsync\([^\r\n]+ResponseHeadersRead[^\r\n]+\$CancellationToken\)/,
      /ReadAsStreamAsync\(\$CancellationToken\)/,
      /ReadAsync\(\$buffer,\s*0,\s*\$buffer\.Length,\s*\$CancellationToken\)/,
      /WriteAsync\(\$buffer,\s*0,\s*\$read,\s*\$CancellationToken\)/,
      /FlushAsync\(\$CancellationToken\)/,
    ]) expect(transferFunction).toMatch(requiredCall);

    const result = await runPowerShell(`
      $ErrorActionPreference = 'Stop'
      Import-Module ${psLiteral(modulePath)} -Force -DisableNameChecking
      ${transferFunction}
      Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
namespace HermesHttpDeadlineTest {
  public sealed class SlowReadStream : Stream {
    private bool sent;
    public override bool CanRead => true; public override bool CanSeek => false; public override bool CanWrite => false;
    public override long Length => 1; public override long Position { get => 0; set => throw new NotSupportedException(); }
    public override void Flush() { }
    public override int Read(byte[] buffer, int offset, int count) { Thread.Sleep(750); if (sent) return 0; sent = true; buffer[offset] = 1; return 1; }
    public override async Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken token) { await Task.Delay(750, token); if (sent) return 0; sent = true; buffer[offset] = 1; return 1; }
    public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
    public override void SetLength(long value) => throw new NotSupportedException();
    public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
  }
  public sealed class ProbeHandler : HttpMessageHandler {
    private readonly string phase;
    public ProbeHandler(string phase) { this.phase = phase; }
    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token) {
      if (phase == "headers") await Task.Delay(750, token);
      var response = new HttpResponseMessage(HttpStatusCode.OK);
      response.RequestMessage = request;
      response.Content = new StreamContent(phase == "body" ? (Stream)new SlowReadStream() : new MemoryStream(new byte[] { 1 }, false));
      response.Content.Headers.ContentLength = 1;
      return response;
    }
  }
  public sealed class SlowOutputStream : Stream {
    private readonly string phase;
    public SlowOutputStream(string phase) { this.phase = phase; }
    public override bool CanRead => false; public override bool CanSeek => false; public override bool CanWrite => true;
    public override long Length => 0; public override long Position { get => 0; set => throw new NotSupportedException(); }
    public override void Flush() { if (phase == "flush") Thread.Sleep(750); }
    public override async Task FlushAsync(CancellationToken token) { if (phase == "flush") await Task.Delay(750, token); }
    public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
    public override void SetLength(long value) => throw new NotSupportedException();
    public override void Write(byte[] buffer, int offset, int count) { if (phase == "write") Thread.Sleep(750); }
    public override async Task WriteAsync(byte[] buffer, int offset, int count, CancellationToken token) { if (phase == "write") await Task.Delay(750, token); }
  }
}
'@
      $artifact = @{ url = 'https://github.com/openai/deadline-probe'; size = [int64]1; sha256 = ('0' * 64) }
      foreach ($phase in @('headers','body','write','flush')) {
        $handler = [HermesHttpDeadlineTest.ProbeHandler]::new($phase)
        $client = [Net.Http.HttpClient]::new($handler)
        $client.Timeout = [Threading.Timeout]::InfiniteTimeSpan
        $output = [HermesHttpDeadlineTest.SlowOutputStream]::new($phase)
        $outputFactory = { $output }.GetNewClosure()
        $cts = [Threading.CancellationTokenSource]::new()
        $watch = [Diagnostics.Stopwatch]::StartNew()
        try {
          $cts.CancelAfter(100)
          try {
            [void](Invoke-PinnedHttpTransfer $artifact ([Uri]$artifact.url) $client $outputFactory 'Deadline probe' $cts.Token)
            throw "deadline_not_enforced_$phase"
          } catch {
            $exception = $_.Exception
            $cancelled = $false
            while ($null -ne $exception) { if ($exception -is [OperationCanceledException]) { $cancelled = $true; break }; $exception = $exception.InnerException }
            if (-not $cancelled) { throw }
          }
          if ($watch.ElapsedMilliseconds -ge 600) { throw "deadline_exceeded_bound_$phase" }
        } finally { $watch.Stop(); $cts.Dispose(); $output.Dispose(); $client.Dispose(); $handler.Dispose() }
      }
      $successHandler = [HermesHttpDeadlineTest.ProbeHandler]::new('success')
      $successClient = [Net.Http.HttpClient]::new($successHandler)
      $successOutput = [HermesHttpDeadlineTest.SlowOutputStream]::new('success')
      $successOutputFactory = { $successOutput }.GetNewClosure()
      try {
        $transferResult = @(Invoke-PinnedHttpTransfer $artifact ([Uri]$artifact.url) $successClient $successOutputFactory 'Success probe' ([Threading.CancellationToken]::None))
        if ($transferResult.Count -ne 1 -or $transferResult[0] -isnot [int64] -or $transferResult[0] -ne 1) {
          throw 'http_transfer_return_value_is_not_exact_byte_count'
        }
      } finally { $successOutput.Dispose(); $successClient.Dispose(); $successHandler.Dispose() }
      'ABSOLUTE_HTTP_DEADLINE_OK'
    `, 30_000);

    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("ABSOLUTE_HTTP_DEADLINE_OK");
    expect(result.stderr).toBe("");
  }, 30_000);

  it("rejects a manifest pathname replacement between an earlier hash check and the exact bytes it parses", async () => {
    const root = await mkdtemp(join(canonicalTmpdir, "jarvis-hermes-manifest-swap-"));
    const manifest = join(root, "reviewed-lock.json");
    try {
      await writeFile(manifest, '{"schemaVersion":"1"}\n', "utf8");
      const result = await runPowerShell(`
        $ErrorActionPreference = 'Stop'
        Import-Module ${psLiteral(modulePath)} -Force -DisableNameChecking
        $manifest = ${psLiteral(manifest)}
        $expected = Get-Sha256Hex $manifest
        Assert-ExactHash $manifest $expected 'Pinned manifest'
        Move-Item -LiteralPath $manifest -Destination ($manifest + '.validated')
        [IO.File]::WriteAllText($manifest, ('{"schemaVersion":"0"}' + [char]10), [Text.UTF8Encoding]::new($false))
        try {
          [void](Get-Manifest $manifest $expected 'Pinned manifest')
          throw 'swapped_manifest_accepted'
        } catch {
          if ($_.Exception.Message -eq 'swapped_manifest_accepted') { throw }
          if ($_.Exception.Message -cne 'Pinned manifest hash mismatch.') { throw }
        }
        Write-Output 'manifest_swap_rejected'
      `);
      expect({ code: result.code, stdout: result.stdout, stderr: result.stderr }).toEqual({ code: 0, stdout: "manifest_swap_rejected\r\n", stderr: "" });
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

  it("extracts a bounded archive snapshot even when its source pathname is swapped", async () => {
    const root = await mkdtemp(join(canonicalTmpdir, "jarvis-hermes-artifact-identity-"));
    const safeArchive = join(root, "leaf-stage", "downloads", "candidate.tar");
    const maliciousArchive = join(root, "link-traversal.tar");
    const extractionStage = join(root, "tar-extraction-stage");
    const destination = join(extractionStage, "destination");
    const rejectedStage = join(root, "tar-rejection-stage");
    const rejectedDestination = join(rejectedStage, "destination");
    const outside = join(root, "outside");
    const leafEscape = join(root, "leaf-escape");
    const destinationEscape = join(root, "tar-destination-escape");
    const result = await runPowerShell(`
      $ErrorActionPreference = 'Stop'
      Import-Module ${psLiteral(modulePath)} -Force
      $root = ${psLiteral(root)}
      $safeArchive = ${psLiteral(safeArchive)}
      $maliciousArchive = ${psLiteral(maliciousArchive)}
      $extractionStage = ${psLiteral(extractionStage)}
      $destination = ${psLiteral(destination)}
      $rejectedStage = ${psLiteral(rejectedStage)}
      $rejectedDestination = ${psLiteral(rejectedDestination)}
      $outside = ${psLiteral(outside)}
      $leafEscape = ${psLiteral(leafEscape)}
      $destinationEscape = ${psLiteral(destinationEscape)}
      $downloadDirectory = [IO.Directory]::GetParent($safeArchive).FullName
      foreach ($directory in @($downloadDirectory, $extractionStage, $destination, $rejectedStage, $rejectedDestination, $outside, $leafEscape, (Join-Path $destinationEscape 'python'))) { New-Item -ItemType Directory -Path $directory -Force | Out-Null }

      function Add-TarFile([System.Formats.Tar.TarWriter]$Writer, [string]$Name, [string]$Value) {
        $entry = [System.Formats.Tar.PaxTarEntry]::new([System.Formats.Tar.TarEntryType]::RegularFile, $Name)
        $bytes = [Text.UTF8Encoding]::new($false).GetBytes($Value)
        $payload = [IO.MemoryStream]::new($bytes, $false)
        try { $entry.DataStream = $payload; $Writer.WriteEntry($entry) } finally { $payload.Dispose() }
      }

      $safeFile = [IO.File]::Create($safeArchive)
      $safeStream = [IO.Compression.GZipStream]::new($safeFile, [IO.Compression.CompressionLevel]::NoCompression, $false)
      $safeWriter = [System.Formats.Tar.TarWriter]::new($safeStream, [System.Formats.Tar.TarEntryFormat]::Pax, $false)
      try {
        $safeWriter.WriteEntry([System.Formats.Tar.PaxTarEntry]::new([System.Formats.Tar.TarEntryType]::Directory, 'python/'))
        Add-TarFile $safeWriter 'python/safe.txt' 'identity-stable'
      } finally { $safeWriter.Dispose(); $safeStream.Dispose(); $safeFile.Dispose() }
      $safeExpectedSize = [int64](Get-Item -LiteralPath $safeArchive).Length
      $safeExpectedSha256 = Get-Sha256Hex $safeArchive

      $maliciousStream = [IO.File]::Create($maliciousArchive)
      $maliciousWriter = [System.Formats.Tar.TarWriter]::new($maliciousStream, [System.Formats.Tar.TarEntryFormat]::Pax, $false)
      try {
        $maliciousWriter.WriteEntry([System.Formats.Tar.PaxTarEntry]::new([System.Formats.Tar.TarEntryType]::Directory, 'python/'))
        $link = [System.Formats.Tar.PaxTarEntry]::new([System.Formats.Tar.TarEntryType]::SymbolicLink, 'python/escape')
        $link.LinkName = '../../outside'
        $maliciousWriter.WriteEntry($link)
        Add-TarFile $maliciousWriter 'python/escape/pwned.txt' 'outside-write'
      } finally { $maliciousWriter.Dispose(); $maliciousStream.Dispose() }

      $tarExtractionFailure = $null
      try {
      Expand-HermesCpythonArchiveIdentityStable -Archive $safeArchive -StableRoot $extractionStage -Destination $destination -ExpectedSha256 $safeExpectedSha256 -ExpectedSize $safeExpectedSize -BeforeSnapshotCopy {
        try {
          Move-Item -LiteralPath $downloadDirectory -Destination ($downloadDirectory + '.validated')
          New-Item -ItemType Junction -Path $downloadDirectory -Target $leafEscape | Out-Null
        } catch {
          [IO.File]::WriteAllText((Join-Path $root 'leaf-swap-blocked.txt'), 'blocked', [Text.UTF8Encoding]::new($false))
        }
      } -AfterValidation {
        if (@(Get-ChildItem -LiteralPath $leafEscape -Force).Count -ne 0) {
          [IO.File]::WriteAllText((Join-Path $root 'leaf-outside-observed.txt'), 'outside-write', [Text.UTF8Encoding]::new($false))
        }
        Move-Item -LiteralPath $safeArchive -Destination ($safeArchive + '.validated')
        Copy-Item -LiteralPath $maliciousArchive -Destination $safeArchive
      } -BeforeFileCreate {
        param($targetPath)
        $targetParent = [IO.Directory]::GetParent([string]$targetPath).FullName
        try {
          Move-Item -LiteralPath $targetParent -Destination ($targetParent + '.validated')
          New-Item -ItemType Junction -Path $targetParent -Target (Join-Path $destinationEscape 'python') | Out-Null
        } catch {
          [IO.File]::WriteAllText((Join-Path $root 'tar-child-swap-blocked.txt'), 'blocked', [Text.UTF8Encoding]::new($false))
        }
        try {
          Move-Item -LiteralPath $destination -Destination ($destination + '.validated')
          New-Item -ItemType Junction -Path $destination -Target $destinationEscape | Out-Null
        } catch {
          [IO.File]::WriteAllText((Join-Path $root 'tar-destination-swap-blocked.txt'), 'blocked', [Text.UTF8Encoding]::new($false))
        }
      }
      } catch { $tarExtractionFailure = $_ }
      if (Test-Path -LiteralPath (Join-Path $destinationEscape 'python\\safe.txt') -PathType Leaf) { throw 'Tar extraction destination swap wrote outside its stable root.' }
      if ($null -ne $tarExtractionFailure) { throw $tarExtractionFailure }
      if (-not (Test-Path -LiteralPath (Join-Path $root 'leaf-swap-blocked.txt') -PathType Leaf)) { throw 'Artifact source leaf swap was not blocked.' }
      if (Test-Path -LiteralPath (Join-Path $root 'leaf-outside-observed.txt') -PathType Leaf) { throw 'Artifact source leaf swap created an outside file.' }
      if (-not (Test-Path -LiteralPath (Join-Path $root 'tar-child-swap-blocked.txt') -PathType Leaf)) { throw 'Tar extraction child-directory swap was not blocked.' }
      if (-not (Test-Path -LiteralPath (Join-Path $root 'tar-destination-swap-blocked.txt') -PathType Leaf)) { throw 'Tar extraction destination swap was not blocked.' }
      if ([IO.File]::ReadAllText((Join-Path $destination 'python\\safe.txt')) -cne 'identity-stable') { throw 'Bounded archive snapshot was not extracted.' }
      if (Test-Path -LiteralPath (Join-Path $outside 'pwned.txt')) { throw 'Swapped pathname escaped extraction.' }

      try {
        Expand-HermesCpythonArchiveIdentityStable -Archive $maliciousArchive -StableRoot $rejectedStage -Destination $rejectedDestination
        throw 'link_archive_accepted'
      } catch {
        if ($_.Exception.Message -eq 'link_archive_accepted') { throw }
      }
      if (Test-Path -LiteralPath (Join-Path $outside 'pwned.txt')) { throw 'Rejected link archive wrote outside its destination.' }

      function New-UvZip([string]$Path, [switch]$Hostile) {
        $zip = [IO.Compression.ZipFile]::Open($Path, [IO.Compression.ZipArchiveMode]::Create)
        try {
          foreach ($name in @('uv.exe', 'uvw.exe', 'uvx.exe')) {
            $entry = $zip.CreateEntry($name)
            $entryStream = $entry.Open()
            try { $entryStream.WriteByte(0x41) } finally { $entryStream.Dispose() }
          }
          if ($Hostile) {
            $entry = $zip.CreateEntry('../escaped.exe')
            $entryStream = $entry.Open()
            try { $entryStream.WriteByte(0x42) } finally { $entryStream.Dispose() }
          }
        } finally { $zip.Dispose() }
      }

      $hostileZip = Join-Path $root 'hostile.zip'
      $uvExtractionStage = Join-Path $root 'uv-extraction-stage'
      $uvDestination = Join-Path $uvExtractionStage 'destination'
      $uvRejectionStage = Join-Path $root 'uv-rejection-stage'
      $uvRejected = Join-Path $uvRejectionStage 'destination'
      $sourceAncestorStage = Join-Path $root 'source-ancestor-stage'
      $ancestorDownloads = Join-Path $sourceAncestorStage 'downloads'
      $safeZip = Join-Path $ancestorDownloads 'candidate.zip'
      $ancestorEscape = Join-Path $root 'ancestor-escape'
      $uvDestinationEscape = Join-Path $root 'uv-destination-escape'
      New-Item -ItemType Directory -Path $uvDestination -Force | Out-Null
      New-Item -ItemType Directory -Path $uvRejected -Force | Out-Null
      New-Item -ItemType Directory -Path $ancestorDownloads -Force | Out-Null
      New-Item -ItemType Directory -Path (Join-Path $ancestorEscape 'downloads') -Force | Out-Null
      New-Item -ItemType Directory -Path (Join-Path $uvDestinationEscape 'destination') -Force | Out-Null
      New-UvZip $safeZip
      New-UvZip $hostileZip -Hostile
      $safeZipExpectedSize = [int64](Get-Item -LiteralPath $safeZip).Length
      $safeZipExpectedSha256 = Get-Sha256Hex $safeZip
      $uvDestinationSwapAttempted = $false
      $uvExtractionFailure = $null
      try {
      Expand-HermesUvArchiveIdentityStable -Archive $safeZip -StableRoot $uvExtractionStage -Destination $uvDestination -ExpectedSha256 $safeZipExpectedSha256 -ExpectedSize $safeZipExpectedSize -BeforeSnapshotCopy {
        try {
          Move-Item -LiteralPath $sourceAncestorStage -Destination ($sourceAncestorStage + '.validated')
          New-Item -ItemType Junction -Path $sourceAncestorStage -Target $ancestorEscape | Out-Null
        } catch {
          [IO.File]::WriteAllText((Join-Path $root 'ancestor-swap-blocked.txt'), 'blocked', [Text.UTF8Encoding]::new($false))
        }
      } -AfterValidation {
        if (@(Get-ChildItem -LiteralPath $ancestorEscape -Force -Recurse).Count -ne 1) {
          [IO.File]::WriteAllText((Join-Path $root 'ancestor-outside-observed.txt'), 'outside-write', [Text.UTF8Encoding]::new($false))
        }
        Move-Item -LiteralPath $safeZip -Destination ($safeZip + '.validated')
        Copy-Item -LiteralPath $hostileZip -Destination $safeZip
      } -BeforeFileCreate {
        if (-not $uvDestinationSwapAttempted) {
          $uvDestinationSwapAttempted = $true
          try {
            Move-Item -LiteralPath $uvExtractionStage -Destination ($uvExtractionStage + '.validated')
            New-Item -ItemType Junction -Path $uvExtractionStage -Target $uvDestinationEscape | Out-Null
          } catch {
            [IO.File]::WriteAllText((Join-Path $root 'uv-destination-swap-blocked.txt'), 'blocked', [Text.UTF8Encoding]::new($false))
          }
        }
      }
      } catch { $uvExtractionFailure = $_ }
      if (Test-Path -LiteralPath (Join-Path $uvDestinationEscape 'destination\\uv.exe') -PathType Leaf) { throw 'uv extraction staging ancestor swap wrote outside its stable root.' }
      if ($null -ne $uvExtractionFailure) { throw $uvExtractionFailure }
      if (-not (Test-Path -LiteralPath (Join-Path $root 'ancestor-swap-blocked.txt') -PathType Leaf)) { throw 'Artifact source staging ancestor swap was not blocked.' }
      if (Test-Path -LiteralPath (Join-Path $root 'ancestor-outside-observed.txt') -PathType Leaf) { throw 'Artifact source staging ancestor swap created an outside file.' }
      if (-not (Test-Path -LiteralPath (Join-Path $root 'uv-destination-swap-blocked.txt') -PathType Leaf)) { throw 'uv extraction staging ancestor swap was not blocked.' }
      if (@(Get-ChildItem -LiteralPath $uvDestination -File).Count -ne 3) { throw 'Bounded uv archive snapshot was not extracted.' }
      try {
        Expand-HermesUvArchiveIdentityStable -Archive $hostileZip -StableRoot $uvRejectionStage -Destination $uvRejected
        throw 'hostile_zip_accepted'
      } catch {
        if ($_.Exception.Message -eq 'hostile_zip_accepted') { throw }
      }
      if (Test-Path -LiteralPath (Join-Path $root 'escaped.exe')) { throw 'Rejected zip wrote outside its destination.' }
    `);

    try {
      expect(result.code, result.stderr).toBe(0);
      expect(await readFile(join(destination, "python", "safe.txt"), "utf8")).toBe("identity-stable");
      expect(await pathExists(join(outside, "pwned.txt"))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

  it("fails closed when payload data cannot be flushed and orders the barrier before the commit marker", async () => {
    const root = await mkdtemp(join(canonicalTmpdir, "jarvis-hermes-artifact-durability-"));
    const payload = join(root, "payload");
    const result = await runPowerShell(`
      $ErrorActionPreference = 'Stop'
      Import-Module ${psLiteral(modulePath)} -Force
      $root = ${psLiteral(root)}
      $payload = ${psLiteral(payload)}
      New-Item -ItemType Directory -Path $payload | Out-Null
      $file = Join-Path $payload 'payload.bin'
      [IO.File]::WriteAllBytes($file, [byte[]](1,2,3,4))
      Sync-HermesPublicationPayload -RuntimeRoot $root -Directory $payload
      $held = [IO.File]::Open($file, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
      try {
        try {
          Sync-HermesPublicationPayload -RuntimeRoot $root -Directory $payload
          throw 'unflushable_payload_accepted'
        } catch {
          if ($_.Exception.Message -eq 'unflushable_payload_accepted') { throw }
        }
      } finally { $held.Dispose() }
    `);

    try {
      expect(result.code, result.stderr).toBe(0);
      const source = await readFile(modulePath, "utf8");
      const completion = source.slice(source.indexOf("function Complete-StagedDirectories"), source.indexOf("function Recover-StagedDirectories"));
      const containedMove = source.slice(source.indexOf("function Move-HermesLeasedDirectoryNoReplace"), source.indexOf("function Remove-HermesContainedFileNoFollow"));
      expect(completion.indexOf("Sync-HermesPublicationPayload")).toBeGreaterThanOrEqual(0);
      expect(completion.indexOf("Sync-HermesPublicationPayload")).toBeLessThan(completion.indexOf("Write-HermesPublicationReady"));
      expect(source).toContain("Move-HermesLeasedDirectoryNoReplace $scope.Context $staged $final");
      expect(containedMove).toContain("$sourceMoveLease.MoveToNoReplace($destinationFull)");
      expect(containedMove).toContain("Release-HermesDirectoryLeaseSubtree $Context $sourceFull -RetainRootLease");
      expect(containedMove).toContain("Enter-HermesGitWritableDirectory $Context $parent");
      expect(containedMove).toContain("Exit-HermesGitWritableDirectory $Context $enteredParents[$index]");
      expect(containedMove).toContain("if ([string]$Context.Leases[$destinationFull].Identity -cne $identity)");
      expect(containedMove).toContain("Assert-HermesSafeTree $root $destinationFull 'Contained moved directory'");
      expect(containedMove).toContain("Get-HermesDirectoryDigest $root $destinationFull");
      expect(source).toContain("$stream.Flush($true)");
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

  it("keeps concurrent VerifyOnly extraction leases scoped to each verifier scratch root", async () => {
    const roots = await Promise.all([
      mkdtemp(join(canonicalTmpdir, "jarvis-hermes-workflow-fixture-")),
      mkdtemp(join(canonicalTmpdir, "jarvis-hermes-workflow-fixture-")),
    ]);
    try {
      for (const root of roots) {
        await writeFile(join(root, "artifact-operations.json"), '{"schemaVersion":1,"workflow":"runtime-artifacts","scenario":"success"}\n', "utf8");
        const acquired = await runPowerShellFile(artifactScriptPath, [
          "-RuntimeRoot", root,
          "-TestOperationFixture", join(root, "artifact-operations.json"),
        ]);
        expect(acquired.code, acquired.stderr).toBe(0);
      }

      const verifies = await Promise.all(roots.map((root) => runPowerShellFile(artifactScriptPath, [
        "-RuntimeRoot", root,
        "-VerifyOnly",
        "-TestOperationFixture", join(root, "artifact-operations.json"),
      ])));
      for (const [index, verify] of verifies.entries()) {
        expect(verify.code, `verifier ${index + 1}: ${verify.stderr}`).toBe(0);
        expect(await pathExists(join(roots[index], ".hermes-runtime-publication.ready.json"))).toBe(true);
      }
    } finally {
      await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })));
    }
  }, 120_000);
});
