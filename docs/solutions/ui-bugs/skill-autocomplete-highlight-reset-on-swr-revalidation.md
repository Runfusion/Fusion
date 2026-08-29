---
title: "Skill autocomplete highlight reset on SWR cache revalidation"
date: 2026-06-03
category: ui-bugs
module: packages/dashboard/app/components/ChatView
problem_type: ui_bug
component: frontend_stimulus
symptoms:
  - "Open slash-skill autocomplete menu loses keyboard highlight position when SWR cache revalidation lands mid-interaction"
  - "ChatView arrow-navigation test fails intermittently on CI shards: expected chat-skill-menu-item--highlighted class missing"
  - "Test passes locally but flakes on slow CI; three prior stabilization commits (FN-5864, FN-5745, FN-5725) patched symptoms without finding the cause"
  - "Highlight resets to index 0 whenever useDiscoveredSkillsCache re-delivers a content-identical list with a fresh array identity"
root_cause: async_timing
resolution_type: code_fix
severity: medium
related_components:
  - testing_framework
tags:
  - swr-cache
  - react-useeffect
  - array-identity
  - flaky-test
  - async-race
  - highlight-state
  - test-isolation
  - chatview
---

# Skill autocomplete highlight reset on SWR cache revalidation

## Problem

A recurring "flaky" CI test in the Fusion dashboard — ArrowUp in the slash-skill menu failing to highlight the wrapped-to-last item — was root-caused as a real product bug, not a test-environment quirk: the SWR skills cache re-delivers content-identical skill lists with fresh array *identities*, and a highlight-reset `useEffect` keyed on that identity wiped the user's (and the test's) keyboard position whenever a revalidation landed mid-navigation. Fixed in commit `87d044f18`.

## Symptoms

- CI shard intermittently failed asserting a menu item carried the `chat-skill-menu-item--highlighted` class after `ArrowUp` (expected wrap to the last item); the class was missing.
- Passed locally every run; the failure only surfaced on CI shards.
- A repeat-stabilization history: the same test family (`packages/dashboard/app/components/__tests__/ChatView.test.tsx`) had been "stabilized" three separate times without the flake going away — a tell-tale sign the cause was upstream of the assertions.

## What Didn't Work

The initial instinct — treat it as a flaky environment and rerun the shard — only masked it, because the race window simply didn't reopen every run. Three prior commits each patched the *test*, never the product:

- **FN-5725** (`158f74962`, "streamline ChatView room-creation and slash-autocomplete tests") — reduced setup and tightened slash-autocomplete assertions; a net deletion of test code. Touched assertions/structure only.
- **FN-5745** (`8e2c19285`, "optimize ChatView agent-mentions test timing") — swapped to a local user-event instance and replaced async DOM lookup with immediate assertion. Pure timing/interaction tuning.
- **FN-5864** (`04e1701d9`, "stabilize ChatView skill-menu keyboard assertions") — wrapped the post-`ArrowUp` highlighted-option assertion in `waitFor` to avoid synchronous timing races.

None could fix it: `waitFor` retries an assertion, but here a *later* async event (revalidation) actively resets state back to `0` after the highlight is correct, so waiting longer can land on the wrong side of the reset. The bug was a product state race, and no amount of assertion/timing massaging in the test addresses product state.

## Solution

Key the reset effect on a *semantic* derived value (the joined skill-id list) instead of array identity. `packages/dashboard/app/components/ChatView.tsx`:

Before:

```tsx
useEffect(() => {
  setHighlightedSkillIndex(0);
}, [filteredSkills]);
```

After:

```tsx
const filteredSkillsKey = useMemo(
  () => filteredSkills.map((skill) => skill.id).join(" "),
  [filteredSkills],
);
useEffect(() => {
  setHighlightedSkillIndex(0);
}, [filteredSkillsKey]);
```

Now the effect only fires when the *contents* of the skill list change, so an identity-only revalidation no longer resets the keyboard position.

**Regression test technique** (`ChatView.test.tsx`, "keeps the keyboard highlight when revalidation re-delivers an identical skill list"): seed the SWR cache so the menu renders from cache, defer the revalidation fetch behind a manually-held resolver, navigate, then resolve with identical content but a fresh identity and assert the highlight survives:

