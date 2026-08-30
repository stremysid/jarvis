import { describe, expect, it } from "vitest";
import { parseRelayEvent } from "../../src/providers/conversation-relay.js";
import { renderConversationRelayTwiML } from "../../src/voice/twiml.js";

const SESSION_SID = `VX${"0".repeat(32)}`;
const ACCOUNT_SID = `AC${"1".repeat(32)}`;
const CALL_SID = `CA${"2".repeat(32)}`;
const RELAY_NONCE = "Abcdefghijklmnopqrstuvwxyz0123456789_-ABCDE";
const CALL_SESSION_ID = "01k3s6k8000000000000000000";
const PUBLIC_ORIGIN = "https://jarvis.example/";

class MisleadingUrl extends URL {
  constructor(value: string, private readonly misleadingValue: string) {
    super(value);
  }

  override toString(): string {
    return this.misleadingValue;
  }
}

const officialSetupFixture = {
  type: "setup",
  sessionId: SESSION_SID,
  accountSid: ACCOUNT_SID,
  parentCallSid: "",
  callSid: CALL_SID,
  from: "+18005550100",
  to: "+18005550101",
  forwardedFrom: "+18005550102",
  callType: "PSTN",
  callerName: "",
  direction: "inbound",
  callStatus: "RINGING",
  customParameters: { relayNonce: RELAY_NONCE },
} as const;

function frameWithAsciiByteLength(size: number): string {
  const prefix = '{"type":"interrupt","utteranceUntilInterrupt":"","durationUntilInterruptMs":0,"futurePadding":"';
  const suffix = '"}';
  return `${prefix}${"a".repeat(size - prefix.length - suffix.length)}${suffix}`;
}

function parseObject(value: Record<string, unknown>): ReturnType<typeof parseRelayEvent> {
  return parseRelayEvent(JSON.stringify(value));
}

