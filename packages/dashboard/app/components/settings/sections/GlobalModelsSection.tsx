/**
 * Global Models section (U9 / KTD-10).
 *
 * Default + fallback model pickers, thinking-effort selector (only for reasoning
 * models), the per-role global model lanes, startup model-sync toggles, and the
 * OpenRouter advanced routing/attribution knobs. Model catalog, favorites, and
 * the favorite-toggle handlers live in the shell (fetched + persisted there) and
 * are relayed as props. The comma-list (de)serializers are reproduced locally as
 * pure helpers — identical to the modal's.
 */
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { THINKING_LEVELS } from "@fusion/core";
import type { Settings, ThinkingLevel } from "@fusion/core";
import type { ModelInfo } from "../../../api";
import { CustomModelDropdown } from "../../CustomModelDropdown";
import type { SectionBaseProps, ModelLane } from "./context";

function toCommaSeparatedInput(values?: string[]): string {
  return values?.join(", ") ?? "";
}

function fromCommaSeparatedInput(value: string): string[] {
  return value.split(",").map((item) => item.trim()).filter((item) => item.length > 0);
}

export interface GlobalModelsSectionProps extends SectionBaseProps {
  scopeBanner: ReactNode;
  availableModels: ModelInfo[];
  modelsLoading: boolean;
  /** Global model lanes (i.e. MODEL_LANES without the `default` lane). */
  globalModelLanes: ModelLane[];
  favoriteProviders: string[];
  favoriteModels: string[];
  onToggleFavorite: (provider: string) => void;
  onToggleModelFavorite: (modelId: string) => void;
}

