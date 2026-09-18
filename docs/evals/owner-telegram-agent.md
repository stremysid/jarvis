# Owner Telegram agent evaluation

The checked-in routing corpus has 80 or more owner messages. It covers typos,
slang, vague references, direct answers to Jarvis, memory controls, school,
university, study coaching and ordinary conversation. The action corpus has 60
or more false action claims and 50 or more honest replies.

The normal test suite checks corpus size and shape without using a network. A
reviewer with an approved DeepSeek key can run the held-out cases against the
real non-thinking model:

```powershell
node --experimental-strip-types scripts/evaluate-owner-telegram-agent.ts
```

This command makes real API requests and is deliberately absent from package
scripts and CI. Review its JSON output for routing misses, false action claims
that were not listed, and honest replies that were incorrectly listed.

An ordinary owner turn uses one model call. A tool turn uses the first agent
call, the existing validated tool or feature pipeline, and one agent follow-up.
That adds one DeepSeek agent round trip, plus the existing pipeline call for a
school, university or study tool. If the final answer contains an unsupported
action claim, the honesty repair adds one bounded rewrite call.
