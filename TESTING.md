# Testing

Install dependencies with `pnpm install`.

Run the Worker runtime check with `pnpm --filter @jarvis/cloud-gateway test -- workspace.test.ts`. Run all configured tests with `pnpm test`, cloud tests with `pnpm test:cloud`, type checks with `pnpm typecheck`, and acceptance tests with `pnpm test:acceptance`.

Run the credential-free voice smoke contract with `pnpm test:voice-smoke`. `pnpm smoke:voice -- --scenario inbound` is non-live by default and must report `skipped`; the current branch contains no live driver. `pnpm release:voice-gate` performs only an offline audit of five already-generated redacted evidence files and exits nonzero when any are absent or invalid. `pnpm clean:voice-smoke-evidence` removes only those five local generated files.

Never add live flags during ordinary tests. Calls, provider configuration, deployment, and rollback require the later operator workflow and explicit authorization documented in [docs/runbooks/voice-smoke.md](docs/runbooks/voice-smoke.md).
