---
category: workflow-learnings
module: packages/engine/src/self-healing.ts
tags: [lifecycle-columns, testing, coverage, resolved-lanes, ratchets]
problem_type: process-learning
applies_when: deciding whether a lane conversion is actually protected by a test
---

# Blind the resolver: the only way to know a conversion is covered

Sibling to [a-falling-count-is-not-evidence](./a-falling-count-is-not-evidence.md), which records that
a metric moving is not proof the system moved. This one records the **positive** procedure: how to
find out whether a landed conversion is held by anything, and how to write a test that holds it.

Written from the phase where the lifecycle-column backlog went 126 → 10. Measured at the time: of
**64 resolved lane sets in `self-healing.ts`, 26 had no test that could distinguish them from the
literal they replaced** — including three conversions the author had shipped that same day, and two
halves of sweeps already recorded as covered.

## The procedure

Blind one resolver back to its legacy ids, run the file's suites, and look at the result:

```
- const reviewColumns = await resolveProjectColumnsForRoles(this.store, REVIEW_ROLES);
+ const reviewColumns = new Set<string>(["in-review"]);
```

- suite **fails** → that conversion is covered
- suite **passes** → nothing in the tree can tell the conversion from the literal

One resolver, one 17-second run. Cheaper than writing the conversion was.

## Why the census cannot answer this

The census counts **comparisons**. It cannot tell a working conversion from one a later merge
silently reverted, because both look the same to a syntactic scan. That is how a conversion merged
with 204 green tests behind it and zero of them able to see it.

The two instruments answer different questions and neither substitutes for the other:

| instrument | question |
|---|---|
| census / lane-wiring ratchet | is this site written in the resolved vocabulary? |
| blinding | does anything break if it stops being? |

## Four rules for a test that actually holds a conversion

Each was paid for by a test that passed while proving nothing.

**1. Blind each resolver separately — coverage is per-resolver, not per-sweep.**
A sweep with three buckets can have one covered and the others not. Twice a sweep recorded as done
was half-done: the control flow short-circuited before the second guard was ever consulted, so the
first test could not reach it.

**2. The fixture must reach the branch the resolver gates.**
A card in a renamed *wip* lane cannot exercise a *terminal* skip — it is caught by the wip∪review set
first, and the terminal resolver never decides anything. The test exercises the sweep, passes, and
never touches the line under test.

**3. Assert a path-specific side effect, not a return value.**
In a sweep with several routes to one outcome, `outcome === "reclaimed"` is reachable without the
guarded branch. Assert the thing only that branch does — `removeWorktree`, a `task:reconcile-*` audit
type, a specific `reason` string. Every case that stuck used one; every discard asserted a return
value.

**4. A store fake must honour `options.column`.**
`mockResolvedValue([task])` returns the same row whatever column is asked for, and
`mockResolvedValueOnce` × 3 answers by call order. Blinding then changes which column is *requested*
and identical rows come back. **A fake that ignores its own filter cannot see a filter bug** — which
is exactly the bug these resolvers exist to fix. Use the column-honouring store in
`packages/engine/src/__tests__/self-healing-query-filter-blindness.test.ts`.

Fixtures also encode contracts invisible from the resolver: action sites that deliberately skip a
card whose board cannot be read, buckets with their own pause-reason predicates, gates that resolve
the *blocker's* workflow rather than the card's. All were discovered by a test failing first.

## Two shapes a ratchet cannot distinguish

Found an hour apart, in sibling sweeps:

- **resolved gate, literal branch** — the branch is entered on a resolved question and decided on a
  literal one. Reads as *unwired*; was a live defect (a working agent lost its task link).
- **passed-but-unread** — the parameter is passed but the only field it influences is never read.
  Reads as *wired*; is dead code.

A ratchet counting call sites scores the first as debt and the second as done. Both are wrong. Only
reading the site tells you which you have, which is why that distinction belongs in a comment at the
site and not in a baseline number.

## When you cannot pin it, say so at the site

One resolver in this program is inert by construction and no test can cover it. That is worth a
comment explaining why — otherwise the next worker either writes a green test that proves nothing, or
deletes the parameter and invites someone to re-add it. Recording *why it cannot be pinned* is a
result, not a failure.
