# Task: KB-221 - Change the binary from kb to fn for fusion

**Created:** 2026-03-31
**Size:** S

## Review Level: 0 (None)

**Assessment:** This is a single-line configuration change to rename the npm binary entry point. No code logic changes, no security implications, fully reversible.
**Score:** 1/8 — Blast radius: 0, Pattern novelty: 0, Security: 0, Reversibility: 2

## Mission

Rename the CLI binary from "kb" to "fn" in the published npm package to align with the Fusion branding. This change only affects the binary name exposed when users install `@dustinbyrne/kb` globally — the internal codebase will still reference "kb" until KB-222 completes the broader documentation and naming migration.

## Dependencies

- **None**

## Context to Read First

- `packages/cli/package.json` — Contains the `bin` field that defines the binary name
- `packages/cli/src/bin.ts` — Contains help text with "kb" references (for awareness only, not changing)

## File Scope

- `packages/cli/package.json`

## Steps

### Step 1: Update Binary Name in package.json

- [ ] Change the `bin` field from `"kb": "./dist/bin.js"` to `"fn": "./dist/bin.js"`
- [ ] Verify the JSON syntax is valid

**Artifacts:**
- `packages/cli/package.json` (modified)

### Step 2: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run `pnpm build` to ensure the package builds successfully
- [ ] Run `pnpm test` to ensure all tests pass
- [ ] Verify the change by checking `cat packages/cli/package.json | grep -A2 '"bin"'`

### Step 3: Documentation & Delivery

- [ ] Create a changeset file documenting the binary rename as a minor version bump

**Changeset location:** `.changeset/rename-binary-to-fn.md`

**Changeset content:**
```md
---
"@dustinbyrne/kb": minor
---

Rename CLI binary from `kb` to `fn` to align with Fusion branding

The binary installed via `npm i -g @dustinbyrne/kb` is now `fn` instead of `kb`. Users will need to update their workflows and documentation references accordingly. The old `kb` command will no longer be available after this change.
```

## Documentation Requirements

**Must Update:**
- Changeset file per above (required for release)

**Check If Affected:**
- None for this task (KB-222 handles documentation updates)

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] Changeset file created
- [ ] `packages/cli/package.json` contains `"fn": "./dist/bin.js"` in the `bin` field

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-221): complete Step 1 — rename binary to fn in package.json`
- **Changeset:** `feat(KB-221): add changeset for binary rename`

## Do NOT

- Modify any other files in this task (README, help text, extension.ts, etc. — that's KB-222)
- Change any source code logic
- Modify the bin.ts entry point or its internal name
- Update version numbers manually (changeset handles this)
