import "./EngineControlMenu.css";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { DEFAULT_PROJECT_SETTINGS } from "@fusion/core";
import { Pause, Play, SlidersHorizontal, Square } from "lucide-react";
import { fetchConfig, fetchSettings, updateSettings } from "../api/legacy";
import { useAppSettings } from "../hooks/useAppSettings";
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
  maxTriageConcurrent: number;
  maxWorktrees: number;
};

const CONCURRENCY_SAVE_DEBOUNCE_MS = 500;
const DEFAULT_CONCURRENCY_VALUES: ConcurrencyValues = {
  maxConcurrent: DEFAULT_PROJECT_SETTINGS.maxConcurrent,
  maxTriageConcurrent: DEFAULT_PROJECT_SETTINGS.maxTriageConcurrent,
  maxWorktrees: DEFAULT_PROJECT_SETTINGS.maxWorktrees,
};

const CONCURRENCY_SLIDER_LIMITS: Record<keyof ConcurrencyValues, { min: number; max: number }> = {
  maxConcurrent: { min: 1, max: 50 },
  maxTriageConcurrent: { min: 1, max: 50 },
  maxWorktrees: { min: 1, max: 50 },
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
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const { globalPaused, enginePaused, toggleGlobalPause, toggleEnginePause, refresh } = useAppSettings(projectId);
  const [concurrencyState, setConcurrencyState] = useState<AsyncState<ConcurrencyValues>>({ status: "idle", data: null, error: null });
  const [concurrencyDirty, setConcurrencyDirty] = useState(false);
  const [concurrencySaveState, setConcurrencySaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  // FNXC:GlobalConcurrencyControls 2026-06-25-22:45: Fetch is gated on the menu being open; the hook flushes any pending debounced write when `open` flips false.
  const gc = useGlobalConcurrency({ activeWhen: open });

  const closeMenu = useCallback(() => setOpen(false), []);
  const openMenu = useCallback(() => setOpen(true), []);
  const toggleMenu = useCallback(() => setOpen((current) => !current), []);

  useImperativeHandle(ref, () => ({
    open: openMenu,
    close: closeMenu,
    toggle: toggleMenu,
  }), [closeMenu, openMenu, toggleMenu]);

  useEffect(() => {
    if (!open) return;

    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };

    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

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
          setConcurrencyState({
            status: "loaded",
            data: {
              maxConcurrent: settings.maxConcurrent ?? config.maxConcurrent ?? DEFAULT_CONCURRENCY_VALUES.maxConcurrent,
              maxTriageConcurrent: settings.maxTriageConcurrent ?? DEFAULT_CONCURRENCY_VALUES.maxTriageConcurrent,
              maxWorktrees: settings.maxWorktrees ?? DEFAULT_CONCURRENCY_VALUES.maxWorktrees,
            },
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
    if (!open || !concurrencyDirty || !concurrencyState.data) return;
    const values = concurrencyState.data;
    const timeoutId = setTimeout(() => {
      setConcurrencySaveState("saving");
      void updateSettings(values, projectId)
        .then(async () => {
          await refresh();
          setConcurrencyDirty(false);
          setConcurrencySaveState("saved");
        })
        .catch(() => {
          setConcurrencySaveState("error");
        });
    }, CONCURRENCY_SAVE_DEBOUNCE_MS);
    return () => clearTimeout(timeoutId);
  }, [concurrencyDirty, concurrencyState.data, open, projectId, refresh]);

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
  // FNXC:GlobalConcurrencyControls 2026-06-25-22:45: Mirror the per-project slider save-state labels for the shared global cap (Loading…/Load failed/Saving…/Saved/Save failed/Ready).
  // FNXC:GlobalConcurrencyControls 2026-06-26-06:05: A failed initial load leaves saveState "idle", so without an explicit error branch the label fell through to "Ready" while the slider was disabled and an error alert was shown. Surface the load error instead.
  const globalSaveLabel = gc.status === "loading" || gc.status === "idle"
    ? t("commandCenter.controls.status.loading", "Loading…")
    : gc.status === "error"
    ? t("commandCenter.controls.status.loadError", "Load failed")
    : gc.saveState === "saving"
      ? t("commandCenter.controls.status.saving", "Saving…")
      : gc.saveState === "saved"
        ? t("commandCenter.controls.status.saved", "Saved")
        : gc.saveState === "error"
          ? t("commandCenter.controls.status.saveError", "Save failed")
          : t("commandCenter.controls.status.ready", "Ready");
  const saveLabel = concurrencyState.status === "loading"
    ? t("commandCenter.controls.status.loading", "Loading…")
    : concurrencySaveState === "saving"
      ? t("commandCenter.controls.status.saving", "Saving…")
      : concurrencySaveState === "saved"
        ? t("commandCenter.controls.status.saved", "Saved")
        : concurrencySaveState === "error"
          ? t("commandCenter.controls.status.saveError", "Save failed")
          : t("commandCenter.controls.status.ready", "Ready");

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

          {/*
          FNXC:GlobalConcurrencyControls 2026-06-25-14:10:
          Operators need to adjust the global cross-project concurrency cap from the footer engine menu and the dashboard Concurrency card, not just the Settings modal; global cap is distinct from per-project maxConcurrent and persists via the central /api/global-concurrency endpoint.
          */}
          <div className="engine-control-menu__section engine-control-menu__section--sliders engine-control-menu__section--global">
            <div className="engine-control-menu__section-header">
              <span>{t("settings.scheduling.globalMaxConcurrent", "Global Max Concurrent")}</span>
              <span className="engine-control-menu__scope-caption">{t("commandCenter.controls.scope.allProjects", "All projects")}</span>
              <span className={`engine-control-menu__save-state engine-control-menu__save-state--${gc.saveState}`} aria-live="polite">
                {globalSaveLabel}
              </span>
            </div>
            <label className="engine-control-menu__slider" htmlFor="engine-control-global-max-concurrent">
              <span className="engine-control-menu__slider-label">
                {t("settings.scheduling.maximumConcurrentAgentsAcrossAllProjects", "Maximum concurrent agents across all projects")}
                <strong>{gc.value}</strong>
              </span>
              <input
                id="engine-control-global-max-concurrent"
                className="engine-control-menu__range input"
                type="range"
                min={gc.min}
                max={gc.sliderMax}
                value={gc.value}
                disabled={!gc.interactive}
                onChange={(event) => gc.setValue(event.target.value)}
              />
            </label>
            {gc.status === "error" ? <p className="engine-control-menu__error" role="alert">{t("commandCenter.controls.concurrency.error", "Unable to load concurrency settings")}</p> : null}
          </div>

          <div className="engine-control-menu__section engine-control-menu__section--sliders">
            <div className="engine-control-menu__section-header">
              <span>{t("commandCenter.controls.concurrency.title", "Concurrency")}</span>
              <span className={`engine-control-menu__save-state engine-control-menu__save-state--${concurrencySaveState}`} aria-live="polite">
                {saveLabel}
              </span>
            </div>
            <label className="engine-control-menu__slider" htmlFor="engine-control-max-concurrent">
              <span className="engine-control-menu__slider-label">
                {t("commandCenter.controls.concurrency.maxConcurrent", "Max concurrent tasks")}
                <strong>{concurrencyValues.maxConcurrent}</strong>
              </span>
              <input
                id="engine-control-max-concurrent"
                className="engine-control-menu__range input"
                type="range"
                min={CONCURRENCY_SLIDER_LIMITS.maxConcurrent.min}
                max={getConcurrencySliderMax("maxConcurrent", concurrencyValues.maxConcurrent)}
                value={concurrencyValues.maxConcurrent}
                disabled={concurrencyState.status === "loading"}
                onChange={(event) => updateConcurrencyValue(
                  "maxConcurrent",
                  event.target.value,
                  CONCURRENCY_SLIDER_LIMITS.maxConcurrent.min,
                  getConcurrencySliderMax("maxConcurrent", concurrencyValues.maxConcurrent),
                )}
              />
            </label>
            <label className="engine-control-menu__slider" htmlFor="engine-control-max-triage-concurrent">
              <span className="engine-control-menu__slider-label">
                {t("commandCenter.controls.concurrency.maxTriageConcurrent", "Max triage concurrent")}
                <strong>{concurrencyValues.maxTriageConcurrent}</strong>
              </span>
              <input
                id="engine-control-max-triage-concurrent"
                className="engine-control-menu__range input"
                type="range"
                min={CONCURRENCY_SLIDER_LIMITS.maxTriageConcurrent.min}
                max={getConcurrencySliderMax("maxTriageConcurrent", concurrencyValues.maxTriageConcurrent)}
                value={concurrencyValues.maxTriageConcurrent}
                disabled={concurrencyState.status === "loading"}
                onChange={(event) => updateConcurrencyValue(
                  "maxTriageConcurrent",
                  event.target.value,
                  CONCURRENCY_SLIDER_LIMITS.maxTriageConcurrent.min,
                  getConcurrencySliderMax("maxTriageConcurrent", concurrencyValues.maxTriageConcurrent),
                )}
              />
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
