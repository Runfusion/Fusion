/**
 * Provider id consumed by the engine's mock runtime short-circuit.
 * Kept in core so task/settings/provider selection can share one literal.
 */
export const MOCK_PROVIDER_ID = "mock" as const;

export type MockProviderId = typeof MOCK_PROVIDER_ID;

export type MockSessionPurpose =
  | "executor"
  | "triage"
  | "reviewer"
  | "merger"
  | "heartbeat"
  | "validation";
