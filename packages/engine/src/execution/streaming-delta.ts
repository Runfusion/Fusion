type StreamingContentBlock = {
  type?: string;
  text?: string;
  thinking?: string;
};

type StreamingPartialMessage = {
  content?: StreamingContentBlock[];
};

export function normalizeStreamingDelta(previousText: string, nextDelta: string): string {
  if (!previousText || !nextDelta) {
    return nextDelta;
  }

  const previousChar = previousText.slice(-1);
  const nextChar = nextDelta[0] ?? "";

  if (/\s/.test(previousChar) || /\s/.test(nextChar)) {
    return nextDelta;
  }

  /*
   FNXC:ChatStreaming 2026-08-19-13:52:
   Sentence-boundary repair must leave digit-period-digit continuations intact. Stream chunks can split model versions, decimals, IP addresses, and URL path segments at the period, so inserting a space here corrupts persisted Chat Markdown and its destination.
   */
  const isNumericTokenContinuation =
    previousChar === "." && /\d/.test(previousText.slice(-2, -1)) && /\d/.test(nextChar);

  // Claude sometimes splits adjacent sentences across separate deltas or text
  // blocks without preserving the separating space. Only repair the specific
  // "sentence punctuation + uppercase/quoted sentence start" case so code,
  // domains, lowercase continuations, and numeric tokens remain untouched.
  if (!isNumericTokenContinuation && /[.!?]/.test(previousChar) && /[A-Z0-9"'([]/.test(nextChar)) {
    return ` ${nextDelta}`;
  }

  return nextDelta;
}

function getContentText(block: StreamingContentBlock | undefined, kind: "text" | "thinking"): string {
  if (!block || block.type !== kind) {
    return "";
  }
  if (kind === "text") {
    return typeof block.text === "string" ? block.text : "";
  }
  return typeof block.thinking === "string" ? block.thinking : "";
}

function derivePreviousText(accumulatedText: string, delta: string): string {
  if (!accumulatedText || !delta) {
    return accumulatedText;
  }
  return accumulatedText.endsWith(delta)
    ? accumulatedText.slice(0, Math.max(0, accumulatedText.length - delta.length))
    : accumulatedText;
}

function findPreviousBlockText(
  partial: StreamingPartialMessage,
  contentIndex: number,
  kind: "text" | "thinking",
): string {
  const content = partial.content;
  if (!Array.isArray(content)) {
    return "";
  }

  for (let i = contentIndex - 1; i >= 0; i--) {
    const text = getContentText(content[i], kind);
    if (text) {
      return text;
    }
  }
  return "";
}

function derivePreviousTextFromEvent(
  partial: StreamingPartialMessage | undefined,
  contentIndex: number,
  delta: string,
  kind: "text" | "thinking",
): string {
  const content = partial?.content;
  const block = Array.isArray(content) && Number.isInteger(contentIndex) && contentIndex >= 0
    ? content[contentIndex]
    : undefined;

  const accumulatedText = getContentText(block, kind);
  let previousText = derivePreviousText(accumulatedText, delta);

  if (!previousText && partial && Number.isInteger(contentIndex) && contentIndex > 0) {
    previousText = findPreviousBlockText(partial, contentIndex, kind);
  }

  return previousText;
}

/*
FNXC:ThinkingTrace 2026-08-22-16:56:
FN-155 regression coverage proves the normalizer returns multi-section thinking deltas losslessly. A titles-only trace therefore originates in the provider payload, not this Fusion capture chokepoint.
*/
export function createStreamingDeltaNormalizer(): {
  normalize: (
    partial: StreamingPartialMessage | undefined,
    contentIndex: number,
    delta: string,
    kind: "text" | "thinking",
  ) => string;
} {
  let lastTextTail = "";
  let lastThinkingTail = "";

  return {
    normalize(partial, contentIndex, delta, kind) {
      const derivedPreviousText = derivePreviousTextFromEvent(partial, contentIndex, delta, kind);
      const previousText = derivedPreviousText || (kind === "text" ? lastTextTail : lastThinkingTail);
      const result = normalizeStreamingDelta(previousText, delta);

      if (result) {
        /*
        FNXC:ChatStreaming 2026-08-19-14:34:
        Fallback normalization has no partial message to inspect. Retain two characters per stream so its numeric-boundary classifier can still see the digit before a trailing period.
        */
        const tail = result.slice(-2);
        if (kind === "text") {
          lastTextTail = tail;
        } else {
          lastThinkingTail = tail;
        }
      }

      return result;
    },
  };
}

export function normalizeStreamingDeltaFromEvent(
  partial: StreamingPartialMessage | undefined,
  contentIndex: number,
  delta: string,
  kind: "text" | "thinking",
): string {
  return normalizeStreamingDelta(derivePreviousTextFromEvent(partial, contentIndex, delta, kind), delta);
}
