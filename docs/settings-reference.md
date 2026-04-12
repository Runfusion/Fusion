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
| `ntfyEvents` | `("in-review" \| "merged" \| "failed" \| "awaiting-approval" \| "awaiting-user-review")[]` | `["in-review","merged","failed","awaiting-approval","awaiting-user-review"]` | Event types that trigger ntfy notifications. |
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
| `testCommand` | `string` | `undefined` | Test command run at merge time (before `buildCommand`). When set, runs as a hard gate — non-zero exit blocks the merge. When not set, Fusion automatically infers a default command from the package manager lock file (`pnpm test`, `yarn test`, `bun test`, or `npm test`). |
| `buildCommand` | `string` | `undefined` | Build command run at merge time (after `testCommand`). When set, runs as a hard gate — non-zero exit blocks the merge. |
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
| `reviewHandoffPolicy` | `"disabled" \| "comment-triggered" \| "always"` | `"disabled"` | Policy for agent-to-user review handoff. |
| `showQuickChatFAB` | `boolean` | `false` | Show floating quick-chat button. Chat accessible from More menu when hidden. |
| `taskStuckTimeoutMs` | `number` | `undefined` | Inactivity timeout for stuck-task recovery. |
| `autoUnpauseEnabled` | `boolean` | `true` | Auto-unpause after rate-limit-triggered pauses. |
| `autoUnpauseBaseDelayMs` | `number` | `300000` | Base unpause retry delay in ms (5 min). |
| `autoUnpauseMaxDelayMs` | `number` | `3600000` | Max unpause delay cap in ms (1 hour). |
| `maxStuckKills` | `number` | `6` | Max stuck-task terminations before permanent failure. |
| `maxSpawnedAgentsPerParent` | `number` | `5` | Max child agents per parent. |
| `maxSpawnedAgentsGlobal` | `number` | `20` | Max total spawned agents in an executor instance. |
| `missionStaleThresholdMs` | `number` | `600000` | Time in ms after which a mission in `activating` state is considered stale and eligible for self-healing recovery. |
| `missionMaxTaskRetries` | `number` | `3` | Maximum automatic retry attempts for a failed mission-linked task before its feature is marked as blocked for manual intervention. |
| `missionHealthCheckIntervalMs` | `number` | `300000` | Interval in ms between mission feature/task consistency checks. Set to 0 to disable periodic health checks. |
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
| `memoryBackendType` | `string` | `"file"` | Memory backend type: `file` or `readonly`. |
| `runStepsInNewSessions` | `boolean` | `false` | Run each task step in a fresh agent session. |
| `maxParallelSteps` | `number` | `2` | Max concurrent step sessions (1–4). |
| `aiSessionTtlMs` | `number` | `604800000` | TTL in ms for persisted AI planning, subtask breakdown, and mission interview sessions. Valid range: 600000 (10 min) to 2592000000 (30 days). |
| `aiSessionCleanupIntervalMs` | `number` | `3600000` | Interval in ms for scheduled AI session cleanup sweeps. Valid range: 60000 (1 min) to 86400000 (24 hours). |
| `reflectionEnabled` | `boolean` | `false` | Enable/disable agent self-reflection workflows. |
| `reflectionIntervalMs` | `number` | `3600000` | How often periodic reflections occur in milliseconds. |
| `reflectionAfterTask` | `boolean` | `true` | When true, automatically trigger reflection after task completion. |
| `agentPrompts` | `object` | `undefined` | Custom agent prompt templates + role assignments. |
| `promptOverrides` | `Record<string, string>` | `undefined` | Fine-grained prompt segment overrides (e.g., `{"executor-welcome": "..."}`). |

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

## Prompt Overrides

Fusion supports fine-grained customization of AI agent prompts through the `promptOverrides` setting. This enables surgical customization of specific prompt segments without replacing entire role prompts (which `agentPrompts` does).

### Supported Prompt Keys

| Key | Agent Role | Description |
|-----|-----------|-------------|
| `executor-welcome` | executor | Introductory section for the executor agent |
| `executor-guardrails` | executor | Behavioral guardrails and constraints |
| `executor-spawning` | executor | Instructions for spawning child agents |
| `executor-completion` | executor | Completion criteria and signaling |
| `triage-welcome` | triage | Introductory section for the triage/specification agent |
| `triage-context` | triage | Context-gathering instructions |
| `reviewer-verdict` | reviewer | Verdict criteria and format |
| `merger-conflicts` | merger | Merge conflict resolution instructions |
| `agent-generation-system` | — | System prompt for AI-assisted agent specification generation |
| `workflow-step-refine` | — | System prompt for refining workflow step descriptions into detailed agent prompts |

