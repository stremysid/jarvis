import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { realpath } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const nativeRealpath = promisify(realpath.native);

export async function createClosedFixture(workflow, label, scenario = "success") {
  const parent = await mkdtemp(join(await nativeRealpath(tmpdir()), "jarvis-hermes-containment-review5-"));
  const externalTemp = join(parent, "t");
  const runtimeRoot = join(externalTemp, `jarvis-hermes-workflow-fixture-${label}`);
  const outside = join(parent, `outside-${label}`);
  const fixture = join(runtimeRoot, `${workflow}-operations.json`);
  const effects = join(runtimeRoot, "effects.log");
  const ack = join(runtimeRoot, "containment.ack");
  await mkdir(externalTemp);
  await mkdir(runtimeRoot);
  await mkdir(outside);
  await writeFile(fixture, `${JSON.stringify({ schemaVersion: 1, workflow, scenario })}\n`, "utf8");
  return { parent, runtimeRoot, outside, externalTemp, fixture, effects, ack, createdJunctions: [], convertedJunctions: [], running: undefined };
}