```tsx
writeCache(`${SWR_CACHE_KEYS.DISCOVERED_SKILLS_PREFIX}proj-123`, skillsList);
let resolveFetch!: (skills: DiscoveredSkill[]) => void;
mockFetchDiscoveredSkills.mockImplementationOnce(
  () => new Promise((resolve) => { resolveFetch = resolve; }),
);
// ... open menu, ArrowUp to /gamma/, assert it's highlighted ...
await act(async () => {
  resolveFetch(JSON.parse(JSON.stringify(skillsList)) as DiscoveredSkill[]);
});
expect(screen.getByRole("option", { name: /gamma/i }))
  .toHaveClass("chat-skill-menu-item--highlighted");
```

The `JSON.parse(JSON.stringify(...))` is the key move: same content, new object identities — exactly what the SWR layer produces. The test fails on the old identity-keyed reset in all three vitest projects.

## Why This Works

React `useEffect` dependency comparison is `Object.is` (reference identity), not deep equality. `filteredSkills` is a fresh array on every identity-changing render, so the old effect re-ran on churn and re-fired `setHighlightedSkillIndex(0)`. The derived `filteredSkillsKey` is a string; it is `Object.is`-equal across identity-only churn, so the effect stays inert until the actual skill set changes.

The identity churn comes from three places in the SWR layer:

- **Re-parse on read** — `swrCache.ts` `readCache` does `JSON.parse(raw)` every call, minting a brand-new object graph each time (`useDiscoveredSkillsCache` reads via `readCachedSkills` repeatedly: in state init, in the effect, for `loading`, and for `hasCachedStateRef`).
- **Fresh array on notify** — revalidation calls `notifyListeners(projectKey, nextSkills)` delivering a newly-fetched array to every subscriber, replacing the in-state array with a new identity even when contents match.
- **Module-level shared maps** — `inflightByProject` and `listenersByProject` are module-scoped `Map`s, so revalidation state bleeds across renders and, in tests, across cases sharing the module — making a stray revalidation more likely to fire at an inconvenient moment.

**Why CI-only:** the reset is a genuine race between the keypress-driven highlight and an async revalidation. Slower, more contended CI shards widen the window between "ArrowUp set the highlight" and "the assertion reads it," giving the revalidation room to land in between and zero it out. Fast local machines almost always finish the assertion before revalidation resolves.

## Prevention

- **Never key a state-reset `useEffect` on the identity of an array/object that originates from an SWR/cache hook.** Cache layers legitimately hand back content-identical-but-new references. Key the effect on a derived *semantic* value (`xs.map(x => x.id).join(" ")`, a count, a hash) so it fires only on real content change.
- **Treat "this test needed N stabilization passes" as a product-race smell, not a timing smell.** Three assertion/timing patches that don't stick means the test is correctly catching a real race; stop patching the test and find the state mutation that fights it. Resist the "flaky env, just rerun" reflex. (This is the AGENTS.md "Fix the Invariant, Not the Repro" rule, FN-5893, applied to flake triage.)
- **Identity-churn regression pattern (reusable):** seed the cache (`writeCache`), defer the revalidation fetch behind a captured `resolve`, drive the user interaction, then resolve with `JSON.parse(JSON.stringify(original))` to simulate identical-content/new-identity revalidation landing mid-interaction, and assert the user-state invariant holds. This deterministically reproduces a race that only flaked under CI timing.
- **Grep heuristic** for other reset effects fed by cache/array identity: `git grep -nE -A1 'set\w*Index\(0\)'` (search the setter-call line; the dep array is on the following line) and inspect any dep that is a memoized array from a cache/SWR hook. The reset effects span multiple lines, so a single-line `useEffect(...)` pattern matches nothing — search the setter call, not the hook call. This audit at fix time found the same bug class in `QuickChatFAB.tsx` (fixed alongside), while `setMentionHighlightIndex` in both components is keyed on `[mentionFilter, mentionPopupVisible]` — primitives — so the bug class does not apply there. That is the shape to keep: reset on primitive/semantic inputs, never on a cached array's identity.

## Related Issues

- AGENTS.md → "Standing Rule: Fix the Invariant, Not the Repro (FN-5893)" — this fix is a direct application of that rule to flaky-test triage.
- `docs/testing.md` — fake-timer guidance covers timer flakes; this doc covers the *identity-churn* flake class.
- Prior stabilization attempts: FN-5864 (`04e1701d9`), FN-5745 (`8e2c19285`), FN-5725 (`158f74962`).
- Distinct from the engine timeout-flake family (FN-5573/FN-5542/FN-5518) — those are real-timer/subprocess timeouts, a different class.
- Fix: commit `87d044f18` on PR #1352.
