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
    const profile = lock.profiles[0];
    expect(profile.runtimeModes.live.configurationHash).toBe(await sha256Hex(live));
    expect(profile.runtimeModes.pinned_runtime.configurationHash).toBe(await sha256Hex(compatibility));
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
      });
      expect(config.model_overrides).toEqual({ deepseek: { "deepseek-v4-pro": { context_tokens: 1_000_000, max_output_tokens: 393_216, reasoning: true, tools: false, vision: false } } });
      expect(config.auxiliary.background_review.enabled).toBe(false);
      expect(config.messaging_gateways).toEqual([]);
    }
  });

  it("freezes the deterministic compatibility contract and both deny snapshots", async () => {
    const lock = await json("hermes-profile-lock.json");
    const contract = await json("contracts/openai-compatibility-stub-v1.json");
    expect(lock.compatibilityStub).toMatchObject({ bind: "127.0.0.1:8792", baseUrl: "http://127.0.0.1:8792/v1", readinessRoute: "/private/readiness", outboundNetwork: false });
    expect(lock.compatibilityStub.contractHash).toBe(await sha256Hex(contract));
    expect(contract.request.additionalProperties).toBe(false);
    expect(contract.responses.streaming.utf8).toBeTypeOf("string");
    expect(contract.responses.nonstreaming.utf8).toBeTypeOf("string");
    const remote = await readFile(file("profiles/jarvis-voice-safe/model_catalog.json"));
    const modelsDev = await readFile(file("profiles/jarvis-voice-safe/models_dev_cache.json"));
    expect(remote.equals(Buffer.from("{}", "utf8"))).toBe(true);
    expect(hash(remote)).toBe("44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a");
    expect(modelsDev.equals(Buffer.from('{"jarvis-h1-disabled":{"models":{}}}', "utf8"))).toBe(true);
    expect(hash(modelsDev)).toBe("0ad75b8d2d416f1a1015ef33b2d3f7da25221314c911bc49e95556ddaa1e02b4");
    expect(lock.profiles[0].catalog).toMatchObject({ networkAllowed: false, refreshAllowed: false, etagPaths: [], alternateCachePaths: [] });
  });

  it("keeps every JSON contract canonical except the two byte-exact deny files", async () => {
    for (const path of ["hermes-profile-lock.json", "contracts/openai-compatibility-stub-v1.json", "schemas/hermes-profile-lock-v1.schema.json"]) {
      const bytes = await readFile(file(path)); const value = JSON.parse(bytes.toString("utf8"));
      expect(bytes.equals(Buffer.concat([Buffer.from(canonicalize(value)), Buffer.from("\n")]))).toBe(true);
    }
  });
});
