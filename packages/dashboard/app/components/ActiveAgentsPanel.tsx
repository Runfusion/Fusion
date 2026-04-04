import { Activity } from "lucide-react";
import type { Agent } from "../api";
import { useLiveTranscript } from "../hooks/useLiveTranscript";

interface LiveAgentCardProps {
  agent: Agent;
}

function LiveAgentCard({ agent }: LiveAgentCardProps) {
  const { entries, isConnected } = useLiveTranscript(agent.taskId);
  const elapsed = agent.lastHeartbeatAt
    ? Math.floor((Date.now() - new Date(agent.lastHeartbeatAt).getTime()) / 1000)
    : 0;

  return (
    <div className="live-agent-card">
      <div className="live-agent-card-header">
        <div className="live-agent-card-name">
          <span className="live-agent-pulse" />
          <span>{agent.name}</span>
        </div>
        {agent.taskId && (
          <span className="live-agent-task badge">{agent.taskId}</span>
        )}
      </div>
      <div className="live-agent-card-transcript">
        {entries.length === 0 ? (
          <div className="live-agent-card-empty">
            {isConnected ? "Waiting for output..." : "Connecting..."}
          </div>
        ) : (
          entries.slice(0, 20).map((entry, i) => (
            <div key={i} className="live-agent-card-line">
              {entry.content}
            </div>
          ))
        )}
      </div>
      <div className="live-agent-card-footer">
        <span className="text-secondary">{formatElapsed(elapsed)}</span>
        {isConnected && <Activity size={12} className="live-agent-streaming-dot" />}
      </div>
    </div>
  );
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

interface ActiveAgentsPanelProps {
  agents: Agent[];
}

export function ActiveAgentsPanel({ agents }: ActiveAgentsPanelProps) {
  if (agents.length === 0) return null;

  return (
    <div className="active-agents-panel">
      <div className="active-agents-panel-header">
        <Activity size={16} />
        <span>Active Agents ({agents.length})</span>
      </div>
      <div className="active-agents-grid">
        {agents.map(agent => (
          <LiveAgentCard key={agent.id} agent={agent} />
        ))}
      </div>
    </div>
  );
}
