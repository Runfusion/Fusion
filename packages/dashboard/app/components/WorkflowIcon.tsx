import "./WorkflowIcon.css";

export interface WorkflowIconProps {
  workflowId: string;
  icon?: string;
  className?: string;
  decorative?: boolean;
}

function isBuiltinWorkflowId(workflowId: string): boolean {
  return workflowId.startsWith("builtin:");
}

function classNames(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

/**
 * FNXC:WorkflowIcons 2026-06-30-12:12:
 * Rich workflow identity surfaces render built-ins with the Fusion brand mark and custom workflows with compact text icons only when metadata exists.
 * Return null for no-icon custom workflows so cards, badges, and switchers never leave empty icon shells.
 */
export function WorkflowIcon({ workflowId, icon, className, decorative = false }: WorkflowIconProps) {
  const isBuiltin = isBuiltinWorkflowId(workflowId);
  const label = isBuiltin ? "Fusion built-in workflow" : "Workflow icon";
  const accessibilityProps = decorative
    ? { "aria-hidden": true as const }
    : { role: "img" as const, "aria-label": label, title: label };

  if (isBuiltin) {
    return (
      <span className={classNames("workflow-icon workflow-icon--builtin", className)} {...accessibilityProps}>
        <svg className="workflow-icon-mark" viewBox="0 0 128 128" focusable="false" aria-hidden="true">
          <circle cx="64" cy="64" r="52" />
          <path d="M26 101C44 82 62 64 82 45C90 37 98 30 104 24C96 35 89 47 81 60C70 79 57 95 43 108C38 112 32 108 26 101Z" />
        </svg>
      </span>
    );
  }

  const trimmedIcon = typeof icon === "string" ? icon.trim() : "";
  if (!trimmedIcon) return null;

  return (
    <span className={classNames("workflow-icon workflow-icon--custom", className)} {...accessibilityProps}>
      <span className="workflow-icon-custom-glyph" aria-hidden="true">{trimmedIcon}</span>
    </span>
  );
}
