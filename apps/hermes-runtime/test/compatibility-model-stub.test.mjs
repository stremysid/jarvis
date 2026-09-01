import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const stubPath = fileURLToPath(
  new URL("../launchers/openai_compatibility_stub.py", import.meta.url),
);
const contractPath = fileURLToPath(
  new URL("../contracts/openai-compatibility-stub-v1.json", import.meta.url),
);
const stubSource = readFileSync(stubPath, "utf8");
const contract = JSON.parse(readFileSync(contractPath, "utf8"));

const python = process.env.JARVIS_STUB_PYTHON ?? "python";
const token = contract.authorization.fixedPublicValue;
const authHeaders = { authorization: `${contract.authorization.scheme} ${token}` };

let child;
let origin;

beforeAll(async () => {
  // Port 0 lets the OS assign a free port so the suite never collides with a
  // real stub on the fixed contract port. The default-port contract is
  // asserted separately, statically, below.
  child = spawn(python, [stubPath, "--port", "0", "--print-port"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });

  const reader = createInterface({ input: child.stdout });
  const port = await Promise.race([
    once(reader, "line").then(([line]) => Number.parseInt(line.trim(), 10)),
    once(child, "exit").then(() => {
      throw new Error(`stub exited before listening:\n${stderr}`);
    }),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`stub did not listen in time:\n${stderr}`)), 15000),
    ),
  ]);
  reader.close();
  expect(Number.isInteger(port) && port > 0).toBe(true);
  origin = `http://${contract.bind.host}:${port}`;
}, 30000);

afterAll(async () => {
  if (child && child.exitCode === null) {
    child.kill();
    await once(child, "exit").catch(() => {});
  }
});

async function post(body, { headers = {}, raw = false } = {}) {
  return fetch(`${origin}${contract.request.route}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders, ...headers },
    body: raw ? body : JSON.stringify(body),
  });
}

function validRequest(overrides = {}) {
  return {
    model: contract.request.fields.model.const,
    messages: [{ role: "user", content: "hello" }],
    stream: false,
    ...overrides,
  };
}

async function expectContractError(response, key) {
  const spec = contract.errors[key];
  expect(response.status).toBe(spec.status);
  expect(response.headers.get("content-type")).toBe(spec.contentType);
  expect(await response.text()).toBe(spec.utf8);
}

describe("readiness route", () => {
  it("returns the exact frozen readiness bytes", async () => {
    const response = await fetch(`${origin}${contract.readiness.route}`, { headers: authHeaders });
    expect(response.status).toBe(contract.readiness.status);
    expect(response.headers.get("content-type")).toBe(contract.readiness.contentType);
    expect(await response.text()).toBe(contract.readiness.utf8);
  });

  it("requires the bearer token", async () => {
    const response = await fetch(`${origin}${contract.readiness.route}`);
    await expectContractError(response, "unauthorized");
  });

  it("rejects a token that differs by one byte", async () => {
    const wrong = `${contract.authorization.scheme} ${token.slice(0, -1)}X`;
    const response = await fetch(`${origin}${contract.readiness.route}`, {
      headers: { authorization: wrong },
    });
    await expectContractError(response, "unauthorized");
  });

  it("rejects POST on the readiness route", async () => {
    const response = await fetch(`${origin}${contract.readiness.route}`, {
      method: "POST",
      headers: authHeaders,
    });
    await expectContractError(response, "method_not_allowed");
  });
});

describe("chat completions", () => {
  it("returns the exact frozen non-streaming body", async () => {
    const response = await post(validRequest());
    expect(response.status).toBe(contract.responses.nonstreaming.status);
    expect(response.headers.get("content-type")).toBe(contract.responses.nonstreaming.contentType);
    expect(await response.text()).toBe(contract.responses.nonstreaming.utf8);
  });

  it("returns the exact frozen streaming body, terminated by [DONE]", async () => {
    const response = await post(validRequest({ stream: true }));
    expect(response.status).toBe(contract.responses.streaming.status);
    expect(response.headers.get("content-type")).toBe(contract.responses.streaming.contentType);
    const text = await response.text();
    expect(text).toBe(contract.responses.streaming.utf8);
    expect(text.endsWith(contract.semantics.streamTerminal)).toBe(true);
    expect(text.split("\n\n").filter((f) => f.length > 0)).toHaveLength(
      contract.semantics.streamFrames,
    );
  });

  it("is deterministic: request values do not affect output", async () => {
    const first = await (await post(validRequest({ messages: [{ role: "user", content: "a" }] }))).text();
    const second = await (
      await post(
        validRequest({
          messages: [
            { role: "system", content: "wildly different" },
            { role: "user", content: "second turn" },
          ],
          temperature: 1.5,
          top_p: 0.4,
          max_tokens: 4096,
          reasoning_effort: "max",
        }),
      )
    ).text();
    expect(first).toBe(second);
    expect(first).toBe(contract.responses.nonstreaming.utf8);
  });

  it("requires the bearer token", async () => {
    const response = await fetch(`${origin}${contract.request.route}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validRequest()),
    });
    await expectContractError(response, "unauthorized");
  });

  it("rejects a non-JSON media type", async () => {
    const response = await post(validRequest(), { headers: { "content-type": "text/plain" } });
    await expectContractError(response, "unsupported_media_type");
  });

  it("rejects malformed JSON", async () => {
    const response = await post("{not json", { raw: true });
    await expectContractError(response, "invalid_json");
  });

  it("rejects a body over the size limit", async () => {
    const oversized = "x".repeat(contract.limits.maxBodyBytes + 1);
    const response = await post(oversized, { raw: true });
    await expectContractError(response, "payload_too_large");
  });

  it("rejects an unknown route", async () => {
    const response = await fetch(`${origin}/v1/models`, { headers: authHeaders });
    await expectContractError(response, "not_found");
  });
});

