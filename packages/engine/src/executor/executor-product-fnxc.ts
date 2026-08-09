/**
 * FNXC:CodeOrganization 2026-08-04-07:00:
 * Product-domain FNXC notes relocated from TaskExecutor (U4). Side-effect imported from executor.ts.
 * Field/method declarations remain on TaskExecutor; this module preserves greppable requirement history.
 *
 * FNXC:Workspace 2026-06-21-15:00: F5/F8 workspace-path helpers are consumed via free peels / pure-bindings, not direct imports here.
 * FNXC:TaskTiming 2026-07-30-21:40: graph-owned Plan Review sessions only (self-healing liveness).
 * FNXC:ReviewArtifacts 2026-07-19-10:00: best-effort feature-video before review handoff (never delays transition).
 * FNXC:TaskTiming 2026-07-30-21:40: Plan Review liveness (narrower than isTaskActive).
 * FNXC:GlobalConcurrencyControls 2026-07-14-18:30: share scheduler pre-held global slot; no second top-level acquire under full cap.
 * FNXC:PlannerOversight 2026-07-13-23:05: session-advisor flush setter (options captured at construct).
 * FNXC:TokenBudget 2026-07-16-00:00: persist-time budget enforcement for all executor token writes.
 * FNXC:TokenAnalytics 2026-07-17-14:00: persistTokenUsage sole central writer; baselines feed that delta seam (no double-credit).
 * FNXC:ProactiveChatStatus 2026-07-16-12:30: RETHINK summary held until rework reset succeeds.
 * FNXC:Settings-ThinkingLevel 2026-07-10-00:00: per-run thinking pin for execute/step-execute seams.
 * FNXC:WorkflowStepSkills 2026-07-22-00:00: FN-8490 skill pin for pass-initiating foreach instance.
 * FNXC:WorkflowMerge 2026-07-27-12:00: FN-8601 checklist/foreach merge admission gate.
 * FNXC:Workspace 2026-06-21-12:00: KTD2 flat-map each task Set to holder rows; reaper keys taskId (idempotent multi-row).
 */

export {};
