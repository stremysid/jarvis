import { createHash } from "node:crypto";
import { link, lstat, open, rm, unlink } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCENARIOS = Object.freeze([
  "inbound",
  "unauthorized-caller",
  "outbound-answer",
  "outbound-no-answer",
  "owner-step-up-refused",
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

function digest(contents) {
  return createHash("sha256").update(contents, "utf8").digest("hex");
}

export function createFileEvidenceStore(directoryUrl) {
  const directory = fileURLToPath(new URL(directoryUrl));
  const pending = new Map();

  return Object.freeze({
    async exists(name) {
      safeName(name, FINAL_NAME);
      await requireDirectory(directory);
      try {
        await lstat(join(directory, name));
        return true;
      } catch (error) {
        if (isCode(error, "ENOENT")) return false;
        throw new Error("evidence_store_unavailable");
      }
    },

    async writeTemporary(name, contents) {
      safeName(name, TEMPORARY_NAME);
      if (typeof contents !== "string") throw new Error("evidence_contents_invalid");
      await requireDirectory(directory);
      const temporaryPath = join(directory, name);
      let handle;
      try {
        handle = await open(temporaryPath, "wx", 0o600);
      } catch (error) {
        if (isCode(error, "EEXIST")) throw new Error("evidence_temporary_exists");
        throw new Error("evidence_write_failed");
      }
      let completed = false;
      try {
        await handle.writeFile(contents, { encoding: "utf8" });
        await handle.sync();
        pending.set(name, digest(contents));
        completed = true;
      } finally {
        await handle.close();
        if (!completed) await rm(temporaryPath, { force: true });
      }
    },

    async commitTemporary(temporaryName, finalName) {
      const temporary = safeName(temporaryName, TEMPORARY_NAME);
      const final = safeName(finalName, FINAL_NAME);
      if (temporary[1] !== final[1]) throw new Error("unsafe_evidence_path");
      await requireDirectory(directory);
      const temporaryPath = join(directory, temporaryName);
      const finalPath = join(directory, finalName);
      const expectedDigest = pending.get(temporaryName);
      let currentDigest;
      try {
        currentDigest = digest(await readFile(temporaryPath, "utf8"));
      } catch {
        throw new Error("evidence_temporary_changed");
      }
      if (expectedDigest === undefined || currentDigest !== expectedDigest) throw new Error("evidence_temporary_changed");
      try {
        await link(temporaryPath, finalPath);
      } catch (error) {
        if (isCode(error, "EEXIST")) throw new Error("evidence_destination_exists");
        throw new Error("evidence_write_failed");
      }
      try {
        if (digest(await readFile(finalPath, "utf8")) !== expectedDigest) throw new Error();
      } catch {
        await rm(finalPath, { force: true });
        throw new Error("evidence_temporary_changed");
      }
      await unlink(temporaryPath);
      pending.delete(temporaryName);
    },

    async remove(name) {
      if (FINAL_NAME.exec(name) === null && TEMPORARY_NAME.exec(name) === null) throw new Error("unsafe_evidence_path");
      await requireDirectory(directory);
      await rm(join(directory, name), { force: true });
      pending.delete(name);
    },
  });
}
