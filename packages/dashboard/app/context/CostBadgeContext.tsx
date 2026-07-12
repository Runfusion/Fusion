import { createContext, useContext, type ReactNode } from "react";
import type { ModelPricingOverrides } from "../../../core/src/model-pricing";

export interface CostBadgeContextValue {
  enabled: boolean;
  pricingOverrides?: ModelPricingOverrides;
}

const CostBadgeContext = createContext<CostBadgeContextValue>({ enabled: false });

export function CostBadgeProvider(
  { value, children }: { value: CostBadgeContextValue; children: ReactNode },
) {
  return <CostBadgeContext.Provider value={value}>{children}</CostBadgeContext.Provider>;
}

export function useCostBadge(): CostBadgeContextValue {
  return useContext(CostBadgeContext);
}
