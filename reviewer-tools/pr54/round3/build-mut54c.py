import io, json, os

base = r"C:\Users\Sid\AppData\Local\Temp\claude\C--javis--claude-worktrees-jarvis-code-review-0b1695\491bafd5-6943-47ba-ac70-7a2ebe575839\scratchpad"
src = os.path.join(base, "pr54", "round2", "mut54b.json")
out = os.path.join(base, "pr54", "round3", "mut54c.json")
d = json.load(io.open(src, encoding="utf-8"))
d["branch"] = "67b99dd"
F = "tests/acceptance/live/voice-smoke.ts"
TESTS = ["tests/acceptance/live/voice-smoke.test.ts", "tests/acceptance/live/voice-smoke-runtime.test.ts"]

# W5's anchor moved when the clock-skew allowance landed.
for m in d["mutations"]:
    if m["id"] == "W5-audit-future-started-at":
        m["from"] = ('      if (\n        Date.parse(dataField(record as object, "startedAt") as string) '
                     '> auditTimeMs + AUDIT_CLOCK_SKEW_MS\n      ) throw new Error();\n')
        m["to"] = ""

d["mutations"].extend([
    # S1: the round-2 High-adjacent survivor, now isolated from the rest of the clause.
    {"id": "S1-not-started-claims-owner-authority", "file": F,
     "from": "      || claimsOwnerAuthority\n      || evidence.authenticationMode !== OWNER_PASSPHRASE_AUTHENTICATION_MODE\n",
     "to": "      || evidence.authenticationMode !== OWNER_PASSPHRASE_AUTHENTICATION_MODE\n",
     "tests": TESTS},
    # N1: inbound evidence may not carry the outbound-only not_applicable attestation.
    {"id": "N1-inbound-not-applicable", "file": F,
     "from": '    || direction === "inbound" && attestation === "not_applicable"\n',
     "to": "", "tests": TESTS},
    # N2: an invalid audit time must be refused, not silently disable the startedAt bound.
    {"id": "N2-audit-time-finite", "file": F,
     "from": "    if (!Number.isFinite(auditTimeMs)) throw new Error();\n",
     "to": "", "tests": TESTS},
    # N3: the bounded clock-skew allowance itself must be pinned.
    {"id": "N3-clock-skew-allowance", "file": F,
     "from": "> auditTimeMs + AUDIT_CLOCK_SKEW_MS",
     "to": "> auditTimeMs", "tests": TESTS},
])
d["root"] = "C:/Users/Sid/jarvis-pr39"
io.open(out, "w", encoding="utf-8", newline="").write(json.dumps(d, indent=1))
print("wrote", out, "mutations:", len(d["mutations"]) - 1)
