# Task: FN-668 - Fix Claude CLI credentials detection in usage dropdown

**Created:** 2026-04-01
**Size:** S

## Review Level: 1 (Plan Only)

**Assessment:** The fix is straightforward - add macOS keychain credential reading to the existing Claude usage fetcher. The change is localized to one file with clear test expectations.
**Score:** 3/8 — Blast radius: 1, Pattern novelty: 1, Security: 1, Reversibility: 0

## Mission

The Claude usage indicator in the dashboard shows "No Claude CLI credentials — run 'claude' to login" even when the user is already logged in. This happens because modern Claude Code (the CLI tool) stores credentials in macOS keychain instead of the legacy `~/.claude/.credentials.json` file that the code currently expects.

This task adds support for reading Claude credentials from macOS keychain when the credential files don't exist, ensuring the usage dropdown correctly detects authenticated users.

## Dependencies

- **None**

## Context to Read First

- `packages/dashboard/src/usage.ts` — The usage fetching module containing `fetchClaudeUsage()` function that needs updating
- `packages/dashboard/src/usage.test.ts` — Existing tests showing expected behavior for Claude provider

## File Scope

- `packages/dashboard/src/usage.ts` — Modify `fetchClaudeUsage()` to read from macOS keychain as fallback
- `packages/dashboard/src/usage.test.ts` — Add tests for keychain credential reading

## Steps

### Step 1: Investigate Keychain Credential Format

- [ ] Determine the exact format of credentials stored in macOS keychain for "Claude Code-credentials" service
- [ ] Check if the keychain entry is a JSON blob or encoded data that needs decoding
- [ ] Verify the structure matches what's expected (accessToken, scopes, etc.)

**Notes:** The keychain entry for "Claude Code-credentials" can be read via `security find-generic-password -s "Claude Code-credentials" -w`. The output may be base64-encoded JSON.

### Step 2: Implement Keychain Credential Reading

- [ ] Add macOS keychain reading capability to `fetchClaudeUsage()` in `packages/dashboard/src/usage.ts`
- [ ] Use `child_process.execFile` or similar to run `security find-generic-password -s "Claude Code-credentials" -w`
- [ ] Handle the output properly (may need base64 decode if encoded)
- [ ] Maintain fallback chain: 1) Legacy file paths, 2) macOS keychain, 3) No auth
- [ ] Parse the credential JSON and extract `accessToken`, `scopes`, `subscriptionType`/`rateLimitTier` for plan detection

**Artifacts:**
- `packages/dashboard/src/usage.ts` (modified)

### Step 3: Add Tests for Keychain Credentials

- [ ] Add test case for successful keychain credential reading
- [ ] Add test case for keychain command failure (falls back to no-auth)
- [ ] Mock `child_process` execution in tests to avoid actual keychain access
- [ ] Ensure tests verify the credential parsing logic works correctly

**Artifacts:**
- `packages/dashboard/src/usage.test.ts` (modified)

### Step 4: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run `pnpm test` in `packages/dashboard` directory
- [ ] Verify all existing tests still pass
- [ ] Verify new keychain tests pass
- [ ] Build passes with `pnpm build`

### Step 5: Documentation & Delivery

- [ ] Add changeset file for the fix (patch bump for `@gsxdsm/fusion`)
- [ ] Verify no out-of-scope findings

## Documentation Requirements

**Check If Affected:**
- `AGENTS.md` — No changes needed, this is a bug fix not a feature change

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] Claude usage detection works for both legacy file-based and modern keychain-based credentials

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(FN-668): complete Step N — description`
- **Bug fixes:** `fix(FN-668): description`
- **Tests:** `test(FN-668): description`

## Do NOT

- Expand task scope to other providers (Codex, Gemini, etc.)
- Change the usage API response format
- Modify the dashboard UI components
- Skip tests for the keychain reading functionality
- Remove support for legacy credential file paths
