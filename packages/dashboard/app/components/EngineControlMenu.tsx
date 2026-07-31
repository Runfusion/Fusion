import "./EngineControlMenu.css";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { DEFAULT_PROJECT_SETTINGS } from "@fusion/core";
import { Pause, Play, SlidersHorizontal, Square, X } from "lucide-react";
import { fetchConfig, fetchSettings, updateSettings } from "../api/legacy";
import { useAppSettings } from "../hooks/useAppSettings";
import { useConfirm } from "../hooks/useConfirm";
// FNXC:GlobalConcurrencyControls 2026-06-25-22:45: Footer menu adopts the shared global-concurrency hook so it and the Command Center card read/write ONE source of truth (no more duplicated fetch/debounce/clobber logic).
import { useGlobalConcurrency } from "../hooks/useGlobalConcurrency";

export interface EngineControlMenuHandle {
  open: () => void;
  close: () => void;
  toggle: () => void;
}

export interface EngineControlMenuProps {
  projectId?: string;
}

type AsyncState<T> =
  | { status: "idle" | "loading"; data: T | null; error: null }
  | { status: "loaded"; data: T; error: null }
  | { status: "error"; data: T | null; error: string };

type ConcurrencyValues = {
  maxConcurrent: number;
  maxWorktrees: number;
};

const CONCURRENCY_SAVE_DEBOUNCE_MS = 500;
const DEFAULT_CONCURRENCY_VALUES: ConcurrencyValues = {
  maxConcurrent: DEFAULT_PROJECT_SETTINGS.maxConcurrent,
  maxWorktrees: DEFAULT_PROJECT_SETTINGS.maxWorktrees,
};

const CONCURRENCY_SLIDER_LIMITS: Record<keyof ConcurrencyValues, { min: number; max: number }> = {
  maxConcurrent: { min: 1, max: 50 },
  maxWorktrees: { min: 1, max: 50 },
};

const CONCURRENCY_SETTING_LABEL_KEYS: Record<keyof ConcurrencyValues, { key: string; defaultValue: string }> = {
  maxConcurrent: { key: "commandCenter.controls.concurrency.maxConcurrent", defaultValue: "Max concurrent tasks" },
  maxWorktrees: { key: "commandCenter.controls.concurrency.maxWorktrees", defaultValue: "Max worktrees" },
};

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function getConcurrencySliderMax(key: keyof ConcurrencyValues, value: number) {
  return Math.max(CONCURRENCY_SLIDER_LIMITS[key].max, value);
}

function getErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function getChangedConcurrencyKeys(values: ConcurrencyValues, persisted: ConcurrencyValues) {
  return (Object.keys(values) as Array<keyof ConcurrencyValues>).filter((key) => values[key] !== persisted[key]);
}

/*
FNXC:EngineControls 2026-06-29-16:15:
Footer confirmation copy must stay aligned with the Command Center concurrency card. Build single-setting messages from the shared summary item key so project and global-cap dialogs use the same title, message template, save label, and cancel label.
*/
function getConcurrencyChangeSummary(t: ReturnType<typeof useTranslation>["t"], setting: string, oldValue: number, newValue: number) {
  return t(
    "commandCenter.controls.concurrency.confirmChangeSummaryItem",
    "{{setting}} from {{oldValue}} to {{newValue}}",
    { setting, oldValue, newValue },
  );
}

/*
FNXC:GlobalConcurrencyControls 2026-07-15-17:30:
FN-8007 supersedes FN-7160/FN-7235's 0-based utilization ratio: the current-use dot must share the native range thumb's min-relative coordinates so it lines up with the running-count value. With sliderMin 1, one running agent maps to the visible track start; over-cap use pins to the cap thumb rather than the expanded sliderMax endpoint.
*/
function getUseMarkerRatio(currentRunning: number, capValue: number, sliderMin: number, sliderMax: number) {
  if (sliderMax <= sliderMin) return 0;
  return clamp((Math.min(currentRunning, capValue) - sliderMin) / (sliderMax - sliderMin), 0, 1);
}

function getUseMarkerStyle(ratio: number): CSSProperties {
  return {
    "--use-pct": `${ratio * 100}%`,
    "--use-offset": `calc((var(--engine-control-range-thumb-size) / 2) + ((100% - var(--engine-control-range-thumb-size)) * ${ratio}))`,
  } as CSSProperties;
}

