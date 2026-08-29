/**
 * Dashboard surface entry for the Compound Engineering plugin (U3).
 *
 * Thin re-export of the real hub component (mirrors how reports splits
 * `src/dashboard-view.tsx` from `src/dashboard/ReportsView.tsx`). The export
 * name `CompoundEngineeringDashboardView` is the one `registerBundledPluginViews`
 * imports — `componentPath` in the manifest is cosmetic; this binding is real.
 */
export {
  CompoundEngineeringView as CompoundEngineeringDashboardView,
  default,
} from "./dashboard/CompoundEngineeringView.js";
