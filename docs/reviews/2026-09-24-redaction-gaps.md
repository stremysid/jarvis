# Redaction gaps — builder evidence, 2026-09-24

Branch: `codex/redaction-gaps`, based on `origin/main` at `f5ba9a8`.
Signed: Codex GPT-6 Astra, headless cloud builder, codex/redaction-gaps.
This is implementation evidence, not an independent review or deployment receipt.

The [executable differential table](../../tests/fixtures/redaction-gaps.json)
contains 69 synthetic cases with exact expected text. The two test suites and
the standalone differential consume it. No owner credential was read or used.

| Requested item | Main at the stated base | Result on this branch |
|---|---|---|
| Contextual assignments independent of digit count | #149 already catches contextual four-digit PIN/passcode values in both runtimes. The generic assignment rule lacks PIN, passphrase, passcode and code; `code is` and nonnumeric values escape | Adds all four labels and the `is` delimiter. Numeric PIN/code values retain their authentication marker at any length; other assignments use the credential marker. Unquoted multiword passphrases are covered through sentence/list punctuation |
| Bare four-digit values | Already survive in both runtimes | Preserved deliberately. The six-digit bare rule is unchanged. Exact negative fixtures cover years, quantities, clocks, dates and course codes |
| Phone formats | No rule in either runtime | Adds country-prefixed, parenthesized and hyphenated formats, including the requested short country-prefixed synthetic example. Matches whole number shapes with identifier boundaries before assignments or digit redaction can consume a prefix, and issues `phone_number` metadata |
| Newline bearer pairs | TypeScript removes the header line but leaves the value. Python already refuses any authorization header as a whole fact, so this header leak is TypeScript-only. Both miss a bare bearer followed by a newline | The header rule consumes its bearer value across CR/LF even if short; bare bearer accepts CR/LF while keeping its existing credential-shape test. Python mirrors the match grammar |
| Production-field test | The old `guest.pin` test still exists, alongside #149's real `handleTurn` integration tests | Re-aims the old test at `conversation.turn.text`, with a contextual PIN, a bare number and a year. Keeps the existing real-turn integration tests |
| Streaming across sentences and lines | Voice already redacts its entire unsplit archive. Telegram releases individual lines, which can lose credential context | Voice applies the new shared rules unchanged. Telegram retains a suffix with a credential introducer through EOF, including incomplete multiword labels. Safe earlier lines still release immediately |

The gateway `Redactor` delegates to `sanitizeRedaction`; it needs no separate
copy of these regexes. Python's equivalent is
`jarvis_local/memory/projection_policy.py`: it refuses a fact whose text would
change rather than rewriting its identity. Therefore the cross-runtime assertion
compares redaction/refusal **decisions**, while TypeScript also has exact text and
streamed-prefix assertions. Header leaks demonstrate why booleans alone are weak.

## Verification

The baseline run executed the table plus the existing 27 cases and 275
whitespace expansions against source read directly from main: **371 decisions,
zero cross-runtime boolean differences, 111 failed text/decision expectations**.
Contextual PINs and ordinary four-digit values already passed on main. No tracked
44-case table was found; the report's historical count is not reused as current
evidence.

Final standalone coverage includes 75 whitespace expansions for the new code
and passphrase forms: **371 decisions, zero differences and zero expectation
failures**. **3,456 streams** match the 69 exact expectations, including each
two-part split and character-by-character input, in both sentence and line modes.
Each emitted prefix is checked before the final token, so a later refusal cannot
hide text already released. The same table is wired into Vitest and pytest.
The differential compares text after NFC normalization and checks marker
presence too, so normalization alone cannot be mistaken for secret detection.

Eleven isolated mutations were killed by the standalone checks, without modifying
the working sources:

