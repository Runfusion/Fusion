import { useCallback, useEffect, useRef, useState } from "react";
import { Copy, Check } from "lucide-react";
import { copyTextToClipboard } from "../utils/copyToClipboard";
import "./LoginInstructions.css";

interface LoginInstructionsProps {
  instructions: string;
  "data-testid"?: string;
}

/**
 * Extract a device code from OAuth login instructions.
 * Matches patterns like "GH-2469", "ABCD-1234", "1234-ABCD", and short alphanumeric codes.
 */
function extractDeviceCode(text: string): string | null {
  const codePattern = "([A-Z0-9]{2,}(?:-[A-Z0-9]{2,})+|[A-Z0-9]{6,9})";
  const contextualPattern = new RegExp(`\\b(?:device\\s+code|your\\s+code|code)\\s*(?:is|:)?\\s*${codePattern}\\b`, "i");
  const enterPattern = new RegExp(`\\b(?:enter|use)\\s+${codePattern}\\b`, "i");
  const standaloneDashedPattern = /\b([A-Z0-9]{2,}(?:-[A-Z0-9]{2,})+)\b/;

  const contextualMatch = text.match(contextualPattern);
  if (contextualMatch?.[1]) {
    return contextualMatch[1];
  }

  const enterMatch = text.match(enterPattern);
  if (enterMatch?.[1]) {
    return enterMatch[1];
  }

  const dashedMatch = text.match(standaloneDashedPattern);
  if (dashedMatch?.[1]) {
    return dashedMatch[1];
  }

  return null;
}

/**
 * Renders OAuth login instructions with a copy-to-clipboard button
 * for the device code when one is detected.
 */
export function LoginInstructions({ instructions, "data-testid": testId }: LoginInstructionsProps) {
  const [copied, setCopied] = useState(false);
  const deviceCode = extractDeviceCode(instructions);
  const previousDeviceCodeRef = useRef<string | null>(null);

  const markCopied = useCallback(() => {
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, []);

  /*
  FNXC:Clipboard 2026-07-12-00:00:
  Direct navigator.clipboard.writeText crashes or mis-reports on non-secure origins such as mobile http://fusionstudio:4040; copyTextToClipboard centralizes the secure-context guard and execCommand fallback.
  */
  const handleCopy = useCallback(async () => {
    const textToCopy = deviceCode ?? instructions;
    const copiedToClipboard = await copyTextToClipboard(textToCopy);
    if (copiedToClipboard) markCopied();
  }, [deviceCode, instructions, markCopied]);

  useEffect(() => {
    const shouldAutoCopy = previousDeviceCodeRef.current === null && deviceCode !== null;
    previousDeviceCodeRef.current = deviceCode;

    if (!shouldAutoCopy) {
      return;
    }

    const autoCopy = async () => {
      const copiedToClipboard = await copyTextToClipboard(deviceCode);
      if (copiedToClipboard) markCopied();
    };

    void autoCopy();
  }, [deviceCode, markCopied]);

  return (
    <p className="auth-login-instructions" data-testid={testId}>
      {deviceCode ? (
        <>
          {instructions.split(deviceCode).map((part, i, arr) => (
            <span key={i}>
              {part}
              {i < arr.length - 1 && (
                <span className="device-code-wrapper">
                  <code className="device-code">{deviceCode}</code>
                  <button
                    className="device-code-copy-btn"
                    onClick={handleCopy}
                    title={copied ? "Copied!" : "Copy code"}
                    aria-label={copied ? "Copied to clipboard" : "Copy device code"}
                    type="button"
                  >
                    {copied ? <Check size={12} /> : <Copy size={12} />}
                  </button>
                </span>
              )}
            </span>
          ))}
        </>
      ) : (
        instructions
      )}
    </p>
  );
}
