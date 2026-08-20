---
title: "Chat context overflow: pi threshold compaction is blind to zero-usage providers"
date: 2026-08-18
category: docs/solutions/logic-errors
module: "chat/CLI pi-session context compaction (engine + dashboard)"
problem_type: logic_error
component: chat_cli_pi_session
symptoms:
  - "chat-a4921d83 (2026-08-18, live repro): fresh chat on a 128K-window model (dsai1/deepseek-v4); per-call input grew 107,295 -> 107,777 -> 112,232 -> 114,686 -> 115,168 -> 115,748 -> 116,339 -> 116,866 -> 119,646 -> 120,716 -> 122,715 (stop=length) -> 122,724 (stop=length) -> 124,001 across 13 LLM calls, then output = 1 token (\"The\") with stop_reason=length; pi's threshold compaction (111,616 tokens) never fired on turns 3-10 even though every call ran at 112K-124K"
  - "chat-89c03553 (2026-08-17): after a dashboard restart, session resume reloaded the full history in one first call (~125K input); pi's own compact-and-retry itself overflowed (compacting a >128K context with a 128K model); chat permanently stuck at 1-token output"
root_cause: missing_provider_usage_blind_spot
resolution_type: code_fix
severity: critical
related_components:
  - "packages/engine/src/chat-context-guard.ts (new gate module)"
  - "packages/dashboard/src/chat.ts (sendMessage + generateRoomResponderReply seams)"
  - "packages/engine/src/errors/token-cap-detector.ts (executor-only detector, unchanged)"
  - "packages/engine/src/auth/custom-provider-registry.ts (hardcoded custom-provider contextWindow)"
  - "pi-coding-agent 0.84.1 (dist/core/agent-session.js _checkCompaction, dist/core/compaction/compaction.js)"
  - "pi-ai 0.84.1 (dist/api/openai-completions.js usage parsing)"
tags:
  - context-window
  - compaction
  - pi-integration
  - custom-provider
  - zero-usage
  - stop-reason-length
  - chat
  - resume
applies_when:
  - "Adding or changing context compaction on the chat/CLI pi-session path"
  - "Integrating a streaming provider whose OpenAI-compatible responses may omit usage"
  - "Changing tokenCap semantics (it now means different things on the chat vs executor lanes)"
---

# Chat context overflow: pi threshold compaction is blind to zero-usage providers

RUFU-118 (B.1 LCM phase 1, "Nikdy nepretečie" — deterministic pre-overflow compaction on the
chat/CLI path). Root-cause diagnosis confirmed against pi 0.84.1 sources
(`@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`) on 2026-08-18; the fix is a
Fusion-owned gate, not a pi patch (requirement: do not depend on pi internals).

## The root cause (one sentence)

pi's threshold auto-compaction **refuses to run whenever no assistant message in the session has
non-zero provider usage** — and OpenAI-compatible providers such as dsai1 return no usage in
their streams — so the 111,616-token threshold (128,000 − 16,384 reserve) never fires no matter
how close the context gets to the wall.

## Mechanism (pi 0.84.1, verified line-by-line)

`_checkCompaction(assistantMessage, skipAbortedCheck)` in
`pi-coding-agent/dist/core/agent-session.js:1523-1603` has two triggers:

**Case 1 — overflow / recoverable-length (post-message only):**
`sameModel && (isContextOverflow(msg, contextWindow) || recoverableLength)`
(agent-session.js:1536-1537).
- `isContextOverflow` (pi-ai `dist/utils/overflow.js:130-158`) detects: (1) `stopReason:"error"`
  + message matching `OVERFLOW_PATTERNS` regexes, (2) silent overflow: `stopReason:"stop"` with
  `usage.input + usage.cacheRead > contextWindow`, (3) `stopReason:"length"` with
  `usage.output === 0` and `usage.input + usage.cacheRead >= 0.99 * contextWindow`.
  Cases 2 and 3 are **usage-dependent**; dsai1 returns `stop_reason=length` (not an error), so
  with zero usage none of the three match.
- `isRecoverableLength` (overflow.js:163-165): `stopReason === "length" && desiredMaxOutput > 0
  && usage.output < desiredMaxOutput`. With normalized zero usage, `0 < 16384` is true, so this
  CAN fire on length-stopped turns — which is why the repro's final turns consumed pi's one-shot
  overflow recovery: `_runAutoCompaction("overflow", willRetry)` compact-and-retry, whose
  summarization call itself overflows a 128K model when the context is ~124K. The failure path
  sets the sticky `_overflowRecoveryAttempted = true` (agent-session.js:1542-1556) and emits
  `compaction_end` with the error "Context overflow recovery failed after one compact-and-retry
  attempt"; every subsequent turn short-circuits at the flag and the chat stays wedged at
  1-token output. This is exactly chat-89c03553's resume endgame — the **single observed
  compaction event on the repro was this overflow-error case**, not the threshold.

