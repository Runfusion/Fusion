# Task: KB-295 - Add Favorite Models Feature

**Created:** 2026-03-31
**Size:** M

## Review Level: 1 (Plan Only)

**Assessment:** This is a straightforward UI enhancement adding a favorites system for AI models. The blast radius is limited to the model dropdown component and global settings. The pattern is well-established (similar to model presets). Reversibility is simple (remove favoriteModels field from settings).
**Score:** 3/8 — Blast radius: 1, Pattern novelty: 0, Security: 1, Reversibility: 1

## Mission

Add a "favorite models" feature that allows users to star their preferred AI models. Favorited models appear at the top of model dropdown lists for quick access. This improves the UX for users who frequently switch between a small set of preferred models across different providers.

## Dependencies

- **None**

## Context to Read First

1. `packages/core/src/types.ts` — GlobalSettings interface and DEFAULT_GLOBAL_SETTINGS
2. `packages/core/src/global-settings.ts` — GlobalSettingsStore implementation
3. `packages/dashboard/app/components/CustomModelDropdown.tsx` — Model dropdown component
4. `packages/dashboard/app/api.ts` — API functions including fetchModels
5. `packages/dashboard/src/routes.ts` — API routes (search for `registerModelsRoute` and `/settings/global`)
6. `packages/dashboard/app/styles.css` — Search for `.model-combobox` CSS classes

## File Scope

- `packages/core/src/types.ts` — Add favoriteModels to GlobalSettings and DEFAULT_GLOBAL_SETTINGS
- `packages/core/src/global-settings.ts` — No changes needed (handles arbitrary JSON)
- `packages/dashboard/src/routes.ts` — Add favorite models API endpoints
- `packages/dashboard/app/api.ts` — Add API functions for managing favorites
- `packages/dashboard/app/components/CustomModelDropdown.tsx` — Add star buttons and favorite sorting
- `packages/dashboard/app/styles.css` — Add CSS for star buttons and favorite section

## Steps

### Step 1: Update Core Types and Defaults

- [ ] Add `favoriteModels?: string[]` to `GlobalSettings` interface in `packages/core/src/types.ts`
  - Array of model identifiers in format `"provider/modelId"` (e.g., `["anthropic/claude-sonnet-4-5", "openai/gpt-4o"]`)
- [ ] Add `favoriteModels: undefined` to `DEFAULT_GLOBAL_SETTINGS` in `packages/core/src/types.ts`
- [ ] Add `"favoriteModels"` to `GLOBAL_SETTINGS_KEYS` array in `packages/core/src/types.ts`
- [ ] Run `pnpm typecheck` to verify no type errors

**Artifacts:**
- `packages/core/src/types.ts` (modified)

### Step 2: Add Backend API Endpoints

- [ ] Add `GET /api/models/favorites` endpoint in `packages/dashboard/src/routes.ts`
  - Returns `{ favorites: string[] }` from global settings
- [ ] Add `POST /api/models/favorites` endpoint
  - Body: `{ modelId: string }` (format: "provider/modelId")
  - Adds model to favorites if not already present
  - Returns `{ favorites: string[] }`
- [ ] Add `DELETE /api/models/favorites/:modelId` endpoint
  - URL-encoded modelId param (e.g., `anthropic%2Fclaude-sonnet-4-5`)
  - Removes model from favorites
  - Returns `{ favorites: string[] }`
  - Returns 404 if model not in favorites
- [ ] Add validation: modelId must match format `provider/modelId` with non-empty provider and modelId

**Artifacts:**
- `packages/dashboard/src/routes.ts` (modified)

### Step 3: Add Frontend API Functions

- [ ] Add `fetchFavoriteModels(): Promise<string[]>` in `packages/dashboard/app/api.ts`
- [ ] Add `addFavoriteModel(modelId: string): Promise<string[]>` in `packages/dashboard/app/api.ts`
- [ ] Add `removeFavoriteModel(modelId: string): Promise<string[]>` in `packages/dashboard/app/api.ts`
- [ ] Add tests for new API functions in `packages/dashboard/app/api.test.ts`

**Artifacts:**
- `packages/dashboard/app/api.ts` (modified)
- `packages/dashboard/app/api.test.ts` (modified)

### Step 4: Update CustomModelDropdown Component

- [ ] Add `favoriteModels?: string[]` prop to `CustomModelDropdownProps` interface
- [ ] Add `onToggleFavorite?: (modelId: string, isFavorite: boolean) => void` prop
- [ ] Add `showFavorites?: boolean` prop (default true)
- [ ] Sort models in dropdown: favorites first (sorted alphabetically), then non-favorites (grouped by provider)
- [ ] Add star button next to each model in the dropdown list
  - Filled star (★) for favorited models
  - Empty star (☆) for non-favorited models
  - Clicking toggles favorite status via `onToggleFavorite`