export function GlobalModelsSection({
  scopeBanner,
  form,
  setForm,
  availableModels,
  modelsLoading,
  globalModelLanes,
  favoriteProviders,
  favoriteModels,
  onToggleFavorite,
  onToggleModelFavorite,
}: GlobalModelsSectionProps) {
  const { t } = useTranslation("app");
  const selectedValue =
    form.defaultProvider && form.defaultModelId
      ? `${form.defaultProvider}/${form.defaultModelId}`
      : "";

  return (
    <>
      {scopeBanner}

      {/* --- Default Model --- */}
      <h4 className="settings-section-heading">Default Model</h4>
      {modelsLoading ? (
        <div className="settings-empty-state">{t("settings.models.loadingModels", "Loading available models…")}</div>
      ) : availableModels.length === 0 ? (
        <div className="settings-empty-state settings-muted">
          {t("settings.models.noModels", "No models available. Configure authentication first.")}
        </div>
      ) : (
        <>
          <div className="form-group">
            <label htmlFor="defaultModel">Default Model</label>
            <CustomModelDropdown
              id="defaultModel"
              label="Default Model"
              models={availableModels}
              value={selectedValue}
              onChange={(val) => {
                if (!val) {
                  setForm((f) => ({ ...f, defaultProvider: undefined, defaultModelId: undefined }));
                } else {
                  const slashIdx = val.indexOf("/");
                  setForm((f) => ({
                    ...f,
                    defaultProvider: val.slice(0, slashIdx),
                    defaultModelId: val.slice(slashIdx + 1),
                  }));
                }
              }}
              placeholder="Use default"
              favoriteProviders={favoriteProviders}
              onToggleFavorite={onToggleFavorite}
              favoriteModels={favoriteModels}
              onToggleModelFavorite={onToggleModelFavorite}
            />
            <small>Default AI model used for task execution when no per-task override is set. &quot;Use default&quot; lets the engine choose automatically.</small>
          </div>

          <div className="form-group">
            <label htmlFor="fallbackModel">Fallback Model</label>
            <CustomModelDropdown
              id="fallbackModel"
              label="Fallback Model"
              models={availableModels}
              value={form.fallbackProvider && form.fallbackModelId ? `${form.fallbackProvider}/${form.fallbackModelId}` : ""}
              onChange={(val) => {
                if (!val) {
                  setForm((f) => ({ ...f, fallbackProvider: undefined, fallbackModelId: undefined }));
                } else {
                  const slashIdx = val.indexOf("/");
                  setForm((f) => ({
                    ...f,
                    fallbackProvider: val.slice(0, slashIdx),
                    fallbackModelId: val.slice(slashIdx + 1),
                  }));
                }
              }}
              placeholder="No fallback"
              favoriteProviders={favoriteProviders}
              onToggleFavorite={onToggleFavorite}
              favoriteModels={favoriteModels}
              onToggleModelFavorite={onToggleModelFavorite}
            />
            <small>Used automatically if the primary default model hits a retryable provider error like rate limiting or overload.</small>
          </div>
        </>
      )}
      {(() => {
        const selectedModel = availableModels.find(
          (m) => m.provider === form.defaultProvider && m.id === form.defaultModelId,
        );
        if (selectedModel && !selectedModel.reasoning) return null;
        return (
          <div className="form-group">
            <label htmlFor="defaultThinkingLevel">Thinking Effort</label>
            <select
              id="defaultThinkingLevel"
              value={form.defaultThinkingLevel || ""}
              onChange={(e) => {
                const val = e.target.value;
                setForm((f) => ({ ...f, defaultThinkingLevel: (val as ThinkingLevel) || undefined }));
              }}
            >
              <option value="">Default</option>
              {THINKING_LEVELS.map((level) => (
                <option key={level} value={level}>
                  {level.charAt(0).toUpperCase() + level.slice(1)}
                </option>
              ))}
            </select>
            <small>Controls how much reasoning effort the AI model uses. Higher levels produce better results but cost more.</small>
          </div>
        );
      })()}

      {availableModels.length > 0 && (
        <>
          <h4 className="settings-section-heading settings-section-heading--spaced">Model Lanes</h4>
          <p className="settings-description">
            Global baseline models for each AI role. Project settings can override these per-project.
          </p>
          {globalModelLanes.map((lane) => {
            const provider = form[lane.globalProviderKey as keyof Settings] as string | undefined;
            const model = form[lane.globalModelKey as keyof Settings] as string | undefined;
            const value = provider && model ? `${provider}/${model}` : "";

            return (
              <div className="form-group" key={`global-${lane.laneId}`}>
                <label htmlFor={`global-${lane.laneId}-model`}>{lane.label}</label>
                <CustomModelDropdown
                  id={`global-${lane.laneId}-model`}
                  label={lane.label}
                  models={availableModels}
                  value={value}
                  onChange={(selected) => {
                    if (!selected) {
                      setForm((f) => ({
                        ...f,
                        [lane.globalProviderKey]: undefined,
                        [lane.globalModelKey]: undefined,
                      }));
                      return;
                    }

                    const slashIdx = selected.indexOf("/");
                    setForm((f) => ({
                      ...f,
                      [lane.globalProviderKey]: selected.slice(0, slashIdx),
                      [lane.globalModelKey]: selected.slice(slashIdx + 1),
                    }));
                  }}
                  placeholder="Use default"
                  favoriteProviders={favoriteProviders}
                  onToggleFavorite={onToggleFavorite}
                  favoriteModels={favoriteModels}
                  onToggleModelFavorite={onToggleModelFavorite}
                />
                <small>{lane.helperText}</small>
              </div>
            );
          })}
        </>
      )}

      {/* --- Startup Model Sync --- */}
      <h4 className="settings-section-heading settings-section-heading--spaced">Startup Model Sync</h4>
      <div className="form-group">
        <label htmlFor="openrouterModelSync" className="checkbox-label">
          <input
            id="openrouterModelSync"
            type="checkbox"
            checked={form.openrouterModelSync !== false}
            onChange={(e) => setForm((f) => ({ ...f, openrouterModelSync: e.target.checked }))}
          />
          Sync OpenRouter model list at startup
        </label>
        <small>
          When enabled, startup fetches the latest available models from the OpenRouter API so
          model pickers always include the newest catalog.
        </small>
      </div>
      <div className="form-group">
        <label htmlFor="opencodeGoModelSync" className="checkbox-label">
          <input
            id="opencodeGoModelSync"
            type="checkbox"
            checked={form.opencodeGoModelSync !== false}
            onChange={(e) => setForm((f) => ({ ...f, opencodeGoModelSync: e.target.checked }))}
          />
          Sync opencode-go model list at startup
        </label>
        <small>
          When enabled, startup refreshes models through the local <code>opencode models opencode --refresh</code>
          flow and publishes them under the opencode-go provider in model pickers.
        </small>
      </div>
      <details>
        <summary>OpenRouter advanced</summary>
        <div className="form-group">
          <label htmlFor="openrouterAppAttributionReferer">OpenRouter HTTP-Referer</label>
          <input
            id="openrouterAppAttributionReferer"
            className="input"
            placeholder="https://runfusion.ai"
            value={form.openrouterAppAttribution?.referer ?? ""}
            onChange={(e) => setForm((f) => ({
              ...f,
              openrouterAppAttribution: {
                ...(f.openrouterAppAttribution || {}),
                referer: e.target.value,
              },
            }))}
          />
          <small>Leave empty to omit this header. Default: https://runfusion.ai.</small>
        </div>
        <div className="form-group">
          <label htmlFor="openrouterAppAttributionTitle">OpenRouter X-Title</label>
          <input
            id="openrouterAppAttributionTitle"
            className="input"
            placeholder="Fusion"
            value={form.openrouterAppAttribution?.title ?? ""}
            onChange={(e) => setForm((f) => ({
              ...f,
              openrouterAppAttribution: {
                ...(f.openrouterAppAttribution || {}),
                title: e.target.value,
              },
            }))}
          />
          <small>Leave empty to omit this header. Default: Fusion.</small>
        </div>
        <div className="form-group">
          <label htmlFor="openrouterModelFiltersSupportedParameters">OpenRouter supported_parameters filter</label>
          <input
            id="openrouterModelFiltersSupportedParameters"
            className="input"
            placeholder="tools, structured_outputs"
            value={toCommaSeparatedInput(form.openrouterModelFilters?.supported_parameters)}
            onChange={(e) => {
              const parsed = fromCommaSeparatedInput(e.target.value);
              setForm((f) => ({
                ...f,
                openrouterModelFilters: {
                  ...(f.openrouterModelFilters || {}),
                  supported_parameters: parsed.length > 0 ? parsed : undefined,
                },
              }));
            }}
          />
          <small>Comma-separated values sent to OpenRouter model sync.</small>
        </div>
        <div className="form-group">
          <label htmlFor="openrouterModelFiltersOutputModalities">OpenRouter output_modalities filter</label>
          <input
            id="openrouterModelFiltersOutputModalities"
            className="input"
            placeholder="text"
            value={toCommaSeparatedInput(form.openrouterModelFilters?.output_modalities)}
            onChange={(e) => {
              const parsed = fromCommaSeparatedInput(e.target.value);
              setForm((f) => ({
                ...f,
                openrouterModelFilters: {
                  ...(f.openrouterModelFilters || {}),
                  output_modalities: parsed.length > 0 ? parsed : undefined,
                },
              }));
            }}
          />
          <small>Comma-separated values sent to OpenRouter model sync.</small>
        </div>
        <div className="form-group">
          <label htmlFor="openrouterProviderPreferencesOrder">OpenRouter routing order</label>
          <input
            id="openrouterProviderPreferencesOrder"
            className="input"
            placeholder="openai, anthropic"
            value={toCommaSeparatedInput(form.openrouterProviderPreferences?.order)}
            onChange={(e) => {
              const parsed = fromCommaSeparatedInput(e.target.value);
              setForm((f) => ({
                ...f,
                openrouterProviderPreferences: {
                  ...(f.openrouterProviderPreferences || {}),
                  order: parsed.length > 0 ? parsed : undefined,
                },
              }));
            }}
          />
        </div>
        <div className="form-group">
          <label htmlFor="openrouterProviderPreferencesIgnore">OpenRouter routing ignore</label>
          <input
            id="openrouterProviderPreferencesIgnore"
            className="input"
            placeholder="provider-name"
            value={toCommaSeparatedInput(form.openrouterProviderPreferences?.ignore)}
            onChange={(e) => {
              const parsed = fromCommaSeparatedInput(e.target.value);
              setForm((f) => ({
                ...f,
                openrouterProviderPreferences: {
                  ...(f.openrouterProviderPreferences || {}),
                  ignore: parsed.length > 0 ? parsed : undefined,
                },
              }));
            }}
          />
        </div>
        <div className="form-group">
          <label htmlFor="openrouterProviderPreferencesOnly">OpenRouter routing only</label>
          <input
            id="openrouterProviderPreferencesOnly"
            className="input"
            placeholder="provider-name"
            value={toCommaSeparatedInput(form.openrouterProviderPreferences?.only)}
            onChange={(e) => {
              const parsed = fromCommaSeparatedInput(e.target.value);
              setForm((f) => ({
                ...f,
                openrouterProviderPreferences: {
                  ...(f.openrouterProviderPreferences || {}),
                  only: parsed.length > 0 ? parsed : undefined,
                },
              }));
            }}
          />
        </div>
        <div className="form-group">
          <label htmlFor="openrouterProviderPreferencesAllowFallbacks">OpenRouter allow fallbacks</label>
          <select
            id="openrouterProviderPreferencesAllowFallbacks"
            className="select"
            value={form.openrouterProviderPreferences?.allow_fallbacks === undefined ? "default" : form.openrouterProviderPreferences.allow_fallbacks ? "allow" : "deny"}
            onChange={(e) => {
              const value = e.target.value;
              setForm((f) => ({
                ...f,
                openrouterProviderPreferences: {
                  ...(f.openrouterProviderPreferences || {}),
                  allow_fallbacks: value === "default" ? undefined : value === "allow",
                },
              }));
            }}
          >
            <option value="default">default</option>
            <option value="allow">allow</option>
            <option value="deny">deny</option>
          </select>
        </div>
        <div className="form-group">
          <label htmlFor="openrouterProviderPreferencesSort">OpenRouter routing sort</label>
          <select
            id="openrouterProviderPreferencesSort"
            className="select"
            value={form.openrouterProviderPreferences?.sort ?? "default"}
            onChange={(e) => {
              const value = e.target.value;
              setForm((f) => ({
                ...f,
                openrouterProviderPreferences: {
                  ...(f.openrouterProviderPreferences || {}),
                  sort: value === "default" ? undefined : value as "price" | "throughput" | "latency",
                },
              }));
            }}
          >
            <option value="default">default</option>
            <option value="price">price</option>
            <option value="throughput">throughput</option>
            <option value="latency">latency</option>
          </select>
        </div>
        <div className="form-group">
          <label htmlFor="openrouterProviderPreferencesRequireParameters" className="checkbox-label">
            <input
              id="openrouterProviderPreferencesRequireParameters"
              type="checkbox"
              checked={form.openrouterProviderPreferences?.require_parameters === true}
              onChange={(e) => setForm((f) => ({
                ...f,
                openrouterProviderPreferences: {
                  ...(f.openrouterProviderPreferences || {}),
                  require_parameters: e.target.checked,
                },
              }))}
            />
            Require parameters
          </label>
        </div>
      </details>
    </>
  );
}

export default GlobalModelsSection;
