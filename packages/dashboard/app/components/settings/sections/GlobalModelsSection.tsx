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
export function GlobalModelsSection({ scopeBanner, form, setForm, availableModels, modelsLoading, globalModelLanes, favoriteProviders, favoriteModels, onToggleFavorite, onToggleModelFavorite, }: GlobalModelsSectionProps) {
    const { t } = useTranslation("app");
    const selectedValue = form.defaultProvider && form.defaultModelId
        ? `${form.defaultProvider}/${form.defaultModelId}`
        : "";
    return (<>
      {scopeBanner}

      {/* --- Default Model --- */}
      <h4 className="settings-section-heading">{t("settings.globalModels.defaultModel", "Default Model")}</h4>
      {modelsLoading ? (<div className="settings-empty-state">{t("settings.models.loadingModels", "Loading available models…")}</div>) : availableModels.length === 0 ? (<div className="settings-empty-state settings-muted">
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
            <small>{t("settings.globalModels.defaultAIModelUsedForTaskExecutionWhen", "Default AI model used for task execution when no per-task override is set. &quot;Use default&quot; lets the engine choose automatically.")}</small>
          </div>

          <div className="form-group">
            <label htmlFor="fallbackModel">{t("settings.globalModels.fallbackModel", "Fallback Model")}</label>
            <CustomModelDropdown id="fallbackModel" label="Fallback Model" models={availableModels} value={form.fallbackProvider && form.fallbackModelId ? `${form.fallbackProvider}/${form.fallbackModelId}` : ""} onChange={(val) => {
                if (!val) {
                    setForm((f) => ({ ...f, fallbackProvider: undefined, fallbackModelId: undefined }));
                }
                else {
                    const slashIdx = val.indexOf("/");
                    setForm((f) => ({
                        ...f,
                        fallbackProvider: val.slice(0, slashIdx),
                        fallbackModelId: val.slice(slashIdx + 1),
                    }));
                }
            }} placeholder={t("settings.globalModels.noFallback", "No fallback")} favoriteProviders={favoriteProviders} onToggleFavorite={onToggleFavorite} favoriteModels={favoriteModels} onToggleModelFavorite={onToggleModelFavorite}/>
            <small>{t("settings.globalModels.usedAutomaticallyIfThePrimaryDefaultModelHits", "Used automatically if the primary default model hits a retryable provider error like rate limiting or overload.")}</small>
          </div>
        </>)}
      {(() => {
            const selectedModel = availableModels.find((m) => m.provider === form.defaultProvider && m.id === form.defaultModelId);
            if (selectedModel && !selectedModel.reasoning)
                return null;
            return (<div className="form-group">
            {/* FNXC:Settings-ThinkingLevel 2026-06-19-14:55: This global selector renders the canonical THINKING_LEVELS list so newly added `xhigh` stays available anywhere the default reasoning effort is configured. */}
            <label htmlFor="defaultThinkingLevel">{t("settings.globalModels.thinkingEffort", "Thinking Effort")}</label>
            <select id="defaultThinkingLevel" value={form.defaultThinkingLevel || ""} onChange={(e) => {
                    const val = e.target.value;
                    setForm((f) => ({ ...f, defaultThinkingLevel: (val as ThinkingLevel) || undefined }));
                }}>
              <option value="">{t("settings.globalModels.default", "Default")}</option>
              {THINKING_LEVELS.map((level) => (<option key={level} value={level}>
                  {level.charAt(0).toUpperCase() + level.slice(1)}
                </option>))}
            </select>
            <small>{t("settings.globalModels.controlsHowMuchReasoningEffortTheAIModel", "Controls how much reasoning effort the AI model uses. Higher levels produce better results but cost more.")}</small>
          </div>);
        })()}

      {availableModels.length > 0 && (<>
          <h4 className="settings-section-heading settings-section-heading--spaced">{t("settings.globalModels.modelLanes", "Model Lanes")}</h4>
          <p className="settings-description">{t("settings.globalModels.globalBaselineModelsForEachAIRoleProject", " Global baseline models for each AI role. Project settings can override these per-project. ")}</p>
          {globalModelLanes.map((lane) => {
                const provider = form[lane.globalProviderKey as keyof Settings] as string | undefined;
                const model = form[lane.globalModelKey as keyof Settings] as string | undefined;
                const value = provider && model ? `${provider}/${model}` : "";
                return (<div className="form-group" key={`global-${lane.laneId}`}>
                <label htmlFor={`global-${lane.laneId}-model`}>{lane.label}</label>
                <CustomModelDropdown id={`global-${lane.laneId}-model`} label={lane.label} models={availableModels} value={value} onChange={(selected) => {
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
                    }} placeholder={t("settings.globalModels.useDefault", "Use default")} favoriteProviders={favoriteProviders} onToggleFavorite={onToggleFavorite} favoriteModels={favoriteModels} onToggleModelFavorite={onToggleModelFavorite}/>
                <small>{lane.helperText}</small>
              </div>);
            })}
        </>)}

      {/* --- Startup Model Sync --- */}
      <h4 className="settings-section-heading settings-section-heading--spaced">{t("settings.globalModels.startupModelSync", "Startup Model Sync")}</h4>
      <div className="form-group">
        <label htmlFor="openrouterModelSync" className="checkbox-label">
          <input id="openrouterModelSync" type="checkbox" checked={form.openrouterModelSync !== false} onChange={(e) => setForm((f) => ({ ...f, openrouterModelSync: e.target.checked }))}/>{t("settings.globalModels.syncOpenRouterModelListAtStartup", " Sync OpenRouter model list at startup ")}</label>
        <small>{t("settings.globalModels.whenEnabledStartupFetchesTheLatestAvailableModels", " When enabled, startup fetches the latest available models from the OpenRouter API so model pickers always include the newest catalog. ")}</small>
      </div>
      <div className="form-group">
        <label htmlFor="opencodeGoModelSync" className="checkbox-label">
          <input id="opencodeGoModelSync" type="checkbox" checked={form.opencodeGoModelSync !== false} onChange={(e) => setForm((f) => ({ ...f, opencodeGoModelSync: e.target.checked }))}/>{t("settings.globalModels.syncOpencodeGoModelListAtStartup", " Sync opencode-go model list at startup ")}</label>
        <small>{t("settings.globalModels.whenEnabledStartupRefreshesModelsThroughTheLocal", " When enabled, startup refreshes models through the local ")}<code>opencode models opencode --refresh</code>{t("settings.globalModels.flowAndPublishesThemUnderTheOpencodeGo", " flow and publishes them under the opencode-go provider in model pickers. ")}</small>
      </div>
      <details>
        <summary>{t("settings.globalModels.openRouterAdvanced", "OpenRouter advanced")}</summary>
        <div className="form-group">
          <label htmlFor="openrouterAppAttributionReferer">{t("settings.globalModels.openRouterHTTPReferer", "OpenRouter HTTP-Referer")}</label>
          <input id="openrouterAppAttributionReferer" className="input" placeholder={t("settings.globalModels.httpsRunfusionAi", "https://runfusion.ai")} value={form.openrouterAppAttribution?.referer ?? ""} onChange={(e) => setForm((f) => ({
            ...f,
            openrouterAppAttribution: {
                ...(f.openrouterAppAttribution || {}),
                referer: e.target.value,
            },
        }))}/>
          <small>{t("settings.globalModels.leaveEmptyToOmitThisHeaderDefaultHttps", "Leave empty to omit this header. Default: https://runfusion.ai.")}</small>
        </div>
        <div className="form-group">
          <label htmlFor="openrouterAppAttributionTitle">{t("settings.globalModels.openRouterXTitle", "OpenRouter X-Title")}</label>
          <input id="openrouterAppAttributionTitle" className="input" placeholder={t("settings.globalModels.fusion", "Fusion")} value={form.openrouterAppAttribution?.title ?? ""} onChange={(e) => setForm((f) => ({
            ...f,
            openrouterAppAttribution: {
                ...(f.openrouterAppAttribution || {}),
                title: e.target.value,
            },
        }))}/>
          <small>{t("settings.globalModels.leaveEmptyToOmitThisHeaderDefaultFusion", "Leave empty to omit this header. Default: Fusion.")}</small>
        </div>
        <div className="form-group">
          <label htmlFor="openrouterModelFiltersSupportedParameters">{t("settings.globalModels.openRouterSupportedParametersFilter", "OpenRouter supported_parameters filter")}</label>
          <input id="openrouterModelFiltersSupportedParameters" className="input" placeholder={t("settings.globalModels.toolsStructuredOutputs", "tools, structured_outputs")} value={toCommaSeparatedInput(form.openrouterModelFilters?.supported_parameters)} onChange={(e) => {
            const parsed = fromCommaSeparatedInput(e.target.value);
            setForm((f) => ({
                ...f,
                openrouterModelFilters: {
                    ...(f.openrouterModelFilters || {}),
                    supported_parameters: parsed.length > 0 ? parsed : undefined,
                },
            }));
        }}/>
          <small>{t("settings.globalModels.commaSeparatedValuesSentToOpenRouterModelSync", "Comma-separated values sent to OpenRouter model sync.")}</small>
        </div>
        <div className="form-group">
          <label htmlFor="openrouterModelFiltersOutputModalities">{t("settings.globalModels.openRouterOutputModalitiesFilter", "OpenRouter output_modalities filter")}</label>
          <input id="openrouterModelFiltersOutputModalities" className="input" placeholder={t("settings.globalModels.text", "text")} value={toCommaSeparatedInput(form.openrouterModelFilters?.output_modalities)} onChange={(e) => {
            const parsed = fromCommaSeparatedInput(e.target.value);
            setForm((f) => ({
                ...f,
                openrouterModelFilters: {
                    ...(f.openrouterModelFilters || {}),
                    output_modalities: parsed.length > 0 ? parsed : undefined,
                },
            }));
        }}/>
          <small>{t("settings.globalModels.commaSeparatedValuesSentToOpenRouterModelSync", "Comma-separated values sent to OpenRouter model sync.")}</small>
        </div>
        <div className="form-group">
          <label htmlFor="openrouterProviderPreferencesOrder">{t("settings.globalModels.openRouterRoutingOrder", "OpenRouter routing order")}</label>
          <input id="openrouterProviderPreferencesOrder" className="input" placeholder={t("settings.globalModels.openaiAnthropic", "openai, anthropic")} value={toCommaSeparatedInput(form.openrouterProviderPreferences?.order)} onChange={(e) => {
            const parsed = fromCommaSeparatedInput(e.target.value);
            setForm((f) => ({
                ...f,
                openrouterProviderPreferences: {
                    ...(f.openrouterProviderPreferences || {}),
                    order: parsed.length > 0 ? parsed : undefined,
                },
            }));
        }}/>
        </div>
        <div className="form-group">
          <label htmlFor="openrouterProviderPreferencesIgnore">{t("settings.globalModels.openRouterRoutingIgnore", "OpenRouter routing ignore")}</label>
          <input id="openrouterProviderPreferencesIgnore" className="input" placeholder={t("settings.globalModels.providerName", "provider-name")} value={toCommaSeparatedInput(form.openrouterProviderPreferences?.ignore)} onChange={(e) => {
            const parsed = fromCommaSeparatedInput(e.target.value);
            setForm((f) => ({
                ...f,
                openrouterProviderPreferences: {
                    ...(f.openrouterProviderPreferences || {}),
                    ignore: parsed.length > 0 ? parsed : undefined,
                },
            }));
        }}/>
        </div>
        <div className="form-group">
          <label htmlFor="openrouterProviderPreferencesOnly">{t("settings.globalModels.openRouterRoutingOnly", "OpenRouter routing only")}</label>
          <input id="openrouterProviderPreferencesOnly" className="input" placeholder={t("settings.globalModels.providerName", "provider-name")} value={toCommaSeparatedInput(form.openrouterProviderPreferences?.only)} onChange={(e) => {
            const parsed = fromCommaSeparatedInput(e.target.value);
            setForm((f) => ({
                ...f,
                openrouterProviderPreferences: {
                    ...(f.openrouterProviderPreferences || {}),
                    only: parsed.length > 0 ? parsed : undefined,
                },
            }));
        }}/>
        </div>
        <div className="form-group">
          <label htmlFor="openrouterProviderPreferencesAllowFallbacks">{t("settings.globalModels.openRouterAllowFallbacks", "OpenRouter allow fallbacks")}</label>
          <select id="openrouterProviderPreferencesAllowFallbacks" className="select" value={form.openrouterProviderPreferences?.allow_fallbacks === undefined ? "default" : form.openrouterProviderPreferences.allow_fallbacks ? "allow" : "deny"} onChange={(e) => {
            const value = e.target.value;
            setForm((f) => ({
                ...f,
                openrouterProviderPreferences: {
                    ...(f.openrouterProviderPreferences || {}),
                    allow_fallbacks: value === "default" ? undefined : value === "allow",
                },
            }));
        }}>
            <option value="default">{t("settings.globalModels.default2", "default")}</option>
            <option value="allow">{t("settings.globalModels.allow", "allow")}</option>
            <option value="deny">{t("settings.globalModels.deny", "deny")}</option>
          </select>
        </div>
        <div className="form-group">
          <label htmlFor="openrouterProviderPreferencesSort">{t("settings.globalModels.openRouterRoutingSort", "OpenRouter routing sort")}</label>
          <select id="openrouterProviderPreferencesSort" className="select" value={form.openrouterProviderPreferences?.sort ?? "default"} onChange={(e) => {
            const value = e.target.value;
            setForm((f) => ({
                ...f,
                openrouterProviderPreferences: {
                    ...(f.openrouterProviderPreferences || {}),
                    sort: value === "default" ? undefined : value as "price" | "throughput" | "latency",
                },
            }));
        }}>
            <option value="default">{t("settings.globalModels.default2", "default")}</option>
            <option value="price">{t("settings.globalModels.price", "price")}</option>
            <option value="throughput">{t("settings.globalModels.throughput", "throughput")}</option>
            <option value="latency">{t("settings.globalModels.latency", "latency")}</option>
          </select>
        </div>
        <div className="form-group">
          <label htmlFor="openrouterProviderPreferencesRequireParameters" className="checkbox-label">
            <input id="openrouterProviderPreferencesRequireParameters" type="checkbox" checked={form.openrouterProviderPreferences?.require_parameters === true} onChange={(e) => setForm((f) => ({
            ...f,
            openrouterProviderPreferences: {
                ...(f.openrouterProviderPreferences || {}),
                require_parameters: e.target.checked,
            },
        }))}/>{t("settings.globalModels.requireParameters", " Require parameters ")}</label>
        </div>
      </details>
    </>);
}
export default GlobalModelsSection;
