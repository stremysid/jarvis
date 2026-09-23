import { EventEmitter } from "node:events";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const io = vi.hoisted(() => ({ lstat: vi.fn(), realpath: vi.fn(), spawn: vi.fn() }));
vi.mock("node:fs/promises", async (original) => ({ ...await original(), lstat: io.lstat, realpath: io.realpath }));
vi.mock("node:child_process", async (original) => ({ ...await original(), spawn: io.spawn }));
import { resolveTrustedPowerShellHost } from "../src/generate-sbom.mjs";

const msi = String.raw`C:\Program Files\PowerShell\7\pwsh.exe`;
const queryHost = String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`;
const queryDirectory = dirname(queryHost);
const modules = join(queryDirectory, "Modules");
const taskkill = String.raw`C:\Windows\System32\taskkill.exe`;
// A package volume need not be on C: or have a version-shaped folder name.
const storeDirectory = String.raw`D:\Package volume\PowerShell é ' & data`;
const storeHost = join(storeDirectory, "pwsh.exe");
const appxDirectory = join(modules, "Appx");
const appxManifest = join(appxDirectory, "Appx.psd1");
const utilityDirectory = join(modules, "Microsoft.PowerShell.Utility");
const utilityManifest = join(utilityDirectory, "Microsoft.PowerShell.Utility.psd1");
const queryFailure = "PowerShell 7 package discovery failed: Windows Appx query did not return usable evidence";
let files;
let packages;
let queryExit;
let queryOutput;
let queryDelay;

function put(path, kind = "file", properties = {}) {
  files.set(path, { kind, canonical: path, link: false, ...properties });
}

function get(path) {
  if (!files.has(path)) throw Object.assign(new Error("synthetic absence"), { code: "ENOENT" });
  const entry = files.get(path);
  if (entry.error) throw Object.assign(new Error("synthetic access failure"), { code: entry.error });
  return entry;
}

