import { readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  REQUIRED_LIVE_CONFIGURATION,
  VOICE_SMOKE_SCENARIOS,
  auditVoiceEvidence,
  cleanupVoiceEvidence,
  formatRunResult,
  parseSmokeArguments,
  runVoiceSmoke,
} from "./voice-smoke.ts";

function safeLine(value) {
  return `${JSON.stringify(value)}\n`;
}

function evidencePath(name) {
  if (!VOICE_SMOKE_SCENARIOS.some((scenario) => name === `${scenario}.json`)) throw new Error("unsafe_evidence_path");
  return fileURLToPath(new URL(`./evidence/${name}`, import.meta.url));
}

const store = {
  async writeTemporary() {
    throw new Error("live_driver_unavailable");
  },
  async commitTemporary() {
    throw new Error("live_driver_unavailable");
  },
  async remove(name) {
    await rm(evidencePath(name), { force: true });
  },
};

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

async function smoke(arguments_) {
  try {
    const parsed = parseSmokeArguments(arguments_);
    const configuration = Object.fromEntries(REQUIRED_LIVE_CONFIGURATION.map((name) => [name, process.env[name]]));
    const result = await runVoiceSmoke({
      ...parsed,
      configuration,
      secretPresence: {},
    }, {});
    process.stdout.write(formatRunResult(result));
    if (result.status === "blocked") process.exitCode = 2;
  } catch {
    process.stdout.write(safeLine({ status: "blocked", reason: "invalid_smoke_arguments" }));
    process.exitCode = 2;
  }
}

const arguments_ = process.argv.slice(2);
if (arguments_.length === 1 && arguments_[0] === "--audit-evidence") await audit();
else if (arguments_.length === 1 && arguments_[0] === "--cleanup-evidence") await cleanup();
else await smoke(arguments_);