**Case 2 — threshold (the blind spot):**
```js
// agent-session.js:1567-1589
const directContextTokens = assistantMessage.usage ? calculateContextTokens(assistantMessage.usage) : 0;
if (assistantMessage.stopReason === "error" || directContextTokens === 0) {
    const estimate = estimateContextTokens(this.agent.state.messages);
    if (estimate.lastUsageIndex === null)
        return false; // No usage data at all.  <-- BLIND SPOT
    contextTokens = estimate.tokens;
} else {
    contextTokens = directContextTokens;
}
if (shouldCompact(contextTokens, contextWindow, settings))
    return await this._runAutoCompaction("threshold", false);
```
`calculateContextTokens` (compaction.js:86-88) returns 0 for zero/all-zero usage;
`estimateContextTokens` (compaction.js:131-157) walks back through the message list for the last
assistant message with non-zero usage (`getAssistantUsage` skips aborted/error/all-zero usage)
and returns `lastUsageIndex: null` when **none exists**. The function *does* compute a
pure-estimate fallback — the sum of `estimateTokens` (chars/4) across all messages — but the
caller **discards it** via the `return false` early exit. The pre-prompt call
(`skipAbortedCheck === false`, agent-session.js:~865) takes the same path, so the blind spot
holds for the pre-prompt check too.

`shouldCompact` (compaction.js:160-165) is the plain threshold:
`contextTokens > contextWindow - reserveTokens`, with
`DEFAULT_COMPACTION_SETTINGS = { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 }`
(compaction.js:74-77).

## Confirmed premises (ruled out as the cause)

- **Compaction is enabled in Fusion chat/CLI sessions.** `createFnAgent` builds the pi session
  with `SettingsManager.inMemory({ compaction: { enabled: true }, ... })`
  (`packages/engine/src/pi.ts:2538`); pi's default is `enabled: true` anyway. Not the problem.
- **`contextWindow` propagates correctly.** Custom-provider models (dsai1 included) are
  registered via `buildCustomProviderModels` with a hardcoded `contextWindow: 128000,
  maxTokens: 16384` (`packages/engine/src/auth/custom-provider-registry.ts:97-98`) into the
  pi-ai `ModelRegistry`. The observed 111,616 threshold (128,000 − 16,384) matches exactly — if
  `contextWindow` were missing (0), the threshold would be negative and compaction would
  over-fire, which is not observed.
- **pi-ai requests usage.** The openai-completions adapter sends
  `stream_options: { include_usage: true }` (pi-ai `dist/api/openai-completions.js:530`) and
  parses `chunk.usage ?? choice.usage` when present (lines 315-324). dsai1's
  OpenAI-compatible gateway does not return a final usage block, so every assistant message
  lands with zero/missing usage — precisely the condition that makes case 2's early return
  permanent.
- **The session DOES load file history.** A fresh pi session loads the persisted messages
  (`dist/core/sdk.js:233`), so the check would fire had usage data existed — the repro's
  107K first call proves the history was present; only the usage data was absent.

## Evidence

- **Step 1 diagnosis** (task document `step1-root-cause`, rev 1, 2026-08-18): mechanism
  verified line-by-line against pi 0.84.1 in the worktree's `node_modules`; premises above
  ruled out by source.
- **13-call progression from the live repro** (chat-a4921d83, dsai1/deepseek-v4,
  registered `contextWindow=128,000`): 107,295 -> 107,777 -> 112,232 -> 114,686 -> 115,168 ->
  115,748 -> 116,339 -> 116,866 -> 119,646 -> 120,716 -> 122,715 (stop=length) -> 122,724
  (stop=length) -> 124,001 → output "The" (1 token), `stop_reason=length`. Turns 3-10 all ran
  above the 111,616 threshold with zero compaction events.
- **Scripted stand-in** (exact repro session files inaccessible — privileged `~/.fusion/agent/sessions`):
  engine unit tests drive the gate with a fake pi-shaped session whose `getContextUsage()`
  reports the zero-usage dsai1 shape (usage null/zero, only the chars/4 estimate available) and
  assert compaction fires pre-prompt — the exact failure mode pi's own check cannot see.
- Residual verification (optional, cheap): capture one raw dsai1 stream to record the absent
  usage field as hard evidence.

## The fix (RUFU-118, B.1 phase 1)

A deterministic **Fusion-owned compaction gate before every model-loop LLM call** on the
chat/CLI path — deliberately NOT a pi patch:

- **Module:** `packages/engine/src/chat-context-guard.ts` — `computeCompactionThreshold`,
  `estimateLoadedContextTokens`, `ensureContextWithinCompactionThreshold`, and
  `ChatContextOverflowError` (code `CHAT_CONTEXT_OVERFLOW`, non-retryable `PermanentError`),
  exported from `@fusion/engine`.
