import {
  isTrustedFixedUrl,
  snapshotTrustedPublicOrigin,
  snapshotUrl,
} from "../security/trusted-public-origin.js";

const RELAY_NONCE_PATTERN = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
const ULID_PATTERN = /^[0-7][0-9a-hjkmnp-tv-z]{25}$/;
const SESSION_PATH_PATTERN = /^\/voice\/relay\/([0-7][0-9a-hjkmnp-tv-z]{25})$/;

export interface ConversationRelayVoiceConfig {
  language: "en-US";
  transcriptionProvider: "Deepgram";
  speechModel: "nova-3-general";
  ttsProvider: "Google";
  voice: "en-US-Journey-O";
}

export interface ConversationRelayTwiMLInput {
  publicOrigin: URL;
  sessionUrl: URL;
  actionUrl: URL;
  relayNonce: string;
  voiceConfig: ConversationRelayVoiceConfig;
}

function invalidTwiML(): never {
  throw new Error("invalid_conversation_relay_twiml");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function xmlAttribute(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&apos;";
      default:
        return character;
    }
  });
}

export function renderConversationRelayTwiML(input: ConversationRelayTwiMLInput): string {
  if (!isRecord(input)) {
    invalidTwiML();
  }

  const voiceConfig = input.voiceConfig;
  const publicOrigin = snapshotTrustedPublicOrigin(input.publicOrigin);
  const sessionUrl = snapshotUrl(input.sessionUrl);
  const actionUrl = snapshotUrl(input.actionUrl);
  const sessionPath = sessionUrl?.url.pathname.match(SESSION_PATH_PATTERN);
  if (
    publicOrigin === null ||
    sessionPath === undefined ||
    sessionPath === null ||
    !ULID_PATTERN.test(sessionPath[1] ?? "") ||
    !isTrustedFixedUrl(sessionUrl, publicOrigin, "wss:", `/voice/relay/${sessionPath[1]}`) ||
    !isTrustedFixedUrl(actionUrl, publicOrigin, "https:", "/voice/relay-ended") ||
    typeof input.relayNonce !== "string" ||
    !RELAY_NONCE_PATTERN.test(input.relayNonce) ||
    !isRecord(voiceConfig) ||
    voiceConfig.language !== "en-US" ||
    voiceConfig.transcriptionProvider !== "Deepgram" ||
    voiceConfig.speechModel !== "nova-3-general" ||
    voiceConfig.ttsProvider !== "Google" ||
    voiceConfig.voice !== "en-US-Journey-O"
  ) {
    invalidTwiML();
  }

  const serializedActionUrl = xmlAttribute(actionUrl.serialized);
  const serializedSessionUrl = xmlAttribute(sessionUrl.serialized);
  const language = xmlAttribute(voiceConfig.language);
  const transcriptionProvider = xmlAttribute(voiceConfig.transcriptionProvider);
  const speechModel = xmlAttribute(voiceConfig.speechModel);
  const ttsProvider = xmlAttribute(voiceConfig.ttsProvider);
  const voice = xmlAttribute(voiceConfig.voice);
  const relayNonce = xmlAttribute(input.relayNonce);

  return `<?xml version="1.0" encoding="UTF-8"?><Response><Connect action="${serializedActionUrl}" method="POST"><ConversationRelay url="${serializedSessionUrl}" language="${language}" transcriptionProvider="${transcriptionProvider}" speechModel="${speechModel}" ttsProvider="${ttsProvider}" voice="${voice}" dtmfDetection="true" partialPrompts="false" interruptible="any" reportInputDuringAgentSpeech="any"><Parameter name="relayNonce" value="${relayNonce}" /></ConversationRelay></Connect></Response>`;
}
