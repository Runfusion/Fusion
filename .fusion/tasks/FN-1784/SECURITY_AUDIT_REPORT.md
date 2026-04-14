# Security Audit Report — Fusion Monorepo

**Task:** FN-1784  
**Date:** 2026-04-14  
**Auditor:** AI Agent  
**Scope:** `@fusion/core`, `@fusion/dashboard`, `@fusion/engine`, `@gsxdsm/fusion`

---

## Executive Summary

The Fusion monorepo demonstrates a **generally strong security posture** with several well-implemented security controls. Key strengths include robust path traversal prevention in file operations, HMAC-SHA256 webhook signature verification with timing-safe comparison, git ref validation to prevent command injection, async execution of user-configured commands with timeouts, and parameterized SQLite queries throughout the database layer.

The audit identified **3 findings requiring attention**: one **Medium** severity issue (lack of request body size limits on text-based endpoints), and two **Info/Low** severity observations related to rate limiting coverage and potential information disclosure through error messages. No Critical or High severity vulnerabilities were identified.

The codebase demonstrates security awareness through:
- Path boundary validation via `validatePath()` in `file-service.ts`
- Git ref sanitization via `isValidBranchName()` and `isValidGitRef()` in `routes.ts`
- Proper use of `timingSafeEqual` for HMAC verification in `github-webhooks.ts`
- Async `exec` with timeouts for user-configured commands in `executor.ts`
- Parameterized SQL queries throughout `store.ts`

---

## Findings

### [MEDIUM] Missing Request Body Size Limits on Text-Based API Endpoints

- **Severity:** Medium
- **Category:** Rate Limiting / DoS Resilience
- **Location:** `packages/dashboard/src/routes.ts:2800-2840`
- **Description:** Several text input endpoints accept large strings without enforcing content-length limits, potentially enabling resource exhaustion attacks via oversized payloads.
- **Evidence:** 
  - `POST /tasks/:id/comments` accepts `text` up to 2000 characters (validated at lines 2786-2788), but no raw request body size limit
  - `PUT /tasks/:id/documents/:key` accepts `content` up to 100000 characters (validated at line 3350), but no raw request body size limit
  - `POST /memory` (PUT route) accepts arbitrary string content without size validation
  - The multer middleware only limits file uploads (`5MB` at line 95), not JSON/text payloads
- **Recommendation:** Add global JSON body size limits via Express middleware configuration:
  ```typescript
  app.use(express.json({ limit: '1mb' }));
  ```
  Also consider adding explicit `content-length` validation headers where oversized payloads could cause denial of service.

---

### [LOW] Rate Limiting Gaps on Bulk Operations

- **Severity:** Low
- **Category:** Rate Limiting / DoS Resilience
- **Location:** `packages/dashboard/src/routes.ts:2710-2770`
- **Description:** Certain endpoints that create multiple resources or perform bulk operations lack specific rate limiting, potentially enabling abuse.
- **Evidence:**
  - `POST /planning/start-breakdown` generates multiple tasks without per-session rate limiting
  - `POST /tasks/batch-update-models` updates multiple tasks but uses the standard mutation rate limit (30 req/min)
  - `POST /api/ai/summarize-title` endpoint lacks specific rate limiting despite AI service costs
  - `POST /api/subtasks/start-streaming` has no per-session rate limit
- **Recommendation:** Consider adding endpoint-specific rate limits for expensive operations:
  ```typescript
  const summarizationLimit = rateLimit({ windowMs: 60_000, max: 10 });
  app.post('/api/ai/summarize-title', summarizationLimit, ...);
  ```
  The existing rate limiter in `rate-limit.ts` supports custom configurations per endpoint.

---

### [INFO] In-Memory Rate Limiter Memory Footprint

