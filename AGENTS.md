# Project Guidelines

## Changesets

When making changes that affect the published `@dustinbyrne/kb` package, create a changeset file:

```bash
cat > .changeset/<short-description>.md << 'EOF'
---
"@dustinbyrne/kb": patch
---

Short description of the change.
EOF
```

Bump types:
- **patch**: bug fixes, internal changes
- **minor**: new features, new CLI commands
- **major**: breaking changes

Include the changeset file in the same commit as the code change. The filename should be a short kebab-case description (e.g. `fix-merge-conflict.md`, `add-retry-button.md`).

Only create changesets for changes that affect the published `@dustinbyrne/kb` package — user-facing features, bug fixes, CLI changes. Do NOT create changesets for internal docs (AGENTS.md, README), CI config, or refactors that don't change behavior.

## Package Structure

- `@kb/core` — domain model, task store (private, not published)
- `@kb/dashboard` — web UI + API server (private, not published)  
- `@kb/engine` — AI agents: triage, executor, reviewer, merger, scheduler (private, not published)
- `@dustinbyrne/kb` — CLI entry point (published to npm)

Only `@dustinbyrne/kb` is published. The others are internal workspace packages.

## Testing

```bash
pnpm test          # run all tests
pnpm build         # build all packages
```

Tests are required. Typechecks and manual verification are not substitutes for real tests with assertions.

## CLI-to-Skills Sync

When CLI commands, flags, or workflows change in `@dustinbyrne/kb`, update the corresponding skill docs:

- `.agents/skills/kb-task/SKILL.md` — task creation, management, and tracking commands
- `.agents/skills/kb-board/SKILL.md` — dashboard startup, AI engine, and configuration commands

These skill files are what AI agents read to understand how to use the CLI. Stale skill docs cause agent errors. Always check them when modifying CLI behavior.

## Git

- Commit messages: `feat(KB-XXX):`, `fix(KB-XXX):`, `test(KB-XXX):`
- One commit per step (not per file change)
- Always include the task ID prefix
