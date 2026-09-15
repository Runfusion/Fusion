import { AlphaButton, AlphaListBox, AlphaListBoxItem, AlphaPopoverSurface } from "./alpha-ui";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { THINKING_LEVELS } from "@fusion/core";
import { Brain } from "lucide-react";
import { CustomModelDropdown } from "./CustomModelDropdown";
import type { ModelInfo } from "../api";
import { FN_AGENT_ID } from "../hooks/useChat";
import { computeFixedMenuPosition, getLayoutViewportSize, type FixedMenuPosition } from "../utils/fixedMenuPosition";
import { isInsidePortaledModelMenu } from "../utils/portalSurfaces";

/*
FNXC:Chat-ThinkingLevel 2026-08-18-23:38:
FN-7775 only let a user pick a direct chat session's thinking (reasoning-effort) level once, at
session creation, via the New Chat dialog's model-mode picker (CustomModelDropdown's inline
selector). FN-7898 closes that gap with a small `Brain`-icon trigger next to the composer's
attach button that opens a popup listing the canonical THINKING_LEVELS plus a "Default" (clear/inherit)
option; selecting one persists immediately via PATCH /api/chat/sessions/:id and takes effect on
the session's next send. This mirrors ThemeDropdown.tsx's small-popover interaction pattern
(rootRef + pointerdown outside-close, Escape, aria-haspopup listbox) and reuses
CustomModelDropdown's exact i18n keys for level labels and the default entry, rather than
introducing a parallel thinking-level list.

FNXC:Chat-ThinkingLevel 2026-07-12-20:08:
The Default entry must describe the resolved project/global default supplied by ChatView, while omitted props preserve the legacy isolated fallback label `Default (off)`.

FNXC:Chat-ModelSwitch 2026-09-06-21:10:
Task Chat reuses this one brain-icon popover with model-only targeting, so selecting its model can never impersonate a durable agent. Every chat host now shares that model-only lane: the popover retargets a MODEL and nothing else. Chat hosts also pass the shared favorite-provider and favorite-model actions through this control so the existing dropdown renders the same persistent star affordance on desktop and mobile.

FNXC:Chat-ModelSwitch 2026-09-14-23:48:
FN-396 removes the Model/Agent toggle and the selectable agent list from this panel. Agents are solicited by writing `@Agent_Name` in the message, and each agent answers with the model and thinking level configured on its own record, so a second, contradictory place to re-assign a conversation to an agent was duplicate mechanism rather than a feature. A conversation historically bound to an agent still works: its target is surfaced read-only so the operator can see who owns it, and the server-side agent-bound session support is untouched.

FNXC:Chat-ThinkingLevel 2026-07-16-00:34:
FN-8030 lets room composers reuse this control with showTargetSection={false}. A room's thinking effort is the default reasoning effort for every responder, and rooms have no per-composer model or agent target to switch.
*/

export interface ChatThinkingLevelControlProps {
  /** Session's current thinkingLevel; null/undefined/empty means "inherit default". */
  level: string | null | undefined;
  /** Called with the newly selected level ("" for the Default/clear option). */
  onChange: (level: string) => void | Promise<void>;
  /** Resolved project/global default used only for the Default/clear label. */
  defaultThinkingLevel?: string;
  /** Show the model targeting control; rooms render only the thinking-level list. */
  showTargetSection?: boolean;
  /** Optional accessible label forwarded to the embedded model picker. */
  modelPickerLabel?: string;
  /** Optional inherited/default entry label forwarded to the embedded model picker. */
  modelDefaultOptionLabel?: string;
  /** Conversation identity; omitted and null are both a stable legacy identity. */
  targetKey?: string | null;
  /** Concrete target that this host applies when the picker chooses its default entry. */
  defaultModelValue?: string;
  models?: ModelInfo[];
  favoriteProviders?: string[];
  onToggleFavorite?: (provider: string) => void;
  favoriteModels?: string[];
  onToggleModelFavorite?: (modelId: string) => void;
  /** Conversation already bound to a durable agent; surfaced read-only, never selectable here. */
  agentId?: string | null;
  /** Display name for a bound agent; the id is used when the host cannot resolve one. */
  agentName?: string;
  modelProvider?: string | null;
  modelId?: string | null;
  onChangeModel?: (selection: { modelProvider?: string | null; modelId?: string | null }) => void | Promise<void>;
  disabled?: boolean;
}

