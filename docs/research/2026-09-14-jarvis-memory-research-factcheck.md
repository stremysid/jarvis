# Fact-check: "Jarvis memory: where it should live and how to build it"

> **Superseded in part by merged [#129](https://github.com/stremysid/jarvis/pull/129) and [#133](https://github.com/stremysid/jarvis/pull/133):** the selected model and gateway default are now Flash; the V4 Pro default and pricing observations below are dated research, not current configuration or a refreshed price check.

Report checked: `scratchpad/memory-research-2026-09-14.md` (all sections, sources S1 to S71).
Checked 2026-09-14. Read-only: no repository, Cloudflare account, D1, R2 or provider was changed or queried.

**Method.** Each cited primary page was fetched live: vendor docs, pricing pages, App Store listings, READMEs and arXiv abstracts. The fetch tool returns summaries. Where a summary and a cached raw copy disagreed (the DeepSeek and Workflows pricing pages), I re-read the live page word for word from two places before deciding. Repository claims were checked with read-only `grep` and `git show 4833b74:…`.

**Verdicts.** CONFIRMED, CONTRADICTED (with the correct value), OUTDATED or UNVERIFIABLE. "Caveat" in a note means the claim is right but a detail matters when building.

---

## Result in brief

| Verdict | Count |
|---|---|
| CONFIRMED | 77 |
| CONTRADICTED | 5 |
| OUTDATED | 1 |
| UNVERIFIABLE | 1 |
| **Total** | **84** |

**Contradicted or outdated**

1. **Vectorize cost after five years (§4.8): about $0.60 a month, not $0.05.** Cloudflare adds every stored vector to the queried-dimension count each month.
2. **Workers AI distillation cost (§4.4): about $0, not $0.40.** At the report's volume it stays inside the 10,000 free neurons a day.
3. **Queues consumer CPU (§2.3): 30 s by default, up to 5 min.** 15 min is the wall-clock limit, not CPU.
4. **The free Obsidian git route (§5.1, §5.3 route B, §8 Q3c) does not need a $9.99 app.** The Obsidian Git README points to GitSync by ViscousPotential, which is free for one repository and includes push. The $9.99 app is a different one, GitSync.md.
5. **Anthropic retrieval figure (§4.3): the 49% came from contextual embeddings plus contextual BM25.** It is not the gain from adding plain BM25 to embeddings.
6. **Hetzner price (§3, option C), OUTDATED.** Since 15 June 2026, new orders cost $6.49 (CX23) or $6.99 (CAX11) a month excluding IPv4, not "$4.50 to $6.50".

**Recommendation: unchanged. Cost range of $1 to $6 a month: unchanged. Backup design: unchanged, and better supported.**

The most decision-critical claims all hold:
- D1 limits, prices and FTS5 support
- the `wrangler d1 export` virtual-table limitation
- D1 Time Travel
- Vectorize limits
- the bge-m3 price and Cloudflare's no-training statement
- Workflows and cron limits
- R2 bucket locks
- the Obsidian headless client and Sync price
- memory-vendor prices
- DeepSeek prices

---

## 1. Cloudflare D1

| # | Claim as written (report §) | Source checked | Verdict | Note |
|---|---|---|---|---|
| 1.1 | "10 GB per database" (§2.2) | https://developers.cloudflare.com/d1/platform/limits/ | CONFIRMED | Workers Paid; Free is 500 MB. Page updated 21 Apr 2026. |
| 1.2 | "2 MB max row" | same | CONFIRMED | 2,000,000 bytes per string, BLOB or row. |
| 1.3 | "30 s max query" | same | CONFIRMED | |
| 1.4 | "1,000 queries per invocation on Paid" | same | CONFIRMED | Free is 50. |
| 1.5 | "25 B rows read, 50 M rows written, 5 GB storage included; then $0.001/M reads, $1.00/M writes, $0.75/GB-month" (§2.3) | https://developers.cloudflare.com/d1/platform/pricing/ | CONFIRMED | Monthly, Workers Paid. |
| 1.6 | "D1 supports FTS5" (§2.2) | https://developers.cloudflare.com/d1/sql-api/sql-statements/ | CONFIRMED | Includes `fts5vocab`. |
| 1.7 | "`wrangler d1 export` does **not** work on databases containing virtual tables such as FTS5" (§2.2, §4.7) | https://developers.cloudflare.com/d1/best-practices/import-export-data/ ; https://github.com/cloudflare/workers-sdk/issues/9519 | CONFIRMED | Listed under Known limitations (page updated 21 Apr 2026). The page's only workaround is to drop the virtual tables, export, then recreate them. It also says a running export blocks other database requests. Issue #9519, open since June 2025, reports a database left stuck on a "long-running export" after a failed attempt. Never run the built-in export against production. |
| 1.8 | "production D1 already has one" [R] (§2.2) | `apps/cloud-gateway/src/persistence/migrations/0014_memory_projection.sql:239`; `git show 4833b74:docs/HANDOFF.md` | CONFIRMED | 0014 creates an FTS5 virtual table. HANDOFF at 4833b74 records that production applied 0014 and verified its 21 triggers. The older worktree commit 9363b58 still lists this as pending. |
| 1.9 | "Time Travel restores to any minute in the last 30 days, no extra cost, destructive in place" (§2.2, §4.7) | https://developers.cloudflare.com/d1/reference/time-travel/ | CONFIRMED | 30 days on Paid, 7 on Free. A restore can itself be undone with a bookmark. |

## 2. Vectorize

| # | Claim as written (report §) | Source checked | Verdict | Note |
|---|---|---|---|---|
| 2.1 | "1,536 dims max" (§2.2) | https://developers.cloudflare.com/vectorize/platform/limits/ | CONFIRMED | bge-m3's 1,024 fits. |
| 2.2 | "20 M vectors per index" | same | CONFIRMED | |
| 2.3 | "10 metadata indexes" | same | CONFIRMED | |
| 2.4 | "metadata indexes must exist before inserts" | https://developers.cloudflare.com/vectorize/reference/metadata-filtering/ | CONFIRMED | Vectors inserted earlier are indexed only after they are upserted again. |
| 2.5 | "writes queryable after 'a few seconds'" (§2.2, §4.5) | https://developers.cloudflare.com/vectorize/reference/client-api/ | CONFIRMED | Deletes take the same time. |
| 2.6 | "topK up to 100, or 50 with metadata" (§2.3) | limits page and client API page | CONFIRMED | The 50 cap applies with `returnValues: true` or `returnMetadata: "all"`. |
| 2.7 | "50 M queried and 10 M stored dimensions included; then $0.01/M queried, $0.05 per 100 M stored" (§2.3) | https://developers.cloudflare.com/vectorize/platform/pricing/ | CONFIRMED | |
| 2.8 | "after five years about 100,000, roughly 102 M stored dimensions, about $0.05 a month" (§4.8) | same | **CONTRADICTED** | The page defines queried dimensions as (queries + stored vectors) × dimensions, each month. 100,000 × 1,024 alone is 102 M queried dimensions, about $0.55 over the 50 M included. Add about $0.05 for storage: **about $0.60 a month**. The year-one figure of about $0.01 (§4.4) is still right. |

## 3. Workers AI

| # | Claim as written (report §) | Source checked | Verdict | Note |
|---|---|---|---|---|
| 3.1 | "`@cf/baai/bge-m3` $0.012 per million input tokens" (§2.2) | https://developers.cloudflare.com/workers-ai/platform/pricing/ | CONFIRMED | 1,075 neurons per M tokens. |
| 3.2 | "1,024 dims, 100+ languages" | https://huggingface.co/BAAI/bge-m3 | CONFIRMED | Cloudflare's model page does not state dimensions. |
| 3.3 | "Cloudflare's model page lists a 60,000-token context; the model card says 8,192" (§2.2 note) | https://developers.cloudflare.com/workers-ai/models/bge-m3/ ; model card | CONFIRMED | The report's advice to keep chunks under 8,000 tokens stands. |
| 3.4 | "$0.011 per 1,000 neurons, 10,000 neurons/day free on Free and Paid" (§2.3) | pricing page | CONFIRMED | |
| 3.5 | "Same-price alternative `@cf/qwen/qwen3-embedding-0.6b`" (§2.2) | https://developers.cloudflare.com/workers-ai/models/qwen3-embedding-0.6b/ ; pricing page | CONFIRMED | Available at $0.012/M. Cloudflare lists an 8,192-token context. |
| 3.6 | "Cloudflare does not train on Workers AI customer content" (§2.2, §4.6) | https://developers.cloudflare.com/workers-ai/platform/data-usage/ | CONFIRMED | Customer content is also not used to improve Cloudflare or third-party services without explicit consent. |
| 3.7 | "reranker `bge-reranker-base` $0.0031/M tokens" (§2.3) | https://developers.cloudflare.com/workers-ai/models/bge-reranker-base/ | CONFIRMED | The pricing table rounds it to $0.003. |
| 3.8 | "`qwen3-30b-a3b-fp8` $0.051 / $0.335" (§4.4) | pricing page | CONFIRMED | |
| 3.9 | "Workers AI `qwen3-30b-a3b-fp8` … About $0.40" a month (§4.4) | pricing page (4,625 / 30,475 neurons per M input / output tokens) | **CONTRADICTED** | Report volume: 1.755 M input and 0.99 M output tokens a month. That is about 1,280 neurons a day, inside the 10,000 free a day, so **about $0**. $0.42 is the list-price value. The report already applies the free allowance to embeddings. |

## 4. Workflows

| # | Claim as written (report §) | Source checked | Verdict | Note |
|---|---|---|---|---|
| 4.1 | "5 min CPU per step" (§2.2) | https://developers.cloudflare.com/workflows/reference/limits/ | CONFIRMED | Caveat: 5 min is the configurable maximum on Paid. The default is 30 s. |
| 4.2 | "unlimited wall clock per step" | same | CONFIRMED | |
| 4.3 | "10,000 steps per workflow" | same | CONFIRMED | Default; configurable up to 25,000. |
| 4.4 | "500,000 steps and 1 GB-month included on Paid" | https://developers.cloudflare.com/workflows/reference/pricing/ | CONFIRMED | Then $0.80 per 100,000 steps and $0.20/GB-month. At the report's volume, about 8,000 steps a month. |
| 4.5 | "Steps and storage billing started 10 Aug 2026" (§2.3) | pricing page (updated 21 Jul 2026); https://developers.cloudflare.com/changelog/product/workflows/ (7 Jul 2026 entry) | CONFIRMED | The pricing page gives 10 Aug 2026; the changelog said "no earlier than". I found no postponement notice. A stale cached copy of the pricing page, without step billing, still circulates. |

## 5. Cron triggers and Queues

| # | Claim as written (report §) | Source checked | Verdict | Note |
|---|---|---|---|---|
| 5.1 | "30 s CPU below a one-hour interval, 15 min CPU at one hour or more, 15 min wall clock" (§2.3) | https://developers.cloudflare.com/workers/platform/limits/ (updated 28 Jul 2026) | CONFIRMED | The hourly `0 * * * *` cron gets 15 min. |
| 5.2 | "[Queues] consumers get 15 min CPU" (§2.3) | https://developers.cloudflare.com/queues/platform/limits/ | **CONTRADICTED** | Consumer CPU is **30 s by default, up to 5 min** with `limits.cpu_ms`. 15 min is the consumer wall-clock limit. No design impact, because the report doesn't use Queues at first. |

## 6. Containers, Sandbox, Browser Run

| # | Claim as written (report §) | Source checked | Verdict | Note |
|---|---|---|---|---|
| 6.1 | "25 GiB-hours memory, 375 vCPU-minutes, 200 GB-hours disk included" (§2.3) | https://developers.cloudflare.com/containers/pricing/ | CONFIRMED | |
| 6.2 | "Instance sizes from 1/16 vCPU and 256 MiB up to 4 vCPU and 12 GiB" | same | CONFIRMED | `lite` to `standard-4`. |
| 6.3 | "CPU billed on active use since 21 Nov 2025" | https://developers.cloudflare.com/changelog/post/2025-11-21-new-cpu-pricing/ | CONFIRMED | Memory and disk are still billed on provisioned size. |
| 6.4 | "disk is wiped when a container sleeps" (§2.3, §5.3) | https://developers.cloudflare.com/containers/faq/ | CONFIRMED | Now read in full (the report had only a search excerpt). The FAQ's persistence options are snapshots (coming soon) or FUSE to R2. |
| 6.5 | "Sandbox runs Linux containers on Paid" | https://developers.cloudflare.com/sandbox/ | CONFIRMED | Priced as Containers. SDK 1.0 is in preview. |
| 6.6 | "smallest size at roughly $2 a month kept running" [E] (§6) | Containers pricing | CONFIRMED | Recomputed for `lite` over 730 hours: about $1.42 memory plus $0.32 disk, so about $1.74 when mostly idle, and about $4.60 at full CPU. |
| 6.7 | "Browser Run" as the product name | https://developers.cloudflare.com/changelog/post/2026-04-15-br-rename/ | CONFIRMED | Renamed from Browser Rendering on 15 Apr 2026. |
| 6.8 | "10 browser-hours and 10 concurrent browsers included, $0.09/hour after" (§2.3) | https://developers.cloudflare.com/browser-rendering/platform/pricing/ | CONFIRMED | Each extra concurrent browser is $2.00. |
| 6.9 | "keep-alive up to 10 min" | https://developers.cloudflare.com/browser-rendering/platform/limits/ | CONFIRMED | |
| 6.10 | "human handoff through Live View links valid up to 1 hour" (§2.3, §6) | https://developers.cloudflare.com/browser-run/features/human-in-the-loop/ | CONFIRMED | Links last 5 min by default, and a handoff wait is capped at 30 min. The page also says Browser Run traffic is always identified as bots, which raises the R5 school sign-in risk the report flags [U]. |

## 7. R2

| # | Claim as written (report §) | Source checked | Verdict | Note |
|---|---|---|---|---|
| 7.1 | "$0.015/GB-month, 10 GB-month free, no egress fee" (§2.2) | https://developers.cloudflare.com/r2/pricing/ | CONFIRMED | |
| 7.2 | "locked objects cannot be deleted or overwritten and the bucket cannot be emptied until the rules are removed" (§2.2, §7 step 9) | https://developers.cloudflare.com/r2/buckets/bucket-locks/ | CONFIRMED | A lock can run for a set period or indefinitely. Rules can be removed in the dashboard, with Wrangler or through the API. So, as the report says, the copy outside Cloudflare is what protects against losing the account. |

## 8. Obsidian

| # | Claim as written (report §) | Source checked | Verdict | Note |
|---|---|---|---|---|
| 8.1 | "official headless Sync client (`obsidian-headless`, open beta)" (§5.1) | https://obsidian.md/help/sync/headless ; https://github.com/obsidianmd/obsidian-headless | CONFIRMED | |
| 8.2 | "requires an active Sync subscription and Node.js 22 or later" | same | CONFIRMED | The Node 22 requirement is in the README. |
| 8.3 | "ships prebuilt binaries for Windows and macOS, supports Linux" | README | CONFIRMED | Only a small file-timestamp add-on is prebuilt; Linux runs without it. |
| 8.4 | "offers `merge` or `conflict` handling, and warns not to use both desktop Sync and headless Sync on the same device" | help page and README | CONFIRMED | There are also pull-only and mirror-remote modes. |
| 8.5 | "$4/month billed annually or $5 monthly (Standard), and $8 or $10 (Plus)" (§5.1) | https://obsidian.md/sync | CONFIRMED | |
| 8.6 | "Standard: 1 GB, 5 MB max file, 1 synced vault, 1 month of history. Plus: 10 GB (upgradable to 100 GB), 200 MB files, 10 vaults, 12 months" | https://obsidian.md/help/sync/plans | CONFIRMED | |
| 8.7 | "End-to-end encryption is available" | https://obsidian.md/help/sync/security | CONFIRMED | End-to-end is the default option. |
| 8.8 | The Obsidian Git README says mobile is very unstable and advises against it (§5.1) | https://github.com/Vinzent03/obsidian-git | CONFIRMED | The report's quote matches the README. |
| 8.9 | "points to a GitSync app instead. GitSync.md for iPhone is $9.99 one-time" (§5.1); route B "$0 for private repos plus a $9.99 iPhone app" (§5.3); "(c) A free but fiddlier setup that needs a $9.99 phone app" (§8 Q3) | README link target; https://apps.apple.com/us/app/gitsync/id6744980427 ; https://apps.apple.com/us/app/gitsync-md/id6758960270 ; https://apps.apple.com/us/app/git-client-working-copy/id896694807 | **CONTRADICTED** | The README links **GitSync by ViscousPotential Ltd**, not GitSync.md. **GitSync is free** for one repository (Premium, $24.99, unlocks more). The free app clones, pulls, commits, pushes, resolves conflicts, and syncs from a widget, Shortcut or Automation. Recurring background sync is a separate optional purchase. The $9.99 app is GitSync.md by Cody Russell Bontecou. Working Copy is free to download, but pushing needs its $35.99 Pro unlock. **Route B can cost $0.** |
| 8.10 | Obsidian's guide lists Sync, iCloud, OneDrive, Google Drive, Syncthing and Git/Working Copy; on iPhone it recommends Sync or iCloud, and says Dropbox, Google Drive, OneDrive and Syncthing are not officially supported on iOS (§5.1) | https://obsidian.md/help/sync-notes | CONFIRMED | |
| 8.11 | "A free app; no sign-up required" (§5.1) | https://obsidian.md/pricing | CONFIRMED | |
| 8.12 | "unattended re-login with two-factor sign-in unproven [U]" (§5.3 route A) | README | UNVERIFIABLE | The docs don't say. `ob login` takes `--mfa <code>`, sign-in is stored on local disk, and container disk is wiped on sleep. Expect a fresh sign-in and 2FA code each run unless the stored sign-in is restored from secrets. Keep this as a trial item. |

## 9. Memory services and research

| # | Claim as written (report §) | Source checked | Verdict | Note |
|---|---|---|---|---|
| 9.1 | "Mem0: Free tier allows 1,000 retrievals/month; Starter $19 (5,000 retrievals); graph memory needs Pro $249" (§3) | https://mem0.ai/pricing | CONFIRMED | Adds per month: Hobby 10,000, Starter 50,000, Pro 500,000. Pro also allows 50,000 retrievals. |
| 9.2 | "the open-source version (Apache-2.0) needs a server" | https://github.com/mem0ai/mem0 | CONFIRMED | Caveat: the license and the Docker Compose self-hosted server are right, but Mem0 can also run as a pip or npm library inside your own process. |
| 9.3 | "Mem0 reports 92.5 on LoCoMo and 94.4 on LongMemEval" (§3) | same | CONFIRMED | Vendor claims for its April 2026 algorithm. |
| 9.4 | "Zep Cloud From $125/month (Flex)" | https://www.getzep.com/pricing | CONFIRMED | That is the cheapest paid plan. A free plan with 10,000 credits a month also exists. |
| 9.5 | "open-source Graphiti needs Neo4j, FalkorDB or Neptune"; graphs "need a graph database server" (§3, §4.3) | https://github.com/getzep/graphiti | CONFIRMED | Caveat: FalkorDB has an embedded option (Python 3.12+), and Kuzu is listed but deprecated, so "server" is slightly overstated. Neptune also needs OpenSearch Serverless. |
| 9.6 | "Zep paper reports up to 18.5% better accuracy on LongMemEval with 90% lower latency" | https://arxiv.org/abs/2501.13956 | CONFIRMED | |
| 9.7 | "Letta API plan $20/month plus model usage" | https://docs.letta.com/letta-code/pricing | CONFIRMED | Plus $0.10 per active agent a month and per-second tool execution. |
| 9.8 | "Letta self-hosted Docker image deprecated" | https://docs.letta.com/guides/selfhosting | CONFIRMED | The docs say the image is no longer a maintained or supported product. They point to local mode or the Letta App Server. |
| 9.9 | "Supermemory Free ($5 credits), Pro $19, Max $100; self-hosting only on Scale at $399 and up" | https://supermemory.ai/pricing | CONFIRMED | Enterprise also self-hosts. |
| 9.10 | "Anthropic measured a 49% drop in top-20 retrieval failures when adding BM25 keyword search to embeddings, and 67% with reranking as well" (§4.3) | https://www.anthropic.com/news/contextual-retrieval | **CONTRADICTED** | The 49% is *contextual* embeddings plus *contextual* BM25 (chunks prefixed with generated context), measured against plain embeddings. Contextual embeddings alone gave 35%. The article gives no figure for adding plain BM25. The 67% adds reranking on top of both contextual methods. |
| 9.11 | "The LongMemEval authors list time-aware query expansion among three design changes" (§4.3) | https://arxiv.org/abs/2410.10813 | CONFIRMED | The other two are session decomposition and fact-augmented key expansion. |

## 10. DeepSeek

| # | Claim as written (report §) | Source checked | Verdict | Note |
|---|---|---|---|---|
| 10.1 | "`deepseek-v4-pro` $0.66 / $1.98 off-peak, double at peak" (§4.4) | https://api-docs.deepseek.com/quick_start/pricing (live) | CONFIRMED | Cache-miss input / output. Peak is $1.32 / $3.96. |
| 10.2 | "`deepseek-flash` $0.15 / $0.60 off-peak, double at peak" | same | CONFIRMED | This name now serves DeepSeek-V4.1-Flash, released 10 Sep 2026. |
| 10.3 | The off-peak discount (peak costs double) | same; https://api-docs.deepseek.com/updates | CONFIRMED | Off-peak is half the peak price, per the change log since 16 Aug 2026. Peak hours are 01:00–04:00 and 06:00–10:00 UTC, Monday to Friday, about 21% of the week. |
| 10.4 | "`deepseek-v4-pro` (current gateway default)" [R] | `apps/cloud-gateway/src/providers/deepseek-provider.ts` (`DEFAULT_MODEL`) | CONFIRMED | |
| 10.5 | v4-pro "About $3 off-peak, up to about $6 at peak"; flash "About $1 to $2" [E] | recomputed from 10.1 and 10.2 | CONFIRMED | Report volume: 1.755 M input and 0.99 M output tokens a month. v4-pro: $3.12 all off-peak, $6.24 all peak. Flash: $0.86 and $1.71. With calls spread evenly across the week, v4-pro is about $3.80 and flash about $1.04. |

**Volatility note (not a verdict).** Two sources describe a different plan:
- DeepSeek's 10 Sep 2026 news post, and a cached copy of the pricing page, said that from 04:00 UTC on 14 Sep 2026 every `deepseek-v4-pro` request would be served by V4.1 Flash at Flash prices.
- The live pricing page and change log, read today, reverse that. V4 Pro continues after 14 Sep with billing unchanged, and DeepSeek promises notice of further changes.

DeepSeek also claims V4.1 Flash beats V4 Pro on performance, cost and speed. The gateway's default model can change at short notice, so re-check the page on the day you budget. If requests are re-routed after all, this workload costs Flash prices, about $0.9 to $1.7 a month.

## 11. Windows Task Scheduler

| # | Claim as written (report §) | Source checked | Verdict | Note |
|---|---|---|---|---|
| 11.1 | "Task Scheduler can run a missed task 'at any time after its scheduled time has passed' (default 10-minute delay)" (§2.2) | https://learn.microsoft.com/en-us/windows/win32/taskschd/tasksettings-startwhenavailable | CONFIRMED | Caveat: the page says this applies only to time-based tasks with an end boundary or set to repeat indefinitely. Set the helper's trigger that way and test one missed run. The report makes no iOS scheduling claim. |

## 12. Other cited facts checked

| # | Claim as written (report §) | Source checked | Verdict | Note |
|---|---|---|---|---|
| 12.1 | "the $5 Workers Paid plan" (§1, §3) | https://developers.cloudflare.com/workers/platform/pricing/ | CONFIRMED | |
| 12.2 | "Queues 1 M operations/month included, $0.40/M after; about 3 operations per message" (§2.3) | https://developers.cloudflare.com/queues/platform/pricing/ | CONFIRMED | |
| 12.3 | "Durable Objects: SQLite objects 10 GB each; 5 GB-month included then $0.20/GB-month; 1 M requests included" (§2.3) | https://developers.cloudflare.com/durable-objects/platform/pricing/ ; https://developers.cloudflare.com/durable-objects/platform/limits/ | CONFIRMED | |
| 12.4 | "AI Gateway core features free; 10 M logs per gateway on Paid" (§2.3) | https://developers.cloudflare.com/ai-gateway/reference/pricing/ | CONFIRMED | |
| 12.5 | "AI Search free in open beta within limits; 4 MB max file; Workers AI and AI Gateway billed separately" (§2.3) | https://developers.cloudflare.com/ai-search/platform/limits-pricing/ | CONFIRMED | |
| 12.6 | "Access free for up to 50 users [U S36]" (§5.3 route D) | https://www.cloudflare.com/plans/zero-trust-services/ | CONFIRMED | Cloudflare's own plans page shows $0 with a 50-user limit, so the report's [U] can become [V]. |
| 12.7 | "DigitalOcean $4 (512 MiB) or $6 (1 GiB), backups +20% weekly or +30% daily" (§3 C) | https://www.digitalocean.com/pricing/droplets | CONFIRMED | |
| 12.8 | "Hetzner from about $4.50 to $6.50 after 2026 increases [U S68]" (§3 C) | https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/ | **OUTDATED** | New orders from 15 Jun 2026 (Germany or Finland, excluding IPv4): **CX23 $6.49 (€5.49), CAX11 $6.99 (€5.99) a month**. $4.99 and $5.49 were the old prices. |
| 12.9 | "GitHub: 5,000 requests/hour, 80 content-creating requests/minute" (§5.3 route B) | https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api | CONFIRMED | Content-creating requests are also capped at 500 an hour. |
| 12.10 | "Hermes itself (its README says it runs natively on Windows)" (§6) | https://github.com/NousResearch/hermes-agent | CONFIRMED | The project's own claim; no WSL needed. |

---

## 13. Report conclusions affected

| Conclusion | Changes? | Why |
|---|---|---|
| **Recommendation** (§2.1, §8 Q1): memory on Cloudflare, no Linux server | **No** | Every platform fact it rests on is confirmed. |
| **Monthly cost "about $1 to $6"** (§1 item 3, §2.4, §3 option A) | **No change to the range** | DeepSeek prices and the report's arithmetic hold. Refinements: with calls spread across the week, v4-pro is about $3.80 and flash about $1.04. Vectorize reaches about $0.60 a month by year five, not $0.05. A Workers AI model would cost about $0, not $0.40. DeepSeek's short-lived plan to re-route V4 Pro to Flash shows the top end can change at short notice; a re-route would only lower it. |
| **Backup design** (§2.2 row 10, §4.7): Time Travel, custom nightly NDJSON export to a locked R2 bucket, PC copy | **No** | The export limitation is confirmed by the official doc and an open workers-sdk issue. Production already has an FTS5 table, and the planned 0016 migration adds two more. The only official workaround drops the FTS5 tables on live D1, and a running export blocks other queries, so a custom row-level export is the right choice. Add a runbook line: never run `wrangler d1 export` against production. |
| Q5 default (§8): "DeepSeek's cheaper model, capped at $3 a month" | No | Still sound. If Cloudflare's own model passes a quality test, it costs about $0, not $0.40. |
| **Obsidian Q3(c) and route B** (§5.1, §5.3, §8) | **Yes, wording** | Replace "needs a $9.99 phone app" with: free with the GitSync app for one vault, synced by hand, from a widget or from a Shortcut. Paid alternatives are GitSync.md at $9.99 and Working Copy Pro at $35.99. The suggested defaults ((a) now, (b) later) do not change. |
| Option C cost (§3) | Yes, figure only | Hetzner's entry price since 15 Jun 2026 is $6.49 to $6.99 before IPv4. Option C is still not recommended. |
| Case for combining search methods (§4.3) | Yes, citation only | Say the 49% came from contextual embeddings combined with contextual BM25. The design choice stands. |
| Queues row (§2.3) | Yes, figure only | Consumer CPU is 30 s by default and 5 min at most; 15 min is wall-clock time. |

## 14. Precision fixes for confirmed claims

- Workflows: set `limits.cpu_ms` if a step needs more than 30 s of CPU. 5 min is the ceiling, not the default.
- Task Scheduler: `StartWhenAvailable` is documented only for tasks with an end boundary or indefinite repetition.
- Zep has a free 10,000-credit plan. Mem0's open-source version can run as a library. Graphiti has an embedded FalkorDB option.
- Browser Run traffic is always identified as bots, so the R5 cloud sign-in risk leans higher.
- Update source statuses:
  - S26 (Containers FAQ): now read in full.
  - S36 (Zero Trust, 50 users): verified on Cloudflare's plans page.
  - S68 (Hetzner, third-party calculator): replaced by Hetzner's own price-adjustment page.
  - S64 (DeepSeek): add the reversed V4 Pro phase-out.

## 15. Not re-checked

These carry little decision weight and were not fetched: S11, S17 (beyond the $5 minimum), S46, S47, S49, S50, S53, S62, S63, S66 and S71.

The report's remaining [U] items need trials; documentation can't settle them:
- voice latency
- Brightspace sign-in
- distillation quality of Workers AI models
- Hermes in Sandbox or Containers
- Tesla API calls from a Worker
- stability of an always-on Container
- a write path into iCloud Drive

## Additional sources used (not cited in the report)

- DeepSeek change log: https://api-docs.deepseek.com/updates
- DeepSeek V4.1 Flash announcement (10 Sep 2026): https://www.deepseek.com/en/news/deepseek-v4-1-flash/
- Workflows changelog: https://developers.cloudflare.com/changelog/product/workflows/
- Browser Run rename (15 Apr 2026): https://developers.cloudflare.com/changelog/post/2026-04-15-br-rename/
- Queues limits: https://developers.cloudflare.com/queues/platform/limits/
- workers-sdk issue #9519: https://github.com/cloudflare/workers-sdk/issues/9519
- Obsidian Sync security: https://obsidian.md/help/sync/security
- GitSync (ViscousPotential) on the App Store: https://apps.apple.com/us/app/gitsync/id6744980427
- Working Copy on the App Store: https://apps.apple.com/us/app/git-client-working-copy/id896694807
- Cloudflare Zero Trust plans: https://www.cloudflare.com/plans/zero-trust-services/
- Hetzner price adjustment: https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/
