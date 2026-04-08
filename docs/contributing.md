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
| `@gsxdsm/fusion` | Published CLI + pi extension |

## Development Workflow

```bash
pnpm dev          # build + run CLI entrypoint in dev mode
pnpm dev:ui       # dashboard dev server only
pnpm typecheck    # workspace typechecks
pnpm test         # workspace test suite
pnpm build        # workspace builds
```

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

When enabled, agents can read/write durable project memory:

- `.fusion/memory.md`

Use it for reusable patterns, constraints, and pitfalls that should persist across tasks.

## SQLite Test Runner Pitfall

When running engine tests with Vitest and `node:sqlite`, ensure the engine Vitest config uses thread pool mode:

- ✅ `pool: "threads"`
- ❌ `pool: "vmThreads"`

`node:sqlite` fails under Vitest VM contexts; using threads avoids that failure mode.
