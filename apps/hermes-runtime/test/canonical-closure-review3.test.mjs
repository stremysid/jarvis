import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJsonFileBytes, loadCanonicalJsonFile } from "../src/canonical-json.mjs";

const runtimeRoot = fileURLToPath(new URL("../", import.meta.url));
const sandboxes = [];

const reviewedPackage = {
  devDependencies: {
    "@iarna/toml": "2.2.5",
    ajv: "8.17.1",
  },
  name: "@jarvis/hermes-runtime",
  private: true,
  scripts: {
    lint: "node --check src/canonical-json.mjs && node --check src/validate-manifests.mjs && node --check src/validate-runs-wire.mjs && node --check src/generate-sbom.mjs",
    test: "vitest run test",
    typecheck: "node --check src/canonical-json.mjs && node --check src/validate-manifests.mjs && node --check src/validate-runs-wire.mjs && node --check src/generate-sbom.mjs",
  },
  type: "module",
  version: "0.1.0",
};

afterEach(async () => {
  await Promise.all(sandboxes.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Hermes H1 committed canonical JSON closure", () => {
  it("loads package.json as the exact reviewed canonical package", async () => {
    const packageFile = await loadCanonicalJsonFile(
      new URL("../package.json", import.meta.url),
      "Hermes runtime package",
    );

    expect(packageFile.value).toStrictEqual(reviewedPackage);
  });

  it("loads the invalid source-lock fixture through the canonical loader", async () => {
    const fixtureFile = await loadCanonicalJsonFile(
      new URL("./fixtures/invalid-source-locks.json", import.meta.url),
      "invalid source-lock fixture",
    );

    expect(fixtureFile.value).toHaveLength(8);
  });

  it("makes the manifest CLI reject exact package.json drift", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "hermes-package-review3-"));
    sandboxes.push(sandbox);
    const copiedRuntime = join(sandbox, "hermes-runtime");
    await cp(runtimeRoot, copiedRuntime, { recursive: true });

    const driftedPackage = { ...reviewedPackage, name: "@jarvis/hermes-runtime-drift" };
    await writeFile(join(copiedRuntime, "package.json"), canonicalJsonFileBytes(driftedPackage));

    const result = spawnSync(process.execPath, [join(copiedRuntime, "src", "validate-manifests.mjs")], {
      cwd: dirname(copiedRuntime),
      encoding: "utf8",
      timeout: 30_000,
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("Hermes H1 manifest validation failed\n");
  });
});
