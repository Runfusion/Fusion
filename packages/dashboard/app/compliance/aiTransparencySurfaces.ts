export const AI_TRANSPARENCY_DECISIONS = ["included", "nested", "excluded"] as const;

export type AiTransparencyDecision = (typeof AI_TRANSPARENCY_DECISIONS)[number];

export interface AiTransparencySurface {
  id: string;
  sourceFiles: readonly string[];
  decision: AiTransparencyDecision;
  rationale: string;
  parentId?: string;
  disclosure?: "ai-interaction" | "generated-output" | "ai-assisted-analysis" | "ai-translation";
  providerStrategy: "session-metadata" | "task-lane-metadata" | "provider-agnostic" | "not-applicable";
}

/**
 * Production inventory for direct AI interactions and rendered AI output in the
 * Fusion dashboard. Tests use this same registry as the compliance census; it
 * is deliberately kept beside the UI instead of in a test-only allowlist.
 */
export const aiTransparencySurfaces = [
  {
    id: "fusion-chat-persisted-assistant",
    sourceFiles: ["StandardChatSurface.tsx", "ChatView.tsx", "TaskPlannerChatTab.tsx"],
    decision: "included",
    rationale: "The shared renderer displays persisted assistant messages in direct, room, quick, and task-planner chat.",
    disclosure: "generated-output",
    providerStrategy: "session-metadata",
  },
  {
    id: "fusion-chat-streaming-assistant",
    sourceFiles: ["StandardChatSurface.tsx", "ChatView.tsx", "TaskPlannerChatTab.tsx"],
    decision: "included",
    rationale: "The shared streaming renderer exposes the current model or agent response at first interaction.",
    disclosure: "ai-interaction",
    providerStrategy: "session-metadata",
  },
  {
    id: "fusion-chat-human-system-tool",
    sourceFiles: ["StandardChatSurface.tsx"],
    decision: "nested",
    parentId: "fusion-chat-persisted-assistant",
    rationale: "Human/system messages are not AI output and tool calls are already nested inside an adjacent assistant disclosure.",
    providerStrategy: "not-applicable",
  },
  {
    id: "fusion-compose-chat-draft",
    sourceFiles: ["ComposeChatPanel.tsx"],
    decision: "included",
    rationale: "The narrative helper directly requests and renders an assistant-authored draft.",
    disclosure: "ai-interaction",
    providerStrategy: "provider-agnostic",
  },
  {
    id: "fusion-task-chat-agent-group",
    sourceFiles: ["TaskChatTab.tsx"],
    decision: "included",
    rationale: "Grouped planner, executor, reviewer, and merger transcript segments directly render agent output.",
    disclosure: "generated-output",
    providerStrategy: "task-lane-metadata",
  },
  {
    id: "fusion-active-agent-transcript",
    sourceFiles: ["ActiveAgentsPanel.tsx"],
    decision: "included",
    rationale: "Active-agent cards directly render the current agent transcript preview.",
    disclosure: "generated-output",
    providerStrategy: "provider-agnostic",
  },
  {
    id: "fusion-agent-log-group",
    sourceFiles: ["AgentLogViewer.tsx"],
    decision: "included",
    rationale: "The standalone activity log groups agent text and thinking output by role.",
    disclosure: "generated-output",
    providerStrategy: "task-lane-metadata",
  },
  {
    id: "fusion-agent-detail-log",
    sourceFiles: ["AgentDetailView.tsx"],
    decision: "nested",
    parentId: "fusion-agent-log-group",
    rationale: "Agent detail and heartbeat-run tabs reuse AgentLogViewer and its adjacent per-group disclosure.",
    providerStrategy: "not-applicable",
  },
  {
    id: "fusion-agent-log-operational",
    sourceFiles: ["AgentLogViewer.tsx"],
    decision: "nested",
    parentId: "fusion-agent-log-group",
    rationale: "Tool, status, and error rows are operational or nested within the disclosed agent grouping.",
    providerStrategy: "not-applicable",
  },
  {
    id: "fusion-workflow-live-agent-output",
    sourceFiles: ["WorkflowResultsTab.tsx"],
    decision: "included",
    rationale: "Running workflow prompt steps stream agent text and thinking output.",
    disclosure: "generated-output",
    providerStrategy: "task-lane-metadata",
  },
  {
    id: "fusion-workflow-completed-output",
    sourceFiles: ["WorkflowResultsTab.tsx"],
    decision: "included",
    rationale: "Completed workflow prompt/review steps render persisted model or agent output.",
    disclosure: "generated-output",
    providerStrategy: "task-lane-metadata",
  },
  {
    id: "fusion-task-summary-workflow-output",
    sourceFiles: ["TaskSummaryTab.tsx", "TaskHistoryTab.tsx"],
    decision: "included",
    rationale: "The task summary discloses generated agent reports, including prior-attempt output now projected through the history tab.",
    disclosure: "generated-output",
    providerStrategy: "provider-agnostic",
  },
  {
    id: "fusion-planning-mode",
    sourceFiles: ["PlanningModeModal.tsx"],
    decision: "included",
    rationale: "Planning Mode is a direct AI interview and renders streamed reasoning, questions, and a generated plan.",
    disclosure: "ai-interaction",
    providerStrategy: "session-metadata",
  },
  {
    id: "fusion-mission-interview",
    sourceFiles: ["MissionInterviewModal.tsx"],
    decision: "included",
    rationale: "The mission interview directly requests and renders AI questions, reasoning, and a generated mission summary.",
    disclosure: "ai-interaction",
    providerStrategy: "provider-agnostic",
  },
  {
    id: "fusion-milestone-slice-interview",
    sourceFiles: ["MilestoneSliceInterviewModal.tsx"],
    decision: "included",
    rationale: "The milestone/slice interview directly requests and renders AI questions, reasoning, and a generated summary.",
    disclosure: "ai-interaction",
    providerStrategy: "provider-agnostic",
  },
  {
    id: "fusion-agent-generation-preview",
    sourceFiles: ["AgentGenerationModal.tsx"],
    decision: "included",
    rationale: "The modal directly asks AI to generate and preview an agent specification and system prompt.",
    disclosure: "ai-interaction",
    providerStrategy: "provider-agnostic",
  },
  {
    id: "fusion-import-ai-translation",
    sourceFiles: ["GitHubImportTranslateControls.tsx", "GitHubImportModal.tsx"],
    decision: "included",
    rationale: "The translated issue or pull-request variant is model-produced and shown in place of original prose.",
    disclosure: "ai-translation",
    providerStrategy: "provider-agnostic",
  },
  {
    id: "fusion-research-synthesis",
    sourceFiles: ["ResearchView.tsx"],
    decision: "included",
    rationale: "Research summaries and findings are synthesized analysis over mixed cited sources.",
    disclosure: "ai-assisted-analysis",
    providerStrategy: "provider-agnostic",
  },
  {
    id: "fusion-research-task-action-preview",
    sourceFiles: ["ResearchTaskActionModal.tsx"],
    decision: "nested",
    parentId: "fusion-research-synthesis",
    rationale: "The modal repeats an already disclosed research finding and does not create new model output.",
    providerStrategy: "not-applicable",
  },
  {
    id: "fusion-insights-analysis",
    sourceFiles: ["InsightsView.tsx"],
    decision: "included",
    rationale: "Persisted project insight content is produced by the AI analysis pipeline.",
    disclosure: "ai-assisted-analysis",
    providerStrategy: "provider-agnostic",
  },
  {
    id: "fusion-evals-rationale",
    sourceFiles: ["EvalsView.tsx"],
    decision: "included",
    rationale: "Evaluation rationale and suggested follow-ups are directly rendered AI-assisted analysis.",
    disclosure: "ai-assisted-analysis",
    providerStrategy: "provider-agnostic",
  },
  {
    id: "fusion-task-recommendations",
    sourceFiles: ["TaskRecommendationsTab.tsx", "MailboxTaskRecommendations.tsx", "InsightsView.tsx"],
    decision: "included",
    rationale: "Task completion recommendations are agent-produced suggestions rendered in task, mailbox, and Insights recommendation views.",
    disclosure: "ai-assisted-analysis",
    providerStrategy: "provider-agnostic",
  },
  {
    id: "fusion-ideation-agent-candidate",
    sourceFiles: ["command-center/IdeationPanel.tsx"],
    decision: "included",
    rationale: "Only candidates whose persisted origin is agent are AI-generated; human and research candidates are not blanket-labelled.",
    disclosure: "generated-output",
    providerStrategy: "provider-agnostic",
  },
  {
    id: "fusion-task-review-comments",
    sourceFiles: ["TaskReviewTab.tsx"],
    decision: "excluded",
    rationale: "GitHub review comments have mixed human/bot authorship and a bot identity does not prove generative AI provenance.",
    providerStrategy: "not-applicable",
  },
  {
    id: "fusion-documents-artifacts-mail",
    sourceFiles: ["DocumentsView.tsx", "TaskDocumentsTab.tsx", "MailboxMessageContent.tsx"],
    decision: "excluded",
    rationale: "Documents, artifacts, and mail have mixed or unknown authorship; blanket output labelling would be inaccurate.",
    providerStrategy: "not-applicable",
  },
  {
    id: "fusion-mission-validation-fixes",
    sourceFiles: ["MissionManager.tsx"],
    decision: "excluded",
    rationale: "Validation telemetry, assertions, and fix records are operational/mixed persisted data without reliable model provenance.",
    providerStrategy: "not-applicable",
  },
  {
    id: "fusion-dev-server-log",
    sourceFiles: ["DevServerLogViewer.tsx"],
    decision: "excluded",
    rationale: "Development server logs are operational process output, not model-generated content.",
    providerStrategy: "not-applicable",
  },
  {
    id: "fusion-task-operational-metrics",
    sourceFiles: ["TaskCard.tsx", "TaskContextMenu.tsx", "TaskDetailModal.tsx", "TaskTokenStatsPanel.tsx"],
    decision: "excluded",
    rationale: "Workflow status, timing, token, and progress calculations are deterministic operational metrics, not generated content.",
    providerStrategy: "not-applicable",
  },
] as const satisfies readonly AiTransparencySurface[];