- **Severity:** Info
- **Category:** Rate Limiting / DoS Resilience
- **Location:** `packages/dashboard/src/rate-limit.ts:55-70`
- **Description:** The sliding-window rate limiter stores all client records in memory without persistent cleanup of expired entries beyond periodic garbage collection.
- **Evidence:**
  ```typescript
  const clients = new Map<string, ClientRecord>();
  const cleanup = setInterval(() => { /* cleanup expired */ }, windowMs);
  ```
  Under high traffic with many unique IPs, the client map could grow unbounded between cleanup cycles.
- **Recommendation:** The current implementation is acceptable for typical usage patterns. If Fusion serves high-traffic deployments with thousands of unique client IPs, consider:
  1. Adding a maximum map size with LRU eviction
  2. Using Redis-backed rate limiting for distributed deployments
  3. Reducing the cleanup interval

---

### [INFO] SQL Error Messages in Development Mode

- **Severity:** Info
- **Category:** Information Disclosure
- **Location:** `packages/dashboard/src/server.ts:380-400`
- **Description:** Error messages from SQLite/database errors are returned to clients in development mode, which could leak schema information.
- **Evidence:**
  ```typescript
  const message = process.env.NODE_ENV === "production"
    ? fallbackMessage
    : err instanceof Error && err.message
      ? err.message
      : fallbackMessage;
  ```
  When `NODE_ENV !== "production"`, raw error messages are returned, which may include SQLite constraint violations, table names, or query details.
- **Recommendation:** The production fallback is correctly implemented. For additional defense-in-depth:
  1. Consider sanitizing error messages in `store.ts` to strip SQL-specific details before throwing
  2. Add a test that verifies production mode strips SQL error details
  3. Log full error details server-side for debugging while returning generic messages to clients

---

### [INFO] Webhook Replay Attack Prevention

- **Severity:** Info
- **Category:** Webhook Security
- **Location:** `packages/dashboard/src/github-webhooks.ts:65-90`
- **Description:** The webhook verification correctly validates HMAC signatures but does not implement explicit replay attack prevention (e.g., timestamp validation or nonce tracking).
- **Evidence:** `verifyWebhookSignature()` only checks that the signature matches, not whether the webhook is a replay of a previously processed event.
- **Recommendation:** GitHub webhooks include an `X-Hub-Signature-256` header that provides cryptographic integrity. For most use cases, the HMAC verification is sufficient. If replay attacks are a concern:
  1. Store recent webhook event IDs with a TTL (e.g., last 5 minutes)
  2. Reject webhooks with duplicate event IDs within the TTL window
  3. Note: GitHub already timestamps webhooks and recommends rejecting requests older than 5 minutes

---

## Positive Security Controls

The following security controls are implemented well and should be maintained:

### 1. Path Traversal Prevention in File Operations
- **Location:** `packages/dashboard/src/file-service.ts:170-210`
- **Implementation:** The `validatePath()` function performs comprehensive path validation:
  - Rejects null bytes and absolute paths
  - Resolves paths against base directory
  - Verifies resolved path starts with base using `relative()` comparison
  - Blocks `../` traversal attempts

### 2. Git Ref Sanitization
- **Location:** `packages/dashboard/src/routes.ts:700-725`, `packages/dashboard/src/routes.ts:770-800`
- **Implementation:** `isValidBranchName()` and `isValidGitRef()` validate all user-supplied git references against allowlist patterns:
  - Blocks shell metacharacters (`;`, `<`, `>`, `&`, `|`, backticks, `$`, etc.)
  - Prevents whitespace and option-prefixed values
  - Validates against reserved git ref names

### 3. HMAC-SHA256 Webhook Signature Verification
- **Location:** `packages/dashboard/src/github-webhooks.ts:65-90`
- **Implementation:** Uses `timingSafeEqual` for constant-time signature comparison, preventing timing attacks:
  ```typescript
  if (!timingSafeEqual(signatureBuffer, expectedBuffer)) {
    return { valid: false, error: "Signature mismatch" };
  }
  ```

