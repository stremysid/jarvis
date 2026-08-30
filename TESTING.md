# Testing

Install dependencies with `pnpm install`.

Run the Worker runtime check with `pnpm --filter @jarvis/cloud-gateway test -- workspace.test.ts`. Run all configured tests with `pnpm test`, cloud tests with `pnpm test:cloud`, type checks with `pnpm typecheck`, and acceptance tests with `pnpm test:acceptance`.
