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

// Anthropic "A" logo from SimpleIcons
function AnthropicIcon({ size, color, label = "Anthropic" }: { size: number; color: string; label?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      data-testid="anthropic-icon"
      aria-label={label}
    >
      <path
        d="M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456Z"
        fill={color}
      />
    </svg>
  );
}

// OpenAI flower logo from Iconify/SimpleIcons
function OpenAIIcon({ size, color, label = "OpenAI" }: { size: number; color: string; label?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      data-testid="openai-icon"
      aria-label={label}
    >
      <path
        d="M22.282 9.821a6 6 0 0 0-.516-4.91a6.05 6.05 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a6 6 0 0 0-3.998 2.9a6.05 6.05 0 0 0 .743 7.097a5.98 5.98 0 0 0 .51 4.911a6.05 6.05 0 0 0 6.515 2.9A6 6 0 0 0 13.26 24a6.06 6.06 0 0 0 5.772-4.206a6 6 0 0 0 3.997-2.9a6.06 6.06 0 0 0-.747-7.073M13.26 22.43a4.48 4.48 0 0 1-2.876-1.04l.141-.081l4.779-2.758a.8.8 0 0 0 .392-.681v-6.737l2.02 1.168a.07.07 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494M3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085l4.783 2.759a.77.77 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646M2.34 7.896a4.5 4.5 0 0 1 2.366-1.973V11.6a.77.77 0 0 0 .388.677l5.815 3.354l-2.02 1.168a.08.08 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855l-5.833-3.387L15.119 7.2a.08.08 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.667m2.01-3.023l-.141-.085l-4.774-2.782a.78.78 0 0 0-.785 0L9.409 9.23V6.897a.07.07 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135l-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08L8.704 5.46a.8.8 0 0 0-.393.681zm1.097-2.365l2.602-1.5l2.607 1.5v2.999l-2.597 1.5l-2.607-1.5Z"
        fill={color}
      />
    </svg>
  );
}

// Google Gemini sparkle logo from SimpleIcons
function GeminiIcon({ size, color, label = "Google Gemini" }: { size: number; color: string; label?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      data-testid="gemini-icon"
      aria-label={label}
    >
      <path
        d="M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81"
        fill={color}
      />
    </svg>
  );
}

