import { link, lstat, open, rm, unlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const SCENARIOS = Object.freeze([
  "inbound",
  "unauthorized-caller",
  "outbound-answer",
  "outbound-no-answer",
  "failure-callbacks",
]);
const ULID_TEXT = "[0-7][0-9a-hjkmnp-tv-z]{25}";
const TEMPORARY_NAME = new RegExp(`^\\.(${SCENARIOS.join("|")})\\.(${ULID_TEXT})\\.tmp$`, "u");
const FINAL_NAME = new RegExp(`^(${SCENARIOS.join("|")})\\.json$`, "u");

function safeName(name, expected) {
  if (typeof name !== "string") throw new Error("unsafe_evidence_path");
  const match = expected.exec(name);
  if (match === null) throw new Error("unsafe_evidence_path");
  return match;
}

async function requireDirectory(path) {
  try {
    const metadata = await lstat(path);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error();
  } catch {
    throw new Error("evidence_directory_unavailable");
  }
}

function isCode(error, code) {
  return error !== null && typeof error === "object" && Object.getOwnPropertyDescriptor(error, "code")?.value === code;
}

export function createFileEvidenceStore(directoryUrl) {
  const directory = fileURLToPath(new URL(directoryUrl));

  return Object.freeze({
    async writeTemporary(name, contents) {
      safeName(name, TEMPORARY_NAME);
      if (typeof contents !== "string") throw new Error("evidence_contents_invalid");
      await requireDirectory(directory);
      let handle;
      try {
        handle = await open(fileURLToPath(new URL(name, directoryUrl)), "wx", 0o600);
      } catch (error) {
        if (isCode(error, "EEXIST")) throw new Error("evidence_temporary_exists");
        throw new Error("evidence_write_failed");
      }
      let completed = false;
      try {
        await handle.writeFile(contents, { encoding: "utf8" });
        await handle.sync();
        completed = true;
      } finally {
        await handle.close();
        if (!completed) await rm(fileURLToPath(new URL(name, directoryUrl)), { force: true });
      }
    },

    async commitTemporary(temporaryName, finalName) {
      const temporary = safeName(temporaryName, TEMPORARY_NAME);
      const final = safeName(finalName, FINAL_NAME);
      if (temporary[1] !== final[1]) throw new Error("unsafe_evidence_path");
      await requireDirectory(directory);
      try {
        await link(
          fileURLToPath(new URL(temporaryName, directoryUrl)),
          fileURLToPath(new URL(finalName, directoryUrl)),
        );
      } catch (error) {
        if (isCode(error, "EEXIST")) throw new Error("evidence_destination_exists");
        throw new Error("evidence_write_failed");
      }
      await unlink(fileURLToPath(new URL(temporaryName, directoryUrl)));
    },

    async remove(name) {
      if (FINAL_NAME.exec(name) === null && TEMPORARY_NAME.exec(name) === null) throw new Error("unsafe_evidence_path");
      await requireDirectory(directory);
      await rm(fileURLToPath(new URL(name, directoryUrl)), { force: true });
    },
  });
}
