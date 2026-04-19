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
pnpm install
```

### Build all packages

```bash
pnpm build
```

## Workspace Package Overview

| Package | Purpose |
|---|---|
| `@fusion/core` | Shared domain types, stores, persistence, and core utilities |
| `@fusion/dashboard` | Express API + React UI |
| `@fusion/engine` | Scheduling, triage, execution, merge orchestration |
| `@fusion/tui` | Ink-based terminal UI components |
| `@fusion/desktop` | Electron shell around Fusion dashboard/client |
| `@fusion/mobile` | Capacitor + PWA mobile packaging |
| `@fusion/plugin-sdk` | Plugin SDK for building Fusion extensions |
| `@gsxdsm/fusion` | Published CLI + pi extension |

## Development Workflow

```bash
pnpm dev          # build + run CLI entrypoint in dev mode
pnpm dev:ui       # dashboard dev server only
pnpm lint         # lint all packages
pnpm typecheck    # workspace typechecks
pnpm test         # workspace test suite
pnpm build        # workspace builds
```

## Quality Gate Checklist

Before submitting changes, verify:

- [ ] `pnpm lint` — lint passes with no errors
- [ ] `pnpm test` — all tests pass
- [ ] `pnpm typecheck` — type checking passes
- [ ] `pnpm build` — builds successfully

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
- Legacy `.fusion/memory.md` is a deprecated legacy fallback (migration seed/alias) and should not be treated as canonical

Use project memory for reusable patterns, constraints, and pitfalls that should persist across tasks.

### Background Memory Summarization

Fusion can automatically extract insights from memory and prune transient content. Enable via `insightExtractionEnabled` setting:

- `.fusion/memory/MEMORY.md` — Canonical long-term memory source (inside the layered `.fusion/memory/` workspace) compacted/pruned by extraction jobs
- `.fusion/memory-insights.md` — Distilled insights output
- `.fusion/memory-audit.md` — Audit report after each extraction (includes pruning outcome)

See [Settings Reference](./settings-reference.md#background-memory-summarization--audit) for configuration details.

## SQLite Test Runner Pitfall

When running engine tests with Vitest and `node:sqlite`, ensure the engine Vitest config uses thread pool mode:

- ✅ `pool: "threads"`
- ❌ `pool: "vmThreads"`

`node:sqlite` fails under Vitest VM contexts; using threads avoids that failure mode.
