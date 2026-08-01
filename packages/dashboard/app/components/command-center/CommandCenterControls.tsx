import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { Power } from "lucide-react";
import { DEFAULT_PROJECT_SETTINGS, type ColorTheme, type ThemeMode } from "@fusion/core";
import { fetchConfig, fetchSettings, updateSettings } from "../../api/legacy";
import { useAppSettings } from "../../hooks/useAppSettings";
import { useConfirm } from "../../hooks/useConfirm";
// FNXC:GlobalConcurrencyControls 2026-06-25-22:45: Concurrency card adopts the shared global-concurrency hook so it and the footer EngineControlMenu read/write ONE source of truth (no more duplicated fetch/debounce/clobber logic).
import { useGlobalConcurrency } from "../../hooks/useGlobalConcurrency";
import { ThemeDropdown } from "../ThemeDropdown";
import type { TaskView } from "../../hooks/useViewState";
import "./CommandCenterControls.css";

export interface CommandCenterControlsProps {
  projectId?: string;
  colorTheme: ColorTheme;
  themeMode: ThemeMode;
  shadcnCustomColors?: Record<string, string>;
  resolvedThemeMode?: "dark" | "light";
  onColorThemeChange: (theme: ColorTheme) => void;
  onThemeModeChange: (mode: ThemeMode) => void;
  onShadcnCustomColorsChange?: (colors: Record<string, string>) => void;
  /* FNXC:CommandCenter 2026-06-22-20:55: View Board / View Agents shortcuts live in the AI engine card (under Stop AI Engine), so this is the single AI-engine instance on Overview — the duplicate cc-overview-engine-panel was removed. */
  onChangeView?: (view: TaskView) => void;
}

type AsyncState<T> =
  | { status: "loading"; data: T | null; error: null }
  | { status: "loaded"; data: T; error: null }
  | { status: "error"; data: T | null; error: string };

type ConcurrencyValues = {
  maxConcurrent: number;
  maxWorktrees: number;
  worktreeLimitEnabled: boolean;
};

const CONCURRENCY_SAVE_DEBOUNCE_MS = 500;
const DEFAULT_CONCURRENCY_VALUES: ConcurrencyValues = {
  maxConcurrent: DEFAULT_PROJECT_SETTINGS.maxConcurrent,
  maxWorktrees: DEFAULT_PROJECT_SETTINGS.maxWorktrees,
  worktreeLimitEnabled: Boolean(DEFAULT_PROJECT_SETTINGS.worktreeLimitEnabled),
};

const CONCURRENCY_SLIDER_LIMITS: Record<Exclude<keyof ConcurrencyValues, "worktreeLimitEnabled">, { min: number; max: number }> = {
  maxConcurrent: { min: 1, max: 50 },
  maxWorktrees: { min: 1, max: 50 },
};

const CONCURRENCY_SETTING_LABEL_KEYS: Record<Exclude<keyof ConcurrencyValues, "worktreeLimitEnabled">, { key: string; defaultValue: string }> = {
  maxConcurrent: { key: "commandCenter.controls.concurrency.maxConcurrent", defaultValue: "Max concurrent tasks" },
  maxWorktrees: { key: "commandCenter.controls.concurrency.maxWorktrees", defaultValue: "Max worktrees" },
};

/*
FNXC:CommandCenter 2026-06-21-00:00:
Operator concurrency sliders must allow dragging each scheduler capacity control up to 50 by default while still expanding beyond 50 for already-persisted higher values so FN-6768 truthful readouts remain intact.

FNXC:CommandCenter 2026-07-18-18:18:
FN-8351 keeps Overview controls limited to global AI engine, Theme, and Concurrency controls. Org chart, heartbeat control, and organization portability now belong to the Team tab so team operations are not duplicated across Command Center sections.
*/
function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function getConcurrencySliderMax(key: Exclude<keyof ConcurrencyValues, "worktreeLimitEnabled">, value: number) {
  return Math.max(CONCURRENCY_SLIDER_LIMITS[key].max, value);
}