/*
FNXC:EngineControls 2026-06-21-00:00:
Engine stop/start, triage pause/resume, and live scheduler concurrency/worktree sliders moved from the Header split button into the footer status bar. Operators open this popover from the footer trigger or running-status text, and the sliders reuse the existing /api/settings debounce flow so no backend route is added for live scheduler tuning.

FNXC:EngineControls 2026-06-21-00:00:
FN-6862 requires the footer popover chrome to stay opaque across themes. Its CSS must use a defined solid surface token (`var(--card)`) because `--surface-elevated` is not in the dashboard token vocabulary and makes the menu transparent when unresolved.

FNXC:EngineControls 2026-06-21-00:00:
FN-6863 raises the footer concurrency sliders' base drag ceiling to 50 for max tasks, triage, and worktrees. Keep getConcurrencySliderMax value-aware so already-persisted settings above 50 expand the slider instead of hiding or clamping the truthful readout.
*/
export const EngineControlMenu = forwardRef<EngineControlMenuHandle, EngineControlMenuProps>(function EngineControlMenu({ projectId }, ref) {
  const { t } = useTranslation("app");
  const { confirm } = useConfirm();
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const { globalPaused, enginePaused, toggleGlobalPause, toggleEnginePause, refresh } = useAppSettings(projectId);
  const [concurrencyState, setConcurrencyState] = useState<AsyncState<ConcurrencyValues>>({ status: "idle", data: null, error: null });
  const [concurrencyDirty, setConcurrencyDirty] = useState(false);
  const [concurrencySaveState, setConcurrencySaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const persistedProjectConcurrencyRef = useRef<ConcurrencyValues>(DEFAULT_CONCURRENCY_VALUES);
  const projectConcurrencySaveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingProjectConcurrencySaveRef = useRef<ConcurrencyValues | null>(null);
  const projectConcurrencyConfirmOpenRef = useRef(false);
  const projectConcurrencyConfirmTokenRef = useRef(0);
  /*
  FNXC:CapacityModel 2026-07-29-00:10 (drop the cross-project cap — settings half):
  The footer's pending/dirty/confirm-token state for the global cap is DELETED with
  the slider it guarded. Its whole purpose was to hold an edit un-persisted until the
  operator confirmed, so a close/Escape/outside-click could not commit a drag; with
  nothing to persist there is nothing to guard.
  */
  // FNXC:EngineControls 2026-06-29-00:00: Footer per-project concurrency sliders affect live scheduler capacity, so settled edits must be confirmed before persisting; close, Escape, outside-click, backdrop, and cancel revert to the last loaded values instead of silently saving.
  // FNXC:GlobalConcurrencyControls 2026-06-25-22:45: Fetch is gated on the menu being open; the hook flushes any pending debounced write when `open` flips false.
  const gc = useGlobalConcurrency({ activeWhen: open });

  const clearProjectConcurrencySaveTimeout = useCallback(() => {
    if (projectConcurrencySaveTimeoutRef.current) {
      clearTimeout(projectConcurrencySaveTimeoutRef.current);
      projectConcurrencySaveTimeoutRef.current = null;
    }
  }, []);

  const revertPendingProjectConcurrencyEdit = useCallback(() => {
    clearProjectConcurrencySaveTimeout();
    pendingProjectConcurrencySaveRef.current = null;
    projectConcurrencyConfirmOpenRef.current = false;
    projectConcurrencyConfirmTokenRef.current += 1;
    setConcurrencyState((current) => (
      current.data
        ? { status: "loaded", data: persistedProjectConcurrencyRef.current, error: null }
        : current
    ));
    setConcurrencyDirty(false);
    setConcurrencySaveState("idle");
  }, [clearProjectConcurrencySaveTimeout]);


  const closeMenu = useCallback(() => {
    if (concurrencyDirty || pendingProjectConcurrencySaveRef.current || projectConcurrencyConfirmOpenRef.current) {
      revertPendingProjectConcurrencyEdit();
    }
    setOpen(false);
  }, [concurrencyDirty, revertPendingProjectConcurrencyEdit]);
  const openMenu = useCallback(() => setOpen(true), []);
  const toggleMenu = useCallback(() => {
    if (open && (concurrencyDirty || pendingProjectConcurrencySaveRef.current || projectConcurrencyConfirmOpenRef.current)) {
      revertPendingProjectConcurrencyEdit();
    }
    setOpen((current) => !current);
  }, [concurrencyDirty, open, revertPendingProjectConcurrencyEdit]);

  useImperativeHandle(ref, () => ({
    open: openMenu,
    close: closeMenu,
    toggle: toggleMenu,
  }), [closeMenu, openMenu, toggleMenu]);

  useEffect(() => {
    if (!open) return;

    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target;
      if (projectConcurrencyConfirmOpenRef.current && target instanceof Element && target.closest(".confirm-dialog-overlay, .confirm-dialog")) {
        return;
      }
      if (menuRef.current && target instanceof Node && !menuRef.current.contains(target)) {
        closeMenu();
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeMenu();
    };

    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [closeMenu, open]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setConcurrencyDirty(false);
    setConcurrencySaveState("idle");
    setConcurrencyState({ status: "loading", data: null, error: null });
    void (async () => {
      try {
        const [config, settings] = await Promise.all([fetchConfig(projectId), fetchSettings(projectId)]);
        if (!cancelled) {
          const persistedValues = {
            maxConcurrent: settings.maxConcurrent ?? config.maxConcurrent ?? DEFAULT_CONCURRENCY_VALUES.maxConcurrent,
            maxWorktrees: settings.maxWorktrees ?? DEFAULT_CONCURRENCY_VALUES.maxWorktrees,
          };
          persistedProjectConcurrencyRef.current = persistedValues;
          pendingProjectConcurrencySaveRef.current = null;
          projectConcurrencyConfirmOpenRef.current = false;
          setConcurrencyState({
            status: "loaded",
            data: persistedValues,
            error: null,
          });
        }
      } catch (error) {
        if (!cancelled) {
          setConcurrencyState({
            status: "error",
            data: DEFAULT_CONCURRENCY_VALUES,
            error: getErrorMessage(error, t("commandCenter.controls.concurrency.error", "Unable to load concurrency settings")),
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, projectId, t]);

  useEffect(() => {
    if (!open || !concurrencyDirty || !concurrencyState.data || projectConcurrencyConfirmOpenRef.current) return;
    const values = concurrencyState.data;
    const confirmToken = projectConcurrencyConfirmTokenRef.current;
    pendingProjectConcurrencySaveRef.current = values;
    projectConcurrencySaveTimeoutRef.current = setTimeout(() => {
      pendingProjectConcurrencySaveRef.current = null;
      projectConcurrencySaveTimeoutRef.current = null;
      const persisted = persistedProjectConcurrencyRef.current;
      const changedKeys = getChangedConcurrencyKeys(values, persisted);
      if (changedKeys.length === 0) {
        setConcurrencyDirty(false);
        setConcurrencySaveState("idle");
        return;
      }

      projectConcurrencyConfirmOpenRef.current = true;
      const changeSummary = changedKeys.map((key) => {
        const labelMeta = CONCURRENCY_SETTING_LABEL_KEYS[key];
        return getConcurrencyChangeSummary(t, t(labelMeta.key, labelMeta.defaultValue), persisted[key], values[key]);
      });
      const message = changedKeys.length === 1
        ? t(
          "commandCenter.controls.concurrency.confirmMessage",
          "Change {{setting}}?",
          { setting: changeSummary[0] },
        )
        : t(
          "commandCenter.controls.concurrency.confirmMultipleMessage",
          "Change these concurrency settings: {{settings}}?",
          { settings: changeSummary.join("; ") },
        );

      void confirm({
        title: t("commandCenter.controls.concurrency.confirmTitle", "Confirm concurrency change"),
        message,
        confirmLabel: t("commandCenter.controls.concurrency.confirmSave", "Save change"),
        cancelLabel: t("commandCenter.controls.concurrency.confirmCancel", "Cancel"),
      }).then((confirmed) => {
        projectConcurrencyConfirmOpenRef.current = false;
        if (projectConcurrencyConfirmTokenRef.current !== confirmToken || !open) return;
        if (!confirmed) {
          setConcurrencyState({ status: "loaded", data: persistedProjectConcurrencyRef.current, error: null });
          setConcurrencyDirty(false);
          setConcurrencySaveState("idle");
          return;
        }

        setConcurrencySaveState("saving");
        void updateSettings(values, projectId)
          .then(async () => {
            await refresh();
            persistedProjectConcurrencyRef.current = values;
            setConcurrencyDirty(false);
            setConcurrencySaveState("saved");
          })
          .catch(() => {
            setConcurrencySaveState("error");
          });
      });
    }, CONCURRENCY_SAVE_DEBOUNCE_MS);
    return () => {
      clearProjectConcurrencySaveTimeout();
      if (pendingProjectConcurrencySaveRef.current === values) {
        pendingProjectConcurrencySaveRef.current = null;
      }
    };
  }, [clearProjectConcurrencySaveTimeout, concurrencyDirty, concurrencyState.data, confirm, open, projectId, refresh, t]);

  const updateConcurrencyValue = (key: keyof ConcurrencyValues, rawValue: string, min: number, max: number) => {
    const nextValue = clamp(Number(rawValue), min, max);
    setConcurrencyState((current) => ({
      status: "loaded",
      data: { ...(current.data ?? DEFAULT_CONCURRENCY_VALUES), [key]: nextValue },
      error: null,
    }));
    setConcurrencyDirty(true);
    setConcurrencySaveState("idle");
  };

  const concurrencyValues = concurrencyState.data ?? DEFAULT_CONCURRENCY_VALUES;
  const saveLabel = concurrencyState.status === "loading"
    ? t("commandCenter.controls.status.loading", "Loading…")
    : concurrencySaveState === "saving"
      ? t("commandCenter.controls.status.saving", "Saving…")
      : concurrencySaveState === "saved"
        ? t("commandCenter.controls.status.saved", "Saved")
        : concurrencySaveState === "error"
          ? t("commandCenter.controls.status.saveError", "Save failed")
          : t("commandCenter.controls.status.ready", "Ready");
  const globalCountsLoaded = gc.status === "loaded";
  const projectActive = gc.projectActiveCount(projectId);
  const maxConcurrentSliderMax = getConcurrencySliderMax("maxConcurrent", concurrencyValues.maxConcurrent);
  const projectUseMarkerRatio = getUseMarkerRatio(
    projectActive,
    concurrencyValues.maxConcurrent,
    CONCURRENCY_SLIDER_LIMITS.maxConcurrent.min,
    maxConcurrentSliderMax,
  );

  return (
    <div className="engine-control-menu" ref={menuRef}>
      <button
        type="button"
        className={`btn-icon engine-control-menu__trigger${open ? " btn-icon--active" : ""}`}
        onClick={toggleMenu}
        title={t("executor.engineControls", "Engine controls")}
        aria-label={t("executor.engineControls", "Engine controls")}
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid="engine-control-menu-trigger"
      >
        <SlidersHorizontal size={14} aria-hidden="true" />
      </button>

      {open && (
        <div className="card engine-control-menu__popover" role="menu" aria-label={t("executor.engineControls", "Engine controls")} data-testid="engine-control-menu">
          {/* FNXC:EngineControls 2026-06-27-00:00: FN-7124 requires the footer engine-controls popover to expose an explicit dismiss affordance in addition to outside-click and Escape, and it must stay inside the popover so desktop and mobile layouts both keep it visible and tappable. */}
          <div className="engine-control-menu__header">
            <button
              type="button"
              className="btn-icon engine-control-menu__close"
              onClick={closeMenu}
              title={t("executor.engineControlsClose", "Close engine controls")}
              aria-label={t("executor.engineControlsClose", "Close engine controls")}
              data-testid="engine-control-menu-close"
            >
              <X size={14} aria-hidden="true" />
            </button>
          </div>
          <div className="engine-control-menu__section engine-control-menu__section--actions">
            <button
              type="button"
              className="btn btn-secondary engine-control-menu__action"
              onClick={() => void toggleGlobalPause()}
              role="menuitem"
              data-testid="engine-control-stop-btn"
            >
              {globalPaused ? <Play size={16} aria-hidden="true" /> : <Square size={16} aria-hidden="true" />}
              <span>{globalPaused ? t("header.startAiEngine", "Start AI Engine") : t("header.stopAiEngine", "Stop AI Engine")}</span>
            </button>
            <button
              type="button"
              className="btn btn-secondary engine-control-menu__action"
              onClick={() => void toggleEnginePause()}
              role="menuitem"
              disabled={globalPaused}
              title={globalPaused ? t("executor.triageDisabledWhileStopped", "Start the AI engine before changing triage scheduling") : undefined}
              data-testid="engine-control-pause-triage-btn"
            >
              {enginePaused ? <Play size={16} aria-hidden="true" /> : <Pause size={16} aria-hidden="true" />}
              <span>{enginePaused ? t("header.resumeScheduling", "Resume scheduling") : t("header.pauseTriage", "Pause triage")}</span>
            </button>
          </div>

          <div className="engine-control-menu__section engine-control-menu__section--sliders">
            <div className="engine-control-menu__section-header">
              <span>{t("commandCenter.controls.concurrency.title", "Concurrency")}</span>
              {/*
              FNXC:CapacityModel 2026-07-28-23:45 (drop the cross-project cap — settings half):
              The Global Max Concurrent SECTION above this one is deleted: the machine-wide
              cap it wrote no longer exists (capacity is two numbers PER PROJECT) and its PUT
              route is gone. The live "N running (all projects)" readout moves here —
              telemetry, never a limit.
              */}
              {globalCountsLoaded ? (
                <span className="engine-control-menu__scope-caption" data-testid="engine-control-global-running">
                  {t("commandCenter.controls.concurrency.runningGlobal", "{{count}} running (all projects)", { count: gc.currentlyActive })}
                </span>
              ) : null}
              <span className={`engine-control-menu__save-state engine-control-menu__save-state--${concurrencySaveState}`} aria-live="polite">
                {saveLabel}
              </span>
            </div>
            {/**
              FNXC:GlobalConcurrencyControls 2026-06-26-06:26:
              The footer concurrency panel now shows read-only utilization counts next to the editable caps so operators can compare running agents against limits without opening another dashboard surface. Counts render only after the shared global-concurrency hook is loaded to avoid presenting a stale zero as live truth.
            */}
            <label className="engine-control-menu__slider" htmlFor="engine-control-max-concurrent">
              <span className="engine-control-menu__slider-label">
                {t("commandCenter.controls.concurrency.maxConcurrent", "Max concurrent tasks")}
                <strong>{concurrencyValues.maxConcurrent}</strong>
              </span>
              {globalCountsLoaded ? (
                <span className="engine-control-menu__slider-meta" data-testid="engine-control-project-running">
                  {t("commandCenter.controls.concurrency.runningProject", "{{count}} running (this project)", { count: projectActive })}
                </span>
              ) : null}
              <span className="engine-control-menu__range-wrap">
                <input
                  id="engine-control-max-concurrent"
                  className="engine-control-menu__range input"
                  type="range"
                  min={CONCURRENCY_SLIDER_LIMITS.maxConcurrent.min}
                  max={maxConcurrentSliderMax}
                  value={concurrencyValues.maxConcurrent}
                  disabled={concurrencyState.status === "loading"}
                  onChange={(event) => updateConcurrencyValue(
                    "maxConcurrent",
                    event.target.value,
                    CONCURRENCY_SLIDER_LIMITS.maxConcurrent.min,
                    maxConcurrentSliderMax,
                  )}
                />
                {globalCountsLoaded ? (
                  <span
                    className="status-dot status-dot--online engine-control-menu__use-marker"
                    style={getUseMarkerStyle(projectUseMarkerRatio)}
                    data-testid="engine-control-project-use-marker"
                    aria-hidden="true"
                  />
                ) : null}
              </span>
            </label>
            <label className="engine-control-menu__slider" htmlFor="engine-control-max-worktrees">
              <span className="engine-control-menu__slider-label">
                {t("commandCenter.controls.concurrency.maxWorktrees", "Max worktrees")}
                <strong>{concurrencyValues.maxWorktrees}</strong>
              </span>
              <input
                id="engine-control-max-worktrees"
                className="engine-control-menu__range input"
                type="range"
                min={CONCURRENCY_SLIDER_LIMITS.maxWorktrees.min}
                max={getConcurrencySliderMax("maxWorktrees", concurrencyValues.maxWorktrees)}
                value={concurrencyValues.maxWorktrees}
                disabled={concurrencyState.status === "loading"}
                onChange={(event) => updateConcurrencyValue(
                  "maxWorktrees",
                  event.target.value,
                  CONCURRENCY_SLIDER_LIMITS.maxWorktrees.min,
                  getConcurrencySliderMax("maxWorktrees", concurrencyValues.maxWorktrees),
                )}
              />
            </label>
            {concurrencyState.status === "error" ? <p className="engine-control-menu__error" role="alert">{concurrencyState.error}</p> : null}
          </div>
        </div>
      )}
    </div>
  );
});
