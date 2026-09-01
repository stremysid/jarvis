import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { validateSbomIntegrity } from "../src/validate-manifests.mjs";

const runtimeRoot = new URL("..", import.meta.url);
const generatorUrl = new URL("src/generate-sbom.mjs", runtimeRoot);
const sbomUrl = new URL("sbom/hermes-agent-v2026.8.27-windows-x86_64-cpython-3.11.16.cdx.json", runtimeRoot);
const reviewedCommit = "5fc308a70719a83cccdbba4c0e39c23f5a8239d5";
const temporaryRoots = [];

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, ...options });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (value) => { stdout += value; });
    child.stderr.on("data", (value) => { stderr += value; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function makeZeroExitPowerShellShadow(directory, marker) {
  const source = join(directory, "shadow.cs");
  const executable = join(directory, "pwsh.exe");
  await writeFile(source, [
    "using System;",
    "using System.IO;",
    "public static class ShadowPwsh {",
    "  public static int Main() {",
    "    File.WriteAllText(Environment.GetEnvironmentVariable(\"SHADOW_PWSH_MARKER\"), \"executed\");",
    "    return 0;",
    "  }",
    "}",
    "",
  ].join("\r\n"));
  const compiler = String.raw`C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe`;
  const compiled = await run(compiler, ["/nologo", "/target:exe", `/out:${executable}`, source]);
  expect(compiled.code, compiled.stderr || compiled.stdout).toBe(0);
  await access(executable);
  return { executable, marker };
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Task 2 final SBOM security boundaries", () => {
  it("does not execute or trust a zero-exit pwsh shadow from inherited PATH", async () => {
    const parent = await mkdtemp(join(tmpdir(), "jarvis-hermes-shadow-pwsh-"));
    temporaryRoots.push(parent);
    const release = join(parent, "releases", reviewedCommit);
    const source = join(release, "source");
    await mkdir(source, { recursive: true });
    await mkdir(join(release, "git"));
    await writeFile(join(parent, ".hermes-runtime.workflow.lock"), "");
    const marker = join(parent, "shadow-executed.txt");
    await makeZeroExitPowerShellShadow(parent, marker);

    const program = [
      `import { verifyAcquiredSourceRoot } from ${JSON.stringify(generatorUrl.href)};`,
      "try {",
      "  await verifyAcquiredSourceRoot(process.argv[1]);",
      "  process.stdout.write('accepted\\n');",
      "} catch (error) {",
      "  process.stderr.write(`${error.message}\\n`);",
      "  process.exitCode = 1;",
      "}",
    ].join("\n");
    const hostileEnvironment = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toLowerCase() !== "path"));
    hostileEnvironment.Path = parent;
    hostileEnvironment.SHADOW_PWSH_MARKER = marker;
    const result = await run(process.execPath, ["--input-type=module", "--eval", program, source], { env: hostileEnvironment });

    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("--source-root failed the complete locked source VerifyOnly boundary\n");
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
  }, 30_000);

  it("declares a unique bom-ref for every component and closes every dependency edge against them", async () => {
    const sbom = JSON.parse(await readFile(sbomUrl, "utf8"));
    const references = [sbom.metadata.component["bom-ref"], ...sbom.components.map((component) => component["bom-ref"])];
    const declared = new Set(references);

    expect(references).toHaveLength(80);
    expect(references.every((reference) => typeof reference === "string" && reference.length > 0)).toBe(true);
    expect(declared.size).toBe(references.length);
    for (const component of [sbom.metadata.component, ...sbom.components.filter((item) => item.purl?.startsWith("pkg:pypi/"))]) {
      expect(component["bom-ref"]).toBe(component.purl);
    }
    for (const dependency of sbom.dependencies) {
      expect(declared.has(dependency.ref), `undeclared dependency ref ${dependency.ref}`).toBe(true);
      for (const reference of dependency.dependsOn) {
        expect(declared.has(reference), `undeclared dependsOn ref ${reference}`).toBe(true);
      }
    }
  });

  it("uses the metadata application as the sole dependency graph root", async () => {
    const sbom = JSON.parse(await readFile(sbomUrl, "utf8"));
    const root = sbom.metadata.component;
    const rootRef = "pkg:pypi/hermes-agent@0.20.6";

    expect(root["bom-ref"]).toBe(rootRef);
    expect(sbom.components.some((component) => component["bom-ref"] === rootRef)).toBe(false);

    const declared = new Set([root["bom-ref"], ...sbom.components.map((component) => component["bom-ref"])]);
    expect(declared.size).toBe(80);
    expect(sbom.dependencies.find((dependency) => dependency.ref === rootRef)).toBeDefined();

    const graph = new Map(sbom.dependencies.map((dependency) => [dependency.ref, dependency.dependsOn]));
    const reached = new Set();
    const pending = [rootRef];
    while (pending.length > 0) {
      const reference = pending.pop();
      if (reached.has(reference)) continue;
      reached.add(reference);
      pending.push(...(graph.get(reference) ?? []));
    }
    expect(reached.size).toBe(66);
  });

  it("makes the executable validator reject absent, duplicate, and unresolved component references", async () => {
    const [source, artifacts, patches, baseline] = await Promise.all([
      readFile(new URL("hermes-source-lock.json", runtimeRoot), "utf8").then(JSON.parse),
      readFile(new URL("runtime-artifacts-lock.json", runtimeRoot), "utf8").then(JSON.parse),
      readFile(new URL("patches/series.json", runtimeRoot), "utf8").then(JSON.parse),
      readFile(sbomUrl, "utf8").then(JSON.parse),
    ]);
    await expect(validateSbomIntegrity({ source, artifacts, patches, sbom: baseline })).resolves.toBeUndefined();

    const absent = structuredClone(baseline);
    delete absent.components[0]["bom-ref"];
    await expect(validateSbomIntegrity({ source, artifacts, patches, sbom: absent })).rejects.toThrow(/bom-ref/);

    const duplicate = structuredClone(baseline);
    duplicate.components.at(-1)["bom-ref"] = duplicate.components.at(-2)["bom-ref"];
    await expect(validateSbomIntegrity({ source, artifacts, patches, sbom: duplicate })).rejects.toThrow(/bom-ref/);

    const unresolved = structuredClone(baseline);
    unresolved.dependencies[0].dependsOn = ["urn:jarvis:undeclared"];
    await expect(validateSbomIntegrity({ source, artifacts, patches, sbom: unresolved })).rejects.toThrow(/dependency edge drift/);
  });
});
