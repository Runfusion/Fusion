import "./TaskCostTab.css";
import { useTranslation } from "react-i18next";
import type { TaskDetail } from "@fusion/core";
import type { ModelPricingOverrides } from "../../../core/src/ai/model-pricing";
import { ProviderIcon } from "./ProviderIcon";
import { inferProviderIconKey } from "../utils/providerIconKey";
import { buildTokenCostRows, formatCost, formatCount, totalCostForRows } from "../utils/taskTokenCost";

interface TaskCostTabProps {
  task: TaskDetail;
  pricingOverrides?: ModelPricingOverrides;
}

export function TaskCostTab({ task, pricingOverrides }: TaskCostTabProps) {
  const { t } = useTranslation("app");

  if (!task.tokenUsage) {
    return (
      <div className="task-cost-tab" data-testid="task-cost-tab">
        <section className="task-summary-section task-cost-section task-cost-section--empty">
          <h4>{t("taskDetail.costTab.heading", "Model cost")}</h4>
          <p className="task-summary-empty">{t("taskDetail.costTab.empty", "No model token usage has been recorded for this task yet.")}</p>
        </section>
      </div>
    );
  }

  const rows = buildTokenCostRows(task, t("taskDetail.costTab.unknownModel", "(unknown)"), pricingOverrides);
  const totalCost = totalCostForRows(rows);

  return (
    <div className="task-cost-tab" data-testid="task-cost-tab">
      <section className="task-summary-section task-cost-section">
        <div className="task-cost-heading-row">
          <h4>{t("taskDetail.costTab.heading", "Model cost")}</h4>
          <span className="task-cost-total" data-testid="task-cost-total">
            {t("taskDetail.costTab.totalCostLabel", "Total")}: {formatCost(totalCost.usd, totalCost.unavailable)}
          </span>
        </div>
        <p className="task-summary-empty">{t("taskDetail.costTab.description", "Derived from recorded input, output, cached, and cache-write tokens. Unpriced rows use — instead of a guessed value.")}</p>
        <div className="task-summary-token-table-wrap task-cost-table-wrap">
          <table className="task-summary-token-table task-cost-table">
            <thead>
              <tr>
                <th>{t("taskDetail.costTab.model", "Model")}</th>
                <th>{t("taskDetail.costTab.inputTokens", "Input")}</th>
                <th>{t("taskDetail.costTab.outputTokens", "Output")}</th>
                <th>{t("taskDetail.costTab.cachedTokens", "Cached")}</th>
                <th>{t("taskDetail.costTab.cacheWriteTokens", "Cache write")}</th>
                <th>{t("taskDetail.costTab.totalTokens", "Total tokens")}</th>
                <th>{t("taskDetail.costTab.cost", "Derived USD")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.key || row.label} data-testid="task-cost-row">
                  <td data-label={t("taskDetail.costTab.model", "Model")}>
                    <span className="task-summary-model-label">
                      <ProviderIcon provider={inferProviderIconKey(row.modelId ?? "")} size="sm" />
                      <span>{row.label}</span>
                    </span>
                  </td>
                  <td data-label={t("taskDetail.costTab.inputTokens", "Input")}>{formatCount(row.inputTokens)}</td>
                  <td data-label={t("taskDetail.costTab.outputTokens", "Output")}>{formatCount(row.outputTokens)}</td>
                  <td data-label={t("taskDetail.costTab.cachedTokens", "Cached")}>{formatCount(row.cachedTokens)}</td>
                  <td data-label={t("taskDetail.costTab.cacheWriteTokens", "Cache write")}>{formatCount(row.cacheWriteTokens)}</td>
                  <td data-label={t("taskDetail.costTab.totalTokens", "Total tokens")}>{formatCount(row.totalTokens)}</td>
                  <td data-label={t("taskDetail.costTab.cost", "Derived USD")}>
                    {row.cost.unavailable || row.cost.usd === null ? (
                      <span className="task-summary-cost-unavailable" title={t("taskDetail.costTab.costUnavailable", "No pricing for this model")}>—</span>
                    ) : (
                      formatCost(row.cost.usd, row.cost.unavailable)
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row" colSpan={6}>{t("taskDetail.costTab.totalCost", "Total cost")}</th>
                <td data-label={t("taskDetail.costTab.totalCost", "Total cost")}>{formatCost(totalCost.usd, totalCost.unavailable)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </section>
    </div>
  );
}

export default TaskCostTab;
