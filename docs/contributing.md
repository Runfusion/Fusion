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

### Build all packages

```bash
pnpm build
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
pnpm test              # workspace test suite (clean-worktree compatible)
pnpm build             # workspace builds
pnpm verify:workspace  # canonical lint -> test -> build verification gate
pnpm typecheck         # workspace typechecks
```

## Deterministic workspace verification bootstrap

Fusion codifies workspace verification as a deterministic contract:

- Use `pnpm install --frozen-lockfile` for clean bootstrap and dependency repair paths.
- `pnpm test` must be runnable in a clean worktree without requiring a prior `pnpm build`.
- This includes clean states where `packages/core/dist`, `packages/engine/dist`, and `packages/dashboard/dist` are absent.
- `pnpm verify:workspace` is the canonical pre-merge gate and runs in strict order:
  1. `pnpm lint`
  2. `pnpm test`
  3. `pnpm build`

CI uses `pnpm verify:workspace` directly, so changes that reintroduce hidden test pre-build dependencies fail fast.

## Quality Gate Checklist

Before submitting changes, verify:

- [ ] `pnpm verify:workspace` — canonical lint → test → build gate
- [ ] `pnpm typecheck` — type checking passes

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
