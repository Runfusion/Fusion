import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { THINKING_LEVELS } from "@fusion/core";
import type { Settings, ThinkingLevel } from "@fusion/core";
import type { ModelInfo } from "../../../api";
import type { ToastType } from "../../../hooks/useToast";
import { ModelPricingSection } from "./ModelPricingSection";
import { CustomModelDropdown } from "../../CustomModelDropdown";
import { SettingsToggleRow } from "../SettingsToggleRow";
import { SettingsSelectRow } from "../SettingsSelectRow";
import { SettingsTextRow } from "../SettingsTextRow";
import type { SectionBaseProps, ModelLane } from "./context";
import { LoadingSpinner } from "../../LoadingSpinner";
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
    getLaneThinkingValue: (lane: ModelLane) => string;
    updateLaneThinkingValue: (lane: ModelLane, level: string) => void;
    resetLaneThinkingValue: (lane: ModelLane) => void;
    favoriteProviders: string[];
    favoriteModels: string[];
    onToggleFavorite: (provider: string) => void;
    onToggleModelFavorite: (modelId: string) => void;
    addToast: (message: string, type?: ToastType) => void;
    projectId?: string;
}
export function GlobalModelsSection({ scopeBanner, form, setForm, availableModels, modelsLoading, globalModelLanes, getLaneThinkingValue, updateLaneThinkingValue, resetLaneThinkingValue, favoriteProviders, favoriteModels, onToggleFavorite, onToggleModelFavorite, addToast, projectId, }: GlobalModelsSectionProps) {
    const { t } = useTranslation("app");
    const selectedValue = form.defaultProvider && form.defaultModelId
        ? `${form.defaultProvider}/${form.defaultModelId}`
        : "";
    return (<>
      {scopeBanner}

      {/* --- Default Model --- */}
      <h4 className="settings-section-heading">{t("settings.globalModels.defaultModel", "Default Model")}</h4>
      {modelsLoading ? (<div className="settings-empty-state"><LoadingSpinner label={t("settings.models.loadingModels", "Loading available models…")} /></div>) : availableModels.length === 0 ? (<div className="settings-empty-state settings-muted">
          {t("settings.models.noModels", "No models available. Configure authentication first.")}
        </div>) : (<>
          <div className="form-group">
            <label htmlFor="defaultModel">{t("settings.globalModels.defaultModel", "Default Model")}</label>
            <CustomModelDropdown id="defaultModel" label="Default Model" models={availableModels} value={selectedValue} onChange={(val) => {
                if (!val) {
                    setForm((f) => ({ ...f, defaultProvider: undefined, defaultModelId: undefined }));
                }
                else {
                    const slashIdx = val.indexOf("/");
                    setForm((f) => ({
                        ...f,
                        defaultProvider: val.slice(0, slashIdx),
                        defaultModelId: val.slice(slashIdx + 1),
                    }));
                }
            }} placeholder={t("settings.globalModels.useDefault", "Use default")} favoriteProviders={favoriteProviders} onToggleFavorite={onToggleFavorite} favoriteModels={favoriteModels} onToggleModelFavorite={onToggleModelFavorite}/>
            <small>{t("settings.globalModels.defaultAIModelUsedForTaskExecutionWhen", "Default AI model used for task execution when no per-task override is set. &quot;Use default&quot; lets the engine choose automatically. No default \u2014 unset.")}</small>
          </div>

          <div className="form-group">
            <label htmlFor="fallbackModel">{t("settings.globalModels.fallbackModel", "Fallback Model")}</label>
            {/* FNXC:Settings-ThinkingLevel 2026-07-10-12:00: Global fallback model selection owns its own thinking-level companion (`fallbackThinkingLevel`). Clearing the fallback picker must clear the companion value so null-as-delete reset parity matches the per-lane model pickers. */}
            <CustomModelDropdown id="fallbackModel" label="Fallback Model" models={availableModels} value={form.fallbackProvider && form.fallbackModelId ? `${form.fallbackProvider}/${form.fallbackModelId}` : ""} onChange={(val) => {
                if (!val) {
                    setForm((f) => ({ ...f, fallbackProvider: undefined, fallbackModelId: undefined, fallbackThinkingLevel: undefined }));
                }
                else {
                    const slashIdx = val.indexOf("/");
                    setForm((f) => ({
                        ...f,
                        fallbackProvider: val.slice(0, slashIdx),
                        fallbackModelId: val.slice(slashIdx + 1),
                    }));
                }
            }} placeholder={t("settings.globalModels.noFallback", "No fallback")} favoriteProviders={favoriteProviders} onToggleFavorite={onToggleFavorite} favoriteModels={favoriteModels} onToggleModelFavorite={onToggleModelFavorite} showThinkingLevel={(() => {
                const selectedModel = availableModels.find((m) => m.provider === form.fallbackProvider && m.id === form.fallbackModelId);
                return selectedModel ? Boolean(selectedModel.reasoning) : true;
            })()} thinkingLevel={form.fallbackThinkingLevel || ""} onThinkingLevelChange={(level) => setForm((f) => ({ ...f, fallbackThinkingLevel: (level as ThinkingLevel) || undefined }))} defaultThinkingLevel={form.defaultThinkingLevel}/>
            <small>{t("settings.globalModels.usedAutomaticallyIfThePrimaryDefaultModelHits", "Used automatically if the primary default model hits a retryable provider error like rate limiting or overload. No default \u2014 unset.")}</small>
          </div>
        </>)}
      {(() => {
            const selectedModel = availableModels.find((m) => m.provider === form.defaultProvider && m.id === form.defaultModelId);
            if (selectedModel && !selectedModel.reasoning)
                return null;
            return (
            /* FNXC:Settings-ThinkingLevel 2026-06-19-14:55: This global selector renders the canonical THINKING_LEVELS list so newly added `xhigh` stays available anywhere the default reasoning effort is configured. */
            <SettingsSelectRow
              descriptor={{
                key: "defaultThinkingLevel",
                label: t("settings.globalModels.thinkingEffort", "Thinking Effort"),
                help: t("settings.globalModels.controlsHowMuchReasoningEffortTheAIModel", "Controls how much reasoning effort the AI model uses. Higher levels produce better results but cost more. No default \u2014 unset (model's own default effort applies)."),
                scope: "global",
                /*
                FNXC:Settings-ThinkingLevel 2026-07-15-17:35:
                The empty option is the unset state, not a level: selecting it writes `undefined` so the model's own default effort applies. Level labels stay derived from THINKING_LEVELS rather than translated per level, exactly as before \u2014 the list is the canonical one, so a new level needs no copy change here.
                */
                options: [
                  { value: "", label: t("settings.globalModels.default", "Default") },
                  ...THINKING_LEVELS.map((level) => ({
                    value: level,
                    label: level.charAt(0).toUpperCase() + level.slice(1),
                  })),
                ],
              }}
              value={form.defaultThinkingLevel || ""}
              onChange={(v) => setForm((f) => ({ ...f, defaultThinkingLevel: (v as ThinkingLevel) || undefined }))}
            />);
        })()}

      {availableModels.length > 0 && (<>
          <h4 className="settings-section-heading settings-section-heading--spaced">{t("settings.globalModels.modelLanes", "Model Lanes")}</h4>
          <p className="settings-description">{t("settings.globalModels.globalBaselineModelsForEachAIRoleProject", " Global baseline models for each AI role. Project settings can override these per-project. ")}</p>
          {globalModelLanes.map((lane) => {
                const provider = form[lane.globalProviderKey as keyof Settings] as string | undefined;
                const model = form[lane.globalModelKey as keyof Settings] as string | undefined;
                const value = provider && model ? `${provider}/${model}` : "";
                const thinkingValue = getLaneThinkingValue(lane);
                return (<div className="form-group" key={`global-${lane.laneId}`}>
                <label htmlFor={`global-${lane.laneId}-model`}>{lane.label}</label>
                <CustomModelDropdown id={`global-${lane.laneId}-model`} label={lane.label} models={availableModels} value={value} onChange={(selected) => {
                        if (!selected) {
                            setForm((f) => ({
                                ...f,
                                [lane.globalProviderKey]: undefined,
                                [lane.globalModelKey]: undefined,
                            }));
                            resetLaneThinkingValue(lane);
                            return;
                        }
                        const slashIdx = selected.indexOf("/");
                        setForm((f) => ({
                            ...f,
                            [lane.globalProviderKey]: selected.slice(0, slashIdx),
                            [lane.globalModelKey]: selected.slice(slashIdx + 1),
                        }));
                    }} placeholder={t("settings.globalModels.useDefault", "Use default")} favoriteProviders={favoriteProviders} onToggleFavorite={onToggleFavorite} favoriteModels={favoriteModels} onToggleModelFavorite={onToggleModelFavorite} showThinkingLevel={Boolean(lane.globalThinkingKey)} thinkingLevel={thinkingValue} onThinkingLevelChange={(level) => updateLaneThinkingValue(lane, level)} defaultThinkingLevel={form.defaultThinkingLevel}/>
                <small>{lane.helperText}</small>
              </div>);
            })}
        </>)}

      <ModelPricingSection form={form} setForm={setForm} addToast={addToast} projectId={projectId}/>

      {/* --- Startup Model Sync --- */}
      <h4 className="settings-section-heading settings-section-heading--spaced">{t("settings.globalModels.startupModelSync", "Startup Model Sync")}</h4>
      {/*
      FNXC:SettingsModels 2026-07-15-17:35:
      `!== false` is the enabled test, not `=== true`: this setting defaults to enabled in DEFAULT_GLOBAL_SETTINGS, so an unset key must read as on.
      */}
      <SettingsToggleRow
        descriptor={{
          key: "openrouterModelSync",
          label: t("settings.globalModels.syncOpenRouterModelListAtStartup", " Sync OpenRouter model list at startup "),
          help: t("settings.globalModels.whenEnabledStartupFetchesTheLatestAvailableModels", " When enabled, startup fetches the latest available models from the OpenRouter API so model pickers always include the newest catalog. Default: enabled. "),
          scope: "global",
        }}
        value={form.openrouterModelSync !== false}
        onChange={(v) => setForm((f) => ({ ...f, openrouterModelSync: v === true }))}
      />
      {/*
      FNXC:SettingsStyling 2026-07-15-17:35:
      Left on hand-rolled markup deliberately: its help text embeds a <code> element for the `opencode models opencode --refresh` command, and the primitives take help as a pre-translated string. Migrating it would mean either dropping the code formatting or splicing the command in as a bare literal, so the row keeps its markup until the descriptor can carry rich help.
      */}
      <div className="form-group">
        <label htmlFor="opencodeGoModelSync" className="checkbox-label">
          <input id="opencodeGoModelSync" type="checkbox" checked={form.opencodeGoModelSync !== false} onChange={(e) => setForm((f) => ({ ...f, opencodeGoModelSync: e.target.checked }))}/>{t("settings.globalModels.syncOpencodeGoModelListAtStartup", " Sync opencode-go model list at startup ")}</label>
        <small>{t("settings.globalModels.whenEnabledStartupRefreshesModelsThroughTheLocal", " When enabled, startup refreshes models through the local ")}<code>opencode models opencode --refresh</code>{t("settings.globalModels.flowAndPublishesThemUnderTheOpencodeGo", " flow and publishes them under the opencode-go provider in model pickers. Default: enabled. ")}</small>
      </div>
      <details>
        <summary>{t("settings.globalModels.openRouterAdvanced", "OpenRouter advanced")}</summary>
        {/*
        FNXC:SettingsScope 2026-07-15-17:35:
        These rows edit leaves inside global blob settings (openrouterAppAttribution / openrouterModelFilters / openrouterProviderPreferences), so the descriptor key is the dotted path to the leaf. The parent blob is what lives in DEFAULT_GLOBAL_SETTINGS, which is what makes every one of them global scope.
        */}
        <SettingsTextRow
          descriptor={{
            key: "openrouterAppAttribution.referer",
            label: t("settings.globalModels.openRouterHTTPReferer", "OpenRouter HTTP-Referer"),
            help: t("settings.globalModels.leaveEmptyToOmitThisHeaderDefaultHttps", "Leave empty to omit this header. No default — unset (Fusion falls back to https://runfusion.ai when unset)."),
            scope: "global",
            placeholder: t("settings.globalModels.httpsRunfusionAi", "https://runfusion.ai"),
          }}
          value={form.openrouterAppAttribution?.referer ?? ""}
          onChange={(v) => setForm((f) => ({
            ...f,
            openrouterAppAttribution: {
                ...(f.openrouterAppAttribution || {}),
                referer: v ?? "",
            },
        }))}
        />
        <SettingsTextRow
          descriptor={{
            key: "openrouterAppAttribution.title",
            label: t("settings.globalModels.openRouterXTitle", "OpenRouter X-Title"),
            help: t("settings.globalModels.leaveEmptyToOmitThisHeaderDefaultFusion", "Leave empty to omit this header. No default — unset (Fusion falls back to the title \"Fusion\" when unset)."),
            scope: "global",
            placeholder: t("settings.globalModels.fusion", "Fusion"),
          }}
          value={form.openrouterAppAttribution?.title ?? ""}
          onChange={(v) => setForm((f) => ({
            ...f,
            openrouterAppAttribution: {
                ...(f.openrouterAppAttribution || {}),
                title: v ?? "",
            },
        }))}
        />
        {/*
        FNXC:SettingsModels 2026-07-15-17:35:
        The comma-separated rows stay round-trip helpers over a string[]: an empty list writes `undefined` rather than `[]`, because an empty array would read as "filter to nothing" instead of "unfiltered".
        */}
        <SettingsTextRow
          descriptor={{
            key: "openrouterModelFilters.supported_parameters",
            label: t("settings.globalModels.openRouterSupportedParametersFilter", "OpenRouter supported_parameters filter"),
            help: t("settings.globalModels.commaSeparatedValuesSentToOpenRouterModelSync", "Comma-separated values sent to OpenRouter model sync. No default \u2014 unset (unfiltered)."),
            scope: "global",
            placeholder: t("settings.globalModels.toolsStructuredOutputs", "tools, structured_outputs"),
          }}
          value={toCommaSeparatedInput(form.openrouterModelFilters?.supported_parameters)}
          onChange={(v) => {
            const parsed = fromCommaSeparatedInput(v ?? "");
            setForm((f) => ({
                ...f,
                openrouterModelFilters: {
                    ...(f.openrouterModelFilters || {}),
                    supported_parameters: parsed.length > 0 ? parsed : undefined,
                },
            }));
        }}
        />
        <SettingsTextRow
          descriptor={{
            key: "openrouterModelFilters.output_modalities",
            label: t("settings.globalModels.openRouterOutputModalitiesFilter", "OpenRouter output_modalities filter"),
            help: t("settings.globalModels.commaSeparatedValuesSentToOpenRouterModelSyncOutputModalities", "Comma-separated values sent to OpenRouter model sync. No default \u2014 unset (unfiltered)."),
            scope: "global",
            placeholder: t("settings.globalModels.text", "text"),
          }}
          value={toCommaSeparatedInput(form.openrouterModelFilters?.output_modalities)}
          onChange={(v) => {
            const parsed = fromCommaSeparatedInput(v ?? "");
            setForm((f) => ({
                ...f,
                openrouterModelFilters: {
                    ...(f.openrouterModelFilters || {}),
                    output_modalities: parsed.length > 0 ? parsed : undefined,
                },
            }));
        }}
        />
        <SettingsTextRow
          descriptor={{
            key: "openrouterProviderPreferences.order",
            label: t("settings.globalModels.openRouterRoutingOrder", "OpenRouter routing order"),
            help: t("settings.globalModels.openRouterRoutingOrderHint", "No default \u2014 unset (OpenRouter's own default routing order applies)."),
            scope: "global",
            placeholder: t("settings.globalModels.openaiAnthropic", "openai, anthropic"),
          }}
          value={toCommaSeparatedInput(form.openrouterProviderPreferences?.order)}
          onChange={(v) => {
            const parsed = fromCommaSeparatedInput(v ?? "");
            setForm((f) => ({
                ...f,
                openrouterProviderPreferences: {
                    ...(f.openrouterProviderPreferences || {}),
                    order: parsed.length > 0 ? parsed : undefined,
                },
            }));
        }}
        />
        <SettingsTextRow
          descriptor={{
            key: "openrouterProviderPreferences.ignore",
            label: t("settings.globalModels.openRouterRoutingIgnore", "OpenRouter routing ignore"),
            help: t("settings.globalModels.openRouterRoutingIgnoreHint", "No default \u2014 unset (no providers ignored)."),
            scope: "global",
            placeholder: t("settings.globalModels.providerName", "provider-name"),
          }}
          value={toCommaSeparatedInput(form.openrouterProviderPreferences?.ignore)}
          onChange={(v) => {
            const parsed = fromCommaSeparatedInput(v ?? "");
            setForm((f) => ({
                ...f,
                openrouterProviderPreferences: {
                    ...(f.openrouterProviderPreferences || {}),
                    ignore: parsed.length > 0 ? parsed : undefined,
                },
            }));
        }}
        />
        <SettingsTextRow
          descriptor={{
            key: "openrouterProviderPreferences.only",
            label: t("settings.globalModels.openRouterRoutingOnly", "OpenRouter routing only"),
            help: t("settings.globalModels.openRouterRoutingOnlyHint", "No default \u2014 unset (no provider restriction)."),
            scope: "global",
            placeholder: t("settings.globalModels.providerName", "provider-name"),
          }}
          value={toCommaSeparatedInput(form.openrouterProviderPreferences?.only)}
          onChange={(v) => {
            const parsed = fromCommaSeparatedInput(v ?? "");
            setForm((f) => ({
                ...f,
                openrouterProviderPreferences: {
                    ...(f.openrouterProviderPreferences || {}),
                    only: parsed.length > 0 ? parsed : undefined,
                },
            }));
        }}
        />
        {/*
        FNXC:SettingsModels 2026-07-15-17:35:
        "default" is a sentinel option, not a stored value: both of these routing preferences are tri-state (unset / explicit A / explicit B), and selecting it writes `undefined` so OpenRouter's own default applies rather than Fusion pinning one.
        */}
        <SettingsSelectRow
          descriptor={{
            key: "openrouterProviderPreferences.allow_fallbacks",
            label: t("settings.globalModels.openRouterAllowFallbacks", "OpenRouter allow fallbacks"),
            help: t("settings.globalModels.openRouterAllowFallbacksHint", "No default \u2014 unset (OpenRouter's own default fallback behavior applies)."),
            scope: "global",
            options: [
              { value: "default", label: t("settings.globalModels.default2", "default") },
              { value: "allow", label: t("settings.globalModels.allow", "allow") },
              { value: "deny", label: t("settings.globalModels.deny", "deny") },
            ],
          }}
          value={form.openrouterProviderPreferences?.allow_fallbacks === undefined ? "default" : form.openrouterProviderPreferences.allow_fallbacks ? "allow" : "deny"}
          onChange={(v) => setForm((f) => ({
                ...f,
                openrouterProviderPreferences: {
                    ...(f.openrouterProviderPreferences || {}),
                    allow_fallbacks: v === "default" ? undefined : v === "allow",
                },
            }))}
        />
        <SettingsSelectRow
          descriptor={{
            key: "openrouterProviderPreferences.sort",
            label: t("settings.globalModels.openRouterRoutingSort", "OpenRouter routing sort"),
            help: t("settings.globalModels.openRouterRoutingSortHint", "No default \u2014 unset (OpenRouter's own default sort applies)."),
            scope: "global",
            options: [
              { value: "default", label: t("settings.globalModels.default2", "default") },
              { value: "price", label: t("settings.globalModels.price", "price") },
              { value: "throughput", label: t("settings.globalModels.throughput", "throughput") },
              { value: "latency", label: t("settings.globalModels.latency", "latency") },
            ],
          }}
          value={form.openrouterProviderPreferences?.sort ?? "default"}
          onChange={(v) => setForm((f) => ({
                ...f,
                openrouterProviderPreferences: {
                    ...(f.openrouterProviderPreferences || {}),
                    sort: v === "default" ? undefined : v as "price" | "throughput" | "latency",
                },
            }))}
        />
        <SettingsToggleRow
          descriptor={{
            key: "openrouterProviderPreferences.require_parameters",
            label: t("settings.globalModels.requireParameters", " Require parameters "),
            help: t("settings.globalModels.requireParametersHint", "Default: disabled."),
            scope: "global",
          }}
          value={form.openrouterProviderPreferences?.require_parameters === true}
          onChange={(v) => setForm((f) => ({
            ...f,
            openrouterProviderPreferences: {
                ...(f.openrouterProviderPreferences || {}),
                require_parameters: v === true,
            },
        }))}
        />
      </details>
    </>);
}
export default GlobalModelsSection;