describe("request validation (values validated, then discarded)", () => {
  const cases = {
    "wrong model": validRequest({ model: "gpt-4" }),
    "unknown top-level field": { ...validRequest(), nickname: "jarvis" },
    "missing required stream": (() => {
      const body = validRequest();
      delete body.stream;
      return body;
    })(),
    "stream as string": validRequest({ stream: "true" }),
    "empty message list": validRequest({ messages: [] }),
    "too many messages": validRequest({
      messages: Array.from({ length: contract.limits.maxMessages + 1 }, () => ({
        role: "user",
        content: "x",
      })),
    }),
    "empty message content": validRequest({ messages: [{ role: "user", content: "" }] }),
    "unknown role": validRequest({ messages: [{ role: "tool", content: "x" }] }),
    "extra key inside a message": validRequest({
      messages: [{ role: "user", content: "x", name: "n" }],
    }),
    "temperature above maximum": validRequest({ temperature: 2.5 }),
    "top_p of zero (exclusive minimum)": validRequest({ top_p: 0 }),
    "max_tokens of zero": validRequest({ max_tokens: 0 }),
    "unknown reasoning_effort": validRequest({ reasoning_effort: "extreme" }),
    "stream_options.include_usage false": validRequest({
      stream: true,
      stream_options: { include_usage: false },
    }),
  };

  for (const [name, body] of Object.entries(cases)) {
    it(`rejects ${name}`, async () => {
      await expectContractError(await post(body), "invalid_request");
    });
  }

  it("rejects a message over the per-message byte limit", async () => {
    const body = validRequest({
      messages: [{ role: "user", content: "x".repeat(contract.limits.maxMessageContentBytes + 1) }],
    });
    await expectContractError(await post(body), "invalid_request");
  });

  it("accepts every allowed role", async () => {
    const roles = contract.request.fields.messages.items.properties.role.enum;
    const body = validRequest({ messages: roles.map((role) => ({ role, content: "x" })) });
    expect((await post(body)).status).toBe(contract.responses.nonstreaming.status);
  });
});

describe("static policy", () => {
  it("binds the contract loopback host and port by default", () => {
    expect(contract.bind.host).toBe("127.0.0.1");
    expect(stubSource).toContain("compatibility stub may bind loopback only");
    // The default comes from the contract, not a literal in the source.
    expect(stubSource).toContain("policy.port if port is None else port");
  });

  it("opens no outbound sockets and resolves no names", () => {
    for (const forbidden of [
      "socket.create_connection",
      "urllib.request",
      "http.client",
      "requests.",
      "getaddrinfo",
      "gethostbyname",
    ]) {
      expect(stubSource).not.toContain(forbidden);
    }
  });

  it("performs no filesystem writes and no shell execution", () => {
    for (const forbidden of [
      "subprocess",
      "os.system",
      "eval(",
      "exec(",
      "shutil",
      "tempfile",
      'open("w"',
      '"w")',
    ]) {
      expect(stubSource).not.toContain(forbidden);
    }
    expect(contract.state.filesystemWrites).toEqual([]);
    expect(contract.state.mutable).toBe(false);
  });

  it("compares the bearer token in constant time", () => {
    expect(stubSource).toContain("hmac.compare_digest");
    expect(contract.authorization.comparison).toBe("constant-time-exact-ascii");
  });

  it("does not log request content", () => {
    expect(stubSource).toContain("def log_message");
  });
});
