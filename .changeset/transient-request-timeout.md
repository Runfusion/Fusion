---
"@runfusion/fusion": patch
---

summary: Provider request timeouts now retry with backoff instead of looping planning forever.
category: fix
dev: Adds `/\brequest timed out\b/i` and `/\bAPIConnectionTimeoutError\b/i` to `TRANSIENT_ERROR_PATTERNS` (`packages/engine/src/errors/transient-error-patterns.ts`). The Anthropic/OpenAI SDK `APIConnectionTimeoutError` default message `"Request timed out."` matched no pattern, so it fell through to `specifyTask`'s generic failure branch which restores `status: null` with no counter and no `nextRecoveryAt` — triage rediscovery then re-admitted the card every poll indefinitely. Now routes into the bounded `MAX_RECOVERY_RETRIES` (3) + 60s/120s/300s backoff policy. Pattern is anchored to "request timed out" rather than a bare timeout match so agent prose and verification output ("BuildKit timed out", "Test suite timed out after 30000ms") stay permanent. Does not affect model fallback, which pi decides internally.