export const FUSION_AI_CENSUS_PATTERNS = [
  /role\s*===\s*["']assistant["']|role:\s*["']assistant["']/,
  /StandardChatMessageItem|StandardStreamingMessage/,
  /generateAgentSpec|streamingOutput/,
  /translateImportContent|autoTranslateImportIssues/,
  /results\?\.summary|finding\.content|insight\.content/,
  /selectedEval\.rationale|recommendation\.description/,
  /item\.origin|origin\s*===\s*["']agent["']/,
  /workflowStepResults/,
  /AgentLogEntry|entry\.text/,
] as const;

export function validateAiTransparencyRegistry(surfaces: readonly AiTransparencySurface[] = aiTransparencySurfaces): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const surface of surfaces) {
    if (!surface.id.trim()) errors.push("surface id is empty");
    if (ids.has(surface.id)) errors.push(`duplicate surface id: ${surface.id}`);
    ids.add(surface.id);
    if (surface.sourceFiles.length === 0) errors.push(`${surface.id}: sourceFiles is empty`);
    if (!surface.rationale.trim()) errors.push(`${surface.id}: rationale is empty`);
    if (surface.decision === "included" && !surface.disclosure) errors.push(`${surface.id}: included surface has no disclosure kind`);
    if (surface.decision === "nested" && !surface.parentId) errors.push(`${surface.id}: nested surface has no parentId`);
  }
  for (const surface of surfaces) {
    if (surface.parentId && !ids.has(surface.parentId)) errors.push(`${surface.id}: unknown parentId ${surface.parentId}`);
    if (surface.parentId === surface.id) errors.push(`${surface.id}: cannot be its own parent`);
  }
  return errors;
}