/*
FNXC:GlobalConcurrencyControls 2026-07-15-17:30:
FN-8007 supersedes FN-7160's 0-based utilization ratio: the current-use dot must share the native range thumb's min-relative coordinates so it lines up with the running-count value. With sliderMin 1, one running agent maps to the visible track start; over-cap use pins to the cap thumb rather than the expanded sliderMax endpoint.
*/
function getUseMarkerRatio(currentRunning: number, capValue: number, sliderMin: number, sliderMax: number) {
  if (sliderMax <= sliderMin) return 0;
  return clamp((Math.min(currentRunning, capValue) - sliderMin) / (sliderMax - sliderMin), 0, 1);
}

function getUseMarkerStyle(ratio: number): CSSProperties {
  return {
    "--use-pct": `${ratio * 100}%`,
    "--use-offset": `calc((var(--cc-controls-range-thumb-size) / 2) + ((100% - var(--cc-controls-range-thumb-size)) * ${ratio}))`,
  } as CSSProperties;
}

function getChangedConcurrencyKeys(values: ConcurrencyValues, persisted: ConcurrencyValues) {
  return (Object.keys(CONCURRENCY_SETTING_LABEL_KEYS) as Array<Exclude<keyof ConcurrencyValues, "worktreeLimitEnabled">>)
    .filter((key) => values[key] !== persisted[key]);
}

function StatusPill({ paused, label }: { paused: boolean; label: string }) {
  return (
    <span className="cc-controls-status-pill">
      <span className={`status-dot ${paused ? "status-dot--pending" : "status-dot--online"}`} aria-hidden="true" />
      <span>{label}</span>
    </span>
  );
}

