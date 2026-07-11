import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { X, Search, Puzzle, ToggleRight } from "lucide-react";
import type { WorkflowDefinition, WorkflowStepTemplate } from "@fusion/core";
import type { WorkflowEditorNodeKind } from "./nodes/WorkflowNodeTypes";
import { nodeHelpFor } from "./nodes/node-help";
import "./WorkflowAddStepModal.css";

/*
FNXC:WorkflowSimpleView 2026-07-10-12:00:
The simplified workflow view's add-step surface. Requirements:
 - One searchable dialog covering EVERYTHING the advanced palette + templates
   toolbar offers (node kinds, fragments, Fusion step templates, plugin
   templates) so the simple view loses no add capability.
 - Node kinds are grouped into human categories (Agent steps / Automation /
   Flow control) with one-line descriptions sourced from the node help
   registry, because the flat 16-button advanced palette is the main thing
   users found hard to use.
 - When inserting INSIDE a container (foreach/loop/optional-group child
   edge), container kinds are hidden — containers cannot nest.
*/

export interface AddStepPaletteEntry {
  kind: WorkflowEditorNodeKind;
  label: string;
  icon: React.ComponentType<{ size?: number | string; "aria-hidden"?: boolean | "true" | "false" }>;
  presetConfig?: Record<string, unknown>;
}

const CONTAINER_KINDS: ReadonlySet<string> = new Set(["foreach", "loop", "optional-group"]);

const AGENT_KINDS: ReadonlySet<string> = new Set(["prompt", "ask-user", "gate", "step-review"]);
const AUTOMATION_KINDS: ReadonlySet<string> = new Set(["script", "code", "notify", "parse-steps"]);

export interface WorkflowAddStepModalProps {
  open: boolean;
  onClose: () => void;
  palette: AddStepPaletteEntry[];
  /** Hide container kinds (insert target is inside a container). */
  disallowContainers?: boolean;
  fragments: WorkflowDefinition[];
  stepTemplates: WorkflowStepTemplate[];
  pluginTemplates: Array<{ pluginId: string; template: WorkflowStepTemplate }>;
  /** Persistent seam-duplication conflict notice (mirrors the toolbar's). */
  templateConflict?: string | null;
  onPickPalette: (entry: AddStepPaletteEntry) => void;
  onPickFragment: (fragment: WorkflowDefinition) => void;
  onPickStepTemplate: (template: WorkflowStepTemplate) => void;
  onPickStepTemplateAsOptionalGroup: (template: WorkflowStepTemplate) => void;
}

