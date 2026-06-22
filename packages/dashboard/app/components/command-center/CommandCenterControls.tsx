import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Power } from "lucide-react";
import { DEFAULT_PROJECT_SETTINGS, type ColorTheme, type ThemeMode } from "@fusion/core";
import { fetchConfig, fetchSettings, updateSettings } from "../../api/legacy";
import { useAppSettings } from "../../hooks/useAppSettings";
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

/*
FNXC:CommandCenter 2026-06-21-00:00:
Operator concurrency sliders must allow dragging each scheduler capacity control up to 50 by default while still expanding beyond 50 for already-persisted higher values so FN-6768 truthful readouts remain intact.

FNXC:CommandCenter 2026-06-19-13:45:
Overview controls keep only global AI engine, Theme, and Concurrency controls. Agent org chart and Heartbeat control belong to the Team tab so team-specific hierarchy and scheduler heartbeat affordances are not duplicated across Command Center sections.
*/
function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function getConcurrencySliderMax(key: keyof ConcurrencyValues, value: number) {
  return Math.max(CONCURRENCY_SLIDER_LIMITS[key].max, value);
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
  const {
    globalPaused,
    toggleGlobalPause,
    refresh,
  } = useAppSettings(projectId);
  const [concurrencyState, setConcurrencyState] = useState<AsyncState<ConcurrencyValues>>({ status: "loading", data: null, error: null });
  const [concurrencyDirty, setConcurrencyDirty] = useState(false);
  const [concurrencySaveState, setConcurrencySaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");

  useEffect(() => {
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
            error: error instanceof Error ? error.message : t("commandCenter.controls.concurrency.error", "Unable to load concurrency settings"),
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, t]);

  useEffect(() => {
    if (!concurrencyDirty || !concurrencyState.data) return;
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
  }, [concurrencyDirty, concurrencyState.data, projectId, refresh]);

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

  const effectiveGlobalPaused = globalPaused;
  const concurrencyValues = concurrencyState.data ?? DEFAULT_CONCURRENCY_VALUES;

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
                className="btn btn-sm cc-overview-engine-nav-btn"
                onClick={() => onChangeView("board")}
              >
                {t("commandCenter.controls.engine.viewBoard", "View Board")}
              </button>
              <button
                type="button"
                className="btn btn-sm cc-overview-engine-nav-btn"
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
            <label className="cc-controls-slider" htmlFor="cc-max-concurrent">
              <span className="cc-controls-slider-label">
                {t("commandCenter.controls.concurrency.maxConcurrent", "Max concurrent tasks")}
                <strong>{concurrencyValues.maxConcurrent}</strong>
              </span>
              <input
                id="cc-max-concurrent"
                className="cc-controls-touch-slider"
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
            <label className="cc-controls-slider" htmlFor="cc-max-triage-concurrent">
              <span className="cc-controls-slider-label">
                {t("commandCenter.controls.concurrency.maxTriageConcurrent", "Max triage concurrent")}
                <strong>{concurrencyValues.maxTriageConcurrent}</strong>
              </span>
              <input
                id="cc-max-triage-concurrent"
                className="cc-controls-touch-slider"
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
            <label className="cc-controls-slider" htmlFor="cc-max-worktrees">
              <span className="cc-controls-slider-label">
                {t("commandCenter.controls.concurrency.maxWorktrees", "Max worktrees")}
                <strong>{concurrencyValues.maxWorktrees}</strong>
              </span>
              <input
                id="cc-max-worktrees"
                className="cc-controls-touch-slider"
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
          </div>
          {concurrencyState.status === "error" ? <p className="cc-controls-error" role="alert">{concurrencyState.error}</p> : null}
        </section>
      </div>
    </section>
  );
}
