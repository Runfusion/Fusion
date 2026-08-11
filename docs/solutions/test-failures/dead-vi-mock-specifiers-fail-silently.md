---
category: test-failures
module: "@fusion/engine"
date: 2026-08-10
problem_type: convention
component: vitest-mocks
severity: high
applies_when:
  - "A relative vi.mock path refers to a module moved during a reorganization"
  - "A module mock appears inert or an imported mock lacks vi.fn methods"
tags:
  - vitest
  - mocks
  - test-harness
  - ratchet
---

# Dead relative `vi.mock` specifiers fail silently

A relative `vi.mock` declaration can name a module that no longer exists without
immediately failing. Vitest's factory is lazy; when the code under test imports the
new path, the old factory never executes and its local `vi.fn()` seams remain
unwired.

The resulting symptoms are misleading: an assertion reports **0 calls** as if a
sweep never ran, or an imported value throws `X.mockClear is not a function` because
it is the real export rather than the factory's mock.

## Diagnose

Resolve every literal relative specifier under `packages/engine/src` against disk:
strip a trailing `.js`, then try `.ts`, `.tsx`, `.js`, and `index.ts` in that order.
The repository guard is
`packages/engine/src/__tests__/vi-mock-specifiers-resolve.test.ts`; run it directly
when moving modules.

At execution, the census contains **12 dead specifiers across 8 files**. The guard
holds those temporary exceptions as `{ file, specifier }` pairs, not bare strings:
`../run-audit.js` and `../reviewer.js` recur in several files, and a string-only
allowlist would let a new defect hide behind another file's exception.

The allowlist only shrinks. It fails if an entry resolves, its file no longer
contains the mock, or any new dead relative mock appears. Bare package mocks are
outside this check. A non-literal first argument is a hard failure with no allowlist
because inspection cannot prove where it resolves.

## Repair

Re-point the mock and its `importOriginal<typeof import(...)>()` type to the real
module path. Then run the affected test and deliberately restore the dead path once
to prove the guard and the test both go red. If the live mock exposes a formerly
vacuous assertion, strengthen the assertion; do not skip or loosen it.

## Related

- `docs/solutions/test-failures/store-fake-defects-that-masquerade-as-production-bugs.md`
- `packages/engine/src/__tests__/vi-mock-specifiers-resolve.test.ts`