// Ollama llama head logo from SimpleIcons
function OllamaIcon({ size, color, label = "Ollama" }: { size: number; color: string; label?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      data-testid="ollama-icon"
      aria-label={label}
    >
      <path
        d="M16.361 10.26a.894.894 0 0 0-.558.47l-.072.148.001.207c0 .193.004.217.059.353.076.193.152.312.291.448.24.238.51.3.872.205a.86.86 0 0 0 .517-.436.752.752 0 0 0 .08-.498c-.064-.453-.33-.782-.724-.897a1.06 1.06 0 0 0-.466 0zm-9.203.005c-.305.096-.533.32-.65.639a1.187 1.187 0 0 0-.06.52c.057.309.31.59.598.667.362.095.632.033.872-.205.14-.136.215-.255.291-.448.055-.136.059-.16.059-.353l.001-.207-.072-.148a.894.894 0 0 0-.565-.472 1.02 1.02 0 0 0-.474.007Zm4.184 2c-.131.071-.223.25-.195.383.031.143.157.288.353.407.105.063.112.072.117.136.004.038-.01.146-.029.243-.02.094-.036.194-.036.222.002.074.07.195.143.253.064.052.076.054.255.059.164.005.198.001.264-.03.169-.082.212-.234.15-.525-.052-.243-.042-.28.087-.355.137-.08.281-.219.324-.314a.365.365 0 0 0-.175-.48.394.394 0 0 0-.181-.033c-.126 0-.207.03-.355.124l-.085.053-.053-.032c-.219-.13-.259-.145-.391-.143a.396.396 0 0 0-.193.032zm.39-2.195c-.373.036-.475.05-.654.086-.291.06-.68.195-.951.328-.94.46-1.589 1.226-1.787 2.114-.04.176-.045.234-.045.53 0 .294.005.357.043.524.264 1.16 1.332 2.017 2.714 2.173.3.033 1.596.033 1.896 0 1.11-.125 2.064-.727 2.493-1.571.114-.226.169-.372.22-.602.039-.167.044-.23.044-.523 0-.297-.005-.355-.045-.531-.288-1.29-1.539-2.304-3.072-2.497a6.873 6.873 0 0 0-.855-.031zm.645.937a3.283 3.283 0 0 1 1.44.514c.223.148.537.458.671.662.166.251.26.508.303.82.02.143.01.251-.043.482-.08.345-.332.705-.672.957a3.115 3.115 0 0 1-.689.348c-.382.122-.632.144-1.525.138-.582-.006-.686-.01-.853-.042-.57-.107-1.022-.334-1.35-.68-.264-.28-.385-.535-.45-.946-.03-.192.025-.509.137-.776.136-.326.488-.73.836-.963.403-.269.934-.46 1.422-.512.187-.02.586-.02.773-.002zm-5.503-11a1.653 1.653 0 0 0-.683.298C5.617.74 5.173 1.666 4.985 2.819c-.07.436-.119 1.04-.119 1.503 0 .544.064 1.24.155 1.721.02.107.031.202.023.208a8.12 8.12 0 0 1-.187.152 5.324 5.324 0 0 0-.949 1.02 5.49 5.49 0 0 0-.94 2.339 6.625 6.625 0 0 0-.023 1.357c.091.78.325 1.438.727 2.04l.13.195-.037.064c-.269.452-.498 1.105-.605 1.732-.084.496-.095.629-.095 1.294 0 .67.009.803.088 1.266.095.555.288 1.143.503 1.534.071.128.243.393.264.407.007.003-.014.067-.046.141a7.405 7.405 0 0 0-.548 1.873c-.062.417-.071.552-.071.991 0 .56.031.832.148 1.279L3.42 24h1.478l-.05-.091c-.297-.552-.325-1.575-.068-2.597.117-.472.25-.819.498-1.296l.148-.29v-.177c0-.165-.003-.184-.057-.293a.915.915 0 0 0-.194-.25 1.74 1.74 0 0 1-.385-.543c-.424-.92-.506-2.286-.208-3.451.124-.486.329-.918.544-1.154a.787.787 0 0 0 .223-.531c0-.195-.07-.355-.224-.522a3.136 3.136 0 0 1-.817-1.729c-.14-.96.114-2.005.69-2.834.563-.814 1.353-1.336 2.237-1.475.199-.033.57-.028.776.01.226.04.367.028.512-.041.179-.085.268-.19.374-.431.093-.215.165-.333.36-.576.234-.29.46-.489.822-.729.413-.27.884-.467 1.352-.561.17-.035.25-.04.569-.04.319 0 .398.005.569.04a4.07 4.07 0 0 1 1.914.997c.117.109.398.457.488.602.034.057.095.177.132.267.105.241.195.346.374.43.14.068.286.082.503.045.343-.058.607-.053.943.016 1.144.23 2.14 1.173 2.581 2.437.385 1.108.276 2.267-.296 3.153-.097.15-.193.27-.333.419-.301.322-.301.722-.001 1.053.493.539.801 1.866.708 3.036-.062.772-.26 1.463-.533 1.854a2.096 2.096 0 0 1-.224.258.916.916 0 0 0-.194.25c-.054.109-.057.128-.057.293v.178l.148.29c.248.476.38.823.498 1.295.253 1.008.231 2.01-.059 2.581a.845.845 0 0 0-.044.098c0 .006.329.009.732.009h.73l.02-.074.036-.134c.019-.076.057-.3.088-.516.029-.217.029-1.016 0-1.258-.11-.875-.295-1.57-.597-2.226-.032-.074-.053-.138-.046-.141.008-.005.057-.074.108-.152.376-.569.607-1.284.724-2.228.031-.26.031-1.378 0-1.628-.083-.645-.182-1.082-.348-1.525a6.083 6.083 0 0 0-.329-.7l-.038-.064.131-.194c.402-.604.636-1.262.727-2.04a6.625 6.625 0 0 0-.024-1.358 5.512 5.512 0 0 0-.939-2.339 5.325 5.325 0 0 0-.95-1.02 8.097 8.097 0 0 1-.186-.152.692.692 0 0 1 .023-.208c.208-1.087.201-2.443-.017-3.503-.19-.924-.535-1.658-.98-2.082-.354-.338-.716-.482-1.15-.455-.996.059-1.8 1.205-2.116 3.01a6.805 6.805 0 0 0-.097.726c0 .036-.007.066-.015.066a.96.96 0 0 1-.149-.078A4.857 4.857 0 0 0 12 3.03c-.832 0-1.687.243-2.456.698a.958.958 0 0 1-.148.078c-.008 0-.015-.03-.015-.066a6.71 6.71 0 0 0-.097-.725C8.997 1.392 8.337.319 7.46.048a2.096 2.096 0 0 0-.585-.041Zm.293 1.402c.248.197.523.759.682 1.388.03.113.06.244.069.292.007.047.026.152.041.233.067.365.098.76.102 1.24l.002.475-.12.175-.118.178h-.278c-.324 0-.646.041-.954.124l-.238.06c-.033.007-.038-.003-.057-.144a8.438 8.438 0 0 1 .016-2.323c.124-.788.413-1.501.696-1.711.067-.05.079-.049.157.013zm9.825-.012c.17.126.358.46.498.888.28.854.36 2.028.212 3.145-.019.14-.024.151-.057.144l-.238-.06a3.693 3.693 0 0 0-.954-.124h-.278l-.119-.178-.119-.175.002-.474c.004-.669.066-1.19.214-1.772.157-.623.434-1.185.68-1.382.078-.062.09-.063.159-.012z"
        fill={color}
      />
    </svg>
  );
}

