import { Bot } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import "./AgentAvatar.css";

interface AgentAvatarProps {
  agent: {
    id: string;
    icon?: string;
    imageUrl?: string;
    name: string;
    updatedAt?: string;
  };
  size?: number;
  className?: string;
}

export function AgentAvatar({ agent, size = 36, className }: AgentAvatarProps) {
  const [imageError, setImageError] = useState(false);

  useEffect(() => {
    setImageError(false);
  }, [agent.imageUrl]);

  const imageSrc = useMemo(() => {
    if (!agent.imageUrl) return undefined;
    const timestamp = encodeURIComponent(agent.updatedAt ?? "");
    const joiner = agent.imageUrl.includes("?") ? "&" : "?";
    return `${agent.imageUrl}${joiner}t=${timestamp}`;
  }, [agent.imageUrl, agent.updatedAt]);

  return (
    <span
      className={`agent-avatar${className ? ` ${className}` : ""}`}
      style={{ width: `${size}px`, height: `${size}px` }}
      aria-label={`${agent.name} avatar`}
    >
      {imageSrc && !imageError ? (
        <img src={imageSrc} alt={`${agent.name} avatar`} onError={() => setImageError(true)} />
      ) : agent.icon?.trim() ? (
        <span className="agent-avatar-emoji" style={{ fontSize: `calc(${size}px * 0.58)` }} aria-hidden="true">
          {agent.icon}
        </span>
      ) : (
        <Bot size={Math.max(14, Math.round(size * 0.55))} aria-hidden="true" />
      )}
    </span>
  );
}

export type { AgentAvatarProps };
