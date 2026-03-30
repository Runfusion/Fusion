import { Cpu } from "lucide-react";

export interface ProviderIconProps {
  provider: string;
  size?: "sm" | "md" | "lg";
}

const sizeMap = {
  sm: 16,
  md: 20,
  lg: 24,
};

// Anthropic "A" monogram logo - diamond-shaped stylized A in warm tan
function AnthropicIcon({ size, color }: { size: number; color: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      data-testid="anthropic-icon"
      aria-label="Anthropic"
    >
      <path
        d="M12 2L2 12L12 22L22 12L12 2Z"
        fill={color}
        opacity="0.9"
      />
      <path
        d="M12 6L7 14H10L12 10.5L14 14H17L12 6Z"
        fill="white"
      />
    </svg>
  );
}

// OpenAI spiral flower logo - green
function OpenAIIcon({ size, color }: { size: number; color: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      data-testid="openai-icon"
      aria-label="OpenAI"
    >
      <path
        d="M12 2C6.48 2 2 6.48 2 12C2 17.52 6.48 22 12 22C17.52 22 22 17.52 22 12C22 6.48 17.52 2 12 2ZM12 20C7.59 20 4 16.41 4 12C4 7.59 7.59 4 12 4C16.41 4 20 7.59 20 12C20 16.41 16.41 20 12 20Z"
        fill={color}
      />
      <path
        d="M12 6C8.69 6 6 8.69 6 12C6 15.31 8.69 18 12 18C15.31 18 18 15.31 18 12C18 8.69 15.31 6 12 6ZM12 16C9.79 16 8 14.21 8 12C8 9.79 9.79 8 12 8C14.21 8 16 9.79 16 12C16 14.21 14.21 16 12 16Z"
        fill={color}
        opacity="0.7"
      />
      <path
        d="M12 10C10.9 10 10 10.9 10 12C10 13.1 10.9 14 12 14C13.1 14 14 13.1 14 12C14 10.9 13.1 10 12 10Z"
        fill={color}
      />
    </svg>
  );
}

// Google Gemini sparkle icon - blue
function GeminiIcon({ size, color }: { size: number; color: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      data-testid="gemini-icon"
      aria-label="Google Gemini"
    >
      <path
        d="M12 2L13.5 8.5L20 10L13.5 11.5L12 18L10.5 11.5L4 10L10.5 8.5L12 2Z"
        fill={color}
      />
      <path
        d="M12 6L12.75 9.25L16 10L12.75 10.75L12 14L11.25 10.75L8 10L11.25 9.25L12 6Z"
        fill="white"
        opacity="0.9"
      />
    </svg>
  );
}

// Ollama llama head logo - white
function OllamaIcon({ size, color }: { size: number; color: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      data-testid="ollama-icon"
      aria-label="Ollama"
    >
      {/* Llama head silhouette */}
      <path
        d="M12 4C9 4 7 6 7 8C7 9 7.5 10 8 10.5C8 10.5 7 11 6 12C5 13 5 15 6 17C7 19 9 20 12 20C15 20 17 19 18 17C19 15 19 13 18 12C17 11 16 10.5 16 10.5C16.5 10 17 9 17 8C17 6 15 4 12 4Z"
        fill={color}
      />
      {/* Ears */}
      <path
        d="M9 6L8 3L10 5"
        fill={color}
        stroke={color}
        strokeWidth="1"
      />
      <path
        d="M15 6L16 3L14 5"
        fill={color}
        stroke={color}
        strokeWidth="1"
      />
      {/* Eyes */}
      <circle cx="10" cy="11" r="1.5" fill="#1a1a1a" />
      <circle cx="14" cy="11" r="1.5" fill="#1a1a1a" />
      {/* Nose */}
      <ellipse cx="12" cy="14" rx="1.5" ry="1" fill="#1a1a1a" />
    </svg>
  );
}

const providerConfig: Record<
  string,
  { component: typeof AnthropicIcon; color: string }
> = {
  anthropic: { component: AnthropicIcon, color: "#d4a27f" }, // warm tan
  openai: { component: OpenAIIcon, color: "#10a37f" }, // green
  google: { component: GeminiIcon, color: "#4285f4" }, // blue
  gemini: { component: GeminiIcon, color: "#4285f4" }, // blue (same as google)
  ollama: { component: OllamaIcon, color: "#fff" }, // white
};

export function ProviderIcon({ provider, size = "sm" }: ProviderIconProps) {
  const normalizedProvider = provider.toLowerCase();
  const config = providerConfig[normalizedProvider];
  const IconComponent = config?.component;
  const color = config?.color ?? "var(--text-muted)";
  const iconSize = sizeMap[size];

  return (
    <span
      className="provider-icon"
      style={{ color }}
      data-provider={normalizedProvider}
    >
      {IconComponent ? (
        <IconComponent size={iconSize} color={color} />
      ) : (
        <Cpu size={iconSize} />
      )}
    </span>
  );
}
