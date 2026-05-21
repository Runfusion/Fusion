/**
 * Unified Window.__fusionDebug type declaration.
 *
 * Dashboard instrumentation modules each contribute a sub-property to this
 * shared interface instead of declaring their own competing `declare global`
 * blocks (which causes TS2717 / TS2339).
 */
export {};

declare global {
  interface Window {
    __fusionDebug?: {
      dashboardTraces?: {
        get: () => import("../utils/dashboardTraceBuffer").TraceEntry[];
        clear: () => void;
      };
      resumeInstrumentation?: {
        get: () => import("../utils/resumeInstrumentation").ResumeEvent[];
        clear: () => void;
        setEnabled: (enabled: boolean) => void;
      };
    };
  }
}
