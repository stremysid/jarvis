import { describe, expect, it, vi } from "vitest";
import { canonicalJson, sha256Hex, type Ulid } from "../../../../packages/contracts/src/index.js";
import {
  handleTwilioRelayEndedCallback,
  handleTwilioStatusCallback,
  type TwilioCallbackRecord,
  type TwilioCallbackRecorder,
} from "../../src/http/voice-callbacks.js";
import { FakeTwilioProvider } from "../../src/providers/fake-twilio-provider.js";
import type { VerifiedTwilioForm } from "../../src/providers/twilio-verifier.js";

const ATTEMPT_ID = "01k3s6k8000000000000000001" as Ulid;
const CALL_SID = `CA${"1".repeat(32)}`;
const SESSION_ID = `VX${"2".repeat(32)}`;
type Pair = readonly [string, string];

async function verifiedForm(exactUrl: string, pairs: readonly Pair[]): Promise<VerifiedTwilioForm> {
  const rawBody = new TextEncoder().encode(
    pairs.map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`).join("&"),
  );
  const fake = new FakeTwilioProvider();
  const request = new Request("https://worker.internal/callback", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-twilio-signature": await fake.signWebhook(exactUrl, rawBody),
    },
    body: rawBody,
  });
  const form = await fake.verifyWebhook({ request, exactUrl });
  if (form === null) throw new Error("fixture_signature_failed");
  return form;
}

async function exactResponse(response: Response) {
  return {
    status: response.status,
    cacheControl: response.headers.get("cache-control"),
    body: await response.text(),
  };
}

describe("Twilio callback handlers", () => {
  it("accepts Twilio's valid initiated callback status", async () => {
    const records: TwilioCallbackRecord[] = [];
    const response = await handleTwilioStatusCallback(
      ATTEMPT_ID,
      await verifiedForm(`https://jarvis.example/voice/status/${ATTEMPT_ID}`, [
        ["CallSid", CALL_SID],
        ["CallbackSource", "call-progress-events"],
        ["SequenceNumber", "0"],
        ["CallStatus", "initiated"],
      ]),
      { record: async (input) => { records.push(input); } },
    );

    expect(response.status).toBe(204);
    expect(records).toEqual([expect.objectContaining({ callStatus: "initiated" })]);
  });

  it("records one frozen allowlisted status fact set from a genuine verified form", async () => {
    const pairs: Pair[] = [
      ["SequenceNumber", "2"],
      ["CallStatus", "completed"],
      ["CallSid", CALL_SID],
      ["CallbackSource", "call-progress-events"],
      ["ErrorMessage", "private provider detail"],
      ["To", "+14165550123"],
    ];
    const records: TwilioCallbackRecord[] = [];
    const record = vi.fn(async (input: TwilioCallbackRecord) => { records.push(input); });
    const recorder: TwilioCallbackRecorder = { record };

    const response = await handleTwilioStatusCallback(
      ATTEMPT_ID,
      await verifiedForm(`https://jarvis.example/voice/status/${ATTEMPT_ID}`, pairs),
      recorder,
    );

    const sortedPairs = [...pairs].sort(([leftName, leftValue], [rightName, rightValue]) => (
      leftName < rightName ? -1 : leftName > rightName ? 1 : leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0
    ));
    expect(records).toEqual([{
      endpointKind: "status",
      attemptId: ATTEMPT_ID,
      callSid: CALL_SID,
      callbackSource: "call-progress-events",
      sequenceNumber: 2,
      callStatus: "completed",
      requestHash: await sha256Hex(canonicalJson(sortedPairs)),
    }]);
    expect(Object.isFrozen(records[0])).toBe(true);
    expect(JSON.stringify(records[0])).not.toContain("private provider detail");
    expect(JSON.stringify(records[0])).not.toContain("+14165550123");
    expect(record).toHaveBeenCalledTimes(1);
    await expect(exactResponse(response)).resolves.toEqual({ status: 204, cacheControl: "no-store", body: "" });
  });

  it.each(["CallSid", "CallbackSource", "SequenceNumber", "CallStatus"])(
    "rejects duplicate %s values before recorder access",
    async (duplicateName) => {
      const fields: Pair[] = [
        ["CallSid", CALL_SID],
        ["CallbackSource", "call-progress-events"],
        ["SequenceNumber", "2"],
        ["CallStatus", "completed"],
      ];
      const duplicate = fields.find(([name]) => name === duplicateName);
      if (duplicate === undefined) throw new Error("fixture_duplicate_missing");
      fields.push(duplicate);
      const record = vi.fn(async () => undefined);

      const response = await handleTwilioStatusCallback(
        ATTEMPT_ID,
        await verifiedForm(`https://jarvis.example/voice/status/${ATTEMPT_ID}`, fields),
        { record },
      );

      expect(record).not.toHaveBeenCalled();
      await expect(exactResponse(response)).resolves.toEqual({ status: 403, cacheControl: "no-store", body: "forbidden" });
    },
  );

  it("maps recorder failures to a neutral response without provider or persistence detail", async () => {
    const form = await verifiedForm(`https://jarvis.example/voice/status/${ATTEMPT_ID}`, [
      ["CallSid", CALL_SID],
      ["CallbackSource", "call-progress-events"],
      ["SequenceNumber", "0"],
      ["CallStatus", "ringing"],
    ]);

    const response = await handleTwilioStatusCallback(ATTEMPT_ID, form, {
      record: async () => { throw new Error("secret database/provider detail"); },
    });

    const observed = await exactResponse(response);
    expect(observed).toEqual({ status: 503, cacheControl: "no-store", body: "unavailable" });
    expect(JSON.stringify(observed)).not.toContain("secret");
  });

  it("records only allowlisted relay-ended lifecycle facts", async () => {
    const pairs: Pair[] = [
      ["CallSid", CALL_SID],
      ["SessionId", SESSION_ID],
      ["SessionStatus", "completed"],
      ["SessionDuration", "17"],
      ["ErrorMessage", "private relay failure"],
      ["HandoffData", "private handoff payload"],
    ];
    const records: TwilioCallbackRecord[] = [];
    const response = await handleTwilioRelayEndedCallback(
      await verifiedForm("https://jarvis.example/voice/relay-ended", pairs),
      { record: async (input) => { records.push(input); } },
    );

    const sortedPairs = [...pairs].sort(([leftName, leftValue], [rightName, rightValue]) => (
      leftName < rightName ? -1 : leftName > rightName ? 1 : leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0
    ));
    expect(records).toEqual([{
      endpointKind: "relay_ended",
      callSid: CALL_SID,
      sessionId: SESSION_ID,
      sessionStatus: "completed",
      sessionDurationSeconds: 17,
      requestHash: await sha256Hex(canonicalJson(sortedPairs)),
    }]);
    expect(Object.isFrozen(records[0])).toBe(true);
    expect(JSON.stringify(records[0])).not.toContain("private");
    await expect(exactResponse(response)).resolves.toEqual({ status: 204, cacheControl: "no-store", body: "" });
  });

  it("captures callback persistence authority before the hash await", async () => {
    const form = await verifiedForm(`https://jarvis.example/voice/status/${ATTEMPT_ID}`, [
      ["CallSid", CALL_SID],
      ["CallbackSource", "call-progress-events"],
      ["SequenceNumber", "3"],
      ["CallStatus", "completed"],
    ]);
    const firstRecord = vi.fn(async () => undefined);
    const replacedRecord = vi.fn(async () => { throw new Error("mutated persistence authority"); });
    const recorder: TwilioCallbackRecorder = { record: firstRecord };

    const pending = handleTwilioStatusCallback(ATTEMPT_ID, form, recorder);
    recorder.record = replacedRecord;

    const response = await pending;
    expect(response.status).toBe(204);
    expect(firstRecord).toHaveBeenCalledTimes(1);
    expect(replacedRecord).not.toHaveBeenCalled();
  });

  it("rejects invalid signed semantics before reading persistence authority", async () => {
    const form = await verifiedForm(`https://jarvis.example/voice/status/${ATTEMPT_ID}`, [
      ["CallSid", CALL_SID],
      ["CallSid", CALL_SID],
      ["CallbackSource", "call-progress-events"],
      ["SequenceNumber", "0"],
      ["CallStatus", "ringing"],
    ]);
    let recorderReads = 0;
    const recorder = new Proxy({ record: async () => undefined }, {
      getOwnPropertyDescriptor: (target, property) => {
        recorderReads += 1;
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
    });

    const response = await handleTwilioStatusCallback(ATTEMPT_ID, form, recorder);

    expect(response.status).toBe(403);
    expect(recorderReads).toBe(0);
  });
});
