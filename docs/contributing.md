# Contributing

[← Docs index](./README.md)

Thanks for contributing to Fusion.

## Development Setup

### Prerequisites

- Node.js (current LTS recommended)
- pnpm (`packageManager` is pnpm)
- Git
- `pi` runtime/auth configured for AI features

### Install dependencies

```bash
pnpm install --frozen-lockfile
```

### Build workspace packages

```bash
pnpm build      # default build (excludes desktop/mobile)
pnpm build:all  # full recursive build including desktop/mobile
```

## Workspace Package Overview

| Package | Purpose |
|---|---|
| `@fusion/core` | Shared domain types, stores, persistence, and core utilities |
| `@fusion/dashboard` | Express API + React UI (including dashboard TUI in CLI) |
| `@fusion/engine` | Scheduling, planning, execution, merge orchestration |
| `@fusion/desktop` | Electron shell around Fusion dashboard/client |
| `@fusion/mobile` | Capacitor + PWA mobile packaging |
| `@fusion/plugin-sdk` | Plugin SDK for building Fusion extensions |
| `@runfusion/fusion` | Published CLI + pi extension (includes merged TUI) |

## Development Workflow

```bash
pnpm dev               # build + run CLI entrypoint in dev mode
pnpm dev:ui            # dashboard dev server only
pnpm lint              # lint all packages
pnpm test              # changed-only workspace tests (falls back to full suite in safety contexts)
pnpm test:full         # full workspace test suite (clean-worktree compatible)
pnpm build             # workspace builds (excludes desktop/mobile)
pnpm build:all         # full workspace build (includes desktop/mobile)
pnpm verify:workspace  # canonical lint -> test -> build verification gate
pnpm typecheck         # workspace typechecks
```

## Deterministic workspace verification bootstrap

Fusion codifies workspace verification as a deterministic contract:

- Use `pnpm install --frozen-lockfile` for clean bootstrap and dependency repair paths.
- `pnpm test:full` must be runnable in a clean worktree without requiring a prior `pnpm build`.
- This includes clean states where `packages/core/dist`, `packages/engine/dist`, and `packages/dashboard/dist` are absent.
- `pnpm verify:workspace` is the canonical pre-merge gate and runs in strict order:
  1. `pnpm lint`
  2. `pnpm test:full`
  3. `pnpm build`

GitHub Actions now runs deterministic test sharding via `pnpm test:ci:shard --shard <index> --total <count>` in both PR checks and manual CI, while keeping local semantics unchanged:

- `pnpm test` remains changed-only local iteration.
- `pnpm test:full` remains the canonical full local suite.
- `pnpm verify:workspace` remains the canonical local lint -> test -> build gate.

`test:ci:shard` is a CI-focused entrypoint (`scripts/ci-test-shard.mjs`) that partitions a fixed package list by shard index modulo total shard count so coverage is deterministic and reproducible.

`pnpm test` now uses a changed-only entrypoint (`scripts/test-changed.mjs`) for faster local iteration. It resolves the comparison base from `.changeset/config.json` (`baseBranch`) and runs only affected package test scripts using safe package-first filtering (`pnpm --filter <pkg> test`). It automatically falls back to the full suite when the run is forced (CI / `--full`), the git comparison base or diff cannot be resolved, no changes are detected, or shared/root test infrastructure changes.

## Quality Gate Checklist

Before submitting changes, verify:

- [ ] `pnpm verify:workspace` — canonical lint → test → build gate
- [ ] `pnpm typecheck` — type checking passes

## Realtime/SSE change note

If your change touches dashboard realtime behavior (`/api/events`, SSE hooks, proxy event streams, or dedicated stream endpoints), review and update the canonical contract doc:

- [`docs/dashboard-realtime.md`](./dashboard-realtime.md)

Do not create parallel SSE architecture docs. Keep ownership/scoping/cleanup guidance centralized there.

## Testing Requirements

Use real test runs (not manual verification substitutes):

```bash
pnpm test
pnpm test:coverage
pnpm test:coverage:core
pnpm test:coverage:engine
pnpm test:coverage:cli
pnpm test:coverage:dashboard
```

### Test File Organization

All test files live in `__tests__/` subdirectories alongside the code they test:

- Test for `src/foo.ts` → `src/__tests__/foo.test.ts`
- Test for `app/components/Bar.tsx` → `app/components/__tests__/Bar.test.tsx`

When adding new tests, follow this convention. The monorepo has been standardized on `__tests__/` organization.

## Build Standalone Executables

Fusion supports standalone binary builds through Bun compile scripts in the CLI package.

```bash
pnpm build:exe      # build host-target executable
pnpm build:exe:all  # build multi-target executables
```

## CLI Integration Test Lanes

Default workspace verification stays lean and deterministic:

- `pnpm test` runs the standard suite and does **not** require Bun cross-build integration tests.
- `pnpm verify:workspace` remains the canonical `lint -> test -> build` gate.

Slow/pre-release CLI coverage is explicit and opt-in:

