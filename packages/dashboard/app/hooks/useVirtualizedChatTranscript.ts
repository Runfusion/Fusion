import type { RefObject } from "react";
import {
  calculateVirtualListRange,
  useVirtualizedList,
  type VirtualListRange,
  type VirtualizedList,
} from "./useVirtualizedList";

export type VirtualTranscriptRange = VirtualListRange;
export type VirtualizedChatTranscript = VirtualizedList;

interface VirtualTranscriptOptions {
  transcriptKey: string | null;
  keys: readonly string[];
  scrollRef: RefObject<HTMLElement | null>;
  estimateHeight?: number;
  overscanViewports?: number;
  maxRenderedRows?: number;
}

/**
 * Compatibility calculator for the Direct and Planner transcript surfaces.
 * Generic list windowing lives in useVirtualizedList so every long dashboard collection shares the same geometry rules.
 */
export const calculateVirtualTranscriptRange = calculateVirtualListRange;

/*
FNXC:ListVirtualization 2026-09-07-16:03:
Direct and Planner transcripts retain their stable public hook while delegating variable-height measurement, bounded overscan, anchor restoration, and collection reset to the dashboard-wide list virtualizer.
*/
export function useVirtualizedChatTranscript(options: VirtualTranscriptOptions): VirtualizedChatTranscript {
  const { transcriptKey, ...rest } = options;
  return useVirtualizedList({ collectionKey: transcriptKey, ...rest });
}
