# Project Memory

## Architecture

- `CronRunner` uses dependency injection for AI prompt execution: an `AiPromptExecutor` function is injected via options. This keeps it decoupled from `createKbAgent` and testable without real agent sessions.
- `createAiPromptExecutor(cwd)` is an async factory function that creates a new agent session per call, uses `onText` for text accumulation, and disposes sessions in a `finally` block.
- The factory uses lazy `import("./pi.js")` to avoid pulling the pi SDK into the module graph when AI execution isn't needed.
- `HeartbeatMonitor.executeHeartbeat()` uses the Paperclip wake→check→work→exit model. The lazy `import("./pi.js")` pattern keeps pi SDK out of the module graph when only monitoring (not execution) is needed.
- Agent tool factories (`createTaskCreateTool`, `createTaskLogTool`) live in `agent-tools.ts` and are shared between `TaskExecutor` and `HeartbeatMonitor` to avoid duplication.
- Dashboard SSE clients (planning/subtask/mission interview) now use a shared keep-alive pattern: start a 25s `setInterval` in stream `onOpen` that `POST`s `/api/ai-sessions/:id/ping`, and always stop it on stream `close`, `complete`, and fatal errors.

## Conventions

- When mocking function types with Vitest for the build (tsc), use `vi.fn().mockResolvedValue(x) as unknown as T` instead of `vi.fn<Parameters<T>, ReturnType<T>>()`. The generic syntax works at runtime but fails during `tsc` build.
- When mocking `AgentStore` for heartbeat execution tests, track `saveRun` calls in a local `Map<string, AgentHeartbeatRun>` and have `getRunDetail` read from it — this way `completeRun`'s saved state is reflected in the returned run.
- When `HeartbeatMonitorOptions` has optional fields (`taskStore?`, `rootDir?`), capture them in local `const` variables after the early-return validation check to avoid `Object is possibly 'undefined'` TypeScript errors in the closure.
- For package-scoped single-file test runs, prefer `pnpm --filter <pkg> exec vitest run <file>` over `pnpm --filter <pkg> test -- <file>` when the package test script already hardcodes positional args.
- In dashboard task-creation forms, avoid special-casing built-in workflow template IDs in UI state; render from fetched `workflowSteps` IDs and let store-side template materialization resolve template IDs (`browser-verification` → `WS-XXX`).
- When a package mixes Electron main-process `.ts` files with renderer `.tsx` files, use `moduleResolution: "bundler"` plus `lib: ["DOM", "DOM.Iterable"]` in that package tsconfig; Node16 resolution will otherwise force `.js` extensions and break renderer imports during `tsc`.
- For React component tests in the desktop package, include `.test.tsx` in Vitest discovery and call `cleanup()` in `afterEach` to avoid cross-test DOM leakage that causes duplicate-element query failures.
- When extracting App-level async handlers into hooks, keep error/toast behavior inside the hook and wire passthrough handlers in `App.tsx` (`const handler = hookAction`) to avoid duplicate rollback/toast logic.
- For deep-link modal behavior (`?task=`), preserve one-time open semantics with internal refs in the hook so closing the modal can safely strip only the `task` query param while preserving other params (like `project`).
- When deprecating fields from `BoardConfig` but tests/internal flows still poke private config methods, keep temporary compatibility fields non-enumerable in `readConfig()` so `writeConfig()` can omit them from `config.json` while legacy tests can still mutate them.
- For dashboard route tests that mock `@fusion/core`, keep the mock export list in sync with the real route imports (for example `parseCompanyArchive`); missing one export silently changes route behavior and causes hard-to-diagnose failures.
- Browser directory pickers (`webkitdirectory`) cannot provide a server filesystem path; for dashboard import flows, parse selected `AGENTS.md` files client-side and send `{ agents }` payloads instead of trying to submit a directory `source` path.
- For conditionally rendered mobile inputs in dashboard components, prefer React `autoFocus` on the input over effect+`setTimeout` focus logic keyed to open-state booleans; mount timing is more reliable and simpler.
- Checkout leasing is explicit: use `checkoutTask`/`releaseTask` (or `/api/tasks/:id/checkout` + `/release`) for ownership, treat 409 conflicts as non-retryable contention, and let `HeartbeatMonitor.executeHeartbeat()` only validate `checkedOutBy` (never auto-acquire leases).

## Pitfalls

