import { useCallback, useEffect, useMemo, useState } from "react";
import type { MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import type { ModelPricing, ModelPricingOverrides } from "@fusion/core";
import { api } from "../../../api";
import { SettingsHelpTip } from "../SettingsHelpTip";
import type { ToastType } from "../../../hooks/useToast";
import type { SetSettingsForm, SettingsFormState } from "./context";
import "./ModelPricingSection.css";

interface PricingFetchResponse {
  count: number;
  fetchedAt: string;
  source: string;
}

interface ModelPricingSectionProps {
  form: SettingsFormState;
  setForm: SetSettingsForm;
  addToast: (message: string, type?: ToastType) => void;
  projectId?: string;
}

interface PricingDraft {
  key: string;
  inputPer1M: number;
  outputPer1M: number;
  cacheReadPer1M: number;
  cacheWritePer1M: number;
  source: string;
}

function pricingToDraft(key: string, pricing: ModelPricing): PricingDraft {
  return { key, ...pricing };
}

function normalizePricingKey(value: string): string {
  return value.trim().toLowerCase();
}

function parseRate(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function pricingPath(projectId?: string): string {
  return projectId
    ? `/command-center/pricing/fetch?projectId=${encodeURIComponent(projectId)}`
    : "/command-center/pricing/fetch";
}

function setOverrides(setForm: SetSettingsForm, overrides: ModelPricingOverrides): void {
  setForm((current) => ({
    ...current,
    modelPricingOverrides: overrides,
  }));
}

/**
 * FNXC:Settings 2026-06-22-00:00:
 * Global Models needs an editable model-pricing override table plus a one-click LiteLLM refresh. Edits flow through the existing Settings save path, while fetch persists immediately through the Command Center pricing route and then refreshes this form from global settings.
 *
 * FNXC:Settings 2026-06-26-00:00:
 * The full pricing table is collapsed behind a popup so Global Models keeps its model-lane hierarchy readable while preserving the same edit, add, delete, and fetch capabilities.
 */
export function ModelPricingSection({ form, setForm, addToast, projectId }: ModelPricingSectionProps) {
  const { t } = useTranslation("app");
  const [draft, setDraft] = useState<PricingDraft>({
    key: "",
    inputPer1M: 0,
    outputPer1M: 0,
    cacheReadPer1M: 0,
    cacheWritePer1M: 0,
    source: "manual",
  });
  const [fetching, setFetching] = useState(false);
  const [tableOpen, setTableOpen] = useState(false);

  const rows = useMemo(
    () => Object.entries(form.modelPricingOverrides ?? {}).sort(([a], [b]) => a.localeCompare(b)),
    [form.modelPricingOverrides],
  );

  const closeTable = useCallback(() => setTableOpen(false), []);

  useEffect(() => {
    if (!tableOpen) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeTable();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [closeTable, tableOpen]);

  const handleOverlayClick = useCallback((event: MouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) {
      closeTable();
    }
  }, [closeTable]);

  const updateRow = (key: string, patch: Partial<ModelPricing>) => {
    const current = form.modelPricingOverrides ?? {};
    const existing = current[key];
    if (!existing) return;
    setOverrides(setForm, {
      ...current,
      [key]: { ...existing, ...patch },
    });
  };

  const deleteRow = (key: string) => {
    const next = { ...(form.modelPricingOverrides ?? {}) };
    delete next[key];
    setOverrides(setForm, next);
  };

  const addRow = () => {
    const key = normalizePricingKey(draft.key);
    if (!key || !key.includes(":")) {
      addToast(t("settings.modelPricing.invalidKey", "Use a provider:model key before adding a pricing row."), "error");
      return;
    }
    setOverrides(setForm, {
      ...(form.modelPricingOverrides ?? {}),
      [key]: {
        inputPer1M: draft.inputPer1M,
        outputPer1M: draft.outputPer1M,
        cacheReadPer1M: draft.cacheReadPer1M,
        cacheWritePer1M: draft.cacheWritePer1M,
        source: draft.source || "manual",
      },
    });
    setDraft({ key: "", inputPer1M: 0, outputPer1M: 0, cacheReadPer1M: 0, cacheWritePer1M: 0, source: "manual" });
  };

  const fetchLatestPrices = async () => {
    setFetching(true);
    try {
      const result = await api<PricingFetchResponse>(pricingPath(projectId), { method: "POST" });
      const settings = await api<Pick<SettingsFormState, "modelPricingOverrides" | "modelPricingFetchedAt" | "modelPricingSource">>("/settings/global");
      setForm((current) => ({
        ...current,
        modelPricingOverrides: settings.modelPricingOverrides ?? current.modelPricingOverrides,
        modelPricingFetchedAt: settings.modelPricingFetchedAt ?? result.fetchedAt,
        modelPricingSource: settings.modelPricingSource ?? result.source,
      }));
      addToast(t("settings.modelPricing.fetchSuccess", "Fetched {{count}} model prices.", { count: result.count }), "success");
    } catch (error) {
      addToast(error instanceof Error ? error.message : t("settings.modelPricing.fetchFailed", "Failed to fetch latest model prices."), "error");
    } finally {
      setFetching(false);
    }
  };

  const emptyCopy = t("settings.modelPricing.empty", "No model pricing overrides yet. Add one manually or fetch the latest LiteLLM prices.");
  const overrideCount = t(
    "settings.modelPricing.overrideCount",
    rows.length === 1 ? "{{count}} pricing override" : "{{count}} pricing overrides",
    { count: rows.length },
  );

  const renderPricingTableModal = () => {
    if (!tableOpen) return null;

    return (
      <div className="modal-overlay open" onClick={handleOverlayClick} role="dialog" aria-modal="true" aria-labelledby="model-pricing-table-title" data-testid="model-pricing-table-modal">
        <div className="modal modal-lg model-pricing-modal">
          <div className="modal-header">
            <div>
              <h3 id="model-pricing-table-title">{t("settings.modelPricing.tableTitle", "Model pricing table")}</h3>
              <p className="settings-muted model-pricing-modal__subtitle">
                {t("settings.modelPricing.saveHint", "Manual edits are saved with the rest of Global settings.")}
              </p>
            </div>
            <button type="button" className="modal-close" onClick={closeTable} aria-label={t("actions.close", "Close")} data-testid="model-pricing-close">
              <X size={20} />
            </button>
          </div>

          <div className="model-pricing-modal__body">
            <div className="model-pricing-table" role="table" aria-label={t("settings.modelPricing.overrides", "Model pricing overrides")}>
              <div className="model-pricing-row model-pricing-row--head" role="row">
                <span role="columnheader">{t("settings.modelPricing.modelKey", "provider:model")}</span>
                <span role="columnheader">{t("settings.modelPricing.input", "Input / 1M")}</span>
                <span role="columnheader">{t("settings.modelPricing.output", "Output / 1M")}</span>
                <span role="columnheader">{t("settings.modelPricing.cacheRead", "Cache read / 1M")}</span>
                <span role="columnheader">{t("settings.modelPricing.cacheWrite", "Cache write / 1M")}</span>
                <span role="columnheader">{t("settings.modelPricing.source", "Source")}</span>
                <span role="columnheader">{t("settings.modelPricing.actions", "Actions")}</span>
              </div>
              {rows.length === 0 ? (
                <div className="settings-empty-state model-pricing-empty" role="row">
                  {emptyCopy}
                </div>
              ) : rows.map(([key, pricing]) => {
                const row = pricingToDraft(key, pricing);
                return (
                  <div className="model-pricing-row" role="row" key={key}>
                    <code className="model-pricing-key" role="cell">{row.key}</code>
                    <input aria-label={`${key} input per 1M`} className="input" type="number" step="any" value={row.inputPer1M} onChange={(event) => updateRow(key, { inputPer1M: parseRate(event.target.value) })} />
                    <input aria-label={`${key} output per 1M`} className="input" type="number" step="any" value={row.outputPer1M} onChange={(event) => updateRow(key, { outputPer1M: parseRate(event.target.value) })} />
                    <input aria-label={`${key} cache read per 1M`} className="input" type="number" step="any" value={row.cacheReadPer1M} onChange={(event) => updateRow(key, { cacheReadPer1M: parseRate(event.target.value) })} />
                    <input aria-label={`${key} cache write per 1M`} className="input" type="number" step="any" value={row.cacheWritePer1M} onChange={(event) => updateRow(key, { cacheWritePer1M: parseRate(event.target.value) })} />
                    <input aria-label={`${key} source`} className="input" value={row.source} onChange={(event) => updateRow(key, { source: event.target.value })} />
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => deleteRow(key)}>{t("settings.modelPricing.delete", "Delete")}</button>
                  </div>
                );
              })}
              <div className="model-pricing-row model-pricing-row--add" role="row">
                <input aria-label={t("settings.modelPricing.newKey", "New provider:model key")} className="input" placeholder="openai:gpt-4o" value={draft.key} onChange={(event) => setDraft((current) => ({ ...current, key: event.target.value }))} />
                <input aria-label={t("settings.modelPricing.newInput", "New input rate")} className="input" type="number" step="any" value={draft.inputPer1M} onChange={(event) => setDraft((current) => ({ ...current, inputPer1M: parseRate(event.target.value) }))} />
                <input aria-label={t("settings.modelPricing.newOutput", "New output rate")} className="input" type="number" step="any" value={draft.outputPer1M} onChange={(event) => setDraft((current) => ({ ...current, outputPer1M: parseRate(event.target.value) }))} />
                <input aria-label={t("settings.modelPricing.newCacheRead", "New cache read rate")} className="input" type="number" step="any" value={draft.cacheReadPer1M} onChange={(event) => setDraft((current) => ({ ...current, cacheReadPer1M: parseRate(event.target.value) }))} />
                <input aria-label={t("settings.modelPricing.newCacheWrite", "New cache write rate")} className="input" type="number" step="any" value={draft.cacheWritePer1M} onChange={(event) => setDraft((current) => ({ ...current, cacheWritePer1M: parseRate(event.target.value) }))} />
                <input aria-label={t("settings.modelPricing.newSource", "New source")} className="input" value={draft.source} onChange={(event) => setDraft((current) => ({ ...current, source: event.target.value }))} />
                <button type="button" className="btn btn-sm" onClick={addRow}>{t("settings.modelPricing.addRow", "Add row")}</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  };

  return (
    <section className="model-pricing-section" aria-label={t("settings.modelPricing.title", "Model pricing overrides")}>
      <div className="model-pricing-section__header">
        <div>
          {/*
          FNXC:SettingsHelp 2026-07-16-12:45:
          Section description and the manual-edit save hint moved behind the shared "?" beside the heading - operator requirement: no inline description paragraphs in Settings. The fetched-at line below stays inline: it is live status (snapshot date/source), not help.
          */}
          <div className="settings-field-label-row">
            <h4 className="settings-section-heading settings-section-heading--spaced">{t("settings.modelPricing.title", "Model Pricing")}</h4>
            <SettingsHelpTip settingKey="model-pricing-section">
              {t("settings.modelPricing.description", "Override per-1M token rates used by Command Center cost estimates. Overrides win over the built-in baseline; unlisted models still use the baseline. No default \u2014 unset (no overrides).")}{" "}
              {t("settings.modelPricing.saveHint", "Manual edits are saved with the rest of Global settings.")}
            </SettingsHelpTip>
          </div>
          <p className="settings-muted model-pricing-section__meta">
            {form.modelPricingFetchedAt
              ? t("settings.modelPricing.pricesAsOf", "Prices as of {{date}}", { date: new Date(form.modelPricingFetchedAt).toLocaleString() })
              : t("settings.modelPricing.noFetchYet", "No fetched pricing snapshot yet.")}
            {form.modelPricingSource ? ` · ${form.modelPricingSource}` : ""}
          </p>
        </div>
        <button type="button" className="btn btn-sm" onClick={() => void fetchLatestPrices()} disabled={fetching}>
          {fetching ? t("settings.modelPricing.fetching", "Fetching…") : t("settings.modelPricing.fetchLatest", "Fetch latest prices")}
        </button>
      </div>

      <div className="model-pricing-summary">
        <div>
          <strong>{overrideCount}</strong>
          {rows.length === 0 ? <p className="settings-muted model-pricing-summary__empty">{emptyCopy}</p> : null}
        </div>
        <button type="button" className="btn btn-sm" onClick={() => setTableOpen(true)}>
          {t("settings.modelPricing.viewTable", "View pricing table")}
        </button>
      </div>
      {renderPricingTableModal()}
    </section>
  );
}