- **Threshold:** `min(tokenCap ?? round(0.8 × contextWindow), contextWindow − max(16384,
  model.maxTokens))`. Default 80% of the window (102,400 for a 128K model); always leaves
  ≥ max(16,384, maxTokens) headroom so a normal reply completes after compaction. Unknown
  (zero/negative) window or degenerate tokenCap → `null` → the gate is a no-op (never guesses
  a window).
- **Estimation:** provider usage from `getContextUsage()` when present; otherwise pi's
  deterministic chars/4 `estimateTokens` over the loaded messages (the value pi's
  `estimateContextTokens` already computes and discards). A throwing usage reader falls back
  to the estimate rather than crashing the send path.
- **Seams:** `ChatManager.sendMessage` (`packages/dashboard/src/chat.ts:2918`, after the
  session is created and the abort check, strictly before `enginePromptWithFallback`) and
  `ChatManager.generateRoomResponderReply` (`chat.ts:2218`, before the responder prompt).
  Because the gate measures the file-loaded history, the **first post-resume call is covered**
  (chat-89c03553's ~125K resume wedge).
- **Fail-loud contract:** if the session compacts and the re-measured context is still at or
  above the hard limit, or compaction returns no result, `ensureContextWithinCompactionThreshold`
  throws `ChatContextOverflowError` **before the prompt is sent** — the over-window call never
  goes out. `sendMessage`'s dedicated catch persists a chat-visible assistant failure message
  (`failureInfo.code=CHAT_CONTEXT_OVERFLOW`, `errorClass=ChatContextOverflowError`) and
  broadcasts the error event; the room path surfaces via `RoomReplyGenerationError` → 502.
- **`tokenCap` dual-lane semantics:** on the executor lane (existing `TokenCapDetector`,
  unchanged) `tokenCap` is an optional pre-overflow cap, `undefined` = disabled (overflow
  errors only). On the chat lane (new) it is an **upper bound on the compaction threshold**,
  `undefined` = 80% default; values above the hard limit are clamped. Documented in
  `settings-scope.ts` JSDoc, the Settings UI help text, and i18n (en/pt-BR).
- **Tests:** 30 engine unit tests (threshold math incl. clamps and degenerate inputs,
  estimation with usage/estimate/throwing-reader/no-state variants, gate seam incl. the
  zero-usage dsai1-shape blind-spot variant) and 7 dashboard seam tests (real `ChatManager` +
  real gate with fake pi session and mocked engine prompt seam: below-threshold no-op,
  threshold compaction, fail-loud persistence, tokenCap upper bound, non-pi session skip).

## Why there is no double-compaction

The gate (chat sessions, pre-prompt) and `TokenCapDetector` (executor task sessions,
post-prompt, only when `tokenCap` is set) operate on **disjoint session lifecycles**: the
dashboard never references the detector (0 `checkAndCompact` references in
`packages/dashboard/src`), and no executor code calls the gate. A chat session is never an
executor session and vice versa.

## Known limitation

**CLI-agent/PTY chat cannot be compacted by Fusion.** The `cliExecutorAdapterId` early branch
in `sendMessage` (CLI-agent sessions run in their own PTY process) is deliberately untouched:
the gate requires a live pi `AgentSession` object in-process, which the PTY path does not
expose. PTY-backed chats still rely on pi's own (blind-spot-limited) compaction; the out-of-scope
follow-ups filed with RUFU-118 (per-model window metadata for custom providers, and the upstream
note about the `_checkCompaction` blind spot) have since landed as RUFU-123 (per-model
`contextWindow`/`maxTokens` on custom-provider settings, registered by
`buildCustomProviderModels` with 128000/16384 fallback) and RUFU-127 (upstream pi#8328 note),
respectively.

## References

- Requirement + gap analysis: `docs/research/volt-lcm-analysis.md` (B.1 "Nikdy nepretečie",
  section 11 gap table).
- pi 0.84.1: `dist/core/agent-session.js:1523-1603` (`_checkCompaction`),
  `dist/core/compaction/compaction.js:74-77,86-88,131-157,160-165` (settings,
  `calculateContextTokens`, `estimateContextTokens`, `shouldCompact`),
  `dist/utils/overflow.js:130-165` (`isContextOverflow`, `isRecoverableLength`),
  `dist/api/openai-completions.js:315-324,530` (usage parse / `include_usage` request).
- Fusion: `packages/engine/src/chat-context-guard.ts` (gate), `packages/dashboard/src/chat.ts`
  (seams + fail-loud surfacing), `packages/engine/src/pi.ts:2538` (compaction enabled),
  `packages/engine/src/auth/custom-provider-registry.ts:119-120` (per-model custom-provider
  window with 128000/16384 fallback, RUFU-123), `packages/engine/src/errors/token-cap-detector.ts` (executor-only, unchanged).
