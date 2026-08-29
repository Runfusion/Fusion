import { useCallback, useLayoutEffect, useRef } from "react";

const DEFAULT_MIN_HEIGHT = 40;
const DEFAULT_MAX_HEIGHT = 320;

export function clampTextareaHeight(scrollHeight: number, opts: { min: number; max: number }): number {
  return Math.max(opts.min, Math.min(scrollHeight, opts.max));
}

interface UseAutosizeTextareaOptions {
  value: string;
  minHeight?: number;
  maxHeight?: number;
  deps?: unknown[];
}

interface UseAutosizeTextareaResult {
  ref: (node: HTMLTextAreaElement | null) => void;
  resize: () => void;
}

export function useAutosizeTextarea({
  value,
  minHeight = DEFAULT_MIN_HEIGHT,
  maxHeight = DEFAULT_MAX_HEIGHT,
  deps = [],
}: UseAutosizeTextareaOptions): UseAutosizeTextareaResult {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const resize = useCallback(() => {
    const node = textareaRef.current;
    if (!node) {
      return;
    }

    node.style.height = "auto";
    node.style.height = `${clampTextareaHeight(node.scrollHeight, { min: minHeight, max: maxHeight })}px`;
  }, [maxHeight, minHeight]);

  const ref = useCallback(
    (node: HTMLTextAreaElement | null) => {
      textareaRef.current = node;
      if (!node) {
        return;
      }
      node.style.height = "auto";
      node.style.height = `${clampTextareaHeight(node.scrollHeight, { min: minHeight, max: maxHeight })}px`;
    },
    [maxHeight, minHeight],
  );

  useLayoutEffect(() => {
    resize();
  }, [resize, value, ...deps]);

  return { ref, resize };
}
