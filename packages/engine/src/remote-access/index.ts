export {
  getTunnelProviderAdapter,
  redactTunnelText,
} from "./provider-adapters.js";

export { TunnelProcessManager, type TunnelProcessManagerOptions } from "./tunnel-process-manager.js";

export {
  RemoteTunnelService,
  getRemoteTunnelService,
  peekRemoteTunnelService,
  remoteTunnelScopeKey,
  shutdownRemoteTunnelService,
  shutdownAllRemoteTunnels,
  preserveRemoteTunnelForSupervisedRestart,
  preserveAllRemoteTunnelsForSupervisedRestart,
  __resetRemoteTunnelServicesForTests,
  type RemoteLifecycleEvaluation,
} from "./remote-tunnel-service.js";

export type {
  CloudflareProviderConfig,
  ExternalTunnelInfo,
  ManagedTunnelProcess,
  PreparedTunnelCommand,
  TailscaleProviderConfig,
  TunnelError,
  TunnelErrorCode,
  TunnelLifecycleState,
  TunnelLogEntry,
  TunnelLogLevel,
  TunnelLogListener,
  TunnelManager,
  TunnelOutputStream,
  TunnelProvider,
  TunnelProviderAdapter,
  TunnelProviderConfig,
  TunnelReadinessEvent,
  TunnelRestoreDiagnostics,
  TunnelRestoreOutcome,
  TunnelRestoreReasonCode,
  TunnelStatusListener,
  TunnelStatusSnapshot,
} from "./types.js";