// MiniMax logo from SimpleIcons — stylized "M" grid mark
function MiniMaxIcon({ size, color, label = "MiniMax" }: { size: number; color: string; label?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      data-testid="minimax-icon"
      aria-label={label}
    >
      <path
        d="M11.43 3.92a.86.86 0 1 0-1.718 0v14.236a1.999 1.999 0 0 1-3.997 0V9.022a.86.86 0 1 0-1.718 0v3.87a1.999 1.999 0 0 1-3.997 0V11.49a.57.57 0 0 1 1.139 0v1.404a.86.86 0 0 0 1.719 0V9.022a1.999 1.999 0 0 1 3.997 0v9.134a.86.86 0 0 0 1.719 0V3.92a1.998 1.998 0 1 1 3.996 0v11.788a.57.57 0 1 1-1.139 0zm10.572 3.105a2 2 0 0 0-1.999 1.997v7.63a.86.86 0 0 1-1.718 0V3.923a1.999 1.999 0 0 0-3.997 0v16.16a.86.86 0 0 1-1.719 0V18.08a.57.57 0 1 0-1.138 0v2a1.998 1.998 0 0 0 3.996 0V3.92a.86.86 0 0 1 1.719 0v12.73a1.999 1.999 0 0 0 3.996 0V9.023a.86.86 0 1 1 1.72 0v6.686a.57.57 0 0 0 1.138 0V9.022a2 2 0 0 0-1.998-1.997"
        fill={color}
      />
    </svg>
  );
}

// Z.ai / Zhipu AI logo — stylized "Z" mark from brand identity
function ZaiIcon({ size, color, label = "Z.ai" }: { size: number; color: string; label?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      data-testid="zai-icon"
      aria-label={label}
    >
      <path
        d="M3 5H21V8.5L7 17.5H21V21H3V17.5L17 8.5H3Z"
        fill={color}
      />
    </svg>
  );
}

// Kimi / Moonshot AI logo — crescent moon mark from official Moonshot AI brand identity
// Source: https://raw.githubusercontent.com/gilbarbara/logos/master/logos/moonshot-ai.svg
// The moon crescent shape is derived from the official Moonshot AI logo
// For a 24x24 icon, we use a simplified crescent moon path
function KimiIcon({ size, color, label = "Kimi" }: { size: number; color: string; label?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      data-testid="kimi-icon"
      aria-label={label}
    >
      {/* Crescent moon from official Moonshot AI logo mark */}
      <path
        d="M12 3a9 9 0 1 0 9 9c0-.46-.04-.92-.1-1.36a5.39 5.39 0 0 1-4.4 2.26 5.4 5.4 0 0 1-3.14-9.8c.2-.07.4-.1.64-.1z"
        fill={color}
      />
    </svg>
  );
}

