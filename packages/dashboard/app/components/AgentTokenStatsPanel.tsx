import { useMemo } from "react";
import type { Agent } from "../api";
import "./AgentTokenStatsPanel.css";

interface AgentTokenStatsPanelProps {
  agents: Agent[];
}

interface AgentTokenRow {
  id: string;
  name: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

function normalizeTokenCount(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function formatTokenCount(value: number): string {
  return value.toLocaleString();
}

export function AgentTokenStatsPanel({ agents }: AgentTokenStatsPanelProps) {
  const { rows, totalInputTokens, totalOutputTokens, totalTokens } = useMemo(() => {
    const computedRows = agents
      .map((agent): AgentTokenRow => {
        const inputTokens = normalizeTokenCount(agent.totalInputTokens);
        const outputTokens = normalizeTokenCount(agent.totalOutputTokens);
        return {
          id: agent.id,
          name: agent.name,
          inputTokens,
          outputTokens,
          totalTokens: inputTokens + outputTokens,
        };
      })
      .sort((a, b) => b.totalTokens - a.totalTokens || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));

    return {
      rows: computedRows,
      totalInputTokens: computedRows.reduce((sum, row) => sum + row.inputTokens, 0),
      totalOutputTokens: computedRows.reduce((sum, row) => sum + row.outputTokens, 0),
      totalTokens: computedRows.reduce((sum, row) => sum + row.totalTokens, 0),
    };
  }, [agents]);

  const hasUsageData = totalTokens > 0;

  return (
    <section className="agent-token-stats-panel" aria-label="Agent token usage statistics">
      <header className="agent-token-stats-panel__header">
        <h3 className="agent-token-stats-panel__title">Token Usage by Agent</h3>
      </header>

      <div className="agent-token-stats-panel__totals" role="list" aria-label="Token usage totals">
        <div className="agent-token-stats-panel__total-card" role="listitem">
          <span className="agent-token-stats-panel__total-label">Input Tokens</span>
          <span className="agent-token-stats-panel__total-value">{formatTokenCount(totalInputTokens)}</span>
        </div>
        <div className="agent-token-stats-panel__total-card" role="listitem">
          <span className="agent-token-stats-panel__total-label">Output Tokens</span>
          <span className="agent-token-stats-panel__total-value">{formatTokenCount(totalOutputTokens)}</span>
        </div>
        <div className="agent-token-stats-panel__total-card" role="listitem">
          <span className="agent-token-stats-panel__total-label">Combined Tokens</span>
          <span className="agent-token-stats-panel__total-value">{formatTokenCount(totalTokens)}</span>
        </div>
      </div>

      {hasUsageData ? (
        <div className="agent-token-stats-panel__table-wrapper">
          <table className="agent-token-stats-panel__table">
            <thead>
              <tr>
                <th scope="col">Agent</th>
                <th scope="col">Input</th>
                <th scope="col">Output</th>
                <th scope="col">Total</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <th scope="row" className="agent-token-stats-panel__agent-cell">
                    <span className="agent-token-stats-panel__agent-name">{row.name}</span>
                    <span className="agent-token-stats-panel__agent-id">{row.id}</span>
                  </th>
                  <td>{formatTokenCount(row.inputTokens)}</td>
                  <td>{formatTokenCount(row.outputTokens)}</td>
                  <td className="agent-token-stats-panel__total-cell">{formatTokenCount(row.totalTokens)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="agent-token-stats-panel__empty" role="status">
          No token usage recorded yet. Token totals appear here once agents run.
        </div>
      )}
    </section>
  );
}
