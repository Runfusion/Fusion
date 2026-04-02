# Task: KB-339 - Export Agent types from @kb/core for dashboard routes

**Created:** 2026-03-31
**Size:** S

## Review Level: 1 (Plan Only)

**Assessment:** Simple export addition with minimal blast radius — just adding missing exports to fix TypeScript build errors.
**Score:** 3/8 — Blast radius: 1, Pattern novelty: 0, Security: 0, Reversibility: 2

## Mission

Fix dashboard build errors by exporting `AgentStore`, `AgentCapability`, and `AgentState` from `@kb/core`. The dashboard's `routes.ts` file uses these types but they are not currently exported from the core package's public API.

## Dependencies

- **None**

## Context to Read First

- `packages/core/src/index.ts` — Current exports from @kb/core
- `packages/core/src/agent-store.ts` — AgentStore class that needs to be exported
- `packages/core/src/types.ts` — AgentCapability and AgentState types (already defined)
- `packages/dashboard/src/routes.ts` (lines ~5130-5330) — Usage of the missing exports

## File Scope

- `packages/core/src/index.ts` (modified — add exports)

## Steps

### Step 1: Add Agent exports to core index.ts

- [ ] Export `AgentStore` class from `./agent-store.js`
- [ ] Export `AgentCapability` type from `./types.js`
- [ ] Export `AgentState` type from `./types.js`
- [ ] Run typecheck to verify the exports are valid

**Artifacts:**
- `packages/core/src/index.ts` (modified)

Add the following to the exports in `packages/core/src/index.ts`:
```typescript
export { AgentStore } from "./agent-store.js";
export type { AgentCapability, AgentState } from "./types.js";
```

### Step 2: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run `cd packages/core && pnpm typecheck` — must pass
- [ ] Run `cd packages/dashboard && pnpm build` — must pass with no TypeScript errors
- [ ] Verify no `AgentStore`, `AgentCapability`, or `AgentState` errors remain

### Step 3: Documentation & Delivery

- [ ] No documentation changes required (internal fix)

## Completion Criteria

- [ ] All steps complete
- [ ] Dashboard builds without TypeScript errors
- [ ] Core package typecheck passes

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-339): export AgentStore and agent types from @kb/core`
- **Bug fixes:** `fix(KB-339): description`

## Do NOT

- Modify the dashboard routes.ts (the imports there are correct)
- Modify agent-store.ts or types.ts (the definitions already exist)
- Add any other exports unless specifically needed to fix build errors
- Change any functionality beyond adding exports