beforeEach(() => {
  vi.clearAllMocks();
  files = new Map();
  for (const path of [queryHost, appxManifest, utilityManifest, taskkill, storeHost]) put(path);
  for (const path of [queryDirectory, modules, appxDirectory, utilityDirectory, storeDirectory]) put(path, "directory");
  packages = [{
    PackageFamilyName: "Microsoft.PowerShell_8wekyb3d8bbwe",
    Publisher: "CN=Microsoft Corporation, O=Microsoft Corporation, L=Redmond, S=Washington, C=US",
    SignatureKind: "Store",
    IsDevelopmentMode: false,
    InstallLocation: storeDirectory,
  }];
  queryExit = 0;
  queryOutput = undefined;
  queryDelay = 0;
  io.lstat.mockImplementation(async (path) => {
    const entry = get(path);
    return { isFile: () => entry.kind === "file", isDirectory: () => entry.kind === "directory", isSymbolicLink: () => entry.link };
  });
  io.realpath.mockImplementation(async (path) => get(path).canonical);
  io.spawn.mockImplementation((host) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.pid = 12345;
    const complete = () => {
      if (host !== taskkill) child.stdout.write(queryOutput ?? JSON.stringify(packages));
      child.emit("close", host === taskkill ? 0 : queryExit);
    };
    if (queryDelay && host !== taskkill) setTimeout(complete, queryDelay);
    else queueMicrotask(complete);
    return child;
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("PowerShell 7 host trust", () => {
  it("keeps the MSI host without querying a fabricated Store installation", async () => {
    put(msi);
    packages[0].Publisher = "CN=Impostor";
    packages[0].InstallLocation = String.raw`C:\Users\fixture\Microsoft.PowerShell_7.6.6.0_x64__8wekyb3d8bbwe`;
    await expect(resolveTrustedPowerShellHost()).resolves.toBe(msi);
    expect(io.spawn).not.toHaveBeenCalled();
  });

  it("uses the registered Store location when the MSI host is absent even if PATH advertises an MSI impostor", async () => {
    vi.stubEnv("Path", String.raw`C:\Users\fixture\PowerShell\7`);
    put(String.raw`C:\Users\fixture\PowerShell\7\pwsh.exe`);
    await expect(resolveTrustedPowerShellHost()).resolves.toBe(storeHost);
    expect(io.spawn).toHaveBeenCalledTimes(1);
    expect(io.spawn.mock.calls[0][0]).toBe(queryHost);
    expect(io.lstat).toHaveBeenCalledWith(storeDirectory);
    expect(io.lstat).toHaveBeenCalledWith(storeHost);
  });

  it.each([
    ["directory", { kind: "directory" }],
    ["symbolic link", { link: true }],
    ["redirected path", { canonical: String.raw`C:\Users\fixture\pwsh.exe` }],
    ["unreadable file", { error: "EACCES" }],
  ])("refuses an MSI %s instead of hiding it behind the Store fallback", async (_name, properties) => {
    put(msi, "file", properties);
    await expect(resolveTrustedPowerShellHost()).rejects.toThrow(/trusted PowerShell 7 MSI host/);
    expect(io.spawn).not.toHaveBeenCalled();
  });

  it.each([
    ["no package", []],
    ["ambiguous packages", "duplicate"],
    ["a non-array response", "array-like"],
  ])("names the unavailable PowerShell 7 host when Windows reports %s", async (_name, response) => {
    packages = response === "duplicate" ? [packages[0], packages[0]] : response === "array-like" ? { 0: packages[0], length: 1 } : response;
    // A convincing folder or alias must not become evidence when Appx has none.
    put(String.raw`C:\Program Files\WindowsApps\Microsoft.PowerShell_7.6.6.0_x64__8wekyb3d8bbwe\pwsh.exe`);
    put(String.raw`C:\Users\fixture\AppData\Local\Microsoft\WindowsApps\pwsh.exe`);
    await expect(resolveTrustedPowerShellHost()).rejects.toThrow("trusted PowerShell 7 host is unavailable: expected one registered Microsoft.PowerShell Store package after the MSI host was absent");
  });

  it.each([
    ["PackageFamilyName", "Impostor_8wekyb3d8bbwe", "family is not trusted"],
    ["Publisher", "CN=Impostor", "publisher is not trusted"],
    ["SignatureKind", "Developer", "not signed by the Windows Store"],
    ["SignatureKind", "None", "not signed by the Windows Store"],
    ["IsDevelopmentMode", true, "development registration"],
    ["IsDevelopmentMode", undefined, "development registration"],
    ["IsDevelopmentMode", "false", "development registration"],
  ])("refuses the Store record when %s is %s", async (field, value, message) => {
    packages[0][field] = value;
    await expect(resolveTrustedPowerShellHost()).rejects.toThrow(message);
    expect(io.lstat).not.toHaveBeenCalledWith(storeHost);
  });

  it.each([
    ["non-string", null],
    ["non-string array", [storeDirectory]],
    ["relative", String.raw`PowerShell\7`],
    ["UNC", String.raw`\\server\packages\PowerShell`],
    ["device", String.raw`\\?\C:\packages\PowerShell`],
    ["forward-slash", String.raw`D:\Package volume/PowerShell`],
    ["parent traversal", String.raw`D:\Package volume\other\..\PowerShell`],
  ])("refuses a %s Store install location before reading it", async (_name, location) => {
    packages[0].InstallLocation = location;
    await expect(resolveTrustedPowerShellHost()).rejects.toThrow("install location is not an exact drive-absolute directory");
    expect(io.lstat).not.toHaveBeenCalledWith(location);
  });

  it.each([
    ["missing", undefined],
    ["file", { kind: "file" }],
    ["symbolic link", { link: true }],
    ["redirected path", { canonical: String.raw`C:\Users\fixture\package` }],
  ])("refuses a Store install directory that is a %s", async (_name, properties) => {
    if (properties) put(storeDirectory, "directory", properties); else files.delete(storeDirectory);
    await expect(resolveTrustedPowerShellHost()).rejects.toThrow(/PowerShell 7 Store install location is (unavailable|not the trusted absolute directory)/);
    expect(io.lstat).not.toHaveBeenCalledWith(storeHost);
  });

  it.each([
    ["missing", undefined],
    ["directory", { kind: "directory" }],
    ["symbolic link", { link: true }],
    ["redirected path", { canonical: String.raw`C:\Users\fixture\pwsh.exe` }],
  ])("refuses a Store executable that is a %s", async (_name, properties) => {
    if (properties) put(storeHost, "file", properties); else files.delete(storeHost);
    await expect(resolveTrustedPowerShellHost()).rejects.toThrow(/trusted PowerShell 7 Store host is (unavailable|not the trusted absolute file)/);
  });

  it.each([
    ["host", queryHost],
    ["process terminator", taskkill],
    ["host directory", queryDirectory],
    ["modules directory", modules],
    ["Appx directory", appxDirectory],
    ["Appx manifest", appxManifest],
    ["Utility directory", utilityDirectory],
    ["Utility manifest", utilityManifest],
  ])("refuses a redirected package discovery %s before executing any process", async (_name, path) => {
    files.get(path).canonical = String.raw`C:\Users\fixture\redirected`;
    await expect(resolveTrustedPowerShellHost()).rejects.toThrow(/not the trusted absolute/);
    expect(io.spawn).not.toHaveBeenCalled();
  });

  it("does not accept successful-looking output from a failed Windows package query", async () => {
    queryExit = 23;
    await expect(resolveTrustedPowerShellHost()).rejects.toThrow(queryFailure);
  });

  it("explains a malformed Windows package query response without exposing its output", async () => {
    queryOutput = "synthetic unusable response";
    await expect(resolveTrustedPowerShellHost()).rejects.toThrow(queryFailure);
  });

  it("bounds package discovery output and terminates its process tree", async () => {
    queryOutput = JSON.stringify(packages) + " ".repeat(65_536);
    await expect(resolveTrustedPowerShellHost()).rejects.toThrow(queryFailure);
    expect(io.spawn).toHaveBeenCalledWith(taskkill, ["/PID", "12345", "/T", "/F"], expect.any(Object));
  });

  it("bounds package discovery time and terminates its process tree", async () => {
    vi.useFakeTimers();
    queryDelay = 121_000;
    const outcome = resolveTrustedPowerShellHost().then((host) => ({ host }), (error) => ({ error: error.message }));
    await vi.runAllTimersAsync();
    expect(await outcome).toEqual({ error: queryFailure });
    expect(io.spawn).toHaveBeenCalledWith(taskkill, ["/PID", "12345", "/T", "/F"], expect.any(Object));
  });

  it("queries only the OS host and modules with profiles and inherited environment closed", async () => {
    for (const key of ["Path", "SystemRoot", "WINDIR", "PSModulePath", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "NODE_OPTIONS", "COR_ENABLE_PROFILING", "DOTNET_STARTUP_HOOKS"]) vi.stubEnv(key, "synthetic-hostile-value");
    await expect(resolveTrustedPowerShellHost()).resolves.toBe(storeHost);
    const [host, args, options] = io.spawn.mock.calls[0];
    expect(host).toBe(queryHost);
    expect(args.slice(0, 4)).toEqual(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"]);
    expect(args[4]).toContain("$ErrorActionPreference = 'Stop'");
    expect(args[4]).toContain("$env:PSModulePath = 'NUL'");
    expect(args[4]).toContain("$PSModuleAutoLoadingPreference = 'None'");
    expect(args[4]).toContain("[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)");
    expect(args[4]).toContain("Import-Module -Name $env:JARVIS_HERMES_APPX_MODULE -Force");
    expect(args[4]).toContain("Import-Module -Name $env:JARVIS_HERMES_UTILITY_MODULE -Force");
    expect(args[4]).toContain("Appx\\Get-AppxPackage -Name Microsoft.PowerShell -PackageTypeFilter Main");
    expect(args[4]).not.toContain(storeDirectory);
    expect(options).toEqual({
      windowsHide: true,
      cwd: queryDirectory,
      env: {
        APPDATA: queryDirectory, ComSpec: String.raw`C:\Windows\System32\cmd.exe`, HOME: queryDirectory,
        JARVIS_HERMES_APPX_MODULE: appxManifest, JARVIS_HERMES_UTILITY_MODULE: utilityManifest,
        LOCALAPPDATA: queryDirectory, Path: String.raw`C:\Windows\System32`, PATHEXT: ".COM;.EXE",
        PSDisableModuleAnalysisCacheCleanup: "1", PSModuleAnalysisCachePath: "NUL", PSModulePath: modules,
        SystemRoot: String.raw`C:\Windows`, TEMP: queryDirectory, TMP: queryDirectory,
        USERPROFILE: queryDirectory, WINDIR: String.raw`C:\Windows`, XDG_CONFIG_HOME: queryDirectory,
      },
    });
  });
});
