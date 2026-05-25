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
  tertiaryLabel?: string;
  tertiaryDanger?: boolean;
  checkbox?: {
    label: string;
    description?: string;
    defaultChecked?: boolean;
  };
}

export type ConfirmChoice = "primary" | "tertiary" | "cancel";

interface PendingConfirm {
  options: ConfirmOptions;
  checkboxValue: boolean;
  resolve: (value: { choice: ConfirmChoice; checkboxValue: boolean }) => void;
}

interface ConfirmContextValue {
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  confirmWithChoice: (options: ConfirmOptions) => Promise<ConfirmChoice>;
  confirmWithCheckbox: (options: ConfirmOptions) => Promise<{ choice: ConfirmChoice; checkboxValue: boolean }>;
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

  const confirmWithCheckbox = useCallback((options: ConfirmOptions) => {
    return new Promise<{ choice: ConfirmChoice; checkboxValue: boolean }>((resolve) => {
      updateQueue((current) => [
        ...current,
        {
          options,
          checkboxValue: options.checkbox?.defaultChecked ?? false,
          resolve,
        },
      ]);
    });
  }, [updateQueue]);

  const confirmWithChoice = useCallback(async (options: ConfirmOptions) => {
    const { choice } = await confirmWithCheckbox(options);
    return choice;
  }, [confirmWithCheckbox]);

  const confirm = useCallback(async (options: ConfirmOptions) => {
    const choice = await confirmWithChoice(options);
    return choice === "primary";
  }, [confirmWithChoice]);

  const resolveCurrent = useCallback((value: ConfirmChoice) => {
    const current = queueRef.current[0];
    if (!current) {
      return;
    }

    current.resolve({ choice: value, checkboxValue: current.checkboxValue });
    updateQueue((items) => items.slice(1));
  }, [updateQueue]);

  const active = queue[0] ?? null;

  const contextValue = useMemo<ConfirmContextValue>(
    () => ({ confirm, confirmWithChoice, confirmWithCheckbox }),
    [confirm, confirmWithCheckbox, confirmWithChoice]
  );

  return React.createElement(
    ConfirmContext.Provider,
    { value: contextValue },
    children,
    React.createElement(ConfirmDialog, {
      isOpen: active !== null,
      options: active?.options ?? null,
      onConfirm: () => resolveCurrent("primary"),
      onTertiary: () => resolveCurrent("tertiary"),
      onCancel: () => resolveCurrent("cancel"),
      checkboxLabel: active?.options.checkbox?.label,
      checkboxDescription: active?.options.checkbox?.description,
      checkboxChecked: active?.checkboxValue ?? false,
      onCheckboxChange: (next) => {
        updateQueue((current) => {
          if (current.length === 0) {
            return current;
          }
          const [head, ...tail] = current;
          return [{ ...head, checkboxValue: next }, ...tail];
        });
      },
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
    confirmWithChoice: async (_options: ConfirmOptions) => "cancel",
    confirmWithCheckbox: async (options: ConfirmOptions) => ({
      choice: "cancel",
      checkboxValue: options.checkbox?.defaultChecked ?? false,
    }),
  };
}
