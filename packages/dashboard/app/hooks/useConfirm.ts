import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import React from "react";
import { ConfirmDialog } from "../components/ConfirmDialog";

export interface ConfirmOptions {
  title: string;
  message: string;
  /*
  FNXC:ConfirmDialogs 2026-07-18-06:00:
  Dialogs that GATE an action on an informed choice (e.g. "git is missing —
  create without a repo?") must render even when the operator globally skips
  critical-action confirmations: auto-resolving "primary" would silently pick
  an option the operator never saw (review finding: skip-confirmations turned
  the git-missing clone dialog into an endless silent browser-tab opener).
  */
  alwaysAsk?: boolean;
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
  select?: {
    label: string;
    options: Array<{ value: string; label: string }>;
    defaultValue?: string;
  };
}

export type ConfirmChoice = "primary" | "tertiary" | "cancel";
export interface ConfirmResult {
  choice: ConfirmChoice;
  checkboxValue: boolean;
  selectValue?: string;
}

interface PendingConfirm {
  options: ConfirmOptions;
  checkboxValue: boolean;
  selectValue?: string;
  resolve: (value: ConfirmResult) => void;
}

interface ConfirmContextValue {
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  confirmWithChoice: (options: ConfirmOptions) => Promise<ConfirmChoice>;
  confirmWithCheckbox: (options: ConfirmOptions) => Promise<ConfirmResult>;
  confirmWithSelect: (options: ConfirmOptions) => Promise<ConfirmResult>;
}

const ConfirmContext = createContext<ConfirmContextValue | null>(null);

export function ConfirmDialogProvider({
  children,
  skipConfirmations = false,
}: {
  children: ReactNode;
  skipConfirmations?: boolean;
}) {
  const [queue, setQueue] = useState<PendingConfirm[]>([]);
  const queueRef = useRef<PendingConfirm[]>([]);
  const skipConfirmationsRef = useRef(skipConfirmations);
  skipConfirmationsRef.current = skipConfirmations;

  const updateQueue = useCallback((updater: (current: PendingConfirm[]) => PendingConfirm[]) => {
    setQueue((current) => {
      const next = updater(current);
      queueRef.current = next;
      return next;
    });
  }, []);

  const confirmWithCheckbox = useCallback((options: ConfirmOptions) => {
    /*
    FNXC:ConfirmDialogs 2026-07-16-05:30:
    Operators who globally skip critical-action confirmations must receive the same primary/default result as clicking the dialog's primary button. Never invent a different outcome or enqueue a hidden dialog; checkbox prompts retain their configured default value.

    FNXC:ConfirmDialogs 2026-08-28-04:16:
    A select whose default is the safe status-quo choice intentionally follows the checkbox contract.
    Operators who disabled confirmations keep today's action behavior, including the configured select
    default, instead of receiving a newly mandatory prompt.
    */
    const selectValue = options.select?.defaultValue ?? options.select?.options[0]?.value;
    if (skipConfirmationsRef.current && !options.alwaysAsk) {
      return Promise.resolve({
        choice: "primary" as const,
        checkboxValue: options.checkbox?.defaultChecked ?? false,
        selectValue: options.select?.defaultValue,
      });
    }

    return new Promise<ConfirmResult>((resolve) => {
      updateQueue((current) => [
        ...current,
        {
          options,
          checkboxValue: options.checkbox?.defaultChecked ?? false,
          selectValue,
          resolve,
        },
      ]);
    });
  }, [updateQueue]);

  const confirmWithSelect = confirmWithCheckbox;

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

    current.resolve({ choice: value, checkboxValue: current.checkboxValue, selectValue: current.selectValue });
    updateQueue((items) => items.slice(1));
  }, [updateQueue]);

  const active = queue[0] ?? null;

  const contextValue = useMemo<ConfirmContextValue>(
    () => ({ confirm, confirmWithChoice, confirmWithCheckbox, confirmWithSelect }),
    [confirm, confirmWithCheckbox, confirmWithChoice, confirmWithSelect]
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
      selectValue: active?.selectValue,
      onSelectChange: (next) => {
        updateQueue((current) => {
          if (current.length === 0) {
            return current;
          }
          const [head, ...tail] = current;
          return [{ ...head, selectValue: next }, ...tail];
        });
      },
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
      selectValue: options.select?.defaultValue,
    }),
    confirmWithSelect: async (options: ConfirmOptions) => ({
      choice: "cancel",
      checkboxValue: options.checkbox?.defaultChecked ?? false,
      selectValue: options.select?.defaultValue,
    }),
  };
}