| Fault | Assertion that detected it |
|---|---|
| Remove new TypeScript assignment labels | `redacts a contextual four-digit code`, nonnumeric and quoted assignment cases |
| Remove TypeScript phone matching | `redacts the requested short country-prefixed phone fixture` and eleven other phone cases |
| Broaden bare digits to four | `preserves a bare four-digit number` and ordinary-number cases |
| Restore the old header rule | Exact text of newline-header cases; boolean parity remains green |
| Restore horizontal-only bare bearer matching | LF and CRLF bare-bearer cases |
| Remove unquoted multiword passphrase coverage | `redacts a spoken multiword passphrase in context`; boolean parity remains green |
| Remove Telegram's context retention | `redacts a PIN whose value starts on another line`, streaming line mode |
| Run phone matching after assignments | Exact country/area-prefix overlap cases fail, despite matching refusal decisions |
| Remove Python phone matching | Ten cross-runtime mismatches |
| Remove new Python assignment labels | Contextual-code and assignment mismatches |
| Restore horizontal-only Python bare bearer matching | LF and CRLF cross-runtime mismatches |

Source typecheck passes. Test typecheck reports **143 diagnostics, none in the
changed TypeScript files**. This container runs Node 22.22.2 and Python 3.12.3;
the required Node 24.19+ project runtime still needs the harness gate. Python
pytest is unavailable in the local environment (`No module named pytest`).
Vitest and pnpm were not invoked, as the harness brief forbids them here.
Python syntax compilation and `git diff --check` pass. The state-carrier check
passes with one existing FACTS re-verification warning about browser background
access; this redaction change supplies no new evidence for that unrelated row.

## Harness handoff

Run focused tests first, from the repository root:

```powershell
pnpm exec vitest --config vitest.workspace.ts run packages/contracts/test/call-redaction.test.ts packages/contracts/test/envelope.test.ts apps/cloud-gateway/test/security/redaction.test.ts apps/cloud-gateway/test/security/pin-redaction-turn.test.ts apps/cloud-gateway/test/security/streaming-output-redactor.test.ts apps/cloud-gateway/test/contracts/projection-policy.test.ts
Push-Location apps/local-agent
uv run pytest -q tests/memory/test_projection_policy.py tests/sync/test_memory_projection.py
uv run python tests/memory/redaction_differential.py --output "$env:TEMP\jarvis-redaction-python.json"
Pop-Location
node scripts/check-redaction-differential.mjs --python-results "$env:TEMP\jarvis-redaction-python.json"
```

Then run `pnpm test`, `pnpm typecheck`, gateway `typecheck:tests` (inspect the
existing diagnostic baseline), and the full credential-free local-agent suite
with `uv run pytest -q --ignore=tests/integration` from `apps/local-agent`.
Also run `uv run ruff check .` and `uv run mypy --platform win32 jarvis_local`
there, and `node scripts/check-state.mjs` from the root. Review at the exact
harness-produced head before any merge. This builder cannot commit or open the
PR; the root `.codex-commit-msg.txt` and `.codex-pr-body.md` are the handoff.

## Limits requiring reviewer attention

- Explicit assignments are syntactic. `pin is on` now redacts `on`, preserving
  the following year; its exact outcome is in the table. The old ordinary-prose
  test now says `pin sits on`, while the original wording remains a separate
  fixture documenting the ambiguity. Likewise, `code is` can introduce an
  ordinary identifier. No semantic exception list was invented.
- Bare four-digit numbers and unlabelled passphrases deliberately cannot be
  classified as secrets by these rules. Complete spoken-word PIN sequences are
  not covered. An unquoted multiword passphrase ends at period, exclamation,
  question mark, comma, semicolon or line break; quoted values support interior
  sentence punctuation, but not multiline phrases. Other international phone
  shapes and arbitrary phone extensions are outside this change.
- Telegram can delay the suffix of a line mentioning a credential introducer
  until EOF even when it is ordinary prose. Existing raw/output size bounds
  remain in force. Voice's sentence-release behavior is unchanged.
- No live call, production data, secrets, migration or deployment was touched.
  This does not remove secrets already stored by an earlier build.
