import "./GatedActionApprovalDetails.css";
import { useTranslation } from "react-i18next";
import type { ApprovalRequestDetail } from "../api";

interface GatedActionApprovalDetailsProps {
  targetAction: ApprovalRequestDetail["targetAction"];
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function readToolArgs(context: Record<string, unknown> | undefined): Record<string, unknown> | null {
  const toolArgs = context?.toolArgs;
  if (!toolArgs || typeof toolArgs !== "object") return null;
  return toolArgs as Record<string, unknown>;
}

/*
FNXC:Approvals 2026-07-05-00:00:
FN-7609: operators approving an agent-gated action (bash command, fn_* tool
call, etc.) must be able to see the real gated payload — tool name, the
shell command line or structured arguments, and working directory — instead
of just the tool name. This component renders `targetAction.context` (which
the engine's permanent-agent gating closures now populate with `toolName`,
`toolArgs`, `command`, and `cwd`) generically for any request whose
context.source === "agent-gating", so it covers both the executor and
heartbeat gating paths without duplicating rendering logic.
*/
export function GatedActionApprovalDetails({ targetAction }: GatedActionApprovalDetailsProps) {
  const { t } = useTranslation("app");
  const context = targetAction.context as Record<string, unknown> | undefined;
  const toolName = readString(context?.toolName) ?? targetAction.resourceId;
  const command = readString(context?.command);
  const cwd = readString(context?.cwd);
  const toolArgs = readToolArgs(context);
  const argsJson = toolArgs && Object.keys(toolArgs).length > 0 ? JSON.stringify(toolArgs, null, 2) : null;

  return (
    <section className="card gated-action-approval-details" data-testid="gated-action-approval-details">
      <h4 className="gated-action-approval-details__title">{t("approvals.gatedActionTitle", "Gated action payload")}</h4>
      <dl className="gated-action-approval-details__list">
        <div className="gated-action-approval-details__row">
          <dt>{t("approvals.gatedActionTool", "Tool")}</dt>
          <dd>{toolName}</dd>
        </div>
        {command && (
          <div className="gated-action-approval-details__row">
            <dt>{t("approvals.gatedActionCommand", "Command")}</dt>
            <dd>
              <pre className="gated-action-approval-details__code"><code>{command}</code></pre>
            </dd>
          </div>
        )}
        {argsJson && (
          <div className="gated-action-approval-details__row">
            <dt>{t("approvals.gatedActionArgs", "Arguments")}</dt>
            <dd>
              <pre className="gated-action-approval-details__code"><code>{argsJson}</code></pre>
            </dd>
          </div>
        )}
        {cwd && (
          <div className="gated-action-approval-details__row">
            <dt>{t("approvals.gatedActionCwd", "Working directory")}</dt>
            <dd>{cwd}</dd>
          </div>
        )}
      </dl>
    </section>
  );
}
