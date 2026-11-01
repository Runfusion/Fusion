/**
 * FNXC:CodeOrganization 2026-07-20-10:00:
 * Run-audit domain types peeled from types.ts.
 */

// ── Run Audit Types ───────────────────────────────────────────────────────────

/** Domain categories for run-audit events.
 *  - "database": TaskStore mutations (task updates, comments, etc.)
 *  - "git": Git operations (commits, branches, merges)
 *  - "filesystem": File system mutations (file reads/writes, attachments)
 *  - "sandbox": Sandbox backend lifecycle events for user-configured command execution */
export type RunAuditDomain = "database" | "git" | "filesystem" | "sandbox";

export type RunAuditMutationType =
  | "mergeQueue:enqueue"
  | "mergeQueue:lease-acquired"
  | "mergeQueue:lease-released"
  | "mergeQueue:lease-expired"
  | "task:handoff"
  | "task:handoff-invariant-violation"
  /*
  FNXC:ApprovalHoldMoveClear 2026-09-25-11:12 (RUFU-297 defect A):
  `task:move-cleared-approval-hold` is emitted post-commit by `moveTaskInternal` when a user-driven
  move out of a review lane clears an approval hold whose evidence the reopen hooks just destroyed
  (or the gated-session pause shape that move supersedes). Metadata: { priorStatus, awaitingApprovalReason
  (the reason-code enum, or "none" for the bare marker), fromColumn, toColumn, moveSource, outcome:
  "cleared" } — status, a fixed code, columns, and a fixed outcome; never hold prose or error text. The row is
  the audit proof of the hold/evidence pair invariant at the move seam; its ABSENCE next to a
  step-wiping review exit is what distinguishes defect A from a legitimate hold-preserving move
  (plan-approval release, graph remediation, preserveStatus, userPaused).
  */
  | "task:move-cleared-approval-hold"
  /*
  FNXC:CompleteColumnGateEvidence 2026-10-11-20:10 (RUFU-406):
  `task:move-refused-complete-column-gate-evidence` is emitted once per refused move into a `complete`
  column: an operator-attributed move (board drag, `fn task move`, or a direct store call that declared
  itself a user move) whose required workflow gates carry no approving evidence — zero rows, `pending`, a
  failed/`REVISE` row, or a `skipped` row with no audited bypass. Measured 2026-09-29: RUFU-389 and RUFU-337
  reached the terminal lane exactly this way and left no row behind, because the pre-existing invariant
  consulted only the merge BLOCKER, which an `in-progress -> done` move never reads.
  Metadata: { rejectionCode, toColumn, moveSource, moveCallerSurface, callerSessionId (only when a session
  marker proved it), gateCount, gateFindings ( `lane:gateId:state` triples, capped at 8) } — a fixed code,
  a column, fixed caller/gate-state enums, and counts. Never gate prose, reviewer findings, verdict text,
  file paths, or the refusal sentence (that lives on the card's History line). Emitted through the FN-9177
  bounded seam, so an absent, throwing, or hanging sink cannot change the refusal.
  */
  | "task:move-refused-complete-column-gate-evidence"
  | "overseer:intervention"
  /*
  FNXC:VanishedTaskDetection 2026-09-24-00:40 (RUFU-283):
  `task:vanished-approved-work` is emitted once per operator-visible finding by the
  `reconcile-vanished-task-dirs` sweep. Metadata: { taskId, reason, branchRef, unmergedCommitCount,
  gateApproved, salvageTarget } — ids, a fixed reason enum, counts and one derived ref; never mirror
  content, prompt text, log prose or error text.

  The literal names the class the operator must never lose silently (approved work with an unmerged
  branch), which is why it stays even though the sweep also reports the neighbouring classes: `reason`
  carries the taxonomy (`row-missing|row-tombstoned` × `branch-unmerged|branch-missing`, plus
  `row-tombstoned-branch-unprobed` and `state-unresolved` when the branch could not be probed, the
  former when a soft-delete tombstone already accounts for the row) and `gateApproved` says whether a
  gate actually approved the card. Do not read a row with `gateApproved: false` as a false positive — it
  is the same disappearance, just not yet an approved one. One row is written per finding and the row is
  unconditional, but only the alarming reasons also raise a mailbox notice: the two tombstone classes
  with no proven unmerged commit stay audit-only, so "nobody was paged" and "nothing was recorded" remain
  distinguishable from this table alone.

  `task:row-purged-for-resurrection` is the mandatory pre-write for a tombstone hard-delete on the
  resurrection path, so a purged id is always attributable. Metadata: { taskId, operation,
  allowResurrection, forceResurrect, deletedAtPresent, purgedWorkflowStepCount }. Both are written
  transactionally with the mutation they describe, which is what makes the purge fail closed.
  */
  /*
  FNXC:PlanningAdmissionStall 2026-09-25-19:31 (RUFU-273 Step 3):
  The planning-admission stall pair, one row per outcome of a `reconcile-planning-admission-stall` pass.
  `stalled` NOMINATES a card (its row now carries an episode code); `stalled-no-action` is a candidate the
  pass examined and deliberately left alone, with `outcome` naming why (`premise-held`,
  `recovery-backoff`, `triage-owned`, `already-named`). Without the second row "the sweep ran and had
  nothing to say" is indistinguishable from "the sweep never ran" — the same ambiguity RUFU-297 removed
  for approval holds. Metadata is ids/counts/fixed codes only: `taskId`, `column`, `code`, `ageMs`,
  `staleBranchCommitCount`, `outcome`, `scannedCount`. The branch is represented by its COMMIT COUNT,
  never a tip sha, and no spec text or blocker prose enters either row.
  */
  | "task:planning-admission-stalled"
  | "task:planning-admission-stalled-no-action"
  /*
  FNXC:CommentDelivery 2026-09-27-17:36 (RUFU-259):
  `task:comment-delivery` records one comment's routing attempt and `task:comment-delivery-unowned` the
  one case where no agent could be resolved at all. Before these rows existed a comment could be dropped
  (an `on-heartbeat` recipient skipped by the wake path, or a card nobody owns) while the write surface
  still answered 200, so nothing in the system distinguished "steering landed" from "steering
  evaporated". Metadata is ids/counts/fixed enums only (`source`, `kind`, `commentId`, `via`, `outcome`,
  `unroutedReason`, `skippedRungs`, `poolSize`, `messageStoreAvailable`, optional
  `messageId`/`noticeDelivered`); the comment body is operator prose and is never recorded.
  */
  | "task:comment-delivery"
  | "task:comment-delivery-unowned"
  | "task:vanished-approved-work"
  | "task:row-purged-for-resurrection"
  /*
  FNXC:StoreOpenProvenance 2026-10-31-22:15 (RUFU-344):
  `store:open` is written by `initImpl` — the single body behind `TaskStore.init()` — once per store
  open, and its only job is to name the PROCESS that opened the shared project database. FN-7910 is
  the motivating incident: a stale binary opened the store, its init passes evacuated Ideas cards,
  and every row that writer left said only `agentId:"system"`, so the mutation could not be
  attributed afterwards. The stamp is the LAST await of a completed open, so it names the process behind
  the mutations a store makes afterwards; a store open that never completes stamps nothing, because the
  stamp is itself a write on the connection whose stall is being diagnosed — which is why
  `docs/architecture.md` still calls a bare 30 s `[taskstore-boot]` expiry un-attributable.

  Metadata is ids/paths only and exactly these six keys: `pid`, `ppid`, `execPath`, `entry`
  (`process.argv[1]`, `"unknown"` when absent), `cwd`, `nodeVersion`. Nothing content-y is legal here:
  no error text, no log line, no task title, no connection URL that could carry credentials, and no
  extra key — the row is written on every store open (every CLI invocation, every test harness), so
  anything else is multiplied across the whole fleet. `target` carries the bound project id
  (`"unscoped"` when the layer is project-agnostic) because the column is NOT NULL, and `task_id`
  stays NULL because opening a store is not a task mutation.

  Restored, not new: the event shipped in a628a13888 and was lost in 5ae6332563 when the SQLite
  dual-path collapse deleted its `insertRunAuditEventRow` call site while the `AGENTS.md` bullet
  describing it stayed. Tests that read unfiltered `runAuditEvents` must filter by `mutationType`
  instead of asserting exact counts, because one row now appears per store open.
  */
  | "store:open"
  | (string & {});

