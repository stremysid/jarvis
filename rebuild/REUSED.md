# Reused code — original path → new path → what changed and why

**Summary: no file from the existing codebase was copied verbatim into `rebuild/`.**

The brief allows reuse by copying-then-editing, and requires logging every copied file here.
This session copied none. Instead the existing code was **read for its shape and lessons** and
the rebuild was written fresh under `rebuild/`. This was deliberate: the brief and
`docs/CODE-VS-JUDGMENT.md` warn that much of the existing code embeds judgment in code
(keyword lists, regexes reading Sid's words, scoring formulas, silent defaults), and copying it
would drag those in. Writing fresh made it easy to keep code to the four jobs (hands, senses,
memory, proof) and put every judgment in the model's prompt/tool descriptions.

## What was studied on `main` (read-only) and the lesson taken

| Original (read only) | Lesson applied in the rebuild |
|---|---|
| `apps/cloud-gateway/src/env.ts` | Which config must fail closed (OWNER_ACTION_PIN, webhook secret). Mirrored in `rebuild/src/env.ts`, expanded with OWNER_CHAT_ID + DEEPSEEK_API_KEY fail-closed notes. |
| `apps/cloud-gateway/src/providers/deepseek-provider.ts` | DeepSeek is OpenAI-compatible; `DEFAULT_MODEL` must agree with Sid's Flash choice; bound-fetch trap. Reimplemented minimally in `rebuild/src/model/deepseek.ts` **without** the memory/consolidation JSON contracts and circuit breaker (not needed yet). |
| `apps/cloud-gateway/src/memory/*` | The memory tool surface and the "one store for text+voice" bug. Reimplemented clean in `rebuild/src/memory/*`; **stripped** the code-side judgment noted in CODE-VS-JUDGMENT rows 6–9/13 (silent lifetime defaults, silent duplicate merges, confidence floors). Confidence + lifetime are now REQUIRED, never defaulted. |
| `apps/cloud-gateway/src/persistence/migrations/*.sql` | Table shapes (facts columns incl. superseded_by/hidden/pinned). `rebuild/migrations/0001_init.sql` is a fresh, trimmed schema (no school/university/deadlines tables). |
| `apps/cloud-gateway/src/autonomy/*` (confirmations) | The pending-action + enforced-tap pattern. Reimplemented in `rebuild/src/confirmations/*` with an explicit same-turn self-confirm guard and args-hash binding. |
| `apps/cloud-gateway/src/channels/telegram/*` | Webhook secret header + owner-chat check. Reimplemented in `rebuild/src/router/telegram-webhook.ts`; **removed** any slash-command grammar parsing (those become model-called tools). |

If a later session copies a file, add a row: `original path → rebuild/<new path> → what was
changed and why (especially which code-side judgment was stripped)`.