describe("current ConversationRelay boundary", () => {
  it("maps the complete documented setup fixture and discards provider-only metadata", () => {
    expect(parseObject({ ...officialSetupFixture, futureProviderField: { revision: 2 } })).toEqual({
      type: "setup",
      sessionId: SESSION_SID,
      accountSid: ACCOUNT_SID,
      callSid: CALL_SID,
      direction: "inbound",
      relayNonce: RELAY_NONCE,
    });
  });

  it.each(["outbound-api", "outbound-dial"])("maps provider direction %s to outbound", (direction) => {
    expect(parseObject({ ...officialSetupFixture, direction })).toMatchObject({ direction: "outbound" });
  });

  it("maps documented final and partial prompts without inventing a provider identifier", () => {
    expect(
      parseObject({
        type: "prompt",
        voicePrompt: "Hi! Can you tell me about life?",
        lang: "en-US",
        last: true,
        futureProviderField: "ignored",
      }),
    ).toEqual({ type: "prompt", text: "Hi! Can you tell me about life?", language: "en-US", final: true });
    expect(parseObject({ type: "prompt", voicePrompt: "Hi!", lang: "en-US", last: false })).toEqual({
      type: "prompt",
      text: "Hi!",
      language: "en-US",
      final: false,
    });
  });

  it.each(["0", "9", "*", "#"])("maps the documented one-key DTMF shape for %s", (digit) => {
    expect(parseObject({ type: "dtmf", digit, futureProviderField: true })).toEqual({ type: "dtmf", digit });
  });

  it("validates but discards raw interrupt and error content", () => {
    const interrupt = parseObject({
      type: "interrupt",
      utteranceUntilInterrupt: "private interrupted text",
      durationUntilInterruptMs: 460,
    });
    const error = parseObject({
      type: "error",
      description: 'Invalid message received: { "private" : "payload" }',
    });

    expect(interrupt).toEqual({ type: "interrupt" });
    expect(error).toEqual({ type: "error", code: "conversation_relay_error" });
    expect(JSON.stringify([interrupt, error])).not.toContain("private");
  });

  it("rejects non-text, malformed, and non-object frames with one safe error", () => {
    const invalidFrames = [
      new Uint8Array([123, 125]) as unknown as string,
      "",
      "{",
      "null",
      "[]",
      '"prompt"',
    ];

    for (const frame of invalidFrames) {
      expect(() => parseRelayEvent(frame)).toThrowError(/^invalid_relay_event$/);
    }
  });

  it("accepts exactly 64 KiB and rejects a larger UTF-8 frame", () => {
    const atLimit = frameWithAsciiByteLength(64 * 1024);
    const aboveLimit = frameWithAsciiByteLength(64 * 1024 + 1);

    expect(new TextEncoder().encode(atLimit)).toHaveLength(64 * 1024);
    expect(parseRelayEvent(atLimit)).toEqual({ type: "interrupt" });
    expect(() => parseRelayEvent(aboveLimit)).toThrowError(/^invalid_relay_event$/);
  });

  it("measures the frame cap in UTF-8 bytes rather than JavaScript code units", () => {
    const frame = JSON.stringify({
      type: "error",
      description: "é".repeat(32_768),
    });

    expect(frame.length).toBeLessThan(64 * 1024);
    expect(new TextEncoder().encode(frame).byteLength).toBeGreaterThan(64 * 1024);
    expect(() => parseRelayEvent(frame)).toThrowError(/^invalid_relay_event$/);
  });

  it.each([
    ["session SID prefix", { sessionId: `CA${"0".repeat(32)}` }],
    ["session SID length", { sessionId: `VX${"0".repeat(31)}` }],
    ["session SID hex", { sessionId: `VX${"g".repeat(32)}` }],
    ["account SID prefix", { accountSid: `CA${"1".repeat(32)}` }],
    ["account SID length", { accountSid: `AC${"1".repeat(33)}` }],
    ["account SID hex", { accountSid: `AC${"x".repeat(32)}` }],
    ["call SID prefix", { callSid: `VX${"2".repeat(32)}` }],
    ["call SID length", { callSid: `CA${"2".repeat(31)}` }],
    ["call SID hex", { callSid: `CA${"z".repeat(32)}` }],
    ["provider direction", { direction: "outbound" }],
    ["unknown direction", { direction: "sideways" }],
    ["ill-formed provider metadata", { from: "\ud800" }],
    ["nonce length", { customParameters: { relayNonce: "A".repeat(42) } }],
    ["nonce alphabet", { customParameters: { relayNonce: `${"A".repeat(42)}=` } }],
    ["nonce pad bits", { customParameters: { relayNonce: `${"A".repeat(42)}B` } }],
    ["nonce location", { customParameters: {}, relayNonce: RELAY_NONCE }],
    ["second custom parameter", { customParameters: { relayNonce: RELAY_NONCE, purpose: "must-not-cross" } }],
    ["non-string custom parameter", { customParameters: { relayNonce: RELAY_NONCE, future: { unsafe: true } } }],
    ["custom parameter object", { customParameters: [RELAY_NONCE] }],
  ])("rejects an invalid setup %s", (_label, replacement) => {
    expect(() => parseObject({ ...officialSetupFixture, ...replacement })).toThrowError(/^invalid_relay_event$/);
  });

  it.each([
    ["prompt text", { type: "prompt", voicePrompt: 7, lang: "en-US", last: true }],
    ["prompt language", { type: "prompt", voicePrompt: "hello", lang: null, last: true }],
    ["prompt finality", { type: "prompt", voicePrompt: "hello", lang: "en-US", last: "true" }],
    ["ill-formed prompt text", { type: "prompt", voicePrompt: "\ud800", lang: "en-US", last: true }],
    ["multiple DTMF digits", { type: "dtmf", digit: "12" }],
    ["unsupported DTMF digit", { type: "dtmf", digit: "A" }],
    ["missing interrupt text", { type: "interrupt", durationUntilInterruptMs: 460 }],
    ["ill-formed interrupt text", { type: "interrupt", utteranceUntilInterrupt: "\ud800", durationUntilInterruptMs: 460 }],
    ["invalid interrupt duration", { type: "interrupt", utteranceUntilInterrupt: "hello", durationUntilInterruptMs: -1 }],
    ["fractional interrupt duration", { type: "interrupt", utteranceUntilInterrupt: "hello", durationUntilInterruptMs: 0.5 }],
    [
      "unsafe interrupt duration",
      { type: "interrupt", utteranceUntilInterrupt: "hello", durationUntilInterruptMs: Number.MAX_SAFE_INTEGER + 1 },
    ],
    ["missing error description", { type: "error" }],
    ["non-string error description", { type: "error", description: { secret: true } }],
    ["ill-formed error description", { type: "error", description: "\ud800" }],
  ])("rejects an invalid current provider shape: %s", (_label, value) => {
    expect(() => parseObject(value)).toThrowError(/^invalid_relay_event$/);
  });

  it.each([
    ["setup plus prompt", { ...officialSetupFixture, voicePrompt: "mixed" }],
    ["prompt plus setup", { type: "prompt", voicePrompt: "hello", lang: "en-US", last: true, callSid: CALL_SID }],
    ["prompt plus DTMF", { type: "prompt", voicePrompt: "hello", lang: "en-US", last: true, digit: "1" }],
    [
      "prompt plus legacy speech identifier",
      { type: "prompt", voicePrompt: "hello", lang: "en-US", last: true, messageId: "legacy-1" },
    ],
    ["DTMF plus error", { type: "dtmf", digit: "1", description: "mixed" }],
    ["DTMF plus legacy digits", { type: "dtmf", digit: "1", digits: "12345678" }],
    [
      "interrupt plus setup",
      {
        type: "interrupt",
        utteranceUntilInterrupt: "hello",
        durationUntilInterruptMs: 460,
        customParameters: { relayNonce: RELAY_NONCE },
      },
    ],
    ["error plus prompt", { type: "error", description: "safe shape", last: true }],
  ])("rejects a mixed known event shape: %s", (_label, value) => {
    expect(() => parseObject(value)).toThrowError(/^invalid_relay_event$/);
  });

  it.each([
    { type: "speech", messageId: "legacy-1", text: "legacy text" },
    { type: "disconnect" },
    { type: "unknown", futureProviderField: true },
  ])("rejects unknown and legacy message type $type", (value) => {
    expect(() => parseObject(value)).toThrowError(/^invalid_relay_event$/);
  });
});