/** Input for recording a run-audit event. */
export interface RunAuditEventInput {
  /** ISO-8601 timestamp when the event occurred. Defaults to current time if not provided. */
  timestamp?: string;
  /** Task ID associated with this event (if applicable). */
  taskId?: string;
  /** Agent ID that performed the mutation. */
  agentId: string;
  /** Heartbeat run ID that initiated this mutation. */
  runId: string;
  /** The domain/category of the mutation. */
  domain: RunAuditDomain;
  /** Type of mutation (for example "task:update", "task:move", "task:handoff", "task:handoff-invariant-violation", "mergeQueue:enqueue", "git:commit", or "file:write"). */
  mutationType: RunAuditMutationType;
  /** Target of the mutation (e.g., task ID, file path, branch name). */
  target: string;
  /** Optional structured metadata about the mutation (compact, actionable data). */
  metadata?: Record<string, unknown>;
}

/** A persisted run-audit event record. */
export interface RunAuditEvent {
  /** Unique event identifier */
  id: string;
  /** ISO-8601 timestamp when the event occurred */
  timestamp: string;
  /** Task ID associated with this event (if applicable) */
  taskId?: string;
  /** Agent ID that performed the mutation */
  agentId: string;
  /** Heartbeat run ID that initiated this mutation */
  runId: string;
  /** The domain/category of the mutation */
  domain: RunAuditDomain;
  /** Type of mutation (e.g., "task:update", "git:commit", "file:write") */
  mutationType: RunAuditMutationType;
  /** Target of the mutation (e.g., task ID, file path, branch name) */
  target: string;
  /** Optional structured metadata about the mutation */
  metadata?: Record<string, unknown>;
}

/** Filter options for querying run-audit events. */
export interface RunAuditEventFilter {
  /** Filter by heartbeat run ID. */
  runId?: string;
  /** Filter by task ID. */
  taskId?: string;
  /** Filter by agent ID. */
  agentId?: string;
  /** Filter by domain. */
  domain?: RunAuditDomain;
  /** Filter by mutation type. */
  mutationType?: RunAuditMutationType;
  /** Start of time range (inclusive). */
  startTime?: string;
  /** End of time range (inclusive). */
  endTime?: string;
  /** Maximum number of events to return. */
  limit?: number;
}

