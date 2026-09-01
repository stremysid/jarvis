import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";
import { canonicalize, sha256Hex } from "../src/canonical-json.mjs";

const file = (path) => new URL(`../${path}`, import.meta.url);
const EMPTY_TOOLS_HASH = "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945";
const PROVIDERS = "actual,ai-gateway,alibaba,alibaba-coding-plan,anthropic,arcee,azure-foundry,bedrock,commandcode,copilot,copilot-acp,custom,deepinfra,deepseek,fireworks,gemini,gmi,huggingface,kilocode,kimi-coding,kimi-coding-cn,lmstudio,meta-ai,minimax,minimax-cn,minimax-oauth,nous,novita,nvidia,ollama-cloud,openai-api,openai-codex,opencode-free,opencode-go,opencode-zen,openrouter,qwen-oauth,stepfun,tencent-tokenhub,upstage,vertex,xai,xai-oauth,xiaomi,zai".split(",");

async function json(path) { return JSON.parse(await readFile(file(path), "utf8")); }
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

function createManagedHarness(config, contract) {
  const activity = { catalogRequests: 0, outboundSockets: 0, writes: 0 };
  function assertClosedState() {
    if (config.model_catalog.enabled !== false || config.models_dev.url !== "jarvis-disabled://models-dev") throw new Error("catalog_state_invalid");
    if (Object.values(config.provider_overrides).some(Boolean) || config.plugins.environmentDiscovery || config.plugins.projectDiscovery || config.plugins.userDiscovery) throw new Error("override_state_invalid");
  }
  return {
    activity,
    turn(request) {
      assertClosedState();
      if (request.authorization !== `Bearer ${contract.authorization.fixedPublicValue}`) return contract.errors.unauthorized;
      if (request.contentType !== contract.contentTypes.request) return contract.errors.unsupported_media_type;
      if (request.body.model !== "deepseek-v4-pro" || typeof request.body.stream !== "boolean") return contract.errors.invalid_request;
      if (!Array.isArray(request.body.messages) || request.body.messages.length < 1 || request.body.messages.length > contract.limits.maxMessages) return contract.errors.invalid_request;
      for (const message of request.body.messages) {
        if (Object.keys(message).sort().join(",") !== "content,role" || !contract.request.fields.messages.items.properties.role.enum.includes(message.role) || typeof message.content !== "string") return contract.errors.invalid_request;
      }
      return request.body.stream ? contract.responses.streaming : contract.responses.nonstreaming;
    },
    forceRefresh() {
      assertClosedState();
      if (!config.catalog_policy || config.catalog_policy.refresh !== "deny") throw new Error("catalog_refresh_state_invalid");
      throw new Error("catalog_refresh_disabled");
    },
  };
}