- `vi.fn<Parameters<SomeType>, ReturnType<SomeType>>()` works in Vitest runtime but causes TypeScript build errors (`TS2558: Expected 0-1 type arguments, but got 2`). Always use the cast pattern instead.
- When adding new exports to `@fusion/engine`, update the mock in `packages/cli/src/commands/__tests__/dashboard.test.ts` to include the new export, otherwise the test may fail with mysterious errors.
- Test `describe` blocks in Vitest can't access helper functions defined in sibling describe blocks. Place shared helpers in the parent scope or within the same describe block.
- When extracting shared code from `executor.ts` (e.g., tool factories), move the parameter schemas (`taskCreateParams`, `taskLogParams`) to the shared module too — keep them canonical in one place to avoid duplication.
- When changing API function signatures (e.g., `startAgentRun`), add new params at the END to preserve backward compatibility. Existing callers passing positional args will break if you insert a new param before existing ones.
- `HeartbeatMonitor.executeHeartbeat()` calls `startRun()` internally — do NOT call both `startRun()` and `executeHeartbeat()` for the same run, or you'll get duplicate runs. Use `startRun()` alone for record-only, or `executeHeartbeat()` for full execution.
- When RunsTab loads data via API calls instead of props, tests must mock the API functions (`fetchAgentRuns`, `fetchAgentRunDetail`) in addition to existing mocks, and set up defaults in `beforeEach`.
- In UI static analysis tests, avoid regex that spans multiple lines for code patterns (e.g., `setInterval.*5000`). Use separate `toContain()` assertions instead since the code is multi-line.
- In large inline mock objects, duplicate property keys are only warned by esbuild and the last declaration silently wins, which can hide the real mock implementation during route tests.
- For hardcoded workflow-step shortcuts in dashboard forms (like `"browser-verification"`), checked/toggle logic must reconcile both the literal template ID and resolved `WS-XXX` IDs by matching `workflowStep.templateId`.
- When using `import.meta.env` in `packages/dashboard/app/*`, ensure `packages/dashboard/tsconfig.app.json` includes `"vite/client"` in `compilerOptions.types`, or the dashboard typecheck test will fail with `Property 'env' does not exist on type 'ImportMeta'`.
- In dashboard app tests under `app/__tests__`, the built client output directory resolves to `../../dist/client` (not `../../../dist/client`).
- Fresh worktrees may miss linked Capacitor plugin packages until dependencies are installed; if dashboard tests/typecheck fail with unresolved `@capacitor/*` imports, run `pnpm install` at repo root first.
- When dashboard components add new `lucide-react` icons or new API functions, update the component test mocks (`vi.mock("lucide-react")` and `vi.mock("../../api")`) immediately; missing mock exports cause cascading runtime failures (`No "X" export is defined`) across otherwise unrelated tests.
- In fresh worktrees, workspace dependency links can be stale enough that dashboard/core tests fail resolving `yaml` from `@fusion/core`; run `pnpm install` at repo root before chasing false test failures.
- `pnpm test` at repo root runs dashboard's clean-checkout typecheck test; App-level TS issues (like duplicate imports or bad hook call signatures) may pass targeted Vitest runs but still fail the full suite.
- In executor worktrees, task attachment files referenced in PROMPT may exist only under the main repo path (`/Users/.../Projects/kb/.fusion/tasks/...`); if relative `.fusion/tasks/...` paths are missing, read the absolute attachment path directly.
- SQLite `ORDER BY timestamp DESC` alone can be nondeterministic when multiple rows share the same millisecond timestamp; add a stable tiebreaker (for example `rowid DESC`) when selecting a "latest" event.
- In `TaskCard.tsx`, `isInteractiveTarget` must check `target instanceof Element` (not `HTMLElement`) so SVG elements from lucide-react icons are correctly detected as interactive when inside buttons.
- If root `pnpm test` fails in `@gsxdsm/fusion` with `No matching export ... exportAgentsToDirectory` from `@fusion/core/dist/index.js`, run `pnpm --filter @fusion/core build` before rerunning tests so the core dist exports are refreshed for Bun compile tests.
- QuickEntryBox control test IDs are reused in `ListView` integration tests; when control layout changes (for example nested menu → inline buttons), update both `QuickEntryBox.test.tsx` and `ListView.test.tsx` together to avoid cascading failures.
- When `InlineCreateCard` layout changes, also check `Column.test.tsx` and `board-mobile.test.tsx` for references to moved/removed test IDs like `inline-create-description-actions`.
- `mission-store.test.ts` has a flaky test (`getMissionHealth computes mission metrics and latest error context`) that fails intermittently when timestamps collide in the same millisecond — this is pre-existing and not related to dashboard changes.
