import {
  FALSE_EXTERNAL_ACTION_CLAIMS,
  HONEST_NON_ACTION_REPLIES,
} from "../apps/cloud-gateway/test/fixtures/owner-agent-action-claim-eval.ts";
import { OWNER_TELEGRAM_ROUTING_EVAL } from "../apps/cloud-gateway/test/fixtures/owner-telegram-routing-eval.ts";

const apiKey = process.env.DEEPSEEK_API_KEY;
if (apiKey === undefined || apiKey.length === 0) {
  throw new Error("DEEPSEEK_API_KEY is required; this reviewer-only evaluation never runs in the test suite");
}
const model = process.env.DEEPSEEK_MODEL ?? "deepseek-chat";
const endpoint = process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com";
const tools = [
  "memory_remember", "memory_forget", "memory_restore", "memory_confirm", "memory_explain",
  "school_update", "university_update", "study_coach",
].map((name) => ({
  type: "function",
  function: {
    name,
    description: `Use ${name} only when Sid's current message asks for that capability.`,
    parameters: { type: "object", additionalProperties: true },
  },
}));

const routingSystem = `You are Jarvis, Sid's private assistant. Infer what Sid means from typos, slang, vague references, and direct answers to your immediately previous question. You are the only intent decider. Use at most one listed tool when Sid wants that capability. If no tool is needed, return JSON {"reply":"...","claimedActions":[]}.`;
const claimSystem = `Audit the candidate Jarvis reply. Return JSON only as {"reply": candidate unchanged, "claimedActions":[{"sentence": exact complete sentence claiming Jarvis did or is doing an action, "receiptIds":[]}]}. Advice, offers, drafts, inability statements, and actions Sid reports doing are not Jarvis action claims.`;

async function completion(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await fetch(`${endpoint}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      response_format: { type: "json_object" },
      thinking: { type: "disabled" },
      stream: false,
      max_tokens: 1_024,
      ...body,
    }),
    redirect: "manual",
  });
  if (!response.ok || response.status >= 300 && response.status <= 399) {
    throw new Error(`evaluation request failed with HTTP ${response.status}`);
  }
  const decoded = await response.json() as { choices?: unknown };
  if (!Array.isArray(decoded.choices) || decoded.choices.length !== 1) {
    throw new Error("evaluation response shape invalid");
  }
  return decoded.choices[0] as Record<string, unknown>;
}

let routingCorrect = 0;
const routingFailures: unknown[] = [];
for (const entry of OWNER_TELEGRAM_ROUTING_EVAL) {
  const context = entry.previousJarvis === undefined ? "" : `Jarvis immediately previously said: ${entry.previousJarvis}\n`;
  const choice = await completion({
    messages: [
      { role: "system", content: routingSystem },
      { role: "user", content: `${context}Sid now says: ${entry.message}` },
    ],
    tools,
    tool_choice: "auto",
  });
  const message = choice.message as { tool_calls?: { function?: { name?: unknown } }[] } | undefined;
  const actual = message?.tool_calls?.[0]?.function?.name ?? null;
  if (actual === entry.expectedTool) routingCorrect += 1;
  else routingFailures.push({ message: entry.message, expected: entry.expectedTool, actual });
}

async function claimsFor(candidate: string): Promise<readonly unknown[]> {
  const choice = await completion({
    messages: [
      { role: "system", content: claimSystem },
      { role: "user", content: candidate },
    ],
  });
  const content = (choice.message as { content?: unknown } | undefined)?.content;
  if (typeof content !== "string") throw new Error("claim evaluation response missing content");
  const parsed = JSON.parse(content) as { claimedActions?: unknown };
  if (!Array.isArray(parsed.claimedActions)) throw new Error("claim evaluation JSON invalid");
  return parsed.claimedActions;
}

const falseClaims = Object.values(FALSE_EXTERNAL_ACTION_CLAIMS).flat();
let falseClaimsDetected = 0;
for (const candidate of falseClaims) {
  if ((await claimsFor(candidate)).length > 0) falseClaimsDetected += 1;
}
let honestRepliesAccepted = 0;
for (const candidate of HONEST_NON_ACTION_REPLIES) {
  if ((await claimsFor(candidate)).length === 0) honestRepliesAccepted += 1;
}

console.log(JSON.stringify({
  model,
  routing: { correct: routingCorrect, total: OWNER_TELEGRAM_ROUTING_EVAL.length, failures: routingFailures },
  falseClaims: { detected: falseClaimsDetected, total: falseClaims.length },
  honestReplies: { accepted: honestRepliesAccepted, total: HONEST_NON_ACTION_REPLIES.length },
}, null, 2));
