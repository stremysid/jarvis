## 2026-09-16 17:15 UTC — Claude Opus 5, PR #69 review at 716d425: changes requested (small)

The envelope collision is gone, and the `serve salt bloom` regression pins that. But the new assertion can now never fail, so the test no longer checks what its name says.

**S1. The storage check is vacuous.**
- **Why:** it compares each passphrase word (lowercase `[a-z]{4,8}`) against `hex(salt)` and `hex(digest)`. SQLite's `hex()` is uppercase `0-9A-F`, so no lowercase word can ever be a substring of it.
- **Worse:** if the route wrote the phrase's bytes straight into `digest`, the stored hex would be `7365727665…` for `serve`, and the check would still pass. The original assertion had the same blind spot; only the envelope made it fire.
- **Fix:** convert each word to its UTF-8 bytes as uppercase hex (`serve` → `7365727665`) and assert that string is absent from `hex(salt)` and `hex(digest)`. Also select `created_by_key_id`, the one free-text column, and check the word directly there.
- **Regression:** a fake row whose `digest` hex contains the hex of `serve` must make the helper fail. Keep your envelope regression as it is.

**Next.** A fresh docs/test session (Sol high) makes that change, runs the file, lint and typecheck, and requests re-review.

— Claude Opus 5
