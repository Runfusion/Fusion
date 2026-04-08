# Settings Reference

[← Docs index](./README.md)

This guide documents Fusion settings from `packages/core/src/types.ts`.

## Settings Scopes

Fusion uses a two-tier settings system:

- **Global settings** (`~/.pi/fusion/settings.json`): user preferences shared across projects
- **Project settings** (`.fusion/config.json`): execution/runtime behavior for one project

At runtime, settings are merged. **Project settings override global settings** when keys overlap.

## Settings API Endpoints

| Endpoint | Purpose |
|---|---|
| `GET /api/settings` | Get merged settings (global + project). |
| `PUT /api/settings` | Update project settings only. |
| `GET /api/settings/global` | Get global settings only. |
| `PUT /api/settings/global` | Update global settings only. |
| `GET /api/settings/scopes` | Get separated `{ global, project }` view. |

---

## Global Settings

Defaults from `DEFAULT_GLOBAL_SETTINGS`; key scope from `GLOBAL_SETTINGS_KEYS`.

| Setting | Type | Default | Description |
|---|---|---:|---|
| `themeMode` | `"dark" \| "light" \| "system"` | `"dark"` | Dashboard theme mode. |
| `colorTheme` | `string` | `"default"` | Dashboard color theme name. |
| `defaultProvider` | `string` | `undefined` | Default AI provider. |
| `defaultModelId` | `string` | `undefined` | Default AI model ID. |
| `fallbackProvider` | `string` | `undefined` | Fallback provider when primary model is unavailable/rate-limited. |
| `fallbackModelId` | `string` | `undefined` | Fallback model ID (must pair with `fallbackProvider`). |
| `defaultThinkingLevel` | `"off" \| "minimal" \| "low" \| "medium" \| "high"` | `undefined` | Default reasoning effort level. |
| `ntfyEnabled` | `boolean` | `false` | Enable ntfy push notifications. |
| `ntfyTopic` | `string` | `undefined` | ntfy topic name. |
| `ntfyEvents` | `("in-review" \| "merged" \| "failed")[]` | `["in-review","merged","failed"]` | Event types that trigger ntfy notifications. |
| `ntfyDashboardHost` | `string` | `undefined` | Dashboard host used for deep-link URLs in notifications. |
| `defaultProjectId` | `string` | `undefined` | Default project for multi-project commands. |
| `openrouterModelSync` | `boolean` | `true` | Sync OpenRouter model catalog into pickers. |
| `modelOnboardingComplete` | `boolean` | `undefined` | Whether model onboarding has been completed/dismissed. |

### Additional GlobalSettings fields

These exist in the `GlobalSettings` interface but are not listed in `GLOBAL_SETTINGS_KEYS`.

| Setting | Type | Default | Description |
|---|---|---:|---|
| `setupComplete` | `boolean` | `undefined` | Marks completion of first-run setup wizard state. |
| `favoriteProviders` | `string[]` | `undefined` | Pinned provider names shown first in model selectors. |
| `favoriteModels` | `string[]` | `undefined` | Pinned models in `{provider}/{modelId}` format. |

---

## Project Settings

Defaults from `DEFAULT_PROJECT_SETTINGS`; key scope from `PROJECT_SETTINGS_KEYS`.

