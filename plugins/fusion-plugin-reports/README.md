# Reports Plugin for Fusion

Generates HTML system activity reports with multi-agent review.

## Install (one-click)

1. Open **Settings → Plugins → Fusion Plugins**.
2. In **Bundled Plugins**, click **Install** on **Reports**.
3. Enable the plugin if prompted.

Once installed and enabled, Fusion registers the **Reports** dashboard destination automatically.

## Scaffold seams (interim)

The plugin currently exports four interim scaffold seams to unblock downstream implementation work:

- `resolveEnabledCadences` / `ReportsCadence` (`src/cadence.ts`) — interim cadence-resolution seam; scheduled cadence registry + cron/sentinel wiring lands in FN-3779.
- `aggregateReportData` + aggregation types (`src/aggregation.ts`) — interim aggregation seam; real aggregation orchestration lands in FN-3780.
- `startReportsPipeline` + pipeline dependency interfaces (`src/pipeline.ts`) — interim orchestrator seam to keep call sites stable while FN-3779/FN-3780 wire real runtime components.
- `createInMemoryReportsRunsStore` + run record/store types (`src/runs-store.ts`) — interim in-memory run state store; persistent store replacement lands in FN-3784.

## Review Panel

The plugin exposes `runReviewPanel()` / `runGeneratedReportReview()` to fan out a generated report draft to multiple reviewer agents in parallel.

### Panel member settings shape

Each reviewer uses this contract:

```ts
{
  id: string;
  name: string;
  perspective: string;
  promptTemplateId?: string;
  provider?: string;
  modelId?: string;
}
```

- `perspective` is appended to the reviewer system prompt.
- `promptTemplateId` selects a template from `settings.reviewPromptTemplates[templateId]` when present.
- `provider` + `modelId` optionally override model selection per reviewer.

### Prompt template contract

`runReviewPanel` resolves reviewer templates in this order:

1. `settings.reviewPromptTemplates[promptTemplateId ?? id]`
2. `settings.reviewPrompt`
3. Built-in fallback (`DEFAULT_REVIEW_PROMPT`)

This is the temporary compatibility contract until FN-3782 lands shared review-template helpers.

### Individual review shape

```ts
{
  memberId: string;
  memberName: string;
  perspective: string;
  verdict: "approve" | "revise" | "reject";
  summary: string;
  highlights: string[];
  lowlights: string[];
  suggestions: string[];
  rawText: string;
  durationMs: number;
}
```

### Combined review shape

```ts
{
  overallVerdict: "approve" | "revise" | "reject";
  consensusSummary: string;
  mergedHighlights: string[];
  mergedLowlights: string[];
  mergedSuggestions: string[];
  individual: IndividualReview[];
  failures: ReviewFailure[];
}
```

Aggregation is deterministic:

- verdict precedence: `approve < revise < reject`
- merged arrays are case-insensitive de-duped, first-seen order, max 25 items each
- consensus summary is generated locally from reviewer summaries (no second AI call)

### Timeout and failure semantics

- Each reviewer has a hard timeout (`120_000ms`).
- A single reviewer failure never aborts the full panel.
- Failures are returned as:

```ts
{
  memberId: string;
  reason: "timeout" | "parse_error" | "session_unavailable" | "exception";
  message: string;
}
```

- If all reviewers fail, combined verdict is `reject` with an explicit consensus summary describing panel failure.

## Report Archive

The plugin persists generated reports in SQLite via `ensureReportSchema(db)` and `ReportStore`.

### Schema

Table: `reports`

- identity/metadata: `id`, `cadence`, `title`, `metadataJson`
- period window: `periodStart`, `periodEnd`
- lifecycle/status: `status`, `failureReason`
- payload references: `draftMarkdown`, `renderedHtmlPath`
- review payload: `combinedReviewJson`
- timestamps: `generationStartedAt`, `generationCompletedAt`, `reviewStartedAt`, `reviewCompletedAt`, `approvedAt`, `publishedAt`, `archivedAt`, `createdAt`, `updatedAt`
- approval actor: `approvedBy`

Indexes:

- `idxReportsCadenceCreated` on `(cadence, createdAt DESC, id)`
- `idxReportsStatusUpdated` on `(status, updatedAt DESC, id)`
- `idxReportsPeriod` on `(periodStart, periodEnd, id)`

### Status lifecycle

`generating → review_pending → review_in_progress → review_complete → approved → published`

`failed` and `archived` are allowed from any non-terminal state. Idempotent transitions (`from === to`) are no-ops.

### Approval + publish lifecycle (FN-3787)

A parallel `approvalState` gate now controls human/approver decisions before distribution:

`review_complete` entry:
- `approvalRequired=false, autoPublishOnApproval=false` → `approvalState=approved`, `status=approved`
- `approvalRequired=false, autoPublishOnApproval=true` → `approvalState=published`, `status=published`
- `approvalRequired=true` → `approvalState=awaiting_approval`, `status=review_complete`

Decision transitions:
- `awaiting_approval --approve--> approved` (or directly `published` when `autoPublishOnApproval=true`)
- `awaiting_approval --reject--> rejected`
- `approved --publish--> published`

Backfilled legacy rows use `approvalState=not_required` and are non-actionable.

Authorization rules:
- When `approvalRequired=true` and `approverAgentIds` is non-empty, only listed approver agent IDs may approve/reject/publish.
- When `approvalRequired=true` and `approverAgentIds=[]`, any human dashboard user is allowed; agents are not.
- `publishTargets` records publish intent metadata when a report reaches `published`.

### Share-ready summary blocks (FN-3787)

Approved/published reports can produce deterministic share artifacts via `GET /reports/:id/share-blocks`:
- `plainText`: compact paste-ready summary
- `markdown`: heading/bullets + report link
- `slack`: mrkdwn-friendly summary
- `emailHtml`: inline-styled HTML snippet for email clients

`share-blocks` is intentionally locked (409) until `approvalState` is `approved` or `published`.

> Email HTML styling exemption: `emailHtml` deliberately uses inline style attributes and hardcoded hex colors for email-client compatibility; dashboard design-token CSS rules do not apply to this serialized output format.

### ReportStore API

- `createReport(input)`
- `getReport(id)`
- `listReports(filter?)`
- `updateReport(id, patch)`
- `setStatus(id, next, opts?)`
- `attachReview(id, combinedReview)`
- `attachRenderedHtml(id, htmlPath)`
- `deleteReport(id)`

Emitted events:

- `report:created`
- `report:updated`
- `report:status-changed`
- `report:review-attached`
- `report:deleted`

This archive is the source of truth for downstream report HTML rendering (FN-3785) and dashboard report list/detail flows (FN-3786).

## Dashboard view

The plugin registers a primary dashboard view (`Reports`) via `dashboardViews` with `componentPath: "./dashboard-view"`.

The view provides:
- History list of reports with filters (cadence, status, period date range, title search, agent filter)
- Embedded detail preview using sandboxed iframe + preview HTML endpoint
- Section quick-jump navigation by stable `data-section` markers
- Side-by-side comparison drawer for two reports with section-level diff summary
- Standalone HTML download action wired to the export endpoint
