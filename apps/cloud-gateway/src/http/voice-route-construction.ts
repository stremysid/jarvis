import type { TwilioRequestVerifier } from "../providers/provider-types.js";
import { snapshotTrustedPublicOrigin } from "../security/trusted-public-origin.js";
import {
  handleInboundVoiceWebhook,
  type InboundVoiceDependencies,
} from "../voice/inbound.js";
import {
  claimOutboundTwiML,
  type OutboundTwiMLDependencies,
} from "../voice/outbound.js";
import {
  handleTwilioRelayEndedCallback,
  handleTwilioStatusCallback,
  type TwilioCallbackRecorder,
} from "./voice-callbacks.js";
import type { VoiceRouteDependencies } from "./voice-routes.js";

export type InboundVoiceRoutePorts = Omit<
  InboundVoiceDependencies,
  "twilio" | "exactInboundWebhookUrl" | "publicOrigin"
>;
export type OutboundVoiceRoutePorts = Omit<OutboundTwiMLDependencies, "twilio" | "publicOrigin">;

export interface VoiceRouteConstruction {
  publicOrigin: URL;
  twilio: TwilioRequestVerifier;
  inbound?: InboundVoiceRoutePorts;
  outbound?: OutboundVoiceRoutePorts;
  callbacks?: TwilioCallbackRecorder;
  relaySession?: VoiceRouteDependencies["relaySession"];
}

function ownData(value: unknown, name: string): unknown {
  if (value === null || typeof value !== "object") return undefined;
  let descriptor: PropertyDescriptor | undefined;
  try { descriptor = Object.getOwnPropertyDescriptor(value, name); }
  catch { return undefined; }
  return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
}

function notImplemented(): Promise<Response> {
  return Promise.resolve(new Response("Not implemented", { status: 501 }));
}

/** Builds route adapters without activating dependencies that have not been supplied. */
export function createVoiceRouteDependencies(input: VoiceRouteConstruction): VoiceRouteDependencies {
  const publicOrigin = ownData(input, "publicOrigin") as URL;
  const twilio = ownData(input, "twilio") as TwilioRequestVerifier;
  const trustedOrigin = snapshotTrustedPublicOrigin(publicOrigin);
  const inboundPorts = ownData(input, "inbound") as InboundVoiceRoutePorts | undefined;
  const outboundPorts = ownData(input, "outbound") as OutboundVoiceRoutePorts | undefined;
  const callbacks = ownData(input, "callbacks") as TwilioCallbackRecorder | undefined;
  const relay = ownData(input, "relaySession");
  const inboundDependencies: InboundVoiceDependencies | null = inboundPorts === undefined
    ? null
    : Object.freeze({
      twilio,
      exactInboundWebhookUrl: trustedOrigin === null ? "" : `${trustedOrigin.origin}/voice/inbound`,
      publicOrigin,
      expectedInboundE164: ownData(inboundPorts, "expectedInboundE164") as string,
      currentChallengeHmacKeyVersion: ownData(inboundPorts, "currentChallengeHmacKeyVersion") as string,
      sessions: ownData(inboundPorts, "sessions") as InboundVoiceDependencies["sessions"],
      initializeSession: ownData(inboundPorts, "initializeSession") as InboundVoiceDependencies["initializeSession"],
      now: (ownData(inboundPorts, "now") ?? (() => new Date())) as () => Date,
    });
  const outboundDependencies: OutboundTwiMLDependencies | null = outboundPorts === undefined
    ? null
    : Object.freeze({
      twilio,
      publicOrigin,
      recipients: ownData(outboundPorts, "recipients") as OutboundTwiMLDependencies["recipients"],
      calls: ownData(outboundPorts, "calls") as OutboundTwiMLDependencies["calls"],
      initializeSession: ownData(outboundPorts, "initializeSession") as OutboundTwiMLDependencies["initializeSession"],
      now: (ownData(outboundPorts, "now") ?? (() => new Date())) as () => Date,
    });

  const inbound: VoiceRouteDependencies["inbound"] = inboundDependencies === null
    ? notImplemented
    : (request) => handleInboundVoiceWebhook(request, inboundDependencies);

  const outbound: VoiceRouteDependencies["outbound"] = outboundDependencies === null
    ? notImplemented
    : (request, attemptId) => claimOutboundTwiML(request, attemptId, outboundDependencies);

  const status: VoiceRouteDependencies["status"] = callbacks === undefined
    ? notImplemented
    : (attemptId, form) => handleTwilioStatusCallback(attemptId, form, callbacks);
  const relayEnded: VoiceRouteDependencies["relayEnded"] = callbacks === undefined
    ? notImplemented
    : (form) => handleTwilioRelayEndedCallback(form, callbacks);
  const relaySession: VoiceRouteDependencies["relaySession"] = typeof relay === "function"
    ? (request, sessionId) => relay.call(input, request, sessionId) as Promise<Response>
    : notImplemented;

  return Object.freeze({ publicOrigin, twilio, inbound, outbound, status, relayEnded, relaySession });
}