| Setting | Type | Default | Description |
|---|---|---:|---|
| `globalPause` | `boolean` | `false` | Hard stop: terminate active engine sessions and pause scheduling. |
| `enginePaused` | `boolean` | `false` | Soft pause: stop dispatching new work but allow active sessions to finish. |
| `maxConcurrent` | `number` | `2` | Max concurrent AI tasks. |
| `maxWorktrees` | `number` | `4` | Max git worktrees. |
| `pollIntervalMs` | `number` | `15000` | Scheduler poll interval (ms). |
| `groupOverlappingFiles` | `boolean` | `true` | Serialize execution when file scopes overlap. |
| `autoMerge` | `boolean` | `true` | Auto-finalize tasks from `in-review`. |
| `mergeStrategy` | `"direct" \| "pull-request"` | `"direct"` | Completion mode (local direct merge or PR-first). |
| `worktreeInitCommand` | `string` | `undefined` | Shell command run after worktree creation. |
| `testCommand` | `string` | `undefined` | Custom test command override. |
| `buildCommand` | `string` | `undefined` | Custom build command override. |
| `recycleWorktrees` | `boolean` | `false` | Reuse worktrees from a pool for faster startup. |
| `worktreeNaming` | `"random" \| "task-id" \| "task-title"` | `"random"` | Naming mode for fresh worktree directories. |
| `taskPrefix` | `string` | `"FN"` | Prefix for generated task IDs. |
| `includeTaskIdInCommit` | `boolean` | `true` | Include task ID in commit message scope. |
| `planningProvider` | `string` | `undefined` | AI provider for triage/spec generation. |
| `planningModelId` | `string` | `undefined` | Model ID for triage/spec generation. |
| `planningFallbackProvider` | `string` | `undefined` | Fallback provider for planning. |
| `planningFallbackModelId` | `string` | `undefined` | Fallback model ID for planning. |
| `validatorProvider` | `string` | `undefined` | AI provider for plan/code review. |
| `validatorModelId` | `string` | `undefined` | Model ID for plan/code review. |
| `validatorFallbackProvider` | `string` | `undefined` | Fallback provider for review. |
| `validatorFallbackModelId` | `string` | `undefined` | Fallback model ID for review. |
| `modelPresets` | `array` | `[]` | Reusable executor/validator model presets. |
| `autoSelectModelPreset` | `boolean` | `false` | Auto-select presets by task size. |
| `defaultPresetBySize` | `object` | `{}` | Mapping for `S`/`M`/`L` → preset ID. |
| `autoResolveConflicts` | `boolean` | `true` | Enable automatic merge conflict pattern resolution. |
| `smartConflictResolution` | `boolean` | `true` | Alias/preferred flag for smart merge conflict handling. |
| `strictScopeEnforcement` | `boolean` | `false` | Block merges on out-of-scope file changes. |
| `buildRetryCount` | `number` | `0` | Build retry attempts during merge. |
| `buildTimeoutMs` | `number` | `300000` | Build timeout in ms (5 minutes). |
| `requirePlanApproval` | `boolean` | `false` | Require manual approval before triage → todo. |
| `taskStuckTimeoutMs` | `number` | `undefined` | Inactivity timeout for stuck-task recovery. |
| `autoUnpauseEnabled` | `boolean` | `true` | Auto-unpause after rate-limit-triggered pauses. |
| `autoUnpauseBaseDelayMs` | `number` | `300000` | Base unpause retry delay in ms (5 min). |
| `autoUnpauseMaxDelayMs` | `number` | `3600000` | Max unpause delay cap in ms (1 hour). |
| `maxStuckKills` | `number` | `6` | Max stuck-task terminations before permanent failure. |
| `maxSpawnedAgentsPerParent` | `number` | `5` | Max child agents per parent. |
| `maxSpawnedAgentsGlobal` | `number` | `20` | Max total spawned agents in an executor instance. |
| `maintenanceIntervalMs` | `number` | `900000` | Maintenance interval in ms (15 min). |
| `autoUpdatePrStatus` | `boolean` | `false` | Auto-refresh PR status badges. |
| `autoCreatePr` | `boolean` | `false` | Auto-create PRs for completed tasks. |
| `autoBackupEnabled` | `boolean` | `false` | Enable scheduled DB backups. |
| `autoBackupSchedule` | `string` | `"0 2 * * *"` | Backup cron schedule. |
| `autoBackupRetention` | `number` | `7` | Number of backups to keep. |
| `autoBackupDir` | `string` | `".fusion/backups"` | Relative backup directory path. |
| `autoSummarizeTitles` | `boolean` | `false` | Auto-generate titles for long untitled task descriptions. |
| `titleSummarizerProvider` | `string` | `undefined` | AI provider for title summarization. |
| `titleSummarizerModelId` | `string` | `undefined` | AI model ID for title summarization. |
| `titleSummarizerFallbackProvider` | `string` | `undefined` | Fallback provider for title summarization. |
| `titleSummarizerFallbackModelId` | `string` | `undefined` | Fallback model ID for title summarization. |
| `tokenCap` | `number` | `undefined` | Proactive token threshold for context compaction. |
| `insightExtractionEnabled` | `boolean` | `false` | Enable scheduled memory insight extraction. |
| `insightExtractionSchedule` | `string` | `"0 2 * * *"` | Insight extraction cron schedule. |
| `insightExtractionMinIntervalMs` | `number` | `86400000` | Minimum interval between insight extraction runs (24h). |
| `memoryEnabled` | `boolean` | `true` | Enable project memory integration. |
| `runStepsInNewSessions` | `boolean` | `false` | Run each task step in a fresh agent session. |
| `maxParallelSteps` | `number` | `2` | Max concurrent step sessions (1–4). |
| `agentPrompts` | `object` | `undefined` | Custom agent prompt templates + role assignments. |