```bash
pnpm test:slow-cli                                  # workspace entrypoint
pnpm --filter @runfusion/fusion test:slow-cli       # agent-export integration (FUSION_TEST_SLOW_CLI=1)
pnpm --filter @runfusion/fusion test:build-exe      # native binary cross-build integration (FUSION_TEST_BUILD_EXE=1)
pnpm --filter @runfusion/fusion test:pre-release    # combined CLI slow lane (slow-cli + build-exe)
```

Additional audited suite:

```bash
pnpm --filter @runfusion/fusion test:extension-integration
```

`test:extension-integration` enables `FUSION_TEST_EXTENSION_INTEGRATION=1` and runs the full fn pi extension integration suite. It remains an explicit opt-in lane so default workspace verification stays fast, while still providing a discoverable command for full extension-tool integration coverage.

## Release Process

Fusion uses Changesets + version PR workflow.

- See [RELEASING.md](../RELEASING.md) for release flow details.
- For published package behavior changes, include a changeset.

## Code Signing

Release binary signing setup is documented here:

- [Code Signing Setup](./CODE_SIGNING.md)

## Git / Commit Conventions

Use task-ID-scoped conventional commits:

- `feat(FN-XXX): ...`
- `fix(FN-XXX): ...`
- `test(FN-XXX): ...`
- `docs(FN-XXX): ...` (for documentation-only changes)

## Project Memory

When enabled, Fusion uses OpenClaw-style memory files:

- `.fusion/memory/MEMORY.md` — long-term project memory
- `.fusion/memory/YYYY-MM-DD.md` — daily running notes
- `.fusion/memory/DREAMS.md` — dream-processing memory file
- The legacy top-level memory file is a deprecated migration fallback (seed/alias behavior) and should not be treated as canonical

Use project memory for reusable patterns, constraints, and pitfalls that should persist across tasks.

### Background Memory Summarization

Fusion can automatically extract insights from memory and prune transient content. Enable via `insightExtractionEnabled` setting:

- `.fusion/memory/MEMORY.md` — Canonical long-term memory source (inside the layered `.fusion/memory/` workspace) compacted/pruned by extraction jobs
- `.fusion/memory-insights.md` — Distilled insights output
- `.fusion/memory-audit.md` — Audit report after each extraction (includes pruning outcome)

See [Settings Reference](./settings-reference.md#background-memory-summarization--audit) for configuration details.

## Dashboard CSS Organization

The dashboard's CSS has been modularized:

- **Global stylesheet** (`packages/dashboard/app/styles.css`, ~4,500 lines)
  - Design tokens, primitives (`.btn`, `.card`, `.modal`, `.form-input`), global cross-component rules
- **Per-component stylesheets** (56+ files in `packages/dashboard/app/components/`)
  - Each component needing CSS has a co-located `ComponentName.css`
  - Each `ComponentName.tsx` must import: `import "./ComponentName.css";`

**Rule:** New component CSS goes in the component's `.css` file, not in `styles.css`. Only truly global rules belong in the root stylesheet.

### Icon-only button sizing contract

Dashboard icon-only controls should use the shared `.btn-icon` contract instead of ad-hoc Lucide `size={12}` / `size={14}` props:

- `.btn-icon` defaults icon glyphs to `--icon-size-md` via `--btn-icon-size`
- compact icon-only buttons (`.btn-icon.btn-sm`, `.btn.btn-icon.btn--sm`) automatically use `--icon-size-sm`
- keep intentionally smaller directional affordances (for example split-button chevrons or non-button inline indicators) as explicit local exceptions in component CSS/JSX

Use component-local overrides only when a surface has a deliberate visual exception; ordinary icon-only actions should inherit the shared contract.

### Todo/list action-row pattern

For dense list rows (for example TodoView items), keep action buttons in a dedicated second row instead of cramming controls beside the primary text line:

- define row-action layout in the component-local stylesheet (for example `TodoView.css`), not `styles.css`
- use spacing/layout tokens (`--space-*`, `--radius-*`, `--transition-*`) instead of literal spacing values
- if row actions are hover-revealed on desktop, include a required mobile override under `@media (max-width: 768px)` that forces visibility (`opacity: 1`) so touch devices can always access controls

### CSS Testing

For CSS regression tests, use the helper at `packages/dashboard/app/test/cssFixture.ts`:

```ts
import { loadAllAppCss, loadAllAppCssBaseOnly } from "../test/cssFixture";

// Load all CSS (styles.css + all component .css)
const allCss = await loadAllAppCss();

// Load base rules only (strips @media/@supports)
const baseOnly = await loadAllAppCssBaseOnly();
```

Never directly `readFileSync('../styles.css')` — the ESLint rule `no-restricted-syntax` in `eslint.config.mjs` blocks this in test files and directs you to `cssFixture.ts`.

## SQLite Test Runner Pitfall

When running engine tests with Vitest and `node:sqlite`, ensure the engine Vitest config uses thread pool mode:

- ✅ `pool: "threads"`
- ❌ `pool: "vmThreads"`

`node:sqlite` fails under Vitest VM contexts; using threads avoids that failure mode.