describe("jarvis-voice-safe profile lock", () => {
  it("defines one closed zero-tool profile and binds its complete provider inventory", async () => {
    const lock = await json("hermes-profile-lock.json");
    const schema = await json("schemas/hermes-profile-lock-v1.schema.json");
    const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
    expect(validate(lock), JSON.stringify(validate.errors)).toBe(true);
    expect(lock.profiles).toHaveLength(1);
    const profile = lock.profiles[0];
    expect(profile).toMatchObject({
      id: "jarvis-voice-safe", serviceId: "JarvisHermesVoiceSafe", process: "hermes",
      endpoint: "http://127.0.0.1:8791/v1/runs", listener: { host: "127.0.0.1", port: 8791 },
      selectedProvider: "deepseek", selectedModel: "deepseek-v4-pro",
      generalPlugins: [], effectiveTools: [], effectiveToolsHash: EMPTY_TOOLS_HASH,
      mcpServers: [], messagingGateways: [],
      memory: { memoryEnabled: false, userProfileEnabled: false },
      backgroundReviewEnabled: false,
      compression: { enabled: false, checkpointRequired: true, activeCheckpointProvider: null },
    });
    expect(profile.providerInventory).toEqual(PROVIDERS);
    expect(profile.providerInventoryHash).toBe(await sha256Hex(PROVIDERS));
    expect(profile.providerOverrides).toEqual({ environment: false, project: false, user: false, loadPaths: [] });
    expect(Object.keys(profile.runtimeModes).sort()).toEqual(["live", "pinned_runtime"]);
  });

  it("binds distinct live and compatibility configs to the only two accepted modes", async () => {
    const lock = await json("hermes-profile-lock.json");
    const live = await json("profiles/jarvis-voice-safe/config.yaml");
    const compatibility = await json("profiles/jarvis-voice-safe/config.compatibility.yaml");
    const contract = await json("contracts/openai-compatibility-stub-v1.json");
    const profile = lock.profiles[0];
    const liveEnvelope = {
      baseUrl: null,
      compatibilityContractHash: null,
      credentialMode: "protected-environment",
      managedConfigHash: await sha256Hex(live),
      model: "deepseek-v4-pro",
      provider: "deepseek",
    };
    const compatibilityEnvelope = {
      baseUrl: "http://127.0.0.1:8792/v1",
      compatibilityContractHash: await sha256Hex(contract),
      credentialMode: "nonsecret-test-token",
      managedConfigHash: await sha256Hex(compatibility),
      model: "deepseek-v4-pro",
      provider: "deepseek",
    };
    expect(profile.runtimeModes.live.configurationEnvelope).toEqual(liveEnvelope);
    expect(profile.runtimeModes.pinned_runtime.configurationEnvelope).toEqual(compatibilityEnvelope);
    expect(profile.runtimeModes.live.configurationHash).toBe(await sha256Hex(liveEnvelope));
    expect(profile.runtimeModes.pinned_runtime.configurationHash).toBe(await sha256Hex(compatibilityEnvelope));
    expect(profile.runtimeModes.live.configurationHash).not.toBe(profile.runtimeModes.pinned_runtime.configurationHash);
    expect(profile.runtimeModes.live).toMatchObject({ provider: "deepseek", model: "deepseek-v4-pro", baseUrl: null, credentialMode: "protected-environment", stubProcessRequired: false });
    expect(profile.runtimeModes.pinned_runtime).toMatchObject({ provider: "deepseek", model: "deepseek-v4-pro", baseUrl: "http://127.0.0.1:8792/v1", credentialMode: "nonsecret-test-token", stubProcessRequired: true });
    expect(live.model).not.toHaveProperty("base_url");
    expect(compatibility.model.base_url).toBe("http://127.0.0.1:8792/v1");
    for (const config of [live, compatibility]) {
      expect(config).toMatchObject({
        environment: { HERMES_MANAGED: "jarvis", HERMES_SAFE_MODE: "1" },
        plugins: { enabled: [], projectDiscovery: false, userDiscovery: false },
        platform_toolsets: { api_server: ["no_mcp"] }, mcp_servers: {}, max_concurrent_sessions: 1,
        memory: { memory_enabled: false, user_profile_enabled: false },
        compression: { enabled: false, checkpoint_required: true },
        model_catalog: { enabled: false }, models_dev: { url: "jarvis-disabled://models-dev" },
        catalog_policy: { network: "deny", refresh: "deny", background_refresh: false, etag: "deny", alternate_cache: "deny" },
      });
      expect(config.model_overrides).toEqual({ deepseek: { "deepseek-v4-pro": { context_tokens: 1_000_000, max_output_tokens: 393_216, reasoning: true, tools: false, vision: false } } });
      expect(config.auxiliary.background_review.enabled).toBe(false);
      expect(config.messaging_gateways).toEqual([]);
    }
  });

  it("rejects every live/pinned-runtime cross-mode substitution in the profile schema", async () => {
    const lock = await json("hermes-profile-lock.json");
    const validate = new Ajv2020({ allErrors: true, strict: true }).compile(await json("schemas/hermes-profile-lock-v1.schema.json"));
    const mutations = [
      ["live", "baseUrl", "http://127.0.0.1:8792/v1"],
      ["live", "credentialMode", "nonsecret-test-token"],
      ["live", "configurationFile", "profiles/jarvis-voice-safe/config.compatibility.yaml"],
      ["live", "stubProcessRequired", true],
      ["pinned_runtime", "baseUrl", null],
      ["pinned_runtime", "credentialMode", "protected-environment"],
      ["pinned_runtime", "configurationFile", "profiles/jarvis-voice-safe/config.yaml"],
      ["pinned_runtime", "stubProcessRequired", false],
    ];
    for (const [mode, key, value] of mutations) {
      const drift = structuredClone(lock);
      drift.profiles[0].runtimeModes[mode][key] = value;
      expect(validate(drift), `${mode}.${key} accepted cross-mode drift`).toBe(false);
    }
  });

  it("freezes the deterministic compatibility contract and both deny snapshots", async () => {
    const lock = await json("hermes-profile-lock.json");
    const contract = await json("contracts/openai-compatibility-stub-v1.json");
    expect(lock.compatibilityStub).toMatchObject({ bind: "127.0.0.1:8792", baseUrl: "http://127.0.0.1:8792/v1", readinessRoute: "/private/readiness", outboundNetwork: false });
    expect(lock.compatibilityStub.contractHash).toBe(await sha256Hex(contract));
    expect(lock.compatibilityStub.sourceInstallPath).toBe("launchers/openai_compatibility_stub.py");
    expect(contract).toMatchObject({
      baseUrl: "http://127.0.0.1:8792/v1",
      authorization: { header: "authorization", scheme: "Bearer", fixedPublicValue: "jarvis-h1-public-compatibility-v1", comparison: "constant-time-exact-ascii", requiredFor: ["readiness", "chat-completions"] },
      contentTypes: { request: "application/json", response: "application/json; charset=utf-8", streaming: "text/event-stream; charset=utf-8" },
      limits: { maxBodyBytes: 65_536, maxConcurrentRequests: 1, maxMessages: 64, maxMessageContentBytes: 16_384, maxTotalContentBytes: 65_536, maxOutputBytes: 65_536, requestTimeoutMs: 5_000 },
      network: { dnsAllowed: false, outboundSocketsAllowed: false },
      state: { mutable: false, filesystemReads: [], filesystemWrites: [] },
    });
    expect(contract.request).toEqual({
      additionalProperties: false,
      fields: {
        max_tokens: { maximum: 393_216, minimum: 1, semantics: "validated-then-ignored", type: "integer" },
        messages: { items: { additionalProperties: false, properties: { content: { maxUtf8Bytes: 16_384, minUtf8Bytes: 1, normalization: "NFC", type: "string" }, role: { enum: ["system", "user", "assistant"] } }, required: ["role", "content"], type: "object" }, maxItems: 64, minItems: 1, type: "array" },
        model: { const: "deepseek-v4-pro" },
        reasoning_effort: { enum: ["none", "low", "high", "max"], semantics: "validated-then-ignored" },
        stream: { type: "boolean" },
        stream_options: { additionalProperties: false, properties: { include_usage: { const: true } }, required: ["include_usage"], semantics: "validated-then-ignored", type: "object" },
        temperature: { maximum: 2, minimum: 0, semantics: "validated-then-ignored", type: "number" },
        top_p: { exclusiveMinimum: 0, maximum: 1, semantics: "validated-then-ignored", type: "number" },
      },
      method: "POST",
      required: ["messages", "model", "stream"],
      route: "/v1/chat/completions",
    });
    for (const response of [contract.readiness, contract.responses.streaming, contract.responses.nonstreaming, ...Object.values(contract.errors)]) {
      expect(response.status).toBeTypeOf("number");
      expect(response.contentType).toBeTypeOf("string");
      expect(Buffer.byteLength(response.utf8)).toBeLessThanOrEqual(contract.limits.maxOutputBytes);
    }
    const remote = await readFile(file("profiles/jarvis-voice-safe/model_catalog.json"));
    const modelsDev = await readFile(file("profiles/jarvis-voice-safe/models_dev_cache.json"));
    expect(remote.equals(Buffer.from("{}", "utf8"))).toBe(true);
    expect(hash(remote)).toBe("44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a");
    expect(modelsDev.equals(Buffer.from('{"jarvis-h1-disabled":{"models":{}}}', "utf8"))).toBe(true);
    expect(hash(modelsDev)).toBe("0ad75b8d2d416f1a1015ef33b2d3f7da25221314c911bc49e95556ddaa1e02b4");
    expect(lock.profiles[0].catalog).toMatchObject({ networkAllowed: false, refreshAllowed: false, etagPaths: [], alternateCachePaths: [] });
  });

  it("executes 20 deterministic managed turns with no catalog, refresh, ETag, override, state, DNS, or socket activity", async () => {
    const compatibility = await json("profiles/jarvis-voice-safe/config.compatibility.yaml");
    const contract = await json("contracts/openai-compatibility-stub-v1.json");
    const harness = createManagedHarness(compatibility, contract);
    const remoteBefore = await readFile(file("profiles/jarvis-voice-safe/model_catalog.json"));
    const modelsDevBefore = await readFile(file("profiles/jarvis-voice-safe/models_dev_cache.json"));
    for (let index = 0; index < 20; index += 1) {
      const result = harness.turn({
        authorization: `Bearer ${contract.authorization.fixedPublicValue}`,
        contentType: contract.contentTypes.request,
        body: { messages: [{ role: "user", content: `turn-${index}` }], model: "deepseek-v4-pro", stream: index % 2 === 0 },
      });
      expect(result.status).toBe(200);
      expect(result.utf8).toBe(index % 2 === 0 ? contract.responses.streaming.utf8 : contract.responses.nonstreaming.utf8);
    }
    expect(() => harness.forceRefresh()).toThrowError("catalog_refresh_disabled");
    expect(harness.activity).toEqual({ catalogRequests: 0, outboundSockets: 0, writes: 0 });
    expect(await readFile(file("profiles/jarvis-voice-safe/model_catalog.json"))).toEqual(remoteBefore);
    expect(await readFile(file("profiles/jarvis-voice-safe/models_dev_cache.json"))).toEqual(modelsDevBefore);
  });

  it("keeps every JSON contract canonical except the two byte-exact deny files", async () => {
    for (const path of ["hermes-profile-lock.json", "contracts/openai-compatibility-stub-v1.json", "schemas/hermes-profile-lock-v1.schema.json"]) {
      const bytes = await readFile(file(path)); const value = JSON.parse(bytes.toString("utf8"));
      expect(bytes.equals(Buffer.concat([Buffer.from(canonicalize(value)), Buffer.from("\n")]))).toBe(true);
    }
  });
});
