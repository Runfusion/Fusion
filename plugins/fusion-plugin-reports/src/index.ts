import type { PluginContext } from "@fusion/core";
import { definePlugin } from "@fusion/plugin-sdk";
import { initializeApprovalState } from "./approval.js";
import { runReviewPanel } from "./review-panel.js";
import { ensureReportSchema } from "./report-schema.js";
import { createReportApprovalRoutes } from "./routes/report-approval-routes.js";
import { createReportExportRoutes } from "./routes/report-export-routes.js";
import { createReportListRoutes } from "./routes/report-list-routes.js";
import type { CombinedReview, ReviewPanelMember, RunReviewPanelInput } from "./review-types.js";
import {
  getApprovalRequired,
  getApproverAgentIds,
  getAutoPublishOnApproval,
  getPublishTargets,
  settingsSchema,
} from "./settings.js";
import type { ReportCadence, ReportCreateInput } from "./store/report-types.js";
import { getReportStore } from "./store/report-store-provider.js";
import { reportTools } from "./tools.js";

/*
FNXC:ReportsAgentVocabulary 2026-07-14-18:47:
Reports are an agent-native project domain. Prompt contributions name the primitive tools and approval vocabulary so agents discover the same review and publication workflow exposed by the dashboard, without inventing direct database mutations.
*/

const plugin = definePlugin({
  manifest: {
    id: "fusion-plugin-reports",
    name: "Reports",
    version: "0.1.0",
    description: "Generates beautiful HTML system-activity reports with multi-agent review.",
    author: "Fusion Team",
    fusionVersion: ">=0.1.0",
    settingsSchema,
    promptSurfaces: ["executor-system", "executor-task"],
  },
  state: "installed",
  hooks: {
    onSchemaInit: ensureReportSchema,
  },
  routes: [...createReportListRoutes(), ...createReportExportRoutes(), ...createReportApprovalRoutes()],
  tools: reportTools,
  promptContributions: {
    enabledByDefault: true,
    contributions: [
      {
        surface: "executor-system",
        content: "Reports are project-scoped records with review status and approval state. Use reports_list/reports_get before reports_decide; approval and publish actions require an authorized agent id. Use reports_export_html only after generation completes.",
      },
      {
        surface: "executor-task",
        content: "For report work, inspect the persisted report entity and return its report id, status, approval state, and any publish targets or export result.",
      },
    ],
  },
  dashboardViews: [
    {
      viewId: "reports",
      label: "Reports",
      componentPath: "./dashboard-view",
      icon: "FileText",
      placement: "primary",
      order: 35,
    },
  ],
});

export interface RunGeneratedReportReviewInput {
  reportDraft: string;
  reportMetadata: RunReviewPanelInput["reportMetadata"];
  panel: ReviewPanelMember[];
  cwd: string;
}

function toCadence(cadence: RunReviewPanelInput["reportMetadata"]["cadence"]): ReportCadence {
  return cadence;
}

export async function runGeneratedReportReview(input: RunGeneratedReportReviewInput, ctx: PluginContext): Promise<CombinedReview> {
  const store = getReportStore(ctx);
  const reportInput: ReportCreateInput = {
    cadence: toCadence(input.reportMetadata.cadence),
    periodStart: input.reportMetadata.periodStart,
    periodEnd: input.reportMetadata.periodEnd,
    title: `Generated ${input.reportMetadata.cadence} report`,
    draftMarkdown: input.reportDraft,
    metadata: {
      reportMetadata: input.reportMetadata,
      source: "runGeneratedReportReview",
    },
  };
  const report = await store.createReportAsync(reportInput);
  await store.setStatusAsync(report.id, "review_pending");
  await store.setStatusAsync(report.id, "review_in_progress");

  const combinedReview = await runReviewPanel({
    reportDraft: input.reportDraft,
    reportMetadata: {
      ...input.reportMetadata,
      reportId: report.id,
    },
    panel: input.panel,
    cwd: input.cwd,
  }, ctx);

  const reviewed = await store.attachReviewAsync(report.id, combinedReview);

  const nextApprovalState = initializeApprovalState(reviewed.status, {
    approvalRequired: getApprovalRequired(ctx.settings),
    autoPublishOnApproval: getAutoPublishOnApproval(ctx.settings),
    approverAgentIds: getApproverAgentIds(ctx.settings),
    publishTargets: getPublishTargets(ctx.settings),
  });

  if (nextApprovalState !== "not_required") {
    const now = new Date().toISOString();
    await store.updateReportAsync(report.id, {
      approvalState: nextApprovalState,
      ...(nextApprovalState === "approved"
        ? { status: "approved", approvedAt: now, approvedBy: "system" }
        : {}),
      ...(nextApprovalState === "published" ? { status: "published", publishedAt: now } : {}),
    });
  }

  return combinedReview;
}

export default plugin;

export * from "./settings.js";
export * from "./cadence.js";
export * from "./aggregation.js";
export * from "./pipeline.js";
export * from "./runs-store.js";
export * from "./review-types.js";
export * from "./review-panel.js";
export { ensureReportSchema } from "./report-schema.js";
export { ReportStore, ReportStoreError, type ReportStoreEvents } from "./store/report-store.js";
export { getReportStore } from "./store/report-store-provider.js";
export { createReportTools, reportTools } from "./tools.js";
export * from "./store/report-types.js";
export * from "./render/index.js";
