import type { ChatMessage } from "@fusion/core";
import type { Dispatch, RefObject, SetStateAction } from "react";
import type { ChatFailureInfo } from "../api";
import type { ChatMessageInfo, FallbackInfo, ToolCallInfo } from "./chatTypes";

/**
 * Inputs for the chat streaming-handler factory.
 *
 * The shared factory owns the per-stream accumulator state (text, thinking,
 * tool calls, fallback info), the requestAnimationFrame coalescing of state
 * updates, and the SSE event → state-setter wiring. Caller-specific behaviour
 * for the terminal events (`onDone`, `onError`) and the optional
 * `onFallbackSession` model-swap is provided through callbacks so that
 * `useChat` can plug in session-management semantics without re-implementing
 * the streaming machinery.
 */
export interface CreateChatStreamHandlersOptions {
  /** Active session id — used by `onFallbackSession` for parent-side updates. */
  sessionId: string;
  /** Optimistic temp id of the user message added before the stream started. */
  tempUserMessageId: string;
  /** Existing text snapshot for reattaching to an in-flight generation. */
  initialText?: string;
  /** Existing thinking snapshot for reattaching to an in-flight generation. */
  initialThinking?: string;
  /** Existing tool-call snapshot for reattaching to an in-flight generation. */
  initialToolCalls?: ToolCallInfo[];
  /**
   * The latest text/thinking/tool-call snapshots that are committed to React
   * state. We pass setters (not values) so the factory can flush per-frame
   * without rerunning the parent's effects.
   */
  setStreamingText: Dispatch<SetStateAction<string>>;
  setStreamingThinking: Dispatch<SetStateAction<string>>;
  setStreamingToolCalls: Dispatch<SetStateAction<ToolCallInfo[]>>;
  /**
   * Caller-side `cancelStreamingFlushes` ref slot. The factory writes its own
   * cancel function here so `stopStreaming` (in either parent hook) can call
   * it to abort pending RAF flushes regardless of which sendMessage owns them.
   */
  cancelStreamingFlushesRef: RefObject<(() => void) | null>;
  /** Optional toast helper, used to surface fallback-model warnings + errors. */
  addToast?: (message: string, level: "error" | "warning" | "success") => void;
  /** Caller-supplied terminal handlers — bind in their own state setters. */
  onDone: (data: {
    messageId: string;
    message?: ChatMessage;
    accumulated: {
      text: string;
      thinking: string;
      toolCalls: ToolCallInfo[];
      fallbackInfo?: FallbackInfo;
    };
  }) => void;
  onError: (data: string | ChatFailureInfo, tempUserMessageId: string) => void;
  /**
   * Fallback-model side effect for the parent (e.g. updating the session list
   * or the active session's model fields). The factory still emits the toast.
   */
  onFallbackSession?: (data: FallbackInfo, sessionId: string) => void;
}

export interface ChatStreamHandlers {
  onThinking: (delta: string) => void;
  onText: (delta: string) => void;
  onToolStart: (data: { toolName: string; args?: Record<string, unknown> }) => void;
  onToolEnd: (data: { toolName: string; isError: boolean; result?: unknown }) => void;
  onFallback: (data: FallbackInfo) => void;
  onDone: (data: { messageId: string; message?: ChatMessage }) => void;
  onError: (data: string | ChatFailureInfo) => void;
}

export interface CreateChatStreamHandlersResult {
  handlers: ChatStreamHandlers;
  /** Cancel any pending RAF flushes for this stream. Idempotent. */
  cancelFlushes: () => void;
}

/**
 * Build the SSE handler bundle that `streamChatResponse` consumes. This is the
 * portion of the chat send/stream flow that is easier to test as a focused
 * seam; extracting it keeps coalescing, tool-call dedup, fallback toasts, etc.
 * independent from the hook. The terminal events
 * (`onDone`/`onError`) and parent-side fallback bookkeeping stay caller-owned
 * because each hook handles message persistence and error recovery
 * differently.
 *
 * The factory writes its `cancelFlushes` into `cancelStreamingFlushesRef.current`
 * so the parent's `stopStreaming` can drain pending RAF callbacks before
 * clearing transient streaming state — preventing a flushed delta from
 * flashing back into the UI after a stop.
 */
