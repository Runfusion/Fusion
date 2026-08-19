---
title: "Upstream note: pi threshold compaction is blind to zero-usage providers"
date: 2026-08-18
category: integration-issues
module: "@earendil-works/pi-coding-agent (upstream)"
problem_type: upstream-sdk-gap
related_components:
  - "RUFU-118: docs/solutions/logic-errors/chat-pre-overflow-compaction-blindness.md (mechanism + fix)"
  - "RUFU-118: packages/engine/src/chat-context-guard.ts (interim Fusion gate)"
tags: [pi-integration, compaction, context-window, zero-usage, upstream-note, dsai1, openai-compatible, token-estimation]
applies_when:
  - "Relying on pi's threshold auto-compaction for context-overflow protection with a provider whose streaming responses omit usage"
  - "Integrating an OpenAI-compatible gateway that does not return a final usage block"
  - "Investigating chats that wedge at 1-token output (stop_reason=length) with no compaction events"
  - "Evaluating pi upgrades for zero-usage provider support"
---

# Upstream note: pi `_checkCompaction` refuses the pure estimate when provider usage is absent (RUFU-124)

**Upstream note** — recorded 2026-08-18 (RUFU-124). Filed upstream the same day as
[earendil-works/pi#8328](https://github.com/earendil-works/pi/issues/8328). This note records the
root cause of the RUFU-118 1-token chat wedges; the full Fusion-side mechanism, incident evidence,
and interim gate live in `docs/solutions/logic-errors/chat-pre-overflow-compaction-blindness.md`
(RUFU-118, branch `fusion/rufu-118`, in review as of 2026-08-18 — not on `main` yet).

## Upstream identification (verified live 2026-08-18)

- Canonical repo: `https://github.com/earendil-works/pi` (monorepo; `packages/coding-agent` =
  pi-coding-agent, `packages/ai` = pi-ai)
- Docs / homepage: `https://pi.dev`
- Releases: `https://github.com/earendil-works/pi/releases` — latest at verification: v0.84.2
  (2026-08-14, tag `914cf1472`)
- Packages / CLI: `@earendil-works/pi-coding-agent` (repo dir `packages/coding-agent`; provides the
  `pi` CLI), `@earendil-works/pi-ai` (repo dir `packages/ai`)
- Fusion pins pi 0.84.1 (`scripts/check-pi-versions-pinned.mjs`). The incident occurred on 0.84.1;
  the defect is still present on v0.84.2 and `main` @ `4809c2abcaa8` (2026-08-19, re-verified live
  2026-08-19 ~07:25 UTC; main was `59a71b235dad` (2026-08-18) at first verification).

## The problem (mechanism — one sentence)

pi's threshold auto-compaction returns `false` — no compaction, ever — whenever no assistant
message in the session carries non-zero provider usage, even though `estimateContextTokens`
already computes a pure chars/4 estimate of the whole message list that the caller discards via a
`lastUsageIndex === null` early return; OpenAI-compatible providers that omit `usage` from
streaming responses (observed: dsai1's OpenAI-compatible gateway, despite pi-ai requesting
`stream_options: { include_usage: true }`) therefore never trigger pi's threshold compaction.

## Mechanism (verified line-by-line, 2026-08-18)

### pi-coding-agent 0.84.1 dist (the incident version)

`dist/core/agent-session.js`, `_checkCompaction(assistantMessage, skipAbortedCheck = true)`
(signature `:1510`; threshold case `:1562-1589`):

```js
// :1562  // Case 2: Threshold - context is getting large
const directContextTokens = assistantMessage.usage ? calculateContextTokens(assistantMessage.usage) : 0;   // :1567
if (assistantMessage.stopReason === "error" || directContextTokens === 0) {                              // :1568
    const messages = this.agent.state.messages;
    const estimate = estimateContextTokens(messages);                                                    // :1570
    if (estimate.lastUsageIndex === null)
        return false; // No usage data at all                                                             // :1571-1572  <-- BLIND SPOT
    ...
    contextTokens = estimate.tokens;                                                                    // :1582
} else {
    contextTokens = directContextTokens;
}
if (shouldCompact(contextTokens, contextWindow, settings))                                              // :1587
    return await this._runAutoCompaction("threshold", false);                                           // :1588
```

`dist/core/compaction/compaction.js`:

- `:74-78` — `DEFAULT_COMPACTION_SETTINGS = { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 }`
- `:86-88` — `calculateContextTokens(usage)` = `usage.totalTokens || usage.input + usage.output +
  usage.cacheRead + usage.cacheWrite`; returns `0` for zero/all-zero usage
- `:131-156` — `estimateContextTokens(messages)`: walks back through the message list for the last
  assistant message with non-zero usage; **when none exists it still computes the pure estimate** —
  `estimated += estimateTokens(message)` summed across all messages — and returns
  `{ tokens: estimated, usageTokens: 0, trailingTokens: estimated, lastUsageIndex: null }`
- `:160-164` — `shouldCompact` = `contextTokens > contextWindow - settings.reserveTokens`
- `:188` — `estimateTokens(message)` = `Math.ceil(chars / 4)` per role (the chars/4 estimator)

`@earendil-works/pi-ai@0.84.1/dist/api/openai-completions.js:529-530`:
`if (compat.supportsUsageInStreaming !== false) params.stream_options = { include_usage: true };`
— pi does request usage; dsai1's OpenAI-compatible gateway simply does not return the final usage
block, so every assistant message lands with zero/missing usage and case 2's early return becomes
permanent for the session.

### v0.84.2 tag (`914cf1472`) — still present

- `packages/coding-agent/src/core/agent-session.ts:1962` — `private async _checkCompaction(...)`
- `packages/coding-agent/src/core/agent-session.ts:2033` —
  `if (estimate.lastUsageIndex === null) return false; // No usage data at all`
- `packages/coding-agent/src/core/compaction/compaction.ts:132` — `DEFAULT_COMPACTION_SETTINGS`
  (`reserveTokens: 16384` at `:134`); `:202` `estimateContextTokens`; `:235-237` `shouldCompact`

### main @ `4809c2abcaa8` (2026-08-19) — still present

Verified against `refs/heads/main` = `4809c2abcaa86257337aa9a44801f4af91144dbc` (2026-08-19
07:11:45Z — "fix(ai): anthropic fallback usage (#8319)"; re-verified live 2026-08-19 ~07:25 UTC by
read-only raw fetch at the pinned sha; supersedes `59a71b235dad` (2026-08-18) from first
verification — the new commit does not touch `agent-session.ts` and only adjusts the Anthropic
fallback return type in `compaction.ts` (no line shifts), so all line numbers below are
unchanged).

- `packages/coding-agent/src/core/agent-session.ts:2102` — same early return
- `packages/coding-agent/src/core/agent-session.ts:1217` — pre-prompt call site
  `await this._checkCompaction(lastAssistant, false);` shares the same code path, so the blind
  spot holds for the pre-prompt check too
- `packages/coding-agent/src/core/compaction/compaction.ts:184` — `DEFAULT_COMPACTION_SETTINGS`;
  `:254` `estimateContextTokens`; `:287` `shouldCompact`

## Why it matters (production impact — RUFU-118 incident evidence)

- **chat-a4921d83** (2026-08-18, live repro): fresh chat, dsai1/deepseek-v4, registered
  `contextWindow = 128,000`. Per-call input progression across 13 LLM calls:
  107,295 → 107,777 → 112,232 → 114,686 → 115,168 → 115,748 → 116,339 → 116,866 → 119,646 →
  120,716 → 122,715 (stop=length) → 122,724 (stop=length) → 124,001 → **output 1 token ("The"),
  `stop_reason=length`**. The 111,616 threshold (128,000 − 16,384) never fired on turns 3–10 even
  though every call ran at 112K–124K — zero threshold compaction events.
- **chat-89c03553** (2026-08-17): after a dashboard restart, session resume reloaded ~125K history
  in one first call; pi's own compact-and-retry (the *overflow* case, which does not require usage)
  itself overflowed (compacting a >128K context with a 128K model) and the sticky
  `_overflowRecoveryAttempted` flag left the chat permanently wedged at 1-token output.
- Net effect: provider-agnostic overflow protection is unavailable for zero-usage providers, so
  every integrating application must ship its own pre-overflow gate.

## Verified premises (ruled out as the cause)

From the RUFU-118 diagnosis (all confirmed against 0.84.1 dist + Fusion source):

1. **Compaction is enabled** in Fusion chat/CLI sessions (`SettingsManager.inMemory({ compaction:
   { enabled: true }, ... })`, `packages/engine/src/pi.ts:2538`); pi's default is `enabled: true`
   anyway.
2. **`contextWindow` propagates**: custom-provider models (dsai1 included) are registered with a
   hardcoded `contextWindow: 128000, maxTokens: 16384`
   (`packages/engine/src/auth/custom-provider-registry.ts:97-98`); the observed 111,616 threshold
   matches `128,000 − 16,384` exactly.
3. **pi requests usage** (`stream_options: { include_usage: true }`, pi-ai
   `dist/api/openai-completions.js:530`) — the omission is on the provider side.
4. **The session loads file history** (`dist/core/sdk.js:233`): the repro's 107K first call proves
   the messages were present; only the usage data was absent.

## Related upstream issues (positioning; statuses verified live 2026-08-18 ~21:25 UTC; re-verified 2026-08-19 ~01:25 and ~07:25 UTC)

- **#8192** "estimateContextTokens crashes on assistant messages without usage" — CLOSED
  *not planned* (no-action), 2026-08-16. **Different defect:** a crash in pi-ai
  `packages/ai/src/utils/estimate.ts` `getLastAssistantUsageInfo` on unvalidated
  imported/older/hand-edited session files. Not the threshold blind spot.
- **#8196** "Compaction fails when summarization input exceeds model context window; session left
  stuck over the limit" — CLOSED *not planned*, 2026-08-16. The overflow-recovery endgame
  (chat-89c03553 class), not the threshold blind spot.
- **#8061** "Context budget ignores maxTokens output reservation" — OPEN (opened 2026-08-13);
  adjacent budgeting defect.
- **#7540** "fix(coding-agent): resume after context-limited length stops" — MERGED
  2026-08-03 (`32850ef7c5ed`); PR, unrelated to the threshold path.
- **#8285** "Anthropic fallback usage is priced with the requested model" — CLOSED *completed*,
  2026-08-19 (resolved by the re-landed fallback-usage fix, PR #8319, main @ `4809c2abcaa8` — was
  OPEN at both earlier verification passes). Adjacent usage-accounting; unrelated to the
  threshold blind spot.
- **#6879** "auto-compaction never triggers after context grows past 100% until provider
  overflow" — OPEN (opened 2026-07-20, label `bug`). **Adjacent but distinct variant:** its repro
  is a model whose backend accepts input beyond the configured `contextWindow` (272k configured,
  ~373k enforced) plus check cadence during long agentic turns — compaction only at provider
  overflow or the next turn boundary. Not the zero-usage early return.
- Issue search `repo:earendil-works/pi compaction in:title` (230 results, 2026-08-18): **no open
  issue specifically proposes the pure-estimate threshold fallback** — which is what
  [earendil-works/pi#8328](https://github.com/earendil-works/pi/issues/8328) records.

## Recommendation

In the threshold case of `_checkCompaction`, fall back to the already-computed pure estimate
instead of returning false when no usage data exists:

```ts
if (estimate.lastUsageIndex === null) {
    contextTokens = estimate.tokens; // pure chars/4 fallback — deterministic, monotonic per message
}
```

The estimate is deterministic and grows monotonically as messages are appended, so
`shouldCompact(contextTokens, contextWindow, settings)` (default `reserveTokens: 16384`) becomes
usable for zero-usage providers without changing any other code path. Optionally keep
`return false` when `estimate.tokens === 0` (empty session) to preserve current behavior there.
This makes the provider-agnostic protection pi already intends (per the case-2 comment: "This
ensures sessions that hit persistent API errors (e.g. 529) or malformed zero-usage responses can
still compact") actually work for providers that simply omit usage.

**Caveats and options.** The chars/4 estimator is coarse — it under-counts token-dense content
(non-English text, code, long identifiers), so the fallback threshold fires slightly late for such
sessions; the default `reserveTokens: 16,384` margin absorbs most of that slack, and the estimate
is only consulted on the `lastUsageIndex === null` path (sessions that carry any real usage data
are unaffected). Implementation options, in increasing invasiveness: (1) **as-is fallback** — the
two-line change above; (2) **opt-in settings knob** (e.g. `compaction.estimateFallback:
"on" | "off"`) so integrating apps that run their own gate can keep today's behavior; (3) a
**conservative multiplier** on the pure estimate (e.g. ×1.5) to compensate for the under-count
before comparing against the threshold; (4) keep current behavior and **document it as a known
limitation** so integrating apps gate defensively. The pre-prompt call site
(`await this._checkCompaction(lastAssistant, false)`, `agent-session.ts:1217` on main) shares this
code path, so any of the options covers both the post-message and pre-prompt checks.

**Suggested regression test shape.** A zero-usage session whose pure estimate crosses
`contextWindow − reserveTokens` triggers `_runAutoCompaction("threshold", false)`; a below-
threshold zero-usage session is a no-op; the post-compaction stale-usage guard (existing behavior
when real usage reappears) is unchanged.

## Ready-to-file GitHub issue (filed)

Filed 2026-08-18 as **earendil-works/pi#8328**.

**Title:**

```
Threshold compaction never fires for zero-usage providers: estimateContextTokens pure estimate discarded when lastUsageIndex === null
```

**Body:**

````markdown
### What happened?

For OpenAI-compatible providers whose streaming responses omit the final `usage` block (despite pi
sending `stream_options: { include_usage: true }`), threshold auto-compaction **never fires**: the
threshold case of `_checkCompaction` bails out when no assistant message carries non-zero usage —
even though `estimateContextTokens` has already computed a pure chars/4 estimate over the whole
message list, which the caller discards.

### Mechanism (verified 2026-08-18)

Threshold case of `packages/coding-agent/src/core/agent-session.ts` (`_checkCompaction`):

```ts
const directContextTokens = assistantMessage.usage ? calculateContextTokens(assistantMessage.usage) : 0;
if (assistantMessage.stopReason === "error" || directContextTokens === 0) {
    const estimate = estimateContextTokens(this.agent.state.messages);
    if (estimate.lastUsageIndex === null) return false; // No usage data at all
    ...
    contextTokens = estimate.tokens;
}
...
if (shouldCompact(contextTokens, contextWindow, settings)) { ... }
```

Verified line references:

- pi-coding-agent **0.84.1** dist: `dist/core/agent-session.js:1567-1572` (early return at `:1571-1572`)
- **v0.84.2** tag (`914cf1472`): `agent-session.ts:2033`
- **main** @ `59a71b235dad` (2026-08-18): `agent-session.ts:2102`; the pre-prompt call site
  `await this._checkCompaction(lastAssistant, false)` at `:1217` shares the same path, so the
  blind spot holds pre-prompt too

`estimateContextTokens` (`packages/coding-agent/src/core/compaction/compaction.ts`; 0.84.1 dist
`compaction.js:131-152`) already handles the no-usage case: it sums `estimateTokens` (chars/4)
across all messages and returns `{ tokens: <estimate>, usageTokens: 0, trailingTokens: <estimate>,
lastUsageIndex: null }`. The pure estimate is computed — then thrown away by the `return false`.

### Impact

Any provider that omits usage (observed against an OpenAI-compatible gateway for a DeepSeek model,
`contextWindow` 128,000) runs from ~87% of the window all the way to hard overflow with **zero
threshold compaction events** (13 consecutive calls at 112K-124K input, threshold 111,616, no
compaction). The overflow endgame (compact-and-retry itself overflowing a 128K model, sticky
`_overflowRecoveryAttempted`) then wedges the session at 1-token output. Net effect:
provider-agnostic overflow protection is unavailable for zero-usage providers, and every
integrating application must ship its own pre-overflow gate.

### Suggested fix

In the threshold case, fall back to the already-computed pure estimate instead of returning false
when no usage data exists:

```ts
if (estimate.lastUsageIndex === null) {
    contextTokens = estimate.tokens; // pure chars/4 fallback — deterministic, monotonic per message
}
```

The estimate grows monotonically as messages are appended, so the
`shouldCompact(contextTokens, contextWindow, settings)` threshold (default
`reserveTokens: 16384`) becomes usable for zero-usage providers without changing any other code
path. The chars/4 estimator under-counts token-dense content, so the default `reserveTokens: 16384`
margin absorbs most of the slack; if a plain fallback is too coarse, alternatives include an opt-in
`compaction.estimateFallback` settings knob, a conservative multiplier on the estimate, or
documenting the limitation for integrating apps to gate against. The pre-prompt call site shares
this code path, so the change covers both checks.

### Related issues

- #8192 (closed, not planned) — crash in `getLastAssistantUsageInfo` on unvalidated session files;
  different defect.
- #8196 (closed, not planned) — compact-and-retry overflow endgame; different defect.
- #6879 (open) — adjacent variant: compaction check cadence during long turns / models whose
  backend accepts beyond the configured window; not the zero-usage early return.

### Version

0.84.1 (incident); still present in v0.84.2 and main @ `59a71b235dad` (2026-08-18).
````

## Filing status

`FILED 2026-08-18: earendil-works/pi#8328 — https://github.com/earendil-works/pi/issues/8328`

- Filed 2026-08-18 21:32:52 UTC via `gh issue create -R earendil-works/pi` (gh authenticated as
  `ischindl`, token scopes include `repo`; RUFU-124 Step 3 credential gate passed). A pre-filing
  duplicate search (issue search `compaction in:title`, plus the related issues above) found no
  existing issue proposing this specific fallback.
- **Auto-closed 2026-08-18 21:33:03 UTC by `github-actions[bot]`** (11 s after filing): the repo
  auto-closes all new-contributor issues by default; maintainers review auto-closed issues daily
  and reopen the worthwhile ones (bot comment cites the repo CONTRIBUTING.md quality bar). The full
  issue body is intact for that review; a maintainer `lgtmi`/`lgtm` reply on one of the account's
  issues would keep its future issues open.
- **Re-verified 2026-08-19 ~01:25 UTC:** #8328 remains closed (`state_reason=not_planned`,
  `reopened_at=null`) with no maintainer response — the sole comment is still the 2026-08-18
  `github-actions[bot]` auto-close notice; the `lastUsageIndex === null` early return is still
  present at `packages/coding-agent/src/core/agent-session.ts:2102` on main @ `59a71b235dad`
  (2026-08-18 — main unchanged since the first verification pass). All six related issues above
  unchanged. Fallback issue search (`compaction in:title`, 231 results): still no open issue
  proposing the pure-estimate threshold fallback.
- **Re-verified 2026-08-19 ~07:25 UTC (pi main moved):** #8328 remains closed
  (`state_reason=not_planned`, `reopened_at=null`) with no maintainer response — the sole comment
  is still the 2026-08-18 `github-actions[bot]` auto-close notice (1 comment). pi main advanced
  to `4809c2abcaa8` (2026-08-19, "fix(ai): anthropic fallback usage (#8319)"), which closed
  related #8285 as *completed*; the commit does not touch `agent-session.ts`, and the
  `lastUsageIndex === null` early return is still present at
  `packages/coding-agent/src/core/agent-session.ts:2102` on main @ `4809c2abcaa8` (line numbers
  unchanged). The other five related issues above are unchanged. Fallback issue search
  (`compaction in:title`, 231 results): still no open issue proposing the pure-estimate threshold
  fallback.
- Operator follow-up (optional, not required by this task): as of 2026-08-19 01:25 UTC (under a
  day after filing) #8328 has not been reopened; if it remains closed, re-file from a
  maintainer-sanctioned account or via the web UI from a collaborating account using the
  Ready-to-file GitHub issue block above, or comment on #8328 to request a reopen. The filing
  decision belongs to the operator.

## Fusion's interim mitigation (RUFU-118)

Fusion does not patch pi (requirement: no dependency on pi internals). The interim mitigation is a
Fusion-owned pre-overflow gate on the chat/CLI path —
`packages/engine/src/chat-context-guard.ts` (RUFU-118, branch `fusion/rufu-118`, in review as of
2026-08-18): before every model-loop LLM call it measures the loaded context (provider usage from
`getContextUsage()` when present; otherwise pi's deterministic chars/4 `estimateTokens` over the
loaded messages — the same value pi's `estimateContextTokens` already computes and discards),
compacts if at/above `min(tokenCap ?? round(0.8 × contextWindow), contextWindow − max(16384,
maxTokens))`, and fails loud (`ChatContextOverflowError`) if the re-measured context is still over
the hard limit. Full mechanism + tests: `docs/solutions/logic-errors/chat-pre-overflow-compaction-blindness.md`
(on `fusion/rufu-118`). If earendil-works/pi#8328 lands upstream, the gate remains as defense-in-depth
for providers that report usage inconsistently mid-session.

## References

- Upstream: https://github.com/earendil-works/pi — filed issue
  https://github.com/earendil-works/pi/issues/8328 ; related #8192, #8196, #8061, #7540, #8285, #6879
- pi 0.84.1 dist (verified against the installed pnpm store of the main checkout,
  `/home/schindler/git/Fusion/node_modules/.pnpm/@earendil-works+pi-coding-agent@0.84.1/...`):
  `dist/core/agent-session.js:1510,1562-1589` (`_checkCompaction`),
  `dist/core/compaction/compaction.js:74-78,86-88,131-156,160-164,188` (settings,
  `calculateContextTokens`, `estimateContextTokens`, `shouldCompact`, `estimateTokens`),
  `@earendil-works/pi-ai@0.84.1/dist/api/openai-completions.js:529-530` (`include_usage` request)
- Upstream source (verified live 2026-08-18 via raw fetch at the cited refs): v0.84.2 tag
  `914cf1472` and main @ `59a71b235dad` — line references above
- Fusion: `docs/solutions/logic-errors/chat-pre-overflow-compaction-blindness.md` (RUFU-118, on
  `fusion/rufu-118`), `packages/engine/src/chat-context-guard.ts` (gate, on `fusion/rufu-118`),
  `packages/engine/src/pi.ts:2538` (compaction enabled),
  `packages/engine/src/auth/custom-provider-registry.ts:97-98` (hardcoded custom-provider window),
  `scripts/check-pi-versions-pinned.mjs` (version pin)
