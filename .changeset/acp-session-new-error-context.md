---
"@runfusion/fusion": patch
---

summary: Include the scoping cwd and JSON-RPC diagnostic when the ACP runtime's session/new fails.

category: fix
dev: `newAcpSession` rethrew raw SDK errors, so a rejected `session/new` surfaced only the bare protocol message (typically "Invalid params" / -32602) with no indication of which agent binary rejected it, why, or which cwd scoped the failing session. The helper now wraps the rejection with the same `describeAcpTurnError` contract as `promptAcpSession`, prefixing `session/new failed (cwd <cwd>):` so operators can immediately tell a misconfigured spawn target from an agent-side fault. The original error is retained as `cause`. The message intentionally does not match `ACP_TRANSIENT_ERROR_PATTERNS` (caller-fault codes are non-retryable). Tests pin the message shape, cwd inclusion, and cause retention across flat/nested RPC envelopes, retryable and caller-fault codes, structured data payloads, and non-RPC passthrough.
