import { describe, expect, it } from "vitest";
import {
  TelegramAlertChannel,
  UnconfiguredAlertChannel,
  fitToMessageLimit,
} from "../src/alert-channel.js";

interface Call {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

function stubFetch(
  handler: (call: Call) => Response | Promise<Response>,
  calls: Call[] = [],
): { fetch: typeof fetch; calls: Call[] } {
  const implementation = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: String(input), init };
    calls.push(call);
    return handler(call);
  }) as unknown as typeof fetch;
  return { fetch: implementation, calls };
}

function acknowledged(): Response {
  return new Response(JSON.stringify({ ok: true, result: { message_id: 7 } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function channel(fetchImplementation: typeof fetch, timeoutMs?: number): TelegramAlertChannel {
  return new TelegramAlertChannel({
    botToken: "1234567890:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    chatId: "-1001234567890",
    fetchImplementation,
    timeoutMs,
  });
}

describe("TelegramAlertChannel", () => {
  it("reports delivery only when Telegram acknowledges the send", async () => {
    const stub = stubFetch(() => acknowledged());
    await expect(channel(stub.fetch).send("DOWN agent")).resolves.toEqual({ delivered: true });
  });

  it("posts the alert text to the bot's sendMessage endpoint", async () => {
    const stub = stubFetch(() => acknowledged());
    await channel(stub.fetch).send("DOWN agent");

    expect(stub.calls).toHaveLength(1);
    const call = stub.calls[0]!;
    expect(call.url).toBe(
      "https://api.telegram.org/bot1234567890:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/sendMessage",
    );
    expect(call.init?.method).toBe("POST");
    expect(JSON.parse(String(call.init?.body))).toEqual({
      chat_id: "-1001234567890",
      text: "DOWN agent",
    });
  });

  it("does not report delivery for a 200 that Telegram did not acknowledge", async () => {
    // Telegram answers 200 with ok:false for errors it blames on the caller.
    // Treating that as sent would record an alert nobody received, and the
    // record is what stops the next cycle sending it again.
    const stub = stubFetch(() => new Response(JSON.stringify({ ok: false, description: "chat not found" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    await expect(channel(stub.fetch).send("DOWN agent")).resolves.toEqual({
      delivered: false,
      reason: "not_acknowledged",
    });
  });

  it("does not report delivery for an HTTP failure, and names the status", async () => {
    const stub = stubFetch(() => new Response("nope", { status: 429 }));
    await expect(channel(stub.fetch).send("DOWN agent")).resolves.toEqual({
      delivered: false,
      reason: "http_429",
    });
  });

  it("does not report delivery for a response body it cannot read", async () => {
    const stub = stubFetch(() => new Response("<html>gateway error</html>", { status: 200 }));
    await expect(channel(stub.fetch).send("DOWN agent")).resolves.toEqual({
      delivered: false,
      reason: "unreadable_response",
    });
  });

  it("returns a failure rather than throwing when the transport itself fails", async () => {
    // Nothing in this class may throw. A caller that must not record an alert
    // it did not send must not be able to forget a catch.
    const stub = stubFetch(() => {
      throw new TypeError("network unreachable");
    });
    await expect(channel(stub.fetch).send("DOWN agent")).resolves.toEqual({
      delivered: false,
      reason: "transport:TypeError",
    });
  });

  it("abandons a hung send rather than holding the scheduled invocation open", async () => {
    const stub = stubFetch((call) => new Promise<Response>((_resolve, reject) => {
      call.init?.signal?.addEventListener("abort", () => {
        const aborted = new Error("aborted");
        aborted.name = "AbortError";
        reject(aborted);
      });
    }));

    await expect(channel(stub.fetch, 5).send("DOWN agent")).resolves.toEqual({
      delivered: false,
      reason: "transport:timeout",
    });
  });

  it("refuses to send an empty message rather than posting one", async () => {
    const stub = stubFetch(() => acknowledged());
    await expect(channel(stub.fetch).send("")).resolves.toEqual({
      delivered: false,
      reason: "empty_message",
    });
    expect(stub.calls).toEqual([]);
  });

  it("throws Illegal invocation when fetch is called with the wrong this, which is what the constructor's bind avoids", () => {
    // The reason for globalThis.fetch.bind(globalThis) in the constructor,
    // pinned as a runtime fact rather than left as a comment. An unbound fetch
    // stored as a class field is called with the instance as `this` and fails
    // only here, in Workers -- it passes every test written under Node.
    //
    // It throws synchronously, before any request is attempted, so this makes
    // no network access; example.invalid appears only in the argument list.
    //
    // What this does not establish is the other half -- that the bound form
    // works -- because establishing that means making a real request, and a
    // test suite that reaches the network to prove a binding detail is worse
    // than one that states the limit.
    const holder: { fetch: typeof fetch } = { fetch: globalThis.fetch };
    expect(() => holder.fetch("https://example.invalid/")).toThrow(/Illegal invocation/u);
  });
});

describe("fitToMessageLimit", () => {
  it("leaves a message Telegram will accept exactly as it is", () => {
    expect(fitToMessageLimit("DOWN agent")).toBe("DOWN agent");
  });

  it("trims an oversized message to the limit and says that it did", () => {
    // Silently dropping the tail would be the same class of failure this
    // Worker exists to prevent: what arrives looks complete, and whatever fell
    // off the end looks fine.
    const trimmed = fitToMessageLimit("x".repeat(5000));
    expect(trimmed).toHaveLength(4096);
    expect(trimmed.endsWith("\n[truncated]")).toBe(true);
  });

  it("leaves a message of exactly the limit untouched", () => {
    const exact = "x".repeat(4096);
    expect(fitToMessageLimit(exact)).toBe(exact);
  });
});

describe("UnconfiguredAlertChannel", () => {
  it("reports every send as undelivered rather than pretending to succeed", async () => {
    await expect(new UnconfiguredAlertChannel().send()).resolves.toEqual({
      delivered: false,
      reason: "alert_channel_not_configured",
    });
  });

  it("declares itself unconfigured, so health cannot answer ok through it", () => {
    expect(new UnconfiguredAlertChannel().configured).toBe(false);
    expect(new TelegramAlertChannel({ botToken: "t", chatId: "c" }).configured).toBe(true);
  });
});