- [ ] Add "Favorites" section header at the top of the dropdown when favorites exist
- [ ] Ensure keyboard navigation works correctly with the new ordering
- [ ] Add `data-testid` attributes for testing:
  - `favorite-star-{modelId}` for star buttons
  - `favorite-section` for favorites group header

**Artifacts:**
- `packages/dashboard/app/components/CustomModelDropdown.tsx` (modified)

### Step 5: Add CSS Styling

Add to `packages/dashboard/app/styles.css`:

- [ ] `.model-combobox-favorite-btn` — Star button styling
  - Position: absolute right side of model option row
  - Size: 24px × 24px
  - Background: transparent
  - Border: none
  - Cursor: pointer
  - Opacity: 0.6 normally, 1.0 on hover
- [ ] `.model-combobox-favorite-btn--active` — Filled star state
  - Color: `var(--kb-accent, #f59e0b)` (amber/gold)
- [ ] `.model-combobox-favorite-btn--inactive` — Empty star state
  - Color: `var(--kb-text-muted, #6b7280)`
- [ ] `.model-combobox-favorites-header` — Favorites section header
  - Padding: 8px 12px
  - Font-size: 11px
  - Text-transform: uppercase
  - Letter-spacing: 0.5px
  - Color: `var(--kb-text-muted)`
  - Border-bottom: 1px solid `var(--kb-border)`

**Artifacts:**
- `packages/dashboard/app/styles.css` (modified)

### Step 6: Integrate in ModelSelectorTab

- [ ] In `packages/dashboard/app/components/ModelSelectorTab.tsx`:
  - Load favorites via `fetchFavoriteModels()` on mount (alongside `fetchModels()`)
  - Pass `favoriteModels` and `onToggleFavorite` to both `CustomModelDropdown` instances
  - Implement `handleToggleFavorite` that calls `addFavoriteModel` or `removeFavoriteModel`
  - Update local favorites state after successful API calls
  - Show toast notification: "Added to favorites" / "Removed from favorites"

**Artifacts:**
- `packages/dashboard/app/components/ModelSelectorTab.tsx` (modified)

### Step 7: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run `pnpm test` — all tests must pass
- [ ] Add tests for favorite models API in `packages/dashboard/src/routes.test.ts`:
  - GET /api/models/favorites returns array
  - POST adds model to favorites
  - DELETE removes model from favorites
  - DELETE returns 404 for non-existent favorite
  - Validation rejects invalid modelId format
- [ ] Add tests in `packages/dashboard/app/components/__tests__/CustomModelDropdown.test.tsx`:
  - Favorites appear first in the list
  - Star buttons render for each model
  - Clicking star calls onToggleFavorite with correct args
  - Filled star shown for favorited models
  - Empty star shown for non-favorited models
- [ ] Manual verification:
  - Open task detail modal → Model tab
  - Open executor model dropdown
  - Click star next to a model
  - Verify model moves to favorites section
  - Close and reopen dropdown — favorites still at top
  - Remove favorite — model returns to provider group

**Artifacts:**
- Test files (modified)

### Step 8: Documentation & Delivery

- [ ] Update `AGENTS.md` — Add `favoriteModels` to the Global Settings section
- [ ] Create changeset: `.changeset/add-favorite-models.md`
  - Bump: `minor` (new feature)
  - Description: "Add ability to star AI models as favorites for quick access in model selectors"
- [ ] Verify all tests pass: `pnpm test`
- [ ] Verify build passes: `pnpm build`

**Artifacts:**
- `.changeset/add-favorite-models.md` (new)
- `AGENTS.md` (modified)

## Documentation Requirements

**Must Update:**
- `AGENTS.md` — Add `favoriteModels` to Global Settings section under "Settings Hierarchy"
- Include example:
  ```json
  {
    "favoriteModels": ["anthropic/claude-sonnet-4-5", "openai/gpt-4o"]
  }
  ```

**Check If Affected:**
- `README.md` — Update if there's a features list or screenshot section

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing (`pnpm test`)
- [ ] Build passes (`pnpm build`)
- [ ] Documentation updated
- [ ] Changeset created
- [ ] Manual verification completed

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-295): complete Step N — description`
- **Bug fixes:** `fix(KB-295): description`
- **Tests:** `test(KB-295): description`

## Do NOT

- Expand task scope (e.g., don't add favorite presets, favorite workflows, etc.)
- Skip tests for the new functionality
- Modify the model registry or auth system
- Change the default model selection behavior
- Add favorite models to project settings (keep it in global settings only)
- Modify files outside the File Scope without good reason