export function CommandCenterControls({ projectId, colorTheme, themeMode, shadcnCustomColors = {}, resolvedThemeMode = themeMode === "light" ? "light" : "dark", onColorThemeChange, onThemeModeChange, onShadcnCustomColorsChange = () => {}, onChangeView }: CommandCenterControlsProps) {
  const { t } = useTranslation("app");
  const { confirm } = useConfirm();
  const {
    globalPaused,
    toggleGlobalPause,
    refresh,
  } = useAppSettings(projectId);
  const [concurrencyState, setConcurrencyState] = useState<AsyncState<ConcurrencyValues>>({ status: "loading", data: null, error: null });
  const [concurrencyDirty, setConcurrencyDirty] = useState(false);
  const [concurrencySaveState, setConcurrencySaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const persistedConcurrencyRef = useRef<ConcurrencyValues>(DEFAULT_CONCURRENCY_VALUES);
  const pendingConcurrencyKeyRef = useRef<keyof ConcurrencyValues | null>(null);
  const concurrencyConfirmOpenRef = useRef(false);
  // FNXC:GlobalConcurrencyControls 2026-06-25-22:45: No activeWhen — the card is mounted only while visible, so it fetches on mount and flushes pending writes on unmount via the shared hook.
  const gc = useGlobalConcurrency();

  useEffect(() => {
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
            worktreeLimitEnabled: settings.worktreeLimitEnabled !== false,
          };
          persistedConcurrencyRef.current = persistedValues;
          pendingConcurrencyKeyRef.current = null;
          concurrencyConfirmOpenRef.current = false;
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
            data: persistedConcurrencyRef.current,
            error: error instanceof Error ? error.message : t("commandCenter.controls.concurrency.error", "Unable to load concurrency settings"),
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, t]);

  /*
  FNXC:CommandCenter 2026-06-26-00:00:
  Concurrency edits mutate live scheduler capacity, so the card must ask for explicit operator confirmation after a slider settles. The UI still updates optimistically while dragging, but cancel, close, backdrop, and Escape all revert to the last persisted values without calling updateSettings.

  FNXC:CommandCenter 2026-06-26-18:08:
  If multiple per-project sliders change inside one debounce window, the confirmation must name every changed scheduler setting before saving the combined update so no capacity change persists silently under another slider's dialog.
  */
  useEffect(() => {
    if (!concurrencyDirty || !concurrencyState.data || concurrencyConfirmOpenRef.current) return;
    const values = concurrencyState.data;
    const timeoutId = setTimeout(() => {
      const persisted = persistedConcurrencyRef.current;
      const changedKeys = getChangedConcurrencyKeys(values, persisted);
      if (changedKeys.length === 0) {
        setConcurrencyDirty(false);
        pendingConcurrencyKeyRef.current = null;
        return;
      }

      concurrencyConfirmOpenRef.current = true;
      const changeSummary = changedKeys.map((key) => {
        const labelMeta = CONCURRENCY_SETTING_LABEL_KEYS[key];
        return t(
          "commandCenter.controls.concurrency.confirmChangeSummaryItem",
          "{{setting}} from {{oldValue}} to {{newValue}}",
          { setting: t(labelMeta.key, labelMeta.defaultValue), oldValue: persisted[key], newValue: values[key] },
        );
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
        concurrencyConfirmOpenRef.current = false;
        if (!confirmed) {
          setConcurrencyState({ status: "loaded", data: persistedConcurrencyRef.current, error: null });
          setConcurrencyDirty(false);
          pendingConcurrencyKeyRef.current = null;
          setConcurrencySaveState("idle");
          return;
        }

        setConcurrencySaveState("saving");
        void updateSettings(values, projectId)
          .then(async () => {
            await refresh();
            persistedConcurrencyRef.current = values;
            setConcurrencyDirty(false);
            pendingConcurrencyKeyRef.current = null;
            setConcurrencySaveState("saved");
          })
          .catch(() => {
            setConcurrencySaveState("error");
          });
      });
    }, CONCURRENCY_SAVE_DEBOUNCE_MS);
    return () => clearTimeout(timeoutId);
  }, [confirm, concurrencyDirty, concurrencyState.data, projectId, refresh, t]);

  const updateConcurrencyValue = (key: Exclude<keyof ConcurrencyValues, "worktreeLimitEnabled">, rawValue: string, min: number, max: number) => {
    const nextValue = clamp(Number(rawValue), min, max);
    pendingConcurrencyKeyRef.current = key;
    setConcurrencyState((current) => ({
      status: "loaded",
      data: { ...(current.data ?? DEFAULT_CONCURRENCY_VALUES), [key]: nextValue },
      error: null,
    }));
    setConcurrencyDirty(true);
    setConcurrencySaveState("idle");
  };

  const effectiveGlobalPaused = globalPaused;
  const concurrencyValues = concurrencyState.data ?? DEFAULT_CONCURRENCY_VALUES;
  const globalCountsLoaded = gc.status === "loaded";
  const projectActive = gc.projectActiveCount(projectId);
  const maxConcurrentSliderMax = getConcurrencySliderMax("maxConcurrent", concurrencyValues.maxConcurrent);
  const worktreesEditable = concurrencyState.status === "loaded" && concurrencyValues.worktreeLimitEnabled;
  const slidersEditable = concurrencyState.status === "loaded";
  const projectUseMarkerRatio = getUseMarkerRatio(
    projectActive,
    concurrencyValues.maxConcurrent,
    CONCURRENCY_SLIDER_LIMITS.maxConcurrent.min,
    maxConcurrentSliderMax,
  );
  /*
  FNXC:CommandCenter 2026-06-20-00:20:
  The concurrency card must reflect actual persisted scheduler settings, including values above the usual slider ranges, instead of silently clamping the readout. The slider max expands to the current persisted value so the numeric readout and input value remain truthful; user edits are still clamped into that input's current valid bounds before saving.

  FNXC:CommandCenter 2026-06-19-12:35:
  The Command Center concurrency sliders mutate live scheduler limits through the existing /api/settings path; after each debounced save, refresh useAppSettings so the running dashboard reflects the new scheduler capacity without local shadow state drifting.

  FNXC:CommandCenter 2026-06-19-12:30:
  Engine controls stop/start all AI work via globalPause. Heartbeat pause/resume moved to TeamArea but still reuses useAppSettings there so Command Center does not add backend routes or competing scheduler state.
  */
  return (
    <section className="cc-controls" data-testid="command-center-controls" aria-label={t("commandCenter.controls.title", "Operator controls")}>
      <div className="cc-controls-grid">
        <section className="card cc-controls-card" data-testid="cc-controls-engine">
          <div className="cc-controls-card-header">
            <div>
              <h3>{t("commandCenter.controls.engine.title", "AI engine")}</h3>
              <p>{t("commandCenter.controls.engine.description", "Stopping the engine halts all AI work.")}</p>
            </div>
            <StatusPill
              paused={effectiveGlobalPaused}
              label={effectiveGlobalPaused ? t("commandCenter.controls.status.stopped", "Stopped") : t("commandCenter.controls.status.running", "Running")}
            />
          </div>
          <button
            type="button"
            className="btn btn-secondary cc-controls-action"
            onClick={() => void toggleGlobalPause()}
          >
            <Power size={16} aria-hidden="true" />
            <span>
              {effectiveGlobalPaused
                ? t("header.startAiEngine", "Start AI Engine")
                : t("header.stopAiEngine", "Stop AI Engine")}
            </span>
          </button>
          {onChangeView ? (
            <div className="cc-overview-engine-nav" data-testid="command-center-engine-panel">
              <button
                type="button"
                className="btn btn-secondary cc-overview-engine-nav-btn"
                onClick={() => onChangeView("board")}
              >
                {t("commandCenter.controls.engine.viewBoard", "View Board")}
              </button>
              <button
                type="button"
                className="btn btn-secondary cc-overview-engine-nav-btn"
                onClick={() => onChangeView("agents")}
              >
                {t("commandCenter.controls.engine.viewAgents", "View Agents")}
              </button>
            </div>
          ) : null}
        </section>

        <section className="card cc-controls-card" data-testid="cc-controls-theme">
          <div className="cc-controls-card-header">
            <div>
              <h3>{t("commandCenter.controls.theme.title", "Theme")}</h3>
              <p>{t("commandCenter.controls.theme.description", "Switch the dashboard theme with live color previews.")}</p>
            </div>
          </div>
          <ThemeDropdown
            colorTheme={colorTheme}
            themeMode={themeMode}
            shadcnCustomColors={shadcnCustomColors}
            resolvedThemeMode={resolvedThemeMode}
            onColorThemeChange={onColorThemeChange}
            onThemeModeChange={onThemeModeChange}
            onShadcnCustomColorsChange={onShadcnCustomColorsChange}
          />
        </section>


        <section className="card cc-controls-card cc-controls-card--concurrency" data-testid="cc-controls-concurrency">
          <div className="cc-controls-card-header">
            <div>
              <h3>{t("commandCenter.controls.concurrency.title", "Concurrency")}</h3>
              <p>{t("commandCenter.controls.concurrency.description", "Tune live scheduler capacity.")}</p>
            </div>
            <span className={`cc-controls-save-state cc-controls-save-state--${concurrencySaveState}`} aria-live="polite">
              {concurrencyState.status === "loading"
                ? t("commandCenter.controls.status.loading", "Loading…")
                : concurrencySaveState === "saving"
                  ? t("commandCenter.controls.status.saving", "Saving…")
                  : concurrencySaveState === "saved"
                    ? t("commandCenter.controls.status.saved", "Saved")
                    : concurrencySaveState === "error"
                      ? t("commandCenter.controls.status.saveError", "Save failed")
                      : t("commandCenter.controls.status.ready", "Ready")}
            </span>
          </div>
          <div className="cc-controls-sliders">
            {/*
            FNXC:CapacityModel 2026-07-28-23:45 (drop the cross-project cap — settings half):
            The Global Max Concurrent SLIDER is deleted: the machine-wide cap it wrote no
            longer exists (capacity is two numbers PER PROJECT) and its PUT route is gone.
            A slider that persists nothing is worse than no slider.

            The live "N running (all projects)" READOUT is kept, moved onto the
            per-project row below. It is telemetry, not a limit — "how busy is this
            machine?" is still a real question once the cap that used to answer it is gone.
            */}
            <label className="cc-controls-slider" htmlFor="cc-max-concurrent">
              <span className="cc-controls-slider-label">
                {t("commandCenter.controls.concurrency.maxConcurrent", "Max concurrent tasks")}
                <strong>{concurrencyValues.maxConcurrent}</strong>
              </span>
              {globalCountsLoaded ? (
                <>
                  <small className="cc-controls-slider-caption" data-testid="cc-project-running">
                    {t("commandCenter.controls.concurrency.runningProject", "{{count}} running (this project)", { count: projectActive })}
                  </small>
                  <small className="cc-controls-slider-caption" data-testid="cc-global-running">
                    {t("commandCenter.controls.concurrency.runningGlobal", "{{count}} running (all projects)", { count: gc.currentlyActive })}
                  </small>
                </>
              ) : null}
              <span className="cc-controls-range-wrap">
                <input
                  id="cc-max-concurrent"
                  className="cc-controls-touch-slider"
                  type="range"
                  min={CONCURRENCY_SLIDER_LIMITS.maxConcurrent.min}
                  max={maxConcurrentSliderMax}
                  value={concurrencyValues.maxConcurrent}
                  disabled={!slidersEditable}
                  onChange={(event) => updateConcurrencyValue(
                    "maxConcurrent",
                    event.target.value,
                    CONCURRENCY_SLIDER_LIMITS.maxConcurrent.min,
                    maxConcurrentSliderMax,
                  )}
                />
                {globalCountsLoaded ? (
                  <span
                    className="status-dot status-dot--online cc-controls-use-marker"
                    style={getUseMarkerStyle(projectUseMarkerRatio)}
                    data-testid="cc-project-use-marker"
                    aria-hidden="true"
                  />
                ) : null}
              </span>
            </label>
            {/*
            FNXC:CommandCenter 2026-08-01-00:14:
            The Concurrency card must always show both per-project capacity sliders. When
            settings are loading, failed, or intentionally disable the worktree limit, keep
            the native control visible but disabled with an explanation rather than hiding it.
            */}
            <label className="cc-controls-slider" htmlFor="cc-max-worktrees">
              <span className="cc-controls-slider-label">
                {t("commandCenter.controls.concurrency.maxWorktrees", "Max worktrees")}
                <strong>{concurrencyValues.maxWorktrees}</strong>
              </span>
              <span className="cc-controls-range-wrap">
                <input
                  id="cc-max-worktrees"
                  className="cc-controls-touch-slider"
                  type="range"
                  min={CONCURRENCY_SLIDER_LIMITS.maxWorktrees.min}
                  max={getConcurrencySliderMax("maxWorktrees", concurrencyValues.maxWorktrees)}
                  value={concurrencyValues.maxWorktrees}
                  disabled={!worktreesEditable}
                  onChange={(event) => updateConcurrencyValue(
                    "maxWorktrees",
                    event.target.value,
                    CONCURRENCY_SLIDER_LIMITS.maxWorktrees.min,
                    getConcurrencySliderMax("maxWorktrees", concurrencyValues.maxWorktrees),
                  )}
                />
              </span>
              {!concurrencyValues.worktreeLimitEnabled && concurrencyState.status === "loaded" ? (
                <small className="cc-controls-slider-caption">
                  {t("commandCenter.controls.concurrency.worktreeLimitDisabled", "Enable the worktree limit in Settings to edit this capacity.")}
                </small>
              ) : null}
            </label>
          </div>
          {concurrencyState.status === "error" ? <p className="cc-controls-error" role="alert">{concurrencyState.error}</p> : null}
        </section>
      </div>
    </section>
  );
}