type TargetExpectation = { agent: string; model: string };
type TargetSnapshot = TargetExpectation & { key: string | null; level: string };

export function ChatThinkingLevelControl({
  level,
  onChange,
  defaultThinkingLevel = "off",
  showTargetSection = true,
  modelPickerLabel,
  modelDefaultOptionLabel,
  targetKey,
  defaultModelValue,
  models = [],
  favoriteProviders = [],
  onToggleFavorite,
  favoriteModels = [],
  onToggleModelFavorite,
  agentId,
  agentName,
  modelProvider,
  modelId,
  onChangeModel,
  disabled = false,
}: ChatThinkingLevelControlProps) {
  const { t } = useTranslation("app");
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const [popoverPosition, setPopoverPosition] = useState<FixedMenuPosition | null>(null);
  const normalizedLevel = level ?? "";
  const currentModelValue = modelProvider && modelId ? `${modelProvider}/${modelId}` : "";
  const selectedAgentId = agentId && agentId !== FN_AGENT_ID ? agentId : "";
  const normalizedTargetKey = targetKey ?? null;
  const pendingTargetRef = useRef<TargetExpectation | null>(null);
  const lastTargetSnapshotRef = useRef<TargetSnapshot>({
    key: normalizedTargetKey,
    level: normalizedLevel,
    agent: selectedAgentId,
    model: currentModelValue,
  });
  const selectedModel = useMemo(() => {
    if (!showTargetSection || selectedAgentId || !currentModelValue) return undefined;
    const slashIdx = currentModelValue.indexOf("/");
    return models.find((model) => model.provider === currentModelValue.slice(0, slashIdx) && model.id === currentModelValue.slice(slashIdx + 1));
  }, [currentModelValue, models, selectedAgentId, showTargetSection]);
  const thinkingLevelOptions = useMemo(() => ["", ...(selectedModel?.supportedThinkingLevels ?? THINKING_LEVELS)], [selectedModel]);
  const hasStaleThinkingLevel = Boolean(normalizedLevel) && !thinkingLevelOptions.includes(normalizedLevel);
  const isActive = normalizedLevel !== "" || (showTargetSection && (Boolean(currentModelValue) || Boolean(selectedAgentId)));
  const listboxId = "chat-thinking-level-listbox";
  const targetSectionTitleId = "chat-thinking-target-section-title";

  useEffect(() => {
    if (!open) return;
    const handleOutsidePress = (event: PointerEvent | TouchEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      /*
      FNXC:Chat-ModelSwitch 2026-07-12-22:35:
      FN-7916: CustomModelDropdown renders its option list in a document.body portal outside rootRef. Treat that portaled menu as inside this popup so tablet/touch pointerdown does not dismiss the brain popup before the option onClick can persist the model selection.

      FNXC:ModelDropdown 2026-08-15-12:27:
      Use the shared portal predicate for pointer and touch origins. Mobile outside-close handlers can receive touchstart before a re-anchored menu's synthesized click lands on the popup backdrop.
      */
      const clickedInsideControl = rootRef.current?.contains(target) || popoverRef.current?.contains(target);
      if (!clickedInsideControl && !isInsidePortaledModelMenu(target)) {
        pendingTargetRef.current = null;
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", handleOutsidePress);
    document.addEventListener("touchstart", handleOutsidePress);
    return () => {
      document.removeEventListener("pointerdown", handleOutsidePress);
      document.removeEventListener("touchstart", handleOutsidePress);
    };
  }, [open]);

  const updatePopoverPosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger || typeof document === "undefined") return;
    const viewport = getLayoutViewportSize();
    const rootStyles = getComputedStyle(document.documentElement);
    const readToken = (name: string, fallback: number) => Number.parseFloat(rootStyles.getPropertyValue(name)) || fallback;
    const spaceXs = readToken("--space-xs", 4);
    const spaceLg = readToken("--space-lg", 16);
    const spaceXl = readToken("--space-xl", 32);
    const rect = trigger.getBoundingClientRect();
    setPopoverPosition(computeFixedMenuPosition({
      triggerRect: rect,
      viewportWidth: viewport.width,
      viewportHeight: viewport.height,
      preferredWidth: spaceXl * 15,
      preferredHeight: spaceXl * 24,
      minWidth: rect.width,
      horizontalPadding: spaceLg,
      verticalPadding: spaceLg,
      gap: spaceXs,
    }));
  }, []);

  /*
  FNXC:Chat-ModelSwitch 2026-09-06-21:10:
  The Brain panel is a fixed body portal, just like its nested model list. Measuring from the trigger in layout-viewport coordinates keeps both layers overlaid above the composer/footer on narrow and mobile chats; resize and capture-phase scroll re-anchor it without letting either portal enlarge a scroll container.
  */
  useLayoutEffect(() => {
    if (!open) return;
    updatePopoverPosition();
    window.addEventListener("resize", updatePopoverPosition);
    window.addEventListener("scroll", updatePopoverPosition, true);
    return () => {
      window.removeEventListener("resize", updatePopoverPosition);
      window.removeEventListener("scroll", updatePopoverPosition, true);
    };
  }, [open, updatePopoverPosition]);

  /*
  FNXC:Chat-ModelSwitch 2026-08-27-12:03:
  Drop stale options when a host changes the conversation or target underneath an open popover.
  Conversation identity is structural rather than inferred from target values because another
  conversation can carry the exact target just selected. Within one identity, only an exact,
  single-use target echo remains open; every other prop change closes it. Thinking-level picks
  are the only deliberate selection that dismisses the popover.
  */
  useEffect(() => {
    const previous = lastTargetSnapshotRef.current;
    const next: TargetSnapshot = {
      key: normalizedTargetKey,
      level: normalizedLevel,
      agent: selectedAgentId,
      model: currentModelValue,
    };
    const targetKeyMoved = previous.key !== next.key;
    const targetMoved = previous.agent !== next.agent || previous.model !== next.model;
    const levelMoved = previous.level !== next.level;

    if (targetKeyMoved) {
      pendingTargetRef.current = null;
      setOpen(false);
    } else if (targetMoved) {
      const pending = pendingTargetRef.current;
      pendingTargetRef.current = null;
      if (!pending || pending.agent !== next.agent || pending.model !== next.model) {
        setOpen(false);
      }
    } else if (levelMoved) {
      pendingTargetRef.current = null;
      setOpen(false);
    }

    lastTargetSnapshotRef.current = next;
  }, [currentModelValue, normalizedLevel, normalizedTargetKey, selectedAgentId]);

  const optionLabel = (value: string): string => {
    if (value === "") {
      return t("modelSelection.thinkingDefault", "Default ({{level}})", { level: defaultThinkingLevel ?? "off" });
    }
    return t(`models.options.${value}`, value === "xhigh" ? "Very High" : value.charAt(0).toUpperCase() + value.slice(1));
  };

  const chooseLevel = (value: string) => {
    pendingTargetRef.current = null;
    setOpen(false);
    void onChange(value);
  };

  const armTargetExpectation = (candidate: TargetExpectation) => {
    if (!onChangeModel || (candidate.agent === selectedAgentId && candidate.model === currentModelValue)) return;
    pendingTargetRef.current = candidate;
  };

  const chooseModel = (value: string) => {
    const slashIdx = value.indexOf("/");
    if (value !== "" && (slashIdx <= 0 || slashIdx === value.length - 1)) return;
    armTargetExpectation({ agent: "", model: value === "" ? defaultModelValue ?? "" : value });
    void onChangeModel?.(value === ""
      ? { modelProvider: null, modelId: null }
      : { modelProvider: value.slice(0, slashIdx), modelId: value.slice(slashIdx + 1) });
  };

  const handleTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "Escape") {
      pendingTargetRef.current = null;
      setOpen(false);
    }
  };

  const handleOptionKeyDown = (event: KeyboardEvent<HTMLElement>, value: string) => {
    if (event.key === "Escape") {
      event.preventDefault();
      pendingTargetRef.current = null;
      setOpen(false);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      chooseLevel(value);
    }
  };

  return (
    <div className="chat-thinking-level-root" ref={rootRef}>
      <AlphaButton
        ref={triggerRef}
        type="button"
        className={`btn-icon chat-thinking-btn${isActive ? " chat-thinking-btn--active" : ""}`}
        data-testid="chat-thinking-btn"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-label={t("chat.thinkingLevelButton", "Thinking level")}
        title={t("chat.thinkingLevelButton", "Thinking level")}
        disabled={disabled}
        onClick={() => setOpen((value) => {
          if (value) pendingTargetRef.current = null;
          return !value;
        })}
        onKeyDown={handleTriggerKeyDown}
      >
        <Brain size={16} />
      </AlphaButton>

      {open && popoverPosition && typeof document !== "undefined" ? createPortal(
        <AlphaPopoverSurface
          ref={popoverRef}
          triggerRef={triggerRef}
          onClose={() => setOpen(false)}
          className="chat-thinking-popover"
          role="presentation"
          data-testid="chat-thinking-popover"
          data-portal-surface="chat-thinking"
          data-open-direction={popoverPosition.openUpward ? "up" : "down"}
          style={{
            position: "fixed",
            top: popoverPosition.top ?? undefined,
            bottom: popoverPosition.bottom ?? undefined,
            left: popoverPosition.left,
            width: popoverPosition.width,
            maxHeight: popoverPosition.maxHeight,
          }}
        >
          {/*
          FNXC:Chat-ModelSwitch 2026-09-14-23:48:
          FN-396: the target section is labelled BY its visible title rather than repeating "Model" in an aria-label,
          because the embedded model picker already owns that accessible name and two identical labels are ambiguous.
          */}
          {showTargetSection ? (
          <section className="chat-thinking-target-section" aria-labelledby={targetSectionTitleId}>
            <div className="chat-thinking-section-title" id={targetSectionTitleId}>{t("chat.newChatModeModel", "Model")}</div>
            <div className="chat-thinking-model-picker" data-testid="chat-thinking-model-picker">
              <CustomModelDropdown
                models={models}
                value={currentModelValue}
                onChange={chooseModel}
                label={modelPickerLabel ?? t("chat.newChatModeModel", "Model")}
                placeholder={t("chat.selectModel", "Select a model")}
                defaultOptionLabel={modelDefaultOptionLabel}
                disabled={!onChangeModel || models.length === 0}
                favoriteProviders={favoriteProviders}
                onToggleFavorite={onToggleFavorite}
                favoriteModels={favoriteModels}
                onToggleModelFavorite={onToggleModelFavorite}
                menuWidth="readable"
              />
              {models.length === 0 ? (
                <div className="chat-thinking-empty" data-testid="chat-thinking-model-empty">
                  {t("chat.noModelsAvailable", "No models available")}
                </div>
              ) : null}
            </div>
            {selectedAgentId ? (
              <div className="chat-thinking-current-target" data-testid="chat-thinking-current-agent">
                {t("chat.currentAgentTarget", "Current agent: {{name}}", { name: agentName || selectedAgentId })}
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
            <AlphaListBox
              id={listboxId}
              className="chat-thinking-popover-list"
              aria-label={t("chat.thinkingLevelButton", "Thinking level")}
            >
              {hasStaleThinkingLevel ? (
                <AlphaListBoxItem
                  legacyAs="button"
                  id={`stale-${normalizedLevel}`}
                  textValue={normalizedLevel}
                  aria-selected
                  isDisabled
                  className="chat-thinking-popover-option"
                  data-testid={`chat-thinking-option-${normalizedLevel}`}
                >
                  {t("models.options.unavailable", "Unavailable: {{level}}", { level: normalizedLevel })}
                </AlphaListBoxItem>
              ) : null}
              {thinkingLevelOptions.map((value) => {
                const selected = normalizedLevel === value;
                return (
                  <AlphaListBoxItem
                    key={value || "default"}
                    id={value || "default"}
                    textValue={optionLabel(value)}
                    legacyAs="button"
                    aria-selected={selected}
                    className={`chat-thinking-popover-option${selected ? " active" : ""}`}
                    data-testid={`chat-thinking-option-${value || "default"}`}
                    onClick={() => chooseLevel(value)}
                    onKeyDown={(event) => handleOptionKeyDown(event, value)}
                  >
                    {optionLabel(value)}
                  </AlphaListBoxItem>
                );
              })}
            </AlphaListBox>
          </section>
        </AlphaPopoverSurface>,
        document.body,
      ) : null}
    </div>
  );
}