### How It Works

1. **Override Selection**: When a prompt key is present with a non-empty value, that override replaces the default prompt segment.

2. **Fallback to Defaults**: Missing or empty values fall back to the built-in default content.

3. **Cascade**: `agentPrompts` provides full-role template customization, while `promptOverrides` provides segment-level customization. Both can be used together — `promptOverrides` applies to the segment even within a custom role template.

### Clearing Overrides

To clear a specific override, set it to `null`:

```json
{
  "promptOverrides": {
    "executor-welcome": null
  }
}
```

To clear all overrides, set `promptOverrides` to `null`:

```json
{
  "promptOverrides": null
}
```

### Configuration Example

```json
{
  "settings": {
    "promptOverrides": {
      "executor-welcome": "Custom executor welcome message for this project...",
      "executor-guardrails": "## Custom Guardrails\n- Project-specific rules...",
      "triage-welcome": "Custom triage introduction..."
    }
  }
}
```

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

---

## Background Memory Summarization & Audit

Fusion can automatically extract insights from project memory and prune transient content on a schedule. This feature is disabled by default and can be enabled via settings.

### How It Works

1. **Scheduled Extraction**: When `insightExtractionEnabled` is `true`, a background automation runs on the configured `insightExtractionSchedule` (default: daily at 2 AM).

2. **AI-Powered Analysis**: The automation uses an AI agent to read `.fusion/memory.md` and `.fusion/memory-insights.md`, extract new insights, and produce a pruned working memory candidate.

3. **Insight Merging**: New insights are automatically merged into `.fusion/memory-insights.md` under the appropriate category (Patterns, Principles, Conventions, Pitfalls, Context). Duplicates are skipped.

4. **Memory Pruning**: The AI agent also produces a pruned version of working memory containing only durable items:
   - **Preserved**: Architecture, Conventions, Pitfalls, Context sections with durable content
   - **Pruned**: Task-specific notes, one-time observations, outdated entries

5. **Audit Report**: After each extraction run, a `.fusion/memory-audit.md` file is generated with:
   - Working memory status (presence, size, sections)
   - Insights memory status (insight counts by category)
   - Last extraction results (success/failure, insight count, duplicates skipped)
   - **Pruning outcome** (applied/skipped, size delta, reason)
   - Health status (healthy/warning/issues)
   - Individual audit checks

### Output Files

| File | Description |
|------|-------------|
| `.fusion/memory.md` | Working memory (updated when pruning is applied and validated) |
| `.fusion/memory-insights.md` | Long-term insights distilled from working memory |
| `.fusion/memory-audit.md` | Human-readable audit report after each extraction |

### Settings Interaction

| Setting | Effect |
|---------|--------|
| `insightExtractionEnabled` | Enables/disables the automation |
| `insightExtractionSchedule` | Cron expression for when extraction runs (default: `"0 2 * * *"` = daily at 2 AM) |
| `insightExtractionMinIntervalMs` | Minimum time between extractions (default: 24 hours) |

### Safety Guarantees

- **Pruning validation**: Before pruning is applied, the candidate is validated to ensure it preserves at least 2 of 3 required sections (Architecture, Conventions, Pitfalls). Invalid candidates are safely ignored.
- **Graceful failures**: Malformed AI output does not destroy existing memory. Prior files are preserved.
- **Isolated processing**: Post-run callback errors are logged but do not flip successful runs to failed.
- **Startup sync**: Automation schedule is synchronized before the cron runner starts, preventing stale config races.
- **Non-destructive by default**: If the AI produces no prune candidate or validation fails, working memory remains unchanged.

### Configuration Example

```json
{
  "settings": {
    "insightExtractionEnabled": true,
    "insightExtractionSchedule": "0 2 * * *",
    "insightExtractionMinIntervalMs": 86400000
  }
}
```

### Cron Expression Format

Standard cron format: `minute hour day-of-month month day-of-week`

| Expression | Meaning |
|-----------|---------|
| `0 2 * * *` | Daily at 2:00 AM (default) |
| `0 */6 * * *` | Every 6 hours |
| `0 9 * * 1` | Weekly on Monday at 9:00 AM |
