import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { Bot, Brain } from "lucide-react";
import { THINKING_LEVELS } from "@fusion/core";
import { CustomModelDropdown } from "./CustomModelDropdown";
import type { ModelInfo } from "../api";
import { FN_AGENT_ID } from "../hooks/useChat";

/*
FNXC:Chat-ThinkingLevel 2026-07-12-19:30:
FN-7775 only let a user pick a direct chat session's thinking (reasoning-effort) level once, at
session creation, via the New Chat dialog's model-mode picker (CustomModelDropdown's inline
selector). FN-7898 closes that gap with a small `Brain`-icon trigger next to the composer's
attach button that opens a popup listing the six THINKING_LEVELS plus a "Default" (clear/inherit)
option; selecting one persists immediately via PATCH /api/chat/sessions/:id and takes effect on
the session's next send. This mirrors ThemeDropdown.tsx's small-popover interaction pattern
(rootRef + pointerdown outside-close, Escape, aria-haspopup listbox) and reuses
CustomModelDropdown's exact i18n keys for level labels and the default entry, rather than
introducing a parallel thinking-level list.

FNXC:Chat-ThinkingLevel 2026-07-12-20:08:
The Default entry must describe the resolved project/global default supplied by ChatView, while omitted props preserve the legacy isolated fallback label `Default (off)`.

FNXC:Chat-ModelSwitch 2026-07-12-00:00:
The same brain-icon popup now owns active direct-session targeting too: model-loop sessions can switch provider/model via CustomModelDropdown, and agent sessions can switch to a real agent from the existing list. Selecting either closes the popup and persists immediately through useChat.setSessionModel, while CLI composers stay gated in ChatView.

FNXC:Chat-ThinkingLevel 2026-07-16-00:34:
FN-8030 lets room composers reuse this control with showTargetSection={false}. A room's thinking effort is the default reasoning effort for every responder, and rooms have no per-composer model or agent target to switch.
*/

export interface ChatThinkingLevelControlAgent {
  id: string;
  name: string;
  role?: string;
}

export interface ChatThinkingLevelControlProps {
  /** Session's current thinkingLevel; null/undefined/empty means "inherit default". */
  level: string | null | undefined;
  /** Called with the newly selected level ("" for the Default/clear option). */
  onChange: (level: string) => void | Promise<void>;
  /** Resolved project/global default used only for the Default/clear label. */
  defaultThinkingLevel?: string;
  /** Show direct-chat model/agent targeting controls; rooms render only the thinking-level list. */
  showTargetSection?: boolean;
  models?: ModelInfo[];
  favoriteProviders?: string[];
  favoriteModels?: string[];
  agents?: ChatThinkingLevelControlAgent[];
  agentId?: string | null;
  modelProvider?: string | null;
  modelId?: string | null;
  onChangeModel?: (selection: { agentId?: string; modelProvider?: string | null; modelId?: string | null }) => void | Promise<void>;
  disabled?: boolean;
}

const THINKING_LEVEL_OPTIONS = ["", ...THINKING_LEVELS] as const;
type TargetMode = "model" | "agent";

