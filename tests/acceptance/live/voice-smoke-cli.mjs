import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  REQUIRED_LIVE_CONFIGURATION,
  VOICE_SMOKE_SCENARIOS,
  auditVoiceEvidence,
  cleanupVoiceEvidence,
  formatRunResult,
  parseSmokeArguments,
  runVoiceSmoke,
} from "./voice-smoke.ts";
import { createFileEvidenceStore } from "./voice-smoke-store.mjs";

const OWNER_VOICE_IDENTITY_CONFIGURATION = "OWNER_VOICE_IDENTITY_ID";
const PUBLIC_RUN_FAILURES = new Set([
  "evidence_cleanup_failed",
  "evidence_write_failed",
  "live_smoke_failed",
]);

function safeLine(value) {
  return `${JSON.stringify(value)}\n`;
}

function publicRunFailure(error) {
  try {
    if (error === null || typeof error !== "object") return "invalid_smoke_arguments";
    const message = Object.getOwnPropertyDescriptor(error, "message")?.value;
    return typeof message === "string" && PUBLIC_RUN_FAILURES.has(message)
      ? message
      : "invalid_smoke_arguments";
  } catch {
    return "invalid_smoke_arguments";
  }
}

function evidencePath(name) {
  if (!VOICE_SMOKE_SCENARIOS.some((scenario) => name === `${scenario}.json`)) throw new Error("unsafe_evidence_path");
  return fileURLToPath(new URL(`./evidence/${name}`, import.meta.url));
}

const store = createFileEvidenceStore(new URL("./evidence/", import.meta.url));

async function audit() {
  try {
    const records = await Promise.all(VOICE_SMOKE_SCENARIOS.map(async (scenario) => {
      const contents = await readFile(evidencePath(`${scenario}.json`), "utf8");
      return JSON.parse(contents);
    }));
    auditVoiceEvidence(records);
    process.stdout.write(safeLine({ status: "passed", evidenceCount: VOICE_SMOKE_SCENARIOS.length }));
  } catch {
    process.stdout.write(safeLine({ status: "blocked", reason: "release_voice_evidence_incomplete" }));
    process.exitCode = 2;
  }
}

async function cleanup() {
  try {
    await cleanupVoiceEvidence(store);
    process.stdout.write(safeLine({ status: "passed", cleaned: VOICE_SMOKE_SCENARIOS.length }));
  } catch {
    process.stdout.write(safeLine({ status: "blocked", reason: "evidence_cleanup_failed" }));
    process.exitCode = 2;
  }
}

function liveGateConfiguration(environment) {
  const entries = [];
  for (const name of REQUIRED_LIVE_CONFIGURATION) {
    if (name === OWNER_VOICE_IDENTITY_CONFIGURATION) {
      if (Object.prototype.hasOwnProperty.call(environment, name)) entries.push([name, true]);
    } else {
      entries.push([name, environment[name]]);
    }
  }
  return Object.freeze(Object.fromEntries(entries));
}

export async function runSmokeCommand(arguments_, overrides = {}) {
  const environment = overrides.environment ?? process.env;
  const runGate = overrides.runGate ?? runVoiceSmoke;
  const writeStdout = overrides.writeStdout ?? ((value) => process.stdout.write(value));
  let parsed;
  try {
    parsed = parseSmokeArguments(arguments_);
  } catch {
    writeStdout(safeLine({ status: "blocked", reason: "invalid_smoke_arguments" }));
    return 2;
  }
  try {
    const configuration = liveGateConfiguration(environment);
    const input = {
      ...parsed,
      configuration,
      secretPresence: overrides.secretPresence ?? {},
    };
    if (Object.prototype.hasOwnProperty.call(overrides, "doctorExitCode")) input.doctorExitCode = overrides.doctorExitCode;
    const evidenceStore = overrides.store ?? store;
    const dependencies = overrides.driver === undefined
      ? { store: evidenceStore }
      : { driver: overrides.driver, store: evidenceStore };
    const result = await runGate(input, dependencies);
    writeStdout(formatRunResult(result));
    return result.status === "blocked" ? 2 : 0;
  } catch (error) {
    writeStdout(safeLine({ status: "blocked", reason: publicRunFailure(error) }));
    return 2;
  }
}

const executedPath = process.argv[1];
if (executedPath !== undefined && import.meta.url === pathToFileURL(executedPath).href) {
  const arguments_ = process.argv.slice(2);
  if (arguments_.length === 1 && arguments_[0] === "--audit-evidence") await audit();
  else if (arguments_.length === 1 && arguments_[0] === "--cleanup-evidence") await cleanup();
  else process.exitCode = await runSmokeCommand(arguments_);
}
