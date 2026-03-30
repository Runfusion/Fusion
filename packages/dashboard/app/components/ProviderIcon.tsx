import { Brain, Sparkles, Search, Terminal, Cpu } from "lucide-react";

export interface ProviderIconProps {
  provider: string;
  size?: "sm" | "md" | "lg";
}

const sizeMap = {
  sm: 16,
  md: 20,
  lg: 24,
};

const providerConfig: Record<string, { icon: typeof Brain; color: string }> = {
  anthropic: { icon: Brain, color: "#d4a27f" }, // warm tan
  openai: { icon: Sparkles, color: "#10a37f" }, // green
  google: { icon: Search, color: "#4285f4" }, // blue
  gemini: { icon: Search, color: "#4285f4" }, // blue (same as google)
  ollama: { icon: Terminal, color: "#fff" }, // white
};

export function ProviderIcon({ provider, size = "sm" }: ProviderIconProps) {
  const normalizedProvider = provider.toLowerCase();
  const config = providerConfig[normalizedProvider];
  const Icon = config?.icon ?? Cpu;
  const color = config?.color ?? "var(--text-muted)";
  const iconSize = sizeMap[size];

  return (
    <span className="provider-icon" style={{ color }} data-provider={normalizedProvider}>
      <Icon size={iconSize} />
    </span>
  );
}