export function ChatThinkingLevelControl({
  level,
  onChange,
  defaultThinkingLevel = "off",
  showTargetSection = true,
  models = [],
  favoriteProviders = [],
  favoriteModels = [],
  agents = [],
  agentId,
  modelProvider,
  modelId,
  onChangeModel,
  disabled = false,
}: ChatThinkingLevelControlProps) {
  const { t } = useTranslation("app");
  const [open, setOpen] = useState(false);
  const [targetMode, setTargetMode] = useState<TargetMode>(() => (agentId && agentId !== FN_AGENT_ID ? "agent" : "model"));
  const rootRef = useRef<HTMLDivElement | null>(null);
  const normalizedLevel = level ?? "";
  const currentModelValue = modelProvider && modelId ? `${modelProvider}/${modelId}` : "";
  const selectedAgentId = agentId && agentId !== FN_AGENT_ID ? agentId : "";
  const isActive = normalizedLevel !== "" || (showTargetSection && (Boolean(currentModelValue) || Boolean(selectedAgentId)));
  const listboxId = "chat-thinking-level-listbox";

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      /*
      FNXC:Chat-ModelSwitch 2026-07-12-22:35:
      FN-7916: CustomModelDropdown renders its option list in a document.body portal outside rootRef. Treat that portaled menu as inside this popup so tablet/touch pointerdown does not dismiss the brain popup before the option onClick can persist the model selection.
      */
      const clickedInsideRoot = rootRef.current?.contains(target);
      const clickedInsidePortaledModelMenu = target instanceof Element && Boolean(target.closest(".model-combobox-dropdown--portal"));
      if (!clickedInsideRoot && !clickedInsidePortaledModelMenu) {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [open]);

  // Close the popup whenever the underlying level or target changes out from under us
  // (e.g. the active session switched) so it never leaks open across a
  // session switch showing the previous session's options.
  useEffect(() => {
    setOpen(false);
    setTargetMode(selectedAgentId ? "agent" : "model");
  }, [normalizedLevel, selectedAgentId, currentModelValue]);

  const selectedAgent = useMemo(
    () => agents.find((agent) => agent.id === selectedAgentId),
    [agents, selectedAgentId],
  );

  const optionLabel = (value: string): string => {
    if (value === "") {
      return t("modelSelection.thinkingDefault", "Default ({{level}})", { level: defaultThinkingLevel ?? "off" });
    }
    return t(`models.options.${value}`, value === "xhigh" ? "Very High" : value.charAt(0).toUpperCase() + value.slice(1));
  };

  const chooseLevel = (value: string) => {
    setOpen(false);
    void onChange(value);
  };

  const chooseModel = (value: string) => {
    const slashIdx = value.indexOf("/");
    if (slashIdx <= 0) return;
    setOpen(false);
    void onChangeModel?.({ modelProvider: value.slice(0, slashIdx), modelId: value.slice(slashIdx + 1) });
  };

  const chooseAgent = (nextAgentId: string) => {
    if (!nextAgentId) return;
    setOpen(false);
    void onChangeModel?.({ agentId: nextAgentId });
  };

  /*
  FNXC:Chat-ModelSwitch 2026-07-24-00:00:
  Windows Electron can show the Agent toggle's pressed feedback after primary pointerdown while
  its host prevents the following click. Commit the visual mode switch on primary pointerdown so
  the available-agent list deterministically replaces the model picker; preserve click handling
  only for keyboard/synthetic activation (`detail === 0`) so one pointer gesture does not reset
  the local mode twice. `aria-pressed` makes the selected target observable to assistive tech.
  */
  const activateTargetMode = (mode: TargetMode) => {
    setTargetMode(mode);
  };

  const handleTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "Escape") {
      setOpen(false);
    }
  };

  const handleOptionKeyDown = (event: KeyboardEvent<HTMLButtonElement>, value: string) => {
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      chooseLevel(value);
    }
  };

  const handleAgentKeyDown = (event: KeyboardEvent<HTMLButtonElement>, nextAgentId: string) => {
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      chooseAgent(nextAgentId);
    }
  };

  return (
    <div className="chat-thinking-level-root" ref={rootRef}>
      <button
        type="button"
        className={`btn-icon chat-thinking-btn${isActive ? " chat-thinking-btn--active" : ""}`}
        data-testid="chat-thinking-btn"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-label={t("chat.thinkingLevelButton", "Thinking level")}
        title={t("chat.thinkingLevelButton", "Thinking level")}
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={handleTriggerKeyDown}
      >
        <Brain size={16} />
      </button>

      {open ? (
        <div className="chat-thinking-popover" role="presentation" data-testid="chat-thinking-popover">
          {showTargetSection ? (
          <section className="chat-thinking-target-section" aria-label={t("chat.modelAgentSection", "Model / Agent")}>
            <div className="chat-thinking-section-title">{t("chat.modelAgentSection", "Model / Agent")}</div>
            <div className="chat-thinking-mode-toggle" data-testid="chat-thinking-mode-toggle">
              <button
                type="button"
                className={`chat-thinking-mode-btn${targetMode === "model" ? " chat-thinking-mode-btn--active" : ""}`}
                data-testid="chat-thinking-mode-model"
                aria-pressed={targetMode === "model"}
                onPointerDown={(event) => {
                  if (event.button === 0) activateTargetMode("model");
                }}
                onClick={(event) => {
                  if (event.detail === 0) activateTargetMode("model");
                }}
              >
                {t("chat.newChatModeModel", "Model")}
              </button>
              <button
                type="button"
                className={`chat-thinking-mode-btn${targetMode === "agent" ? " chat-thinking-mode-btn--active" : ""}`}
                data-testid="chat-thinking-mode-agent"
                aria-pressed={targetMode === "agent"}
                onPointerDown={(event) => {
                  if (event.button === 0) activateTargetMode("agent");
                }}
                onClick={(event) => {
                  if (event.detail === 0) activateTargetMode("agent");
                }}
              >
                {t("chat.newChatModeAgent", "Agent")}
              </button>
            </div>

            {targetMode === "model" ? (
              <div className="chat-thinking-model-picker" data-testid="chat-thinking-model-picker">
                <CustomModelDropdown
                  models={models}
                  value={currentModelValue}
                  onChange={chooseModel}
                  label={t("chat.newChatModeModel", "Model")}
                  placeholder={t("chat.selectModel", "Select a model")}
                  disabled={!onChangeModel || models.length === 0}
                  favoriteProviders={favoriteProviders}
                  favoriteModels={favoriteModels}
                  menuWidth="readable"
                />
                {models.length === 0 ? (
                  <div className="chat-thinking-empty" data-testid="chat-thinking-model-empty">
                    {t("chat.noModelsAvailable", "No models available")}
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="chat-thinking-agent-list" data-testid="chat-thinking-agent-list">
                {agents.length === 0 ? (
                  <div className="chat-thinking-empty" data-testid="chat-thinking-agent-empty">
                    {t("chat.noAgentsAvailable", "No agents available")}
                  </div>
                ) : (
                  agents.map((agent) => {
                    const selected = selectedAgentId === agent.id;
                    return (
                      <button
                        key={agent.id}
                        type="button"
                        className={`chat-thinking-agent-item${selected ? " chat-thinking-agent-item--selected" : ""}`}
                        data-testid={`chat-thinking-agent-${agent.id}`}
                        aria-pressed={selected}
                        disabled={!onChangeModel}
                        onClick={() => chooseAgent(agent.id)}
                        onKeyDown={(event) => handleAgentKeyDown(event, agent.id)}
                      >
                        <Bot size={16} />
                        <span className="chat-thinking-agent-name">{agent.name || agent.id}</span>
                        {agent.role ? <span className="chat-thinking-agent-role">{agent.role}</span> : null}
                      </button>
                    );
                  })
                )}
              </div>
            )}
            {selectedAgent ? (
              <div className="chat-thinking-current-target" data-testid="chat-thinking-current-agent">
                {t("chat.currentAgentTarget", "Current agent: {{name}}", { name: selectedAgent.name || selectedAgent.id })}
              </div>
            ) : currentModelValue ? (
              <div className="chat-thinking-current-target" data-testid="chat-thinking-current-model">
                {t("chat.currentModelTarget", "Current model: {{model}}", { model: currentModelValue })}
              </div>
            ) : (
              <div className="chat-thinking-current-target" data-testid="chat-thinking-current-default">
                {t("chat.currentDefaultTarget", "Using the default chat target")}
              </div>
            )}
          </section>
          ) : null}

          <section className="chat-thinking-level-section" aria-label={t("chat.thinkingLevelButton", "Thinking level")}>
            <div className="chat-thinking-section-title">{t("chat.thinkingLevelSection", "Thinking level")}</div>
            <div
              id={listboxId}
              className="chat-thinking-popover-list"
              role="listbox"
              aria-label={t("chat.thinkingLevelButton", "Thinking level")}
            >
              {THINKING_LEVEL_OPTIONS.map((value) => {
                const selected = normalizedLevel === value;
                return (
                  <button
                    key={value || "default"}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    className={`chat-thinking-popover-option${selected ? " active" : ""}`}
                    data-testid={`chat-thinking-option-${value || "default"}`}
                    onClick={() => chooseLevel(value)}
                    onKeyDown={(event) => handleOptionKeyDown(event, value)}
                  >
                    {optionLabel(value)}
                  </button>
                );
              })}
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}
