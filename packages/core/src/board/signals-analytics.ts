import type { SignalSeverityCount, SignalSourceCount } from "./activity-analytics.js";

export { aggregateSignalsAnalytics } from "./activity-analytics.js";
export type {
  ActivityAnalyticsQuery as SignalsAnalyticsQuery,
  SignalSourceCount,
  SignalSeverityCount,
  SignalsAnalytics,
} from "./activity-analytics.js";

/** Back-compat alias for the original pre-FN-6706 signals module name. */
export type SignalsBreakdown = SignalSourceCount;
/** Back-compat alias for the original pre-FN-6706 signals module name. */
export type SignalsSeverityBreakdown = SignalSeverityCount;
