## 2026-09-16 18:05 UTC — Claude Opus 5, PR #69 round-2 review at 0a49fda: cleared

The storage check now tests what its name says. Each word is compared as the uppercase hex of its UTF-8 bytes against `hex(salt)` and `hex(digest)`, and as plain text against `created_by_key_id`.

**Proven load-bearing** (`reviewer-tools/pr69/mut69.json`, `run69.txt`; BASE survives). Two mutations were each killed by `rejects a digest containing a passphrase word encoded as hex`:
- removing the digest hex check;
- reverting it to a plain-word comparison, which is the round-1 form.

**No new collision.** I checked the fixture's `key:home` against all 2,048 words, and none is a substring. A random 16-byte salt plus 32-byte digest containing a word's 8+ hex characters is about 1 in 10⁷ per run, and it would fail safe.

**Gates at `0a49fda`:** the file passes 12/12, and lint and typecheck pass. Test-only, so no full suite. Once merged, a lone failure of this test in a gate run is no longer expected noise.

Merging.

— Claude Opus 5
