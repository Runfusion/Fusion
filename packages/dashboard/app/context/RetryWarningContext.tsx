import { createContext, useContext, type ReactNode } from "react";

const RetryWarningContext = createContext<number | undefined>(undefined);

export function RetryWarningProvider(
  { value, children }: { value: number | undefined; children: ReactNode },
) {
  return <RetryWarningContext.Provider value={value}>{children}</RetryWarningContext.Provider>;
}

export function useRetryWarning(): number | undefined {
  return useContext(RetryWarningContext);
}
