import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import React from "react";
import { ConfirmDialog } from "../components/ConfirmDialog";

export interface ConfirmOptions {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

interface PendingConfirm {
  options: ConfirmOptions;
  resolve: (value: boolean) => void;
}

interface ConfirmContextValue {
  confirm: (options: ConfirmOptions) => Promise<boolean>;
}

const ConfirmContext = createContext<ConfirmContextValue | null>(null);

export function ConfirmDialogProvider({ children }: { children: ReactNode }) {
  const [queue, setQueue] = useState<PendingConfirm[]>([]);
  const queueRef = useRef<PendingConfirm[]>([]);

  const updateQueue = useCallback((updater: (current: PendingConfirm[]) => PendingConfirm[]) => {
    setQueue((current) => {
      const next = updater(current);
      queueRef.current = next;
      return next;
    });
  }, []);

  const confirm = useCallback((options: ConfirmOptions) => {
    return new Promise<boolean>((resolve) => {
      updateQueue((current) => [...current, { options, resolve }]);
    });
  }, [updateQueue]);

  const resolveCurrent = useCallback((value: boolean) => {
    const current = queueRef.current[0];
    if (!current) {
      return;
    }

    current.resolve(value);
    updateQueue((items) => items.slice(1));
  }, [updateQueue]);

  const active = queue[0] ?? null;

  const contextValue = useMemo<ConfirmContextValue>(() => ({ confirm }), [confirm]);

  return React.createElement(
    ConfirmContext.Provider,
    { value: contextValue },
    children,
    React.createElement(ConfirmDialog, {
      isOpen: active !== null,
      options: active?.options ?? null,
      onConfirm: () => resolveCurrent(true),
      onCancel: () => resolveCurrent(false),
    })
  );
}

export function useConfirm(): ConfirmContextValue {
  const context = useContext(ConfirmContext);
  if (context) {
    return context;
  }

  return {
    confirm: async (_options: ConfirmOptions) => false,
  };
}