export function WorkflowAddStepModal({
  open,
  onClose,
  palette,
  disallowContainers = false,
  fragments,
  stepTemplates,
  pluginTemplates,
  templateConflict,
  onPickPalette,
  onPickFragment,
  onPickStepTemplate,
  onPickStepTemplateAsOptionalGroup,
}: WorkflowAddStepModalProps) {
  const { t } = useTranslation("app");
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQuery("");
      // Focus after the dialog paints.
      const id = window.setTimeout(() => searchRef.current?.focus(), 0);
      return () => window.clearTimeout(id);
    }
  }, [open]);

  const q = query.trim().toLowerCase();

  const categories = useMemo(() => {
    const eligible = palette.filter((entry) => !(disallowContainers && CONTAINER_KINDS.has(entry.kind)));
    const withHelp = eligible.map((entry) => ({
      entry,
      description: nodeHelpFor(entry.kind)?.summary ?? "",
    }));
    const matches = (item: { entry: AddStepPaletteEntry; description: string }) =>
      !q || item.entry.label.toLowerCase().includes(q) || item.entry.kind.includes(q) || item.description.toLowerCase().includes(q);
    return [
      {
        id: "agent",
        label: t("workflowNodes.addStepAgentSteps", "Agent steps"),
        items: withHelp.filter((item) => AGENT_KINDS.has(item.entry.kind)).filter(matches),
      },
      {
        id: "automation",
        label: t("workflowNodes.addStepAutomation", "Automation"),
        items: withHelp.filter((item) => AUTOMATION_KINDS.has(item.entry.kind)).filter(matches),
      },
      {
        id: "flow",
        label: t("workflowNodes.addStepFlowControl", "Flow control"),
        items: withHelp
          .filter((item) => !AGENT_KINDS.has(item.entry.kind) && !AUTOMATION_KINDS.has(item.entry.kind))
          .filter(matches),
      },
    ].filter((category) => category.items.length > 0);
  }, [palette, disallowContainers, q, t]);

  const filteredFragments = useMemo(
    () => fragments.filter((f) => !q || f.name.toLowerCase().includes(q)),
    [fragments, q],
  );
  const filteredStepTemplates = useMemo(
    () => stepTemplates.filter((s) => !q || s.name.toLowerCase().includes(q)),
    [stepTemplates, q],
  );
  const filteredPluginTemplates = useMemo(
    () => pluginTemplates.filter((p) => !q || p.template.name.toLowerCase().includes(q)),
    [pluginTemplates, q],
  );
  const hasTemplates =
    filteredFragments.length > 0 || filteredStepTemplates.length > 0 || filteredPluginTemplates.length > 0;
  const hasAnyResult = categories.length > 0 || hasTemplates;

  if (!open) return null;

  return (
    <div
      className="wf-add-step-overlay"
      data-testid="wf-add-step-modal"
      role="presentation"
      onClick={onClose}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <div
        className="wf-add-step-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t("workflowNodes.addStepTitle", "Add a step")}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="wf-add-step-header">
          <h3>{t("workflowNodes.addStepTitle", "Add a step")}</h3>
          <button
            type="button"
            className="btn-icon wf-add-step-close"
            aria-label={t("common.close", "Close")}
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </header>
        <div className="wf-add-step-search">
          <Search size={14} aria-hidden />
          <input
            ref={searchRef}
            type="text"
            className="wf-add-step-search-input"
            data-testid="wf-add-step-search"
            value={query}
            placeholder={t("workflowNodes.addStepSearchPlaceholder", "Search steps and templates…")}
            aria-label={t("workflowNodes.addStepSearchLabel", "Search steps")}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        {templateConflict && (
          <div className="wf-add-step-conflict" role="alert" data-testid="wf-add-step-conflict">
            {t(
              "workflowNodes.templateSeamConflict",
              'This fragment duplicates the "{{seam}}" seam already on the canvas, so it can\'t be inserted.',
              { seam: templateConflict },
            )}
          </div>
        )}
        <div className="wf-add-step-body">
          {categories.map((category) => (
            <section key={category.id} className="wf-add-step-section">
              <h4>{category.label}</h4>
              <div className="wf-add-step-grid">
                {category.items.map(({ entry, description }) => {
                  const Icon = entry.icon;
                  return (
                    <button
                      key={entry.label}
                      type="button"
                      className={`wf-add-step-option wf-add-step-option--${category.id}`}
                      data-testid={`wf-add-step-${entry.kind}-${entry.label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`}
                      onClick={() => onPickPalette(entry)}
                    >
                      <span className="wf-add-step-option-chip" aria-hidden>
                        <Icon size={16} />
                      </span>
                      <span className="wf-add-step-option-text">
                        <span className="wf-add-step-option-label">{entry.label}</span>
                        {description ? <span className="wf-add-step-option-desc">{description}</span> : null}
                      </span>
                    </button>
                  );
                })}
              </div>
            </section>
          ))}
          {hasTemplates && (
            <section className="wf-add-step-section">
              <h4>{t("workflowNodes.templatesSection", "Templates")}</h4>
              <div className="wf-add-step-grid">
                {filteredFragments.map((fragment) => (
                  <button
                    key={fragment.id}
                    type="button"
                    className="wf-add-step-option wf-add-step-option--template"
                    data-testid={`wf-add-step-fragment-${fragment.id}`}
                    onClick={() => onPickFragment(fragment)}
                  >
                    <span className="wf-add-step-option-chip" aria-hidden>
                      <Puzzle size={16} />
                    </span>
                    <span className="wf-add-step-option-text">
                      <span className="wf-add-step-option-label">{fragment.name}</span>
                      <span className="wf-add-step-option-desc">
                        {t("workflowNodes.addStepFragmentDesc", "Workflow fragment")}
                      </span>
                    </span>
                  </button>
                ))}
                {filteredStepTemplates.map((template) => (
                  <div key={template.id} className="wf-add-step-template-row">
                    <button
                      type="button"
                      className="wf-add-step-option wf-add-step-option--template"
                      data-testid={`wf-add-step-tpl-${template.id}`}
                      onClick={() => onPickStepTemplate(template)}
                    >
                      <span className="wf-add-step-option-chip" aria-hidden>
                        <Puzzle size={16} />
                      </span>
                      <span className="wf-add-step-option-text">
                        <span className="wf-add-step-option-label">{template.name}</span>
                        {template.description ? (
                          <span className="wf-add-step-option-desc">{template.description}</span>
                        ) : null}
                      </span>
                    </button>
                    {!disallowContainers && (
                      <button
                        type="button"
                        className="wf-add-step-optional"
                        data-testid={`wf-add-step-tpl-${template.id}-optional-group`}
                        title={t("workflowNodes.insertTemplateAsOptionalGroup", "Insert {{name}} as optional group", {
                          name: template.name,
                        })}
                        aria-label={t("workflowNodes.insertTemplateAsOptionalGroup", "Insert {{name}} as optional group", {
                          name: template.name,
                        })}
                        onClick={() => onPickStepTemplateAsOptionalGroup(template)}
                      >
                        <ToggleRight size={13} aria-hidden />
                        <span>{t("workflowNodes.asOptionalGroup", "as optional group")}</span>
                      </button>
                    )}
                  </div>
                ))}
                {filteredPluginTemplates.map(({ pluginId, template }) => (
                  <button
                    key={`${pluginId}:${template.id}`}
                    type="button"
                    className="wf-add-step-option wf-add-step-option--template"
                    data-testid={`wf-add-step-plugin-tpl-${template.id}`}
                    onClick={() => onPickStepTemplate(template)}
                  >
                    <span className="wf-add-step-option-chip" aria-hidden>
                      <Puzzle size={16} />
                    </span>
                    <span className="wf-add-step-option-text">
                      <span className="wf-add-step-option-label">{template.name}</span>
                      <span className="wf-add-step-option-desc">{pluginId}</span>
                    </span>
                  </button>
                ))}
              </div>
            </section>
          )}
          {!hasAnyResult && (
            <p className="wf-add-step-empty" data-testid="wf-add-step-empty">
              {t("workflowNodes.addStepNoMatches", "No steps match “{{query}}”.", { query })}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
