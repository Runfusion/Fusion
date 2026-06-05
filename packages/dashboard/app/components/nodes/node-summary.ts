import type { WorkflowFlowNodeData, WorkflowEditorNodeKind } from "./WorkflowNodeTypes";

/** Minimal catalog shapes the summary helper needs to resolve display names.
 *  Deliberately local (not imported from @fusion/core or ../api): the dashboard
 *  app build aliases @fusion/core to a types-only entry, and the helper only
 *  reads the few fields below, so a structural mirror keeps it decoupled and
 *  trivially testable. */
export interface SummaryModelInfo {
  provider: string;
  id: string;
  name: string;
}
export interface SummaryNamed {
  id: string;
  name: string;
}

export interface NodeSummaryCatalogs {
  models?: SummaryModelInfo[];
  agents?: SummaryNamed[];
  skills?: SummaryNamed[];
}

/** Translate function shape (matches react-i18next's `t(key, default)`). The
 *  helper is pure, so callers pass `t`; tests pass nothing and get the inline
 *  English defaults. Raw config values (ids, commands, names) are NOT
 *  translated — only the few structural phrases below are. */
export type SummaryTranslate = (key: string, defaultValue: string, opts?: Record<string, unknown>) => string;

const identityT: SummaryTranslate = (_key, defaultValue, opts) => {
  if (!opts) return defaultValue;
  // Minimal interpolation so the identity fallback mirrors i18next {{x}} output.
  return defaultValue.replace(/\{\{(\w+)\}\}/g, (_m, name: string) =>
    name in opts ? String(opts[name]) : `{{${name}}}`,
  );
};

const COMMAND_TRUNCATE = 40;

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function truncate(value: string, max: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1)}…`;
}

function firstLine(value: string): string {
  const line = value.split(/\r?\n/, 1)[0] ?? "";
  return line.trim();
}

function modelSummary(config: Record<string, unknown>, catalogs: NodeSummaryCatalogs): string {
  const provider = str(config.modelProvider);
  const modelId = str(config.modelId);
  const resolved = catalogs.models?.find((m) => m.provider === provider && m.id === modelId);
  if (resolved?.name) return resolved.name;
  if (provider && modelId) return `${provider}/${modelId}`;
  if (modelId) return modelId;
  return "";
}

function joinModeSummary(config: Record<string, unknown>): string {
  const m = config.mode as unknown;
  if (m && typeof m === "object" && "quorum" in (m as object)) {
    return `quorum(${(m as { quorum: number }).quorum})`;
  }
  return typeof m === "string" ? m : "all";
}

/**
 * Map a node's `data.kind` + `data.config` to a short, single-line summary used
 * by the card-style node's summary row. Returns "" for kinds with no meaningful
 * summary (start/end/split/merge) so the card can skip the summary row.
 *
 * Catalog name resolution is best-effort: when a catalog is missing or the id is
 * unknown, the raw id/command/name is returned — never blank for a configured
 * node (KTD-6 raw-id fallback).
 */
export function nodeConfigSummary(
  data: WorkflowFlowNodeData,
  catalogs: NodeSummaryCatalogs = {},
  t: SummaryTranslate = identityT,
): string {
  const kind = data.kind as WorkflowEditorNodeKind;
  const config = (data.config ?? {}) as Record<string, unknown>;

  switch (kind) {
    case "prompt": {
      const executor = str(config.executor) || "model";
      if (executor === "agent") {
        const agentId = str(config.agentId);
        if (!agentId) return t("workflowNodes.summaryNotConfigured", "Not configured");
        const name = catalogs.agents?.find((a) => a.id === agentId)?.name;
        return name || agentId;
      }
      if (executor === "skill") {
        const skillName = str(config.skillName);
        if (!skillName) return t("workflowNodes.summaryNotConfigured", "Not configured");
        // skillName is stored as the skill's name; resolve by name or id.
        const match = catalogs.skills?.find((s) => s.name === skillName || s.id === skillName);
        return match?.name || skillName;
      }
      if (executor === "cli") {
        const cliMode = str(config.cliMode) || "command";
        if (cliMode === "script") {
          const script = str(config.scriptName);
          return script || t("workflowNodes.summaryNotConfigured", "Not configured");
        }
        const command = str(config.cliCommand);
        return command ? truncate(command, COMMAND_TRUNCATE) : t("workflowNodes.summaryNotConfigured", "Not configured");
      }
      // executor === "model"
      const model = modelSummary(config, catalogs);
      if (model) return model;
      if (config.awaitInput === true) return t("workflowNodes.summaryAwaitInput", "Waits for user input");
      return t("workflowNodes.summaryNotConfigured", "Not configured");
    }
    case "script": {
      const script = str(config.scriptName);
      return script || t("workflowNodes.summaryNotConfigured", "Not configured");
    }
    case "gate": {
      const prompt = str(config.prompt);
      if (prompt) return truncate(firstLine(prompt), COMMAND_TRUNCATE);
      const gateMode = str(config.gateMode) || "gate";
      return gateMode === "advisory"
        ? t("workflowNodes.summaryGateAdvisory", "Advisory")
        : t("workflowNodes.summaryGateBlocks", "Gate (blocks)");
    }
    case "hold": {
      const release = str(config.release) || "manual";
      return t("workflowNodes.summaryHoldRelease", "Release: {{release}}", { release });
    }
    case "join":
      return joinModeSummary(config);
    case "foreach": {
      const mode = str(config.mode) || "sequential";
      const isolation = str(config.isolation) || (mode === "parallel" ? "worktree" : "shared");
      return `${mode} · ${isolation}`;
    }
    case "step-review": {
      const reviewType = str(config.type) || "code";
      return t("workflowNodes.summaryReviewType", "{{type}} review", { type: reviewType });
    }
    case "parse-steps": {
      const parser = str(config.parser) || "step-headings";
      const artifact = str(config.artifact);
      return artifact ? `${parser} · ${artifact}` : parser;
    }
    case "code": {
      const source = firstLine(str(config.source));
      return source ? truncate(source, COMMAND_TRUNCATE) : t("workflowNodes.summaryCodeDefault", "TypeScript");
    }
    // No meaningful summary: structural/control nodes.
    case "start":
    case "end":
    case "split":
    case "merge":
    default:
      return "";
  }
}