describe("ConversationRelay TwiML", () => {
  const explicitVoiceConfig = {
    language: "en-US",
    transcriptionProvider: "Deepgram",
    speechModel: "nova-3-general",
    ttsProvider: "Google",
    voice: "en-US-Journey-O",
  } as const;

  function validTwiMLInput(overrides: Record<string, unknown> = {}) {
    return {
      publicOrigin: new URL(PUBLIC_ORIGIN),
      sessionUrl: new URL(`wss://jarvis.example/voice/relay/${CALL_SESSION_ID}`),
      actionUrl: new URL("https://jarvis.example/voice/relay-ended"),
      relayNonce: RELAY_NONCE,
      voiceConfig: explicitVoiceConfig,
      ...overrides,
    };
  }

  it("renders an explicit DTMF-enabled relay document only on the trusted fixed routes", () => {
    const xml = renderConversationRelayTwiML(validTwiMLInput());

    expect(xml).toBe(
      '<?xml version="1.0" encoding="UTF-8"?><Response><Connect action="https://jarvis.example/voice/relay-ended" method="POST"><ConversationRelay url="wss://jarvis.example/voice/relay/01k3s6k8000000000000000000" language="en-US" transcriptionProvider="Deepgram" speechModel="nova-3-general" ttsProvider="Google" voice="en-US-Journey-O" dtmfDetection="true" partialPrompts="false" interruptible="any" reportInputDuringAgentSpeech="any"><Parameter name="relayNonce" value="Abcdefghijklmnopqrstuvwxyz0123456789_-ABCDE" /></ConversationRelay></Connect></Response>',
    );
    expect(xml.match(/<Parameter\b/g)).toHaveLength(1);
    expect(xml.match(/name="relayNonce"/g)).toHaveLength(1);
  });

  it("ignores non-allowlisted identity, purpose, PIN, and prompt input", () => {
    const xml = renderConversationRelayTwiML(validTwiMLInput({
      purpose: "private-purpose",
      identity: "private-identity",
      phoneNumber: "+18005550199",
      pin: "88442211",
      prompt: "private-prompt",
    }) as Parameters<typeof renderConversationRelayTwiML>[0] & Record<string, unknown>);

    expect(xml).not.toMatch(/private|18005550199|88442211/);
  });

  it.each([
    ["session HTTP", `https://jarvis.example/voice/relay/${CALL_SESSION_ID}`, "https://jarvis.example/voice/relay-ended"],
    ["session insecure WebSocket", `ws://jarvis.example/voice/relay/${CALL_SESSION_ID}`, "https://jarvis.example/voice/relay-ended"],
    ["session attacker origin", `wss://attacker.invalid/voice/relay/${CALL_SESSION_ID}`, "https://jarvis.example/voice/relay-ended"],
    ["session credentials", `wss://user:pass@jarvis.example/voice/relay/${CALL_SESSION_ID}`, "https://jarvis.example/voice/relay-ended"],
    ["session fragment", `wss://jarvis.example/voice/relay/${CALL_SESSION_ID}#fragment`, "https://jarvis.example/voice/relay-ended"],
    ["session empty fragment", `wss://jarvis.example/voice/relay/${CALL_SESSION_ID}#`, "https://jarvis.example/voice/relay-ended"],
    ["session query", `wss://jarvis.example/voice/relay/${CALL_SESSION_ID}?identity=private`, "https://jarvis.example/voice/relay-ended"],
    ["session empty query", `wss://jarvis.example/voice/relay/${CALL_SESSION_ID}?`, "https://jarvis.example/voice/relay-ended"],
    ["session nondefault port", `wss://jarvis.example:8443/voice/relay/${CALL_SESSION_ID}`, "https://jarvis.example/voice/relay-ended"],
    ["session route mismatch", `wss://jarvis.example/session/${CALL_SESSION_ID}`, "https://jarvis.example/voice/relay-ended"],
    ["session non-opaque identifier", "wss://jarvis.example/voice/relay/private-identity", "https://jarvis.example/voice/relay-ended"],
    ["action HTTP", `wss://jarvis.example/voice/relay/${CALL_SESSION_ID}`, "http://jarvis.example/voice/relay-ended"],
    ["action attacker origin", `wss://jarvis.example/voice/relay/${CALL_SESSION_ID}`, "https://attacker.invalid/voice/relay-ended"],
    ["action credentials", `wss://jarvis.example/voice/relay/${CALL_SESSION_ID}`, "https://user:pass@jarvis.example/voice/relay-ended"],
    ["action fragment", `wss://jarvis.example/voice/relay/${CALL_SESSION_ID}`, "https://jarvis.example/voice/relay-ended#fragment"],
    ["action empty fragment", `wss://jarvis.example/voice/relay/${CALL_SESSION_ID}`, "https://jarvis.example/voice/relay-ended#"],
    ["action query", `wss://jarvis.example/voice/relay/${CALL_SESSION_ID}`, "https://jarvis.example/voice/relay-ended?identity=private"],
    ["action empty query", `wss://jarvis.example/voice/relay/${CALL_SESSION_ID}`, "https://jarvis.example/voice/relay-ended?"],
    ["action nondefault port", `wss://jarvis.example/voice/relay/${CALL_SESSION_ID}`, "https://jarvis.example:8443/voice/relay-ended"],
    ["action route mismatch", `wss://jarvis.example/voice/relay/${CALL_SESSION_ID}`, "https://jarvis.example/voice/status"],
  ])("rejects invalid relay URLs: %s", (_label, sessionUrl, actionUrl) => {
    expect(() =>
      renderConversationRelayTwiML({
        publicOrigin: new URL(PUBLIC_ORIGIN),
        sessionUrl: new URL(sessionUrl),
        actionUrl: new URL(actionUrl),
        relayNonce: RELAY_NONCE,
        voiceConfig: explicitVoiceConfig,
      }),
    ).toThrowError(/^invalid_conversation_relay_twiml$/);
  });

  it("serializes trusted URL internal slots instead of overridable toString methods", () => {
    const xml = renderConversationRelayTwiML(validTwiMLInput({
      sessionUrl: new MisleadingUrl(
        `wss://jarvis.example/voice/relay/${CALL_SESSION_ID}`,
        "wss://attacker.invalid/collect-relay",
      ),
      actionUrl: new MisleadingUrl(
        "https://jarvis.example/voice/relay-ended",
        "https://attacker.invalid/collect-action",
      ),
    }));

    expect(xml).toContain(`url="wss://jarvis.example/voice/relay/${CALL_SESSION_ID}"`);
    expect(xml).toContain('action="https://jarvis.example/voice/relay-ended"');
    expect(xml).not.toContain("attacker.invalid");
  });

  it("snapshots the trusted public origin through URL internal slots", () => {
    expect(() => renderConversationRelayTwiML(validTwiMLInput({
      publicOrigin: new MisleadingUrl("https://attacker.invalid/", PUBLIC_ORIGIN),
    }))).toThrowError(/^invalid_conversation_relay_twiml$/);
  });

  it.each([
    "A".repeat(42),
    "A".repeat(44),
    `${"A".repeat(42)}=`,
    `${"A".repeat(42)}+`,
    `${"A".repeat(42)}B`,
    "é".repeat(43),
  ])(
    "rejects a relay nonce that is not 32-byte unpadded base64url",
    (relayNonce) => {
      expect(() =>
        renderConversationRelayTwiML(validTwiMLInput({ relayNonce })),
      ).toThrowError(/^invalid_conversation_relay_twiml$/);
    },
  );

  it.each([
    ["missing config", undefined],
    ["empty language", { ...explicitVoiceConfig, language: "" }],
    ["non-string model", { ...explicitVoiceConfig, speechModel: 3 }],
    ["XML control character", { ...explicitVoiceConfig, voice: "unsafe\u0000voice" }],
    ["untested language", { ...explicitVoiceConfig, language: "fr-CA" }],
    ["untested transcription provider", { ...explicitVoiceConfig, transcriptionProvider: "Google" }],
    ["untested speech model", { ...explicitVoiceConfig, speechModel: "nova-2-general" }],
    ["untested TTS provider", { ...explicitVoiceConfig, ttsProvider: "Amazon" }],
    ["untested voice", { ...explicitVoiceConfig, voice: "en-US-Journey-F" }],
  ])("requires a complete XML-safe explicit voice config: %s", (_label, voiceConfig) => {
    expect(() =>
      renderConversationRelayTwiML(validTwiMLInput({ voiceConfig }) as Parameters<typeof renderConversationRelayTwiML>[0]),
    ).toThrowError(/^invalid_conversation_relay_twiml$/);
  });
});