### 4. Async Command Execution with Timeouts
- **Location:** `packages/engine/src/executor.ts:1-30`
- **Implementation:** User-configured commands (`testCommand`, `buildCommand`, `setupScript`) use async `exec` with explicit timeouts, preventing process stalls:
  ```typescript
  import { promisify } from "node:util";
  const execAsync = promisify(exec);
  // Used with timeout in all user-command execution paths
  ```

### 5. Parameterized SQLite Queries
- **Location:** `packages/core/src/store.ts:600-700`
- **Implementation:** All database operations use parameterized queries with `?` placeholders:
  ```typescript
  this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  ```
  This prevents SQL injection throughout the data layer.

### 6. Multi-Project Path Validation
- **Location:** `packages/core/src/central-core.ts` (project registration)
- **Implementation:** Project registration validates absolute paths, preventing path traversal during project registration. Path validation ensures registered projects are within expected directories.

### 7. Checkout Leasing Conflict Detection
- **Location:** `packages/dashboard/src/routes.ts:3900-3950`
- **Implementation:** Checkout conflicts return HTTP 409 with structured error response:
  ```typescript
  res.status(409).json({
    error: "Task is already checked out",
    currentHolder: err.currentHolderId,
    taskId: err.taskId,
  });
  ```
  This prevents race conditions in task ownership.

---

## Recommendations Summary

Ranked by priority for follow-up tasks:

### 1. Add Global JSON Body Size Limits (Medium Priority)
**File:** `packages/dashboard/src/server.ts`  
**Action:** Configure `express.json()` with explicit size limits to prevent oversized payload DoS attacks.  
**Effort:** Low — single line configuration change.

### 2. Add Endpoint-Specific Rate Limits for Expensive AI Operations (Low Priority)
**Files:** `packages/dashboard/src/routes.ts`, `packages/dashboard/src/ai-summarize.ts`  
**Action:** Add specific rate limits for AI endpoints (`/api/ai/summarize-title`, `/planning/*`, `/subtasks/*`) to prevent abuse of expensive model calls.  
**Effort:** Low — existing rate limiter infrastructure can be reused.

### 3. Sanitize Database Error Messages (Low Priority)
**File:** `packages/core/src/store.ts`  
**Action:** Wrap database operations to sanitize error messages before throwing, stripping SQL-specific details (table names, constraint names, column names) for production builds.  
**Effort:** Medium — requires wrapping error handling across the store.

### 4. Consider Webhook Replay Prevention (Informational)
**File:** `packages/dashboard/src/github-webhooks.ts`  
**Action:** If webhook replay attacks are a threat model concern, implement event ID tracking with TTL. For most deployments, HMAC verification alone is sufficient.  
**Effort:** Medium — requires persistent storage for event IDs.

### 5. Document Security Considerations in Project Memory (Informational)
**File:** `.fusion/memory.md`  
**Action:** Add a "Security Considerations" section documenting the security architecture, trusted boundaries, and known security-related patterns for future developers.  
**Effort:** Low — documentation only.

---

## Appendix: Files Reviewed

| Package | File | Purpose |
|---------|------|---------|
| `@fusion/dashboard` | `src/routes.ts` | API route definitions, input validation, git operations |
| `@fusion/dashboard` | `src/server.ts` | Server initialization, middleware, WebSocket setup |
| `@fusion/dashboard` | `src/file-service.ts` | File read/write/move/delete operations |
| `@fusion/dashboard` | `src/rate-limit.ts` | Rate limiting configuration |
| `@fusion/dashboard` | `src/github-webhooks.ts` | Webhook signature verification |
| `@fusion/core` | `src/store.ts` | TaskStore, SQLite operations, path handling |
| `@fusion/core` | `src/plugin-loader.ts` | Plugin loading, dynamic imports, hook isolation |
| `@fusion/engine` | `src/executor.ts` | Agent execution, worktree creation, tool boundaries |
| `@fusion/engine` | `src/merger.ts` | Merge logic, git operations |
| `@fusion/cli` | `src/commands/serve.ts` | Headless node startup, `/api/health` endpoint |

---

*Report generated by AI security audit agent for FN-1784*