function BedrockIcon({ size, color, label = "Amazon Bedrock" }: { size: number; color: string; label?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      data-testid="bedrock-icon"
      aria-label={label}
    >
      <path
        d="M.045 18.02c.072-.116.187-.124.348-.022 2.344 1.476 4.878 2.212 7.607 2.212 1.86 0 3.68-.398 5.453-1.198.386-.168.71-.298.972-.39.26-.092.478-.113.654-.06.176.052.263.2.263.443 0 .222-.12.453-.358.693-.96.962-2.16 1.71-3.592 2.242A12.126 12.126 0 0 1 7.297 23c-2.456 0-4.583-.665-6.378-1.992a.39.39 0 0 1-.098-.096c-.05-.078-.05-.156 0-.234zm6.609-3.26c0-.37.093-.665.282-.886.188-.222.43-.332.727-.332.282 0 .524.105.726.314.2.21.3.498.3.866v4.116c0 .382-.098.676-.294.882-.196.206-.436.31-.72.31-.294 0-.54-.108-.738-.324-.198-.216-.296-.506-.296-.868v-4.078h.014zm-2.986 2.3c0-.376.096-.672.288-.89.192-.216.434-.324.726-.324.292 0 .534.108.726.324.192.218.288.514.288.89v1.778c0 .376-.096.672-.288.89-.192.216-.434.324-.726.324-.292 0-.534-.108-.726-.324-.192-.218-.288-.514-.288-.89v-1.778zm-2.92 1.334c0-.36.09-.65.27-.868.18-.218.42-.328.722-.328s.544.11.73.328c.186.218.278.508.278.868v.444c0 .36-.092.65-.278.868-.186.218-.428.328-.73.328s-.542-.11-.722-.328c-.18-.218-.27-.508-.27-.868v-.444zM21.93 16.4c.804.456 1.39.87 1.758 1.242.368.372.552.7.552.984 0 .208-.102.37-.308.488-.206.118-.462.128-.768.032-.306-.096-.674-.316-1.104-.66a12.728 12.728 0 0 1-1.864-1.75c-1.592.644-3.342.966-5.25.966-1.354 0-2.604-.178-3.752-.534a8.103 8.103 0 0 1-.09-.032l.03.012c-.136-.048.056.022-.042-.014-.04-.016-.04-.016 0 0l.012.004-.012-.004c-.32-.122-.528-.222-.624-.3-.096-.078-.144-.178-.144-.3 0-.098.04-.186.122-.264.082-.078.19-.116.326-.116.076 0 .284.054.624.162 1.078.34 2.264.51 3.558.51 1.642 0 3.194-.286 4.658-.856a17.018 17.018 0 0 1-1.904-3.326c-.416-.94-.726-1.86-.93-2.758-.206-.898-.308-1.728-.308-2.49 0-.664.094-1.194.28-1.592.188-.396.456-.594.804-.594.2 0 .392.074.576.224.184.148.312.354.384.614.1.358.178.758.234 1.198.056.44.084.876.084 1.306 0 .898-.116 1.862-.348 2.894-.232 1.032-.614 2.11-1.146 3.234a16.217 16.217 0 0 0 1.916 1.694z"
        fill={color}
      />
    </svg>
  );
}

function XaiIcon({ size, color, label = "xAI" }: { size: number; color: string; label?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      data-testid="xai-icon"
      aria-label={label}
    >
      <path
        d="M2.21 3l7.964 11.386L2.13 21h1.974l6.843-7.07L17.165 21H22.1l-8.392-11.97L21.17 3h-1.974l-6.349 6.56L6.845 3z"
        fill={color}
      />
    </svg>
  );
}

function OpencodeIcon({ size, color, label = "Opencode" }: { size: number; color: string; label?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      data-testid="opencode-icon"
      aria-label={label}
    >
      <path
        d="M9.4 16.6L4.8 12l4.6-4.6L8 6l-6 6 6 6zm5.2 0l4.6-4.6-4.6-4.6L16 6l6 6-6 6z"
        fill={color}
      />
    </svg>
  );
}

