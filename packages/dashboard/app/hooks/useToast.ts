import { useState, useCallback, useRef, createContext, useContext, useEffect } from "react";
import type { ReactNode } from "react";
import React from "react";

export type ToastType = "success" | "error" | "info" | "warning";

export interface Toast {
  id: number;
  message: string;
  type: ToastType;
}

interface ToastContextValue {
  toasts: Toast[];
  addToast: (message: string, type?: ToastType) => void;
  removeToast: (id: number) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(0);
  const timers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  const removeToast = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const addToast = useCallback((message: string, type: ToastType = "info") => {
    // Suppress bare network-failure toasts (TypeError "Failed to fetch" from
    // aborted in-flight requests when the tab is backgrounded/resumed on
    // mobile). Toasts with additional context still pass through.
    if (type === "error" && /^\s*Failed to fetch\.?\s*$/i.test(message)) {
      return;
    }
    const id = nextId.current++;
    setToasts((prev) => [...prev, { id, message, type }]);
    const timer = setTimeout(() => removeToast(id), 4000);
    timers.current.set(id, timer);
  }, [removeToast]);

  // Clear all pending timers on unmount to prevent state updates on unmounted components
  useEffect(() => {
    return () => {
      timers.current.forEach((timer) => clearTimeout(timer));
      timers.current.clear();
    };
  }, []);

  return React.createElement(ToastContext.Provider, { value: { toasts, addToast, removeToast } }, children);
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within ToastProvider");
  return ctx;
}

/*
FNXC:ToastProvider 2026-07-14-19:25:
Board-card decorations such as RuntimeFallbackBadge may mount outside a full app shell (unit/harness tests and optional plugin surfaces). Optional toast access lets those leaves skip toasting instead of throwing and blanking the board via ErrorBoundary.
*/
export function useOptionalToast(): ToastContextValue | null {
  return useContext(ToastContext);
}
