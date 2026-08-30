const RELAY_NONCE_PATTERN = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;

export interface ConversationRelayVoiceConfig {
  language: "en-US";
  transcriptionProvider: "Deepgram";
  speechModel: "nova-3-general";
  ttsProvider: "Google";
  voice: "en-US-Journey-O";
}

export interface ConversationRelayTwiMLInput {
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

function isSafeUrl(value: unknown, protocol: "wss:" | "https:"): value is URL {
  return (
    value instanceof URL &&
    value.protocol === protocol &&
    value.hostname.length > 0 &&
    value.username.length === 0 &&
    value.password.length === 0 &&
    value.port.length === 0 &&
    !value.href.includes("#") &&
    !value.href.includes("?")
  );
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
  if (
    !isSafeUrl(input.sessionUrl, "wss:") ||
    !isSafeUrl(input.actionUrl, "https:") ||
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

  const actionUrl = xmlAttribute(input.actionUrl.toString());
  const sessionUrl = xmlAttribute(input.sessionUrl.toString());
  const language = xmlAttribute(voiceConfig.language);
  const transcriptionProvider = xmlAttribute(voiceConfig.transcriptionProvider);
  const speechModel = xmlAttribute(voiceConfig.speechModel);
  const ttsProvider = xmlAttribute(voiceConfig.ttsProvider);
  const voice = xmlAttribute(voiceConfig.voice);
  const relayNonce = xmlAttribute(input.relayNonce);

  return `<?xml version="1.0" encoding="UTF-8"?><Response><Connect action="${actionUrl}" method="POST"><ConversationRelay url="${sessionUrl}" language="${language}" transcriptionProvider="${transcriptionProvider}" speechModel="${speechModel}" ttsProvider="${ttsProvider}" voice="${voice}" dtmfDetection="true" partialPrompts="false" interruptible="any" reportInputDuringAgentSpeech="any"><Parameter name="relayNonce" value="${relayNonce}" /></ConversationRelay></Connect></Response>`;
}