// Qwen / Tongyi Qianwen monogram — stylized "Q" with the tail piercing
// the ring, a recognizable simplification of the official mark.
function QwenIcon({ size, color, label = "Qwen" }: { size: number; color: string; label?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      data-testid="qwen-icon"
      aria-label={label}
    >
      <circle cx="11" cy="12" r="7.5" stroke={color} strokeWidth="2" fill="none" />
      <path
        d="M14 15 L21 22"
        stroke={color}
        strokeWidth="2.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

// LM Studio — rounded square frame with a stylized "LM" wordmark inside,
// reminiscent of the desktop app's icon.
function LMStudioIcon({ size, color, label = "LM Studio" }: { size: number; color: string; label?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      data-testid="lmstudio-icon"
      aria-label={label}
    >
      <rect x="2" y="2" width="20" height="20" rx="4.5" fill={color} />
      <text
        x="12"
        y="16"
        textAnchor="middle"
        fontFamily="-apple-system, system-ui, sans-serif"
        fontSize="9.5"
        fontWeight="700"
        fill="var(--provider-icon-contrast)"
        letterSpacing="-0.4"
      >
        LM
      </text>
    </svg>
  );
}

// Hugging Face — the iconic smiling-face emoji used as their official
// brand mark. Eyes and mouth are stamped using the surrounding contrast
// token so the face remains legible on any theme background.
function HuggingFaceIcon({ size, color, label = "Hugging Face" }: { size: number; color: string; label?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      data-testid="huggingface-icon"
      aria-label={label}
    >
      <circle cx="12" cy="12" r="9" fill={color} />
      <circle cx="8.5" cy="10.5" r="1.4" fill="var(--provider-icon-contrast)" />
      <circle cx="15.5" cy="10.5" r="1.4" fill="var(--provider-icon-contrast)" />
      <path
        d="M7.5 14.5 Q12 18.5 16.5 14.5"
        stroke="var(--provider-icon-contrast)"
        strokeWidth="1.6"
        strokeLinecap="round"
        fill="none"
      />
      {/* Hands flanking the face — the "hugging" part of the emoji. */}
      <path
        d="M3.5 16 Q5 13.5 7 14.5 M20.5 16 Q19 13.5 17 14.5"
        stroke={color}
        strokeWidth="1.8"
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  );
}

// Mistral — geometric "M" simplified from the official tricolor mark.
function MistralIcon({ size, color, label = "Mistral AI" }: { size: number; color: string; label?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      data-testid="mistral-icon"
      aria-label={label}
    >
      {/* Five vertical bars descending into staggered baselines, the
          essence of the Mistral wordmark's M. */}
      <path
        d="M2 4h3v16H2zM7 4h3v12H7zM12 4h3v16h-3zM17 4h3v8h-3zM7 16h3v4H7zM17 8h3v12h-3z"
        fill={color}
      />
    </svg>
  );
}

// Azure — Microsoft Azure "A" sail mark.
function AzureIcon({ size, color, label = "Azure" }: { size: number; color: string; label?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      data-testid="azure-icon"
      aria-label={label}
    >
      <path
        d="M10.4 3.2 4.5 16.6l3.5.5L13 6 9.6 19.5h9.9zM3 19.5l4.6.6 8.6-1.7-7-1.6z"
        fill={color}
      />
    </svg>
  );
}

// Cerebras — concentric arcs forming a stylized "C", echoing the
// official wafer-scale brand mark.
function CerebrasIcon({ size, color, label = "Cerebras" }: { size: number; color: string; label?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      data-testid="cerebras-icon"
      aria-label={label}
    >
      <path
        d="M19.5 6.5A8.5 8.5 0 1 0 19.5 17.5"
        stroke={color}
        strokeWidth="2.4"
        strokeLinecap="round"
        fill="none"
      />
      <path
        d="M16.5 9A4.6 4.6 0 1 0 16.5 15"
        stroke={color}
        strokeWidth="1.8"
        strokeLinecap="round"
        fill="none"
      />
      <circle cx="11" cy="12" r="1.6" fill={color} />
    </svg>
  );
}

// Groq — stylized lightning-bolt pulse, evoking their fast-inference
// brand identity.
function GroqIcon({ size, color, label = "Groq" }: { size: number; color: string; label?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      data-testid="groq-icon"
      aria-label={label}
    >
      <path
        d="M14 2 4 13h6l-2 9 10-11h-6z"
        fill={color}
      />
    </svg>
  );
}

// Vercel — the iconic equilateral triangle wordmark.
function VercelIcon({ size, color, label = "Vercel" }: { size: number; color: string; label?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      data-testid="vercel-icon"
      aria-label={label}
    >
      <path d="M12 2 22 21H2z" fill={color} />
    </svg>
  );
}

// Fireworks AI — burst of dots radiating from a central nucleus, a
// monochrome simplification of their identity mark.
function FireworksIcon({ size, color, label = "Fireworks AI" }: { size: number; color: string; label?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      data-testid="fireworks-icon"
      aria-label={label}
    >
      <circle cx="12" cy="12" r="2.4" fill={color} />
      {/* 8 outer dots arranged on a circle */}
      <circle cx="12" cy="3.5" r="1.4" fill={color} />
      <circle cx="12" cy="20.5" r="1.4" fill={color} />
      <circle cx="3.5" cy="12" r="1.4" fill={color} />
      <circle cx="20.5" cy="12" r="1.4" fill={color} />
      <circle cx="6" cy="6" r="1.2" fill={color} />
      <circle cx="18" cy="6" r="1.2" fill={color} />
      <circle cx="6" cy="18" r="1.2" fill={color} />
      <circle cx="18" cy="18" r="1.2" fill={color} />
      {/* 4 connecting rays from the nucleus to the cardinal dots */}
      <path
        d="M12 5.5v3M12 15.5v3M5.5 12h3M15.5 12h3"
        stroke={color}
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

// OpenRouter ring mark — simplified geometric version of the OpenRouter brand symbol.
function OpenRouterIcon({ size, color, label = "OpenRouter" }: { size: number; color: string; label?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      data-testid="openrouter-icon"
      aria-label={label}
    >
      <path
        d="M12 2.5a9.5 9.5 0 1 0 9.5 9.5h-2.7a6.8 6.8 0 1 1-2-4.8l-3.1 3.1H22V2.5l-3.2 3.2A9.45 9.45 0 0 0 12 2.5"
        fill={color}
      />
    </svg>
  );
}

// GitHub logo (Octocat mark) from SimpleIcons.
function GitHubIcon({ size, color, label = "GitHub" }: { size: number; color: string; label?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      data-testid="github-icon"
      aria-label={label}
    >
      <path
        d="M12 0a12 12 0 0 0-3.79 23.39c.6.11.82-.26.82-.58v-2.23c-3.34.73-4.04-1.41-4.04-1.41-.55-1.39-1.34-1.76-1.34-1.76-1.09-.75.08-.74.08-.74 1.2.08 1.84 1.24 1.84 1.24 1.08 1.84 2.82 1.31 3.5 1 .1-.78.42-1.31.77-1.62-2.67-.3-5.47-1.34-5.47-5.95 0-1.31.47-2.38 1.24-3.22-.12-.31-.54-1.56.12-3.24 0 0 1.01-.32 3.3 1.23a11.3 11.3 0 0 1 6 0c2.29-1.55 3.3-1.23 3.3-1.23.66 1.68.24 2.93.12 3.24.77.84 1.24 1.91 1.24 3.22 0 4.62-2.8 5.64-5.48 5.94.43.37.82 1.1.82 2.22v3.29c0 .32.22.69.83.58A12 12 0 0 0 12 0"
        fill={color}
      />
    </svg>
  );
}

// Hermes — caduceus (winged staff) mark, single-color so it adapts to theme.
function HermesIcon({ size, color, label = "Hermes" }: { size: number; color: string; label?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label={label}>
      <rect x="30" y="10" width="4" height="46" rx="2" fill={color} />
      <path d="M30 18 C24 14, 14 14, 10 18 C14 16, 22 16, 28 20" fill={color} opacity="0.9" />
      <path d="M30 22 C26 19, 18 19, 14 22 C18 20, 24 20, 28 24" fill={color} opacity="0.7" />
      <path d="M34 18 C40 14, 50 14, 54 18 C50 16, 42 16, 36 20" fill={color} opacity="0.9" />
      <path d="M34 22 C38 19, 46 19, 50 22 C46 20, 40 20, 36 24" fill={color} opacity="0.7" />
      <path d="M32 48 C22 44, 20 38, 26 34 C20 36, 18 42, 24 46 C18 40, 22 30, 30 28 C24 32, 22 38, 28 42" fill="none" stroke={color} strokeWidth="2.5" strokeLinecap="round" />
      <path d="M32 48 C42 44, 44 38, 38 34 C44 36, 46 42, 40 46 C46 40, 42 30, 34 28 C40 32, 42 38, 36 42" fill="none" stroke={color} strokeWidth="2.5" strokeLinecap="round" opacity="0.8" />
      <circle cx="32" cy="10" r="4" fill={color} />
    </svg>
  );
}

// OpenClaw — pixel-art lobster (verbatim 16×16 source SVG, recolor disabled
// so the iconic palette survives).
function OpenClawIcon({ size, label = "OpenClaw" }: { size: number; color: string; label?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" role="img" aria-label={label}>
      <rect width="16" height="16" fill="none" />
      <g fill="#3a0a0d">
        <rect x="1" y="5" width="1" height="3" />
        <rect x="2" y="4" width="1" height="1" />
        <rect x="2" y="8" width="1" height="1" />
        <rect x="3" y="3" width="1" height="1" />
        <rect x="3" y="9" width="1" height="1" />
        <rect x="4" y="2" width="1" height="1" />
        <rect x="4" y="10" width="1" height="1" />
        <rect x="5" y="2" width="6" height="1" />
        <rect x="11" y="2" width="1" height="1" />
        <rect x="12" y="3" width="1" height="1" />
        <rect x="12" y="9" width="1" height="1" />
        <rect x="13" y="4" width="1" height="1" />
        <rect x="13" y="8" width="1" height="1" />
        <rect x="14" y="5" width="1" height="3" />
        <rect x="5" y="11" width="6" height="1" />
        <rect x="4" y="12" width="1" height="1" />
        <rect x="11" y="12" width="1" height="1" />
        <rect x="3" y="13" width="1" height="1" />
        <rect x="12" y="13" width="1" height="1" />
        <rect x="5" y="14" width="6" height="1" />
      </g>
      <g fill="#ff4f40">
        <rect x="5" y="3" width="6" height="1" />
        <rect x="4" y="4" width="8" height="1" />
        <rect x="3" y="5" width="10" height="1" />
        <rect x="3" y="6" width="10" height="1" />
        <rect x="3" y="7" width="10" height="1" />
        <rect x="4" y="8" width="8" height="1" />
        <rect x="5" y="9" width="6" height="1" />
        <rect x="5" y="12" width="6" height="1" />
        <rect x="6" y="13" width="4" height="1" />
      </g>
      <g fill="#ff775f">
        <rect x="1" y="6" width="2" height="1" />
        <rect x="2" y="5" width="1" height="1" />
        <rect x="2" y="7" width="1" height="1" />
        <rect x="13" y="6" width="2" height="1" />
        <rect x="13" y="5" width="1" height="1" />
        <rect x="13" y="7" width="1" height="1" />
      </g>
      <g fill="#081016">
        <rect x="6" y="5" width="1" height="1" />
        <rect x="9" y="5" width="1" height="1" />
      </g>
      <g fill="#f5fbff">
        <rect x="6" y="4" width="1" height="1" />
        <rect x="9" y="4" width="1" height="1" />
      </g>
    </svg>
  );
}

// Paperclip — official paperclip outline, theme-color aware.
function PaperclipIcon({ size, color, label = "Paperclip" }: { size: number; color: string; label?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label={label}>
      <path
        d="m16 6-8.414 8.586a2 2 0 0 0 2.829 2.829l8.414-8.586a4 4 0 1 0-5.657-5.657l-8.379 8.551a6 6 0 1 0 8.485 8.485l8.379-8.551"
        stroke={color}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// Anthropic "A" mark composited with a small terminal "> _" badge in the
// bottom-right, visually signalling "Anthropic, but via the local CLI".
function ClaudeCliIcon({ size, color, label = "Anthropic — via Claude CLI" }: { size: number; color: string; label?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      data-testid="claude-cli-icon"
      aria-label={label}
    >
      {/* Anthropic "A" mark, slightly shrunk + shifted to leave room for the badge */}
      <g transform="translate(-1 -1.5) scale(0.82)">
        <path
          d="M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456Z"
          fill={color}
        />
      </g>
      {/* Terminal badge — filled square with "> _" glyph */}
      <rect x="13" y="13" width="10" height="9" rx="1.5" fill={color} />
      <path
        d="M15.2 16.2l1.6 1.4-1.6 1.4M18.6 19.6h2.4"
        stroke="var(--provider-icon-contrast)"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}

const providerConfig: Record<
  string,
  { component: typeof AnthropicIcon; color: string; label?: string }
> = {
  // Branded provider colors are tokenized in app/styles.css for theme-system consistency.
  anthropic: { component: AnthropicIcon, color: "var(--provider-anthropic)" },
  "claude-cli": { component: ClaudeCliIcon, color: "var(--provider-anthropic)", label: "Anthropic — via Claude CLI" },
  "pi-claude-cli": { component: ClaudeCliIcon, color: "var(--provider-anthropic)", label: "Anthropic — via Claude CLI" },

  openai: { component: OpenAIIcon, color: "var(--provider-openai)" },
  "openai-codex": { component: OpenAIIcon, color: "var(--provider-openai)", label: "OpenAI Codex" }, // OpenAI alias

  google: { component: GeminiIcon, color: "var(--provider-gemini)" },
  gemini: { component: GeminiIcon, color: "var(--provider-gemini)" }, // Gemini alias family
  "google-antigravity": { component: GeminiIcon, color: "var(--provider-gemini)", label: "Google Gemini" },
  antigravity: { component: GeminiIcon, color: "var(--provider-gemini)", label: "Google Gemini" },
  "google-vertex": { component: GeminiIcon, color: "var(--provider-gemini)", label: "Google Vertex AI" },
  vertex: { component: GeminiIcon, color: "var(--provider-gemini)", label: "Google Vertex AI" },
  "google-cloud-code": { component: GeminiIcon, color: "var(--provider-gemini)", label: "Google Cloud Code" },
  "cloud-code": { component: GeminiIcon, color: "var(--provider-gemini)", label: "Google Cloud Code" },
  "google-gemini-cli": { component: GeminiIcon, color: "var(--provider-gemini)", label: "Google Gemini CLI" },
  "google-generative-ai": { component: GeminiIcon, color: "var(--provider-gemini)", label: "Google Generative AI" },

  // Monochrome marks use theme-aware text color for dark/light safety.
  ollama: { component: OllamaIcon, color: "var(--text)" },
  github: { component: GitHubIcon, color: "var(--text)" },
  "github-copilot": { component: GitHubIcon, color: "var(--text)", label: "GitHub Copilot" },

  // OpenRouter appears in onboarding auth cards and should not fall back to CPU.
  openrouter: { component: OpenRouterIcon, color: "var(--provider-openrouter)" },

  minimax: { component: MiniMaxIcon, color: "var(--provider-minimax)" },
  "minimax-cn": { component: MiniMaxIcon, color: "var(--provider-minimax)", label: "MiniMax (CN)" },
  zai: { component: ZaiIcon, color: "var(--provider-zai)" },

  kimi: { component: KimiIcon, color: "var(--provider-kimi)" },
  moonshot: { component: KimiIcon, color: "var(--provider-kimi)" }, // Moonshot alias
  "kimi-coding": { component: KimiIcon, color: "var(--provider-kimi)", label: "Kimi" }, // Kimi alias

  bedrock: { component: BedrockIcon, color: "var(--provider-bedrock)" },
  "amazon-bedrock": { component: BedrockIcon, color: "var(--provider-bedrock)", label: "Amazon Bedrock" },

  xai: { component: XaiIcon, color: "var(--text)" },
  grok: { component: XaiIcon, color: "var(--text)", label: "xAI" },

  opencode: { component: OpencodeIcon, color: "var(--provider-opencode)" },
  "opencode-go": { component: OpencodeIcon, color: "var(--provider-opencode)", label: "Opencode (Go)" },

  qwen: { component: QwenIcon, color: "var(--provider-qwen)" },
  "qwen-ai": { component: QwenIcon, color: "var(--provider-qwen)", label: "Qwen" },
  "qwen-coder": { component: QwenIcon, color: "var(--provider-qwen)", label: "Qwen Coder" },
  alibaba: { component: QwenIcon, color: "var(--provider-qwen)", label: "Qwen" },
  tongyi: { component: QwenIcon, color: "var(--provider-qwen)", label: "Qwen" },

  lmstudio: { component: LMStudioIcon, color: "var(--provider-lmstudio)", label: "LM Studio" },
  "lm-studio": { component: LMStudioIcon, color: "var(--provider-lmstudio)", label: "LM Studio" },

  huggingface: { component: HuggingFaceIcon, color: "var(--provider-huggingface)", label: "Hugging Face" },
  "hugging-face": { component: HuggingFaceIcon, color: "var(--provider-huggingface)", label: "Hugging Face" },
  hf: { component: HuggingFaceIcon, color: "var(--provider-huggingface)", label: "Hugging Face" },

  mistral: { component: MistralIcon, color: "var(--provider-mistral)", label: "Mistral AI" },
  "mistral-ai": { component: MistralIcon, color: "var(--provider-mistral)", label: "Mistral AI" },

  azure: { component: AzureIcon, color: "var(--provider-azure)" },
  "azure-openai": { component: AzureIcon, color: "var(--provider-azure)", label: "Azure OpenAI" },
  "azure-openai-responses": { component: AzureIcon, color: "var(--provider-azure)", label: "Azure OpenAI" },

  fireworks: { component: FireworksIcon, color: "var(--provider-fireworks)", label: "Fireworks AI" },
  "fireworks-ai": { component: FireworksIcon, color: "var(--provider-fireworks)", label: "Fireworks AI" },
  fireworksai: { component: FireworksIcon, color: "var(--provider-fireworks)", label: "Fireworks AI" },

  cerebras: { component: CerebrasIcon, color: "var(--provider-cerebras)" },

  groq: { component: GroqIcon, color: "var(--provider-groq)" },

  vercel: { component: VercelIcon, color: "var(--provider-vercel)" },
  "vercel-ai-gateway": { component: VercelIcon, color: "var(--provider-vercel)", label: "Vercel AI Gateway" },

  // Runtime-plugin marks (Hermes / OpenClaw / Paperclip).
  hermes: { component: HermesIcon, color: "var(--provider-hermes)", label: "Hermes" },
  "hermes-agent": { component: HermesIcon, color: "var(--provider-hermes)", label: "Hermes" },
  hermesagent: { component: HermesIcon, color: "var(--provider-hermes)", label: "Hermes" },
  openclaw: { component: OpenClawIcon, color: "var(--provider-openclaw)", label: "OpenClaw" },
  "open-claw": { component: OpenClawIcon, color: "var(--provider-openclaw)", label: "OpenClaw" },
  paperclip: { component: PaperclipIcon, color: "var(--provider-paperclip)", label: "Paperclip" },
  paperclipai: { component: PaperclipIcon, color: "var(--provider-paperclip)", label: "Paperclip" },
  "paperclip-ai": { component: PaperclipIcon, color: "var(--provider-paperclip)", label: "Paperclip" },
};

export function ProviderIcon({ provider, size = "sm" }: ProviderIconProps) {
  const normalizedProvider = provider.toLowerCase();
  const config = providerConfig[normalizedProvider];
  const IconComponent = config?.component;
  const color = config?.color ?? "var(--text-muted)";
  const label = config?.label;
  const iconSize = sizeMap[size];

  return (
    <span
      className="provider-icon"
      style={{ color }}
      data-provider={normalizedProvider}
    >
      {IconComponent ? (
        <IconComponent size={iconSize} color={color} label={label} />
      ) : (
        <Cpu size={iconSize} />
      )}
    </span>
  );
}
