import { createContext, createElement, useContext, type ReactNode } from "react";

/*
FNXC:QuickEntry 2026-08-16-03:15:
Quick Add renders from the deep Column and ListView hosts without a shared settings prop channel. This context mirrors ModalDismissPreferenceProvider so global keyboard preference reaches both hosts while the true default preserves unwrapped components and existing tests.
*/
const QuickAddSubmitOnEnterContext = createContext(true);

export function QuickAddSubmitOnEnterProvider({
  enabled,
  children,
}: {
  enabled: boolean;
  children: ReactNode;
}) {
  return createElement(QuickAddSubmitOnEnterContext.Provider, { value: enabled }, children);
}

export function useQuickAddSubmitOnEnter(): boolean {
  return useContext(QuickAddSubmitOnEnterContext);
}
