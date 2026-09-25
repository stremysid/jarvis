/**
 * Offline wire fixtures, not captures. DeepSeek's chat-completions reference
 * documents index/id/type/function on the opening tool delta and only indexed
 * function.arguments on continuations. Live compatibility remains unverified.
 * https://api-docs.deepseek.com/api/create-chat-completion/
 */
export function agentFrame(delta: unknown, finishReason: string | null = null): string {
  return `data: ${JSON.stringify({
    id: "completion_fixture", object: "chat.completion.chunk", created: 1,
    model: "synthetic-runtime-model",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;
}

export function toolFrames(name: string, args: string, id = "call_fixture", index = 0): string[] {
  const cut = Math.floor(args.length / 2);
  return [
    agentFrame({ tool_calls: [{ index, id, type: "function", function: { name, arguments: args.slice(0, cut) } }] }),
    agentFrame({ tool_calls: [{ index, function: { arguments: args.slice(cut) } }] }),
  ];
}

export function agentResponse(frames: readonly string[]): Response {
  return new Response(frames.join(""), { headers: { "content-type": "text/event-stream" } });
}

export function textResponse(text: string): Response {
  return agentResponse([agentFrame({ role: "assistant", content: text }), agentFrame({}, "stop"), "data: [DONE]\n\n"]);
}
