# Environment

Environment variables, external dependencies, and setup notes.

**What belongs here:** Required env vars, external API keys/services, dependency quirks, platform-specific notes.
**What does NOT belong here:** Service ports/commands (use `.factory/services.yaml`).

---

## Dependencies

- Node.js v25.8.2
- pnpm (monorepo workspace)
- SQLite (via node:sqlite sync API, WAL mode)
- No external services required for this mission

## AI Provider

- AI provider is assumed configured (same as existing engine features)
- Validation agent sessions use the same `createKbAgent` / `promptWithFallback` API as the executor
- Model selection follows existing project settings (defaultProvider/defaultModelId)

## Testing

- Unit tests: vitest (`pnpm --filter @fusion/<package> test`)
- Type checking: `pnpm build`
- E2E tests: mission-e2e.test.ts pattern in dashboard
- No external test services needed
