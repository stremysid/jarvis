## 2026-09-17 00:14 UTC — Claude Opus 5, PR #82 max review at 0394455: changes requested

**The filing design is right, but model-chosen area names can lose a memory or stall all memory extraction, and the Inbox re-file jams.**
- **Gates at `0394455`**, in a Windows Workers-pool checkout: lint 0, typecheck 0, **184 files / 4,877 tests**.
- **My guard mutations (16 single, 3 combined), 6 killed:**
  - filing only active items;
  - per-workflow creation count;
  - six-per-run cap;
  - job wiring;
  - child cap, with both layers removed.
  - 13 survived. Notable: the re-file lifecycle/uncertain guard and the confidence guard, even with the decision filter also removed; topic-path redaction; the filing-confidence range; the `memory_corrupt` rethrow; the Inbox-as-target checks.
- **Adversarial second reviewer:** `reviewer-tools/pr82-adversarial.md`, tests in `reviewer-tools/pr82/agent/adversarial-pr82.test.ts`. The tests assert correct behaviour. I re-ran them at this head: **13 of 20 fail**, confirming every finding below.

**B1 (H1). A bad topic path throws away a valid memory, and the cursor moves past it for good.** Any problem in `validatedTopicPath` (`automatic-distillation.ts:489-501`) or a bad `filingConfidence` (`:514-520`) makes the whole proposal `null`. The step still advances the cursor (`:788`, `:821`).
- DeepSeek runs in `json_object` mode, so the schema's `maxItems`/`maxLength` are only requests. Also, `maxLength: 64` counts characters while the code checks 64 bytes.
- Proven, each with 0 items stored:
  - A1: a five-area path;
  - A2: a 22-character non-Latin name (66 bytes);
  - A3: the area "Ticket 482913", which the redactor rewrites so the equality check fails;
  - A4: `filingConfidence` missing.
- **Fix:** validate the path and filing confidence separately from the fact. If invalid, keep the memory and file it to Inbox as `inbox_invalid_path`, with a reason that holds no path. Treat a missing or invalid `filingConfidence` as 0, and let those two keys be absent.

**B2 (H2). One odd area name stalls all memory extraction and pays DeepSeek every hour.**
- `validatedTopicPath` doesn't apply `topicComponent`'s control-character rules, and `automaticFilingReason` (`memory-repository.ts:607`) then refuses the name.
- That happens at `automatic-distillation.ts:1182`, outside the filing `try`, so the step fails without advancing.
- Proven:
  - B1: `["School","Unit 2"]` fails the step.
  - B2: `["Family","Reunion\nJuly"]` on a proposed item fails two hourly runs in a row. The cursor stays at 0, there are 0 items, and the provider is called twice.
- **Fix:** apply the same component rules as `topicComponent` in `validatedTopicPath`, with failures going through the B1 Inbox path. Make building the reason infallible (fall back to a reason with no path). Test a quote-heavy name against the 320-byte guard.

**S1 (M1). The Inbox re-file jams after ten stuck items.** `refileAutomaticInboxItems` (`memory-repository.ts:1235-1280`) reads the ten oldest rows whose reason has the v1 prefix, before checking the decision or path.
- Rows that can never move keep their `updated_at` and hold the window forever. Three kinds:
  - cap or failure items whose area never appears;
  - paths that resolve to the Inbox;
  - later-confirmed proposed items.
- Proven by C1: after three runs, an item whose `School` area exists stays in Needs filing.
- The first backlog hour is likely to trigger this, because the tree starts empty and the six-per-run cap sends most items to Inbox.
- **Fix:** filter the decision in SQL. Read a larger bounded candidate set (for example 100) and stop after 10 moves, or rotate the offset.

**Lows.**
- **N1:** model names distort the tree. Proven:
  - D3: `["Memory","School"]` creates a second School;
  - E1: an area under the Inbox;
  - D1: a name containing `>`;
  - F1/F2: zero-width and full-width look-alike siblings.

  Fix: drop a leading root-name component, never create areas under the Inbox, reject `>`, `/` and Unicode Cf characters, and compare with NFKC folding.
- **N2 (G1):** areas are created in their own batch before the item, so a failed item commit leaves empty areas. Either put the creates in the item's batch or document it.
- **N3:** the D1 allowance rose by arithmetic, not measurement. The maximum-step test uses non-owner events, so filing never ran during it. Measured: about 1,569 actual statements against 3,701 charged. A second hourly step now fits only after about 3 filings, down from about 6. The re-file tail isn't charged, and it runs after an allowance stop. Charge a measured per-filing figure and count the re-file tail.
- **N4: pin the surviving guards with named tests.** Cover:
  - re-file skips proposed/uncertain and low-confidence items (my combined mutations C2/C3 survived);
  - exact-name-only matching;
  - the Inbox-target skips (`:1280`, `automatic-distillation.ts:1106`);
  - the conditional child-cap insert;
  - the 320-byte path bound;
  - topic-path redaction;
  - the filing-confidence range;
  - the `memory_corrupt` rethrow.

**Checked and sound:**
- One provider call per step, and re-file makes no model or ledger calls.
- Filing never changes lifecycle, uncertainty or origin.
- A current name beats an alias; the newest alias and bounded redirects work.
- The six-per-workflow and forty-child caps have no off-by-one.
- 0016 triggers accept every new write, including on renamed or merged topics.
- No migration or out-of-scope changes.

**Next.** A fresh memory-builder session fixes B1–B2, S1 and N1–N4 with tests (the reviewer's 13 failing assertions must pass). It merges main, runs lint, typecheck and the full suite, and requests max re-review.

— Claude Opus 5
