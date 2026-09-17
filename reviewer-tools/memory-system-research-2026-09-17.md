# Jarvis memory system and build vs buy: research synthesis (2026-09-17)

This synthesis draws on four research passes run the same day. Each pass kept its own sources, with URLs and dates, in the reviewer transcript.
- **SOTA agent memory systems:** MemGPT/Letta, Mem0, Zep/Graphiti, A-MEM, HippoRAG 2, Hindsight, Mastra, EMem, MIRIX and others.
- **Benchmarks and techniques:** LongMemEval, LoCoMo and its audit, BEAM, MemoryAgentBench, HaluMem, EverMemBench, "Is Grep All You Need?" and MemDelta.
- **Vendor memory and caching costs:** Anthropic, OpenAI, Gemini, DeepSeek and Cloudflare.
- **Build vs buy:** Claude Managed Agents and Agent SDK, OpenAI, Letta, Cloudflare Agents SDK, voice platforms and MCP device connectors.

Almost all headline benchmark numbers are self-reported by vendors, and several are disputed.

## Plain answer for Sid

The best AI memory today doesn't try to fit your whole life into the AI's context window. It works like a good assistant's brain, in three parts:
1. A short "about Sid" profile that the AI always has in front of it. A background job keeps it up to date overnight.
2. Everything you've ever said kept word for word, plus a very good search over it. That search matches exact words and meaning, understands time ("last week", "Friday"), and re-ranks the results for relevance.
3. The AI deciding for itself when to dig deeper. When a question needs more, it searches your full history. If that takes a while, it says "checking…" and comes back with the answer.

This costs a few thousand tokens per message, not hundreds of thousands, so it stays fast and cheap.

Jarvis already has most of the foundation: full history, extracted facts, keyword search, the topic tree, and meaning search (in review). What's missing:
- the always-on profile;
- smarter ranking and time awareness;
- the AI being allowed to search on its own;
- the overnight tidy-up job.

The single biggest quality lever is which AI is the brain. Swapping the model moves memory benchmarks by 8–10 points.

## What the evidence says actually works (strongest first)

1. **Keep raw turns; add extracted facts only as extra search keys.**
   - LongMemEval paper (independent): adding facts as keys gave +9.4% recall and +5.4% QA.
   - Replacing history with facts or summaries hurts.
   - Fact-only systems miss a lot: Mem0 extraction recall was 43% at about 160k tokens and 3% at about 1M (HaluMem).
2. **Hybrid retrieval, then rerank.**
   - Keyword (BM25/FTS) plus vector search, fused (RRF), then a cross-encoder rerank.
   - Anthropic Contextual Retrieval: −49% retrieval failures with BM25 plus embeddings, −67% with reranking.
   - BM25 beat embeddings on MemoryAgentBench.
   - Every strong 2026 system does this: Zep, Hindsight, Mem0 2026, MemOS.
3. **Time awareness.**
   - Event time vs record time, plus time-filtered query expansion: +7–11% recall.
   - Temporal questions are the weakest category everywhere.
   - Zep's bi-temporal facts gave +38% on temporal questions (vendor-reported).
4. **Generous context assembly.** About 20–40 retrieved chunks, structured notes, and "read then answer": up to +10 points.
5. **Agentic search as a fallback, not the default.**
   - Grep/search-tool agents hit about 93% on LongMemEval subsets with strong models.
   - But they are 10–100× slower and costlier.
   - Use them for hard or explicit recall.
6. **Small always-in-context profile plus background consolidation ("sleep-time").**
   - All major assistants converged on this:
     - ChatGPT: about a 4k-token profile refreshed every few days, plus chat history.
     - Claude: about a 1k-token profile, plus a chat-search tool.
     - Gemini: a structured user_context.
   - Consolidation cuts cost and latency; accuracy gains are modest.
7. **Full history in context:** competitive only up to about 100k tokens on frontier models, at 14× the tokens. It breaks at 1M+ (BEAM, EverMemBench).
8. **Knowledge graphs:** weakest evidence per token.
   - HippoRAG 2's independent table: GraphRAG, LightRAG and RAPTOR lose to plain dense retrieval.
   - Mem0-graph: +1.6 points at 2× the tokens.
   - Don't build one.

**Unsolved everywhere:** updates and contradictions. The best multi-hop conflict resolution is 28%. Keep old facts with a "superseded" mark rather than deleting them.

