type StreamingContentBlock = {
  type?: string;
  text?: string;
  thinking?: string;
};

type StreamingPartialMessage = {
  content?: StreamingContentBlock[];
};

type Kind = "text" | "thinking";
type BlockIdentity = { partial: object | undefined; contentIndex: number | undefined; partialFree: boolean };

export function normalizeStreamingDelta(previousText: string, nextDelta: string): string {
  if (!previousText || !nextDelta) return nextDelta;
  const previousChar = previousText.slice(-1);
  const nextChar = nextDelta[0] ?? "";
  if (/\s/.test(previousChar) || /\s/.test(nextChar)) return nextDelta;
  const isNumericTokenContinuation = previousChar === "." && /\d/.test(previousText.slice(-2, -1)) && /\d/.test(nextChar);
  if (!isNumericTokenContinuation && /[.!?]/.test(previousChar) && /[A-Z0-9"'([]/.test(nextChar)) return ` ${nextDelta}`;
  return nextDelta;
}

function getContentText(block: StreamingContentBlock | undefined, kind: Kind): string {
  if (!block || block.type !== kind) return "";
  return kind === "text" ? (typeof block.text === "string" ? block.text : "") : (typeof block.thinking === "string" ? block.thinking : "");
}

function derivePreviousText(partial: StreamingPartialMessage | undefined, contentIndex: number, delta: string, kind: Kind): string {
  const content = partial?.content;
  const block = Array.isArray(content) && Number.isInteger(contentIndex) && contentIndex >= 0 ? content[contentIndex] : undefined;
  const accumulated = getContentText(block, kind);
  return accumulated && delta && accumulated.endsWith(delta) ? accumulated.slice(0, Math.max(0, accumulated.length - delta.length)) : accumulated;
}

function identityFor(partial: StreamingPartialMessage | undefined, contentIndex: number): BlockIdentity {
  const objectPartial = partial !== null && typeof partial === "object" ? partial as object : undefined;
  const validIndex = Number.isInteger(contentIndex) && contentIndex >= 0 ? contentIndex : undefined;
  return { partial: objectPartial, contentIndex: validIndex, partialFree: !objectPartial };
}

function sameIdentity(left: BlockIdentity | undefined, right: BlockIdentity): boolean {
  return !!left && left.partial === right.partial && left.contentIndex === right.contentIndex && left.partialFree === right.partialFree;
}

/*
FNXC:AssistantTextCapture 2026-09-08-14:13:
FN-9277 restricts sentence-boundary repair to evidence from the current content block. Stale sibling and prior-message tails inserted spaces into paragraphs and REPRO MARKER B; verbatim block flushes bind their tail to this identity so same-block continuation repair remains intact.
*/
export function createStreamingDeltaNormalizer(): {
  normalize: (partial: StreamingPartialMessage | undefined, contentIndex: number, delta: string, kind: Kind) => string;
  noteEmitted: (kind: Kind, text: string, partial?: unknown, contentIndex?: number) => void;
  noteBoundary: (kind: Kind) => void;
} {
  const tails: Record<Kind, string> = { text: "", thinking: "" };
  const identities: Partial<Record<Kind, BlockIdentity>> = {};
  const clear = (kind: Kind) => { tails[kind] = ""; delete identities[kind]; };
  return {
    normalize(partial, contentIndex, delta, kind) {
      const identity = identityFor(partial, contentIndex);
      if (!sameIdentity(identities[kind], identity)) clear(kind);
      const previous = derivePreviousText(partial, contentIndex, delta, kind) || tails[kind];
      const result = normalizeStreamingDelta(previous, delta);
      if (result) {
        tails[kind] = result.slice(-2);
        identities[kind] = identity;
      }
      return result;
    },
    noteEmitted(kind, text, partial, contentIndex) {
      if (!text) return;
      tails[kind] = text.slice(-2);
      identities[kind] = identityFor(partial as StreamingPartialMessage | undefined, contentIndex ?? 0);
    },
    noteBoundary: clear,
  };
}

export function normalizeStreamingDeltaFromEvent(partial: StreamingPartialMessage | undefined, contentIndex: number, delta: string, kind: Kind): string {
  return normalizeStreamingDelta(derivePreviousText(partial, contentIndex, delta, kind), delta);
}