### Additional ProjectSettings fields

These exist in `ProjectSettings` but are not part of `PROJECT_SETTINGS_KEYS`.

| Setting | Type | Default | Description |
|---|---|---:|---|
| `scripts` | `Record<string, string>` | `undefined` | Named script map used by script-mode workflow steps and setup hooks. |
| `setupScript` | `string` | `undefined` | Named script key to run before task execution. |

---

## Model Selection Hierarchy

### Triage/specification model

1. Per-task `planningModelProvider` + `planningModelId`
2. Global/project `planningProvider` + `planningModelId`
3. Global `defaultProvider` + `defaultModelId`
4. Automatic provider/model resolution

### Executor model

1. Per-task `modelProvider` + `modelId`
2. Global `defaultProvider` + `defaultModelId`
3. Automatic provider/model resolution

### Reviewer model

1. Per-task `validatorModelProvider` + `validatorModelId`
2. Global/project `validatorProvider` + `validatorModelId`
3. Global `defaultProvider` + `defaultModelId`
4. Automatic provider/model resolution

---

## JSON Examples

### 1) Team baseline for reliable automation

```json
{
  "settings": {
    "maxConcurrent": 3,
    "maxWorktrees": 6,
    "mergeStrategy": "direct",
    "autoResolveConflicts": true,
    "taskStuckTimeoutMs": 600000,
    "runStepsInNewSessions": true,
    "maxParallelSteps": 2
  }
}
```

### 2) Multi-model routing for plan/execute/review

```json
{
  "settings": {
    "defaultProvider": "anthropic",
    "defaultModelId": "claude-sonnet-4-5",
    "planningProvider": "openai",
    "planningModelId": "gpt-4.1",
    "validatorProvider": "openai",
    "validatorModelId": "gpt-4o"
  }
}
```

### 3) Size-based preset auto-selection

```json
{
  "settings": {
    "modelPresets": [
      {
        "id": "small-fast",
        "name": "Small / Fast",
        "executorProvider": "openai",
        "executorModelId": "gpt-4o-mini"
      },
      {
        "id": "large-deep",
        "name": "Large / Deep",
        "executorProvider": "anthropic",
        "executorModelId": "claude-sonnet-4-5",
        "validatorProvider": "openai",
        "validatorModelId": "gpt-4o"
      }
    ],
    "autoSelectModelPreset": true,
    "defaultPresetBySize": {
      "S": "small-fast",
      "L": "large-deep"
    }
  }
}
```

See also: [Workflow Steps](./workflow-steps.md) for how `scripts` and workflow model overrides are used.