**Latency reality:**
- Plain vector retrieval: 0.1–0.3 s.
- Mem0 search: 0.15–0.2 s.
- Zep and ByteRover totals: 1.3–2.9 s.
- Agentic: 26–180 s.
- Target for Jarvis: fast path under 300 ms, deep path in the background with a follow-up.

## Recommended memory system for Jarvis

| Layer | Contents | How it's used | Status |
|---|---|---|---|
| Profile block | About 1.5k tokens: who Sid is, key preferences, current goals/deadlines, uncertain items labelled | Always in the prompt, placed early so it caches; rebuilt nightly and after big changes | **ADD** |
| Recent window | Last N turns | Always in the prompt | Have (base context) |
| Raw history | Every turn, D1 plus R2 archive | Search target; chunked by turn | Have |
| Facts | Atomic facts with evidence class, uncertainty, source excerpt, valid-from/until, superseded-by | Extra search keys pointing back to raw turns; profile input | Have (add time fields and supersession) |
| Topic tree | Areas → sub-areas | Browsing, "what do you know about X", filtering | Have (#82 merged) |
| Fast retrieval | FTS keyword + Vectorize meaning + time filter → RRF → Workers AI reranker → top 20 | Every turn, under 300 ms, batched D1 reads | Keyword have; meaning in review (#83); rerank and time **ADD**; latency fix in flight |
| Deep search tool | Agent-called search over full history and archive, multi-step | Only when the AI decides; "checking…" plus follow-up if slow | **ADD** (agent-tools PR) |
| Sleep-time jobs | Hourly extraction (have); nightly profile rebuild, contradiction/supersede pass, expiry of time-bound facts, daily summaries | Background, within the $5/month cap on DeepSeek | Partial; **ADD** nightly consolidation |

**Token budget per ordinary turn:**
- System plus tools about 1.5k, profile about 1.5k, recent turns about 3k, retrieved about 2–3k, message and reply about 0.5k.
- That's about 9k input tokens, of which about 3–6k are cacheable.

## Cost per month (brain model; extraction stays on DeepSeek)

Assumptions: about 1.5 model calls per message, about 9–15k input tokens, about 400 output tokens.

| Brain | ~50 msgs/day (Sid now) | ~200 msgs/day (heavy) |
|---|---|---|
| DeepSeek V4.1 Flash (current) | ~$1–2 | ~$4–8 |
| Claude Haiku 4.5 (caches only above 4,096-token prefix) | ~$15–25 | ~$50–90 |
| Claude Sonnet 5 (cache reads $0.20/M) | ~$25–45 | ~$100–200 |
| GPT-5.6 Terra ($2 in / $0.20 cached / $12 out) | ~$25–45 | ~$100–200 |

These are estimates. DeepSeek is 1–2 orders of magnitude cheaper, and model quality is the biggest memory-quality lever.

## Build vs buy

**Recommendation: hybrid.**

**Keep custom on Cloudflare:**
- **Telegram gateway:** no hosted bridge works with every PC off.
- **Twilio calling:** optionally rebase onto the Cloudflare Agents SDK voice adapter later.
- **D1 append-only memory ledger with receipts, FTS and Vectorize.** Claude Managed Agents memory stores are mutable, keep only 30 days of versions, have no semantic search, and cap at 10k memories per store.

**Stop hand-building:**
- **Agent loop, tool calling, scheduling:**
  - Option A: Cloudflare Agents SDK. It is closest to the current stack, works with any model including DeepSeek, and has Durable Object state, scheduling, MCP and voice.
  - Option B: Claude Managed Agents for long or scheduled tasks. Claude-only; about $0.08 per running hour plus tokens.
- **Devices:** MCP connectors.
  - Windows-MCP behind a Cloudflare Tunnel for the home PC and laptop. Works only when the PC is on; no vendor removes that.
  - Google Workspace MCP for mail and calendar (Gmail is draft-only in the preview).
  - iPhone via Shortcuts posting to the gateway.

**Avoid:**
- Letta (mid-pivot, deprecating features).
- OpenAI Agent Builder (shuts down 2026-11-30).
- Anything that needs a PC awake for chat (Claude Dispatch, Code Channels).

## KEEP / CHANGE / ADD / DROP for Jarvis (ordered by impact on Sid)

1. **CHANGE: fix memory lookup latency.** Parallelise and batch D1 reads. In flight (`memory-retrieval-latency`).
2. **CHANGE: one AI with tools instead of code routers**, with honest action claims. Queued (`memory-ai-intent`). Includes the deep-search tool with "checking…" follow-up.
3. **ADD: always-in-context profile block.** Built nightly from active facts, uncertain items labelled, cache-friendly placement. Medium size.
4. **CHANGE: retrieval pipeline.** Fuse keyword and meaning (#83 round 2, relaunch after #1), add the Workers AI reranker and time-aware filtering, and use facts as keys to raw turns. Medium size.
5. **ADD: nightly consolidation.** Supersede contradicted facts (keep history), expire time-bound facts ("test Friday"), daily summaries, profile rebuild. Medium size, DeepSeek within the cap.
6. **DECIDE (Sid, money): brain model.** Stay on DeepSeek Flash or move chat to Claude Sonnet 5, Haiku 4.5 or GPT.
7. **ADD: device and real-world tools via MCP**, starting with Windows-MCP through a Cloudflare Tunnel, then mail and calendar. After the agent core lands.
8. **CHANGE later (optional): move the agent loop onto the Cloudflare Agents SDK** instead of hand-built adapters.
9. **KEEP:** raw history plus R2 archive, evidence classes and receipts, forget/restore, topic tree, nightly backup (#80), $5 extraction cap.
10. **DROP:** regex intent routers and phrase guards (#84 superseded); any knowledge-graph plans; pre-injecting everything each turn.

---

## Cross-check with Sid's external deep research (2026-09-17 ~02:30 UTC)

Sources: Gemini 3.6 thinking, Gemini 3.1 Pro extended thinking, and Claude Opus 5 max (claude.ai Research). All three were given the same self-contained prompt.

**Agreement across all three plus this synthesis (adopted):**
- An always-in-prompt profile, rebuilt only in the background.
- Living topic notes as the primary recall layer; the strongest choice per Opus. It cites Letta's filesystem agent at 74.0 on LoCoMo vs Mem0-graph 68.5, Anthropic's file-based memory tool, and Mastra.
- Raw history kept forever. Atomic facts demoted to a cheap index and audit trail, not the answer engine (arXiv 2603.04814, 2511.17208).
- Fix the timeout by batching and parallelising reads (PR #85).
- A stable cacheable prefix, with small per-turn retrieval: FTS + vector with RRF and no cross-encoder on the hot path. The reranker is used only in deep search.
- A deep-search tool plus "checking…" follow-up. On voice, no pre-retrieval before the first token: answer from cached context and follow up.
- Nightly consolidation (profile, notes, supersede, expire), with deadlines handled event-driven.
- No knowledge graph, no bought memory framework.
- Add origin trust tiers (typed / forwarded / pasted / web), per OWASP ASI06 memory poisoning.

**Brain: all three recommend Claude Haiku 4.5 for live chat and tool calls, with DeepSeek V4.1 Flash for background jobs.** Sonnet 5 only if Haiku measurably fails. This supersedes the Sonnet 5 recommendation above.

**Corrections to the external reports:**
- **Gemini thinking and Gemini Pro:** Sonnet 5 listed at $3/$15. The official price is $2/$10; the planned rise was cancelled.
- **Gemini thinking:** DeepSeek Flash listed at $0.30 input / $0.03 cached. Official prices: cache miss $0.15 off-peak / $0.30 peak; cache hit $0.003 / $0.006.
- **Gemini Pro:**
  - The Managed Agents "24/7 runtime destroys budget" claim is wrong: $0.08 per session-hour is billed only while running, and idle is free.
  - "Move all retrieval to a tool" is rejected: it breaks automatic recall.
  - "PrecisionMemBench" is unverified.
- **Gemini thinking:** "OMEGA" is unverified.
- **Opus:** a D2L Brightspace iCal feed doesn't exist for Sid's board. Use the planned notification-email route.
- **Opus:** a ~2,000-token cached prefix won't cache on Haiku 4.5, whose minimum cacheable prefix is 4,096 tokens. Either keep tools + rules + profile + active notes at ≥4,096 tokens, or don't count on caching. Sonnet 5's minimum is 1,024.

**Worth adopting later:** Durable Object embedded SQLite for hot profile and notes state, which gives near-zero-latency reads (Opus).
