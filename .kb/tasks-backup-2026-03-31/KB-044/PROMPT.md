# Task: KB-044 - Check Test Coverage

**Created:** 2025-03-30
**Size:** M

## Review Level: 1 (Plan Only)

**Assessment:** This is a straightforward infrastructure task adding coverage reporting to existing vitest configurations. Low blast radius - only adds coverage tooling without changing source code behavior.
**Score:** 2/8 — Blast radius: 0, Pattern novelty: 1, Security: 0, Reversibility: 1

## Mission

Add test coverage reporting to the kb workspace to establish a baseline understanding of current test coverage across all packages. Configure Vitest coverage for @kb/core, @dustinbyrne/kb (CLI), @kb/dashboard, and @kb/engine, then run coverage reports and document findings including which files are covered and which gaps exist.

## Dependencies

- **Task:** KB-043 (tests must pass and typecheck must pass before measuring coverage)

## Context to Read First

1. `package.json` — workspace scripts and package structure
2. `packages/core/vitest.config.ts` — current test config for core
3. `packages/cli/vitest.config.ts` — current test config for CLI
4. `packages/dashboard/vitest.config.ts` — current test config for dashboard
5. `packages/engine/vitest.config.ts` — needs to be created or checked if exists
6. `packages/*/package.json` — to understand dependencies and test scripts

## File Scope

**Modified:**
- `packages/core/vitest.config.ts` — add coverage configuration
- `packages/cli/vitest.config.ts` — add coverage configuration
- `packages/dashboard/vitest.config.ts` — add coverage configuration
- `packages/engine/vitest.config.ts` — add coverage configuration (may need to create)
- `package.json` — optional: add coverage script
- `packages/*/package.json` — add @vitest/coverage-v8 dev dependency

**Created:**
- `coverage/` — generated coverage reports (gitignored)
- `.fusion/tasks/KB-044/COVERAGE_REPORT.md` — documentation of findings

## Steps

### Step 0: Preflight

- [ ] Task KB-043 complete (tests passing, typecheck passing)
- [ ] Vitest coverage provider available (@vitest/coverage-v8)
- [ ] All vitest configs located and readable

### Step 1: Install Coverage Dependencies

Add the Vitest coverage provider to all packages that need it.

- [ ] Install @vitest/coverage-v8 in packages/core
- [ ] Install @vitest/coverage-v8 in packages/cli
- [ ] Install @vitest/coverage-v8 in packages/dashboard
- [ ] Install @vitest/coverage-v8 in packages/engine
- [ ] Verify installations with `pnpm install`

**Artifacts:**
- `packages/*/package.json` (modified)

### Step 2: Configure Coverage in Vitest Configs

Update each vitest.config.ts to enable coverage reporting with appropriate settings.

- [ ] Update `packages/core/vitest.config.ts` with coverage config:
  - reporter: ['text', 'html', 'json']
  - reportsDirectory: './coverage'
  - include: ['src/**/*.ts']
  - exclude: ['**/*.test.ts', '**/*.d.ts', 'dist/**']
- [ ] Update `packages/cli/vitest.config.ts` with same coverage config
- [ ] Update `packages/dashboard/vitest.config.ts` with same coverage config (respect existing settings)
- [ ] Update `packages/engine/vitest.config.ts` with same coverage config
- [ ] Ensure all configs have `coverage: { enabled: true }` or can be triggered via CLI flag

**Artifacts:**
- `packages/*/vitest.config.ts` (modified)

### Step 3: Run Coverage Reports

Execute coverage collection for all packages.

- [ ] Run `pnpm --filter @kb/core test -- --coverage` and capture output
- [ ] Run `pnpm --filter @dustinbyrne/kb test -- --coverage` and capture output
- [ ] Run `pnpm --filter @kb/dashboard test -- --coverage` and capture output
- [ ] Run `pnpm --filter @kb/engine test -- --coverage` and capture output
- [ ] Verify HTML reports generated in `packages/*/coverage/` directories

**Artifacts:**
- `packages/*/coverage/` directories (generated)

### Step 4: Analyze and Document Coverage

Create a comprehensive coverage report documenting findings.

- [ ] Read all generated coverage JSON/text reports
- [ ] Document overall coverage percentages per package (lines, functions, branches, statements)
- [ ] List all source files and their individual coverage status
- [ ] Identify uncovered files (0% coverage)
- [ ] Identify partially covered files (<80% coverage)
- [ ] List files with good coverage (≥80% coverage)
- [ ] Note any test files that may be missing or incomplete
- [ ] Create `.fusion/tasks/KB-044/COVERAGE_REPORT.md` with findings

**Artifacts:**
- `.fusion/tasks/KB-044/COVERAGE_REPORT.md` (new)

### Step 5: Optional - Add Coverage Script

Add a convenient root-level script for running coverage across all packages.

- [ ] Add `test:coverage` script to root `package.json` if not present
- [ ] Verify script works with `pnpm test:coverage`

**Artifacts:**
- `package.json` (modified)

### Step 6: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run `pnpm test` — all tests must pass
- [ ] Run `pnpm typecheck` — no type errors
- [ ] Run `pnpm build` — build must succeed
- [ ] Verify coverage reports are generated and readable
- [ ] Ensure coverage configuration doesn't break existing tests

### Step 7: Documentation & Delivery

- [ ] Create changeset if modifying published package (@dustinbyrne/kb)
- [ ] Update `README.md` or relevant docs with coverage instructions if applicable
- [ ] Document any uncovered critical paths that may need follow-up tasks
- [ ] Create follow-up tasks via `task_create` for significant coverage gaps if needed

## Documentation Requirements

**Must Update:**
- `.fusion/tasks/KB-044/COVERAGE_REPORT.md` — coverage findings with:
  - Summary table: package | lines % | functions % | branches % | statements %
  - Uncovered files list with rationale if intentional
  - Recommendations for priority test additions

**Check If Affected:**
- `README.md` — add coverage badge or testing section if relevant
- `AGENTS.md` — update if coverage becomes part of standard workflow

## Completion Criteria

- [ ] All 4 packages have coverage configuration in vitest.config.ts
- [ ] @vitest/coverage-v8 installed in all packages
- [ ] Coverage reports generated successfully for all packages
- [ ] COVERAGE_REPORT.md created with analysis
- [ ] All tests still pass
- [ ] Typecheck passes
- [ ] Build passes

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-044): complete Step N — description`
- **Bug fixes:** `fix(KB-044): description`
- **Tests:** `test(KB-044): description`

Example commits:
- `feat(KB-044): complete Step 1 — add coverage dependencies`
- `feat(KB-044): complete Step 2 — configure vitest coverage`
- `feat(KB-044): complete Step 3 — run coverage reports`
- `feat(KB-044): complete Step 4 — document coverage findings`

## Do NOT

- Write new tests to improve coverage (this task is measurement only)
- Modify source code logic to make it more "testable"
- Set coverage thresholds/gates (will be decided separately based on findings)
- Add coverage to git (coverage/ directories must remain gitignored)
- Skip packages that fail coverage initially — document all results
- Use nyc or other coverage tools — stick to Vitest's built-in coverage
