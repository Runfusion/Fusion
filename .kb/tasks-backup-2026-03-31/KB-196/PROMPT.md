# Task: KB-196 - Fix model selector to show all available models from extensions

**Created:** 2026-03-30
**Size:** M

## Review Level: 2 (Plan and Code)

**Assessment:** The fix requires understanding the pi-coding-agent extension system and ModelRegistry integration. Changes are isolated to dashboard server initialization but involve third-party API surface.
**Score:** 5/8 — Blast radius: 1, Pattern novelty: 2, Security: 1, Reversibility: 1

## Mission

Fix the dashboard model selector to include models registered by extensions (like pi-claude-cli). Currently, the dashboard creates a standalone `ModelRegistry` that only loads built-in models and custom models from `models.json`, missing any providers dynamically registered by extensions via `pi.registerProvider()`.

## Dependencies

- **None**

## Context to Read First

1. `/Users/eclipxe/Projects/kb/packages/cli/src/commands/dashboard.ts` — Where `ModelRegistry` is instantiated and passed to the dashboard server
2. `/Users/eclipxe/Projects/kb/packages/dashboard/src/routes.ts` — The `registerModelsRoute` function and `ModelRegistryLike` interface
3. `/Users/eclipxe/Projects/kb/packages/dashboard/src/server.ts` — Server creation and options handling
4. `/Users/eclipxe/.pi/agent/models.json` — Example custom models file (shows extension-registered providers are missing)
5. `/Users/eclipxe/.pi/agent/git/github.com/mitsuhiko/agent-stuff/node_modules/@mariozechner/pi-coding-agent/examples/extensions/custom-provider-anthropic/index.ts` — Example of how extensions register providers

## File Scope

- `packages/cli/src/commands/dashboard.ts` — Modify to load extensions and apply provider registrations to ModelRegistry
- `packages/dashboard/src/routes.ts` — Add error handling for model loading failures
- `packages/dashboard/src/server.ts` — No changes needed (receives registry via options)

## Steps

### Step 1: Extension Discovery and Loading

- [ ] Import `discoverAndLoadExtensions` from `@mariozechner/pi-coding-agent`
- [ ] Import `createExtensionRuntime` from `@mariozechner/pi-coding-agent`
- [ ] After creating `ModelRegistry` in `runDashboard()`, call `discoverAndLoadExtensions` with:
  - `configuredPaths: []` (empty array - discover from standard locations)
  - `cwd: process.cwd()`
  - `agentDir: undefined` (use default ~/.pi/agent)
- [ ] Apply pending provider registrations from the loaded extensions' runtime to the ModelRegistry
- [ ] Handle errors gracefully - log extension loading errors but don't fail server startup

**Artifacts:**
- `packages/cli/src/commands/dashboard.ts` (modified)

### Step 2: Error Handling and Edge Cases

- [ ] Add try/catch around extension loading to prevent server crash on extension errors
- [ ] Log extension loading errors with console.log (not console.error to avoid noise)
- [ ] Ensure modelRegistry.refresh() is called after applying extension providers
- [ ] Handle case where no extensions are found (should still work with built-in models)
- [ ] Verify that duplicate provider registrations are handled correctly (later registrations override earlier ones)

**Artifacts:**
- `packages/cli/src/commands/dashboard.ts` (modified)

### Step 3: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run full test suite: `pnpm test`
- [ ] Verify dashboard tests pass: `pnpm test -- packages/dashboard`
- [ ] Manually verify the `/api/models` endpoint returns extension-registered models by checking the network response in browser dev tools
- [ ] If pi-claude-cli is installed, verify anthropic models appear in the response

**Verification approach:** Since we can't guarantee pi-claude-cli is installed in CI, the test should verify:
1. The endpoint returns an array
2. The model objects have correct shape: `{ provider, id, name, reasoning, contextWindow }`
3. Extension loading errors don't crash the server

### Step 4: Documentation & Delivery

- [ ] Update `AGENTS.md` if there are any relevant model/extension configuration notes
- [ ] Create changeset for patch release: `.changeset/fix-model-selector-extensions.md`
- [ ] Verify the fix works by checking that the dashboard model selector shows all expected models

**Artifacts:**
- `.changeset/fix-model-selector-extensions.md` (new)

## Documentation Requirements

**Must Update:**
- None (internal fix, no user-facing behavior change beyond the bug fix)

**Check If Affected:**
- `AGENTS.md` — Check if there's any documentation about model selection that needs updating

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] Dashboard `/api/models` endpoint returns models from extensions (verified manually if pi-claude-cli is available)
- [ ] Extension loading errors don't crash the server
- [ ] Changeset file included

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-196): complete Step N — description`
- **Bug fixes:** `fix(KB-196): description`
- **Tests:** `test(KB-196): description`

## Do NOT

- Modify the ModelRegistry class itself (it's from an external package)
- Add new dependencies (use existing `@mariozechner/pi-coding-agent` exports)
- Change the model selector UI components
- Remove or change existing model loading behavior
- Require manual configuration from users
- Break existing built-in model loading

## Implementation Notes

The key insight is that extensions register providers via `pi.registerProvider()` during their initialization. These registrations are stored in `runtime.pendingProviderRegistrations` and normally applied when `ExtensionRunner.bindCore()` is called. Since the dashboard doesn't need a full ExtensionRunner, we need to manually apply these registrations to the ModelRegistry.

Example of applying pending registrations:
```typescript
const { runtime, errors } = await discoverAndLoadExtensions([], cwd, agentDir);

// Apply provider registrations from extensions
for (const reg of runtime.pendingProviderRegistrations) {
  modelRegistry.registerProvider(reg.name, reg.config);
}

// Log any extension loading errors (non-fatal)
for (const error of errors) {
  console.log(`[extensions] Failed to load ${error.path}: ${error.error}`);
}
```

After applying registrations, call `modelRegistry.refresh()` to ensure all models are loaded.

**Type Safety:** The `pendingProviderRegistrations` array contains objects with:
- `name: string` — Provider name
- `config: ProviderConfig` — Provider configuration including models
- `extensionPath: string` — Source extension path

The `ProviderConfig` type includes `models` array which defines the models that should appear in the selector.
