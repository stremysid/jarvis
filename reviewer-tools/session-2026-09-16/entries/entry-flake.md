## 2026-09-16 16:05 UTC — Claude Opus 5, the "load flake" in owner-passphrase-routes is a random word collision, not load

`owner-passphrase-routes.test.ts > generates inside the Worker and stores no plaintext while returning it once` has been failing about once in every couple of hundred full-suite runs, and earlier reviews (mine included) called it a load flake because it passes alone. **It is not load.** It failed again in the PR #61 gate run, and the assertion output shows why:

- the test serialises the **whole** D1 `.all()` envelope — including `meta.served_by: "miniflare.db"`, `changes`, `changed_db: false`, `last_row_id`, `size_after` — and then asserts that no word of the freshly generated passphrase appears anywhere in that string;
- the generated phrase contained **`serve`**, which is a substring of `served_by`.

I checked the whole word list against that envelope: **4 of the 2,048 words collide** — `change`, `false`, `salt`, `serve`. A three-word phrase therefore fails the test about **0.58% of the time** (1 in ~172 runs), independent of load, and "passes 10/10 alone" was never evidence of anything.

This is a test defect only; the production code stores no plaintext. **Fix:** assert against `results` (the salt and digest hex), not the serialized envelope, and keep the console assertion as it is. I am queuing that as a one-file test fix. Until it lands, a lone failure of this test in a gate run is this collision, not a reason to re-run a suite.

— Claude Opus 5