export function createChatStreamHandlers(
  options: CreateChatStreamHandlersOptions,
): CreateChatStreamHandlersResult {
  const {
    sessionId,
    tempUserMessageId,
    initialText,
    initialThinking,
    initialToolCalls,
    setStreamingText,
    setStreamingThinking,
    setStreamingToolCalls,
    cancelStreamingFlushesRef,
    addToast,
    onDone,
    onError,
    onFallbackSession,
  } = options;

  /**
   * FNXC:ChatStreaming 2026-06-18-05:59:
   * Reattached streams must seed their private accumulators from the durable in-flight snapshot, not only paint that snapshot into React state. The SSE replay starts after replayFromEventId, so the first post-reattach delta must append to snapshot text/thinking/tool calls instead of replacing everything the user already saw on load.
   */
  let capturedText = initialText ?? "";
  let capturedThinking = initialThinking ?? "";
  let capturedToolCalls: ToolCallInfo[] = initialToolCalls ? [...initialToolCalls] : [];
  let capturedFallbackInfo: FallbackInfo | undefined;

  // Coalesce per-token state updates to one render per animation frame.
  // ReactMarkdown re-parses the entire growing string on every render and
  // every prior message also re-renders, so unthrottled setState here pegs
  // the main thread on long replies.
  let textRaf: number | null = null;
  let thinkingRaf: number | null = null;
  const flushText = (): void => {
    textRaf = null;
    setStreamingText(capturedText);
  };
  const flushThinking = (): void => {
    thinkingRaf = null;
    setStreamingThinking(capturedThinking);
  };
  const cancelFlushes = (): void => {
    if (textRaf !== null) {
      cancelAnimationFrame(textRaf);
      textRaf = null;
    }
    if (thinkingRaf !== null) {
      cancelAnimationFrame(thinkingRaf);
      thinkingRaf = null;
    }
  };
  cancelStreamingFlushesRef.current = cancelFlushes;

  const handlers: ChatStreamHandlers = {
    onThinking: (delta: string) => {
      capturedThinking += delta;
      if (thinkingRaf === null) {
        thinkingRaf = requestAnimationFrame(flushThinking);
      }
    },
    onText: (delta: string) => {
      capturedText += delta;
      if (textRaf === null) {
        textRaf = requestAnimationFrame(flushText);
      }
    },
    onToolStart: (data: { toolName: string; args?: Record<string, unknown> }) => {
      capturedToolCalls = [
        ...capturedToolCalls,
        {
          toolName: data.toolName,
          args: data.args,
          isError: false,
          status: "running",
        },
      ];
      setStreamingToolCalls(capturedToolCalls);
    },
    onToolEnd: (data: { toolName: string; isError: boolean; result?: unknown }) => {
      const nextToolCalls = [...capturedToolCalls];
      for (let i = nextToolCalls.length - 1; i >= 0; i--) {
        const candidate = nextToolCalls[i];
        if (candidate?.toolName === data.toolName && candidate.status === "running") {
          nextToolCalls[i] = {
            ...candidate,
            status: "completed",
            isError: data.isError,
            result: data.result,
          };
          capturedToolCalls = nextToolCalls;
          setStreamingToolCalls(nextToolCalls);
          return;
        }
      }
      capturedToolCalls = [
        ...nextToolCalls,
        {
          toolName: data.toolName,
          isError: data.isError,
          result: data.result,
          status: "completed",
        },
      ];
      setStreamingToolCalls(capturedToolCalls);
    },
    onFallback: (data: FallbackInfo) => {
      capturedFallbackInfo = data;
      onFallbackSession?.(data, sessionId);
      addToast?.(`Primary model unavailable. Switched to fallback ${data.fallbackModel}.`, "warning");
    },
    onDone: (data: { messageId: string; message?: ChatMessage }) => {
      cancelFlushes();
      onDone({
        messageId: data.messageId,
        message: data.message,
        accumulated: {
          text: capturedText,
          thinking: capturedThinking,
          toolCalls: capturedToolCalls,
          fallbackInfo: capturedFallbackInfo,
        },
      });
    },
    onError: (data: string | ChatFailureInfo) => {
      cancelFlushes();
      onError(data, tempUserMessageId);
    },
  };

  return { handlers, cancelFlushes };
}

export type { ChatMessageInfo };
