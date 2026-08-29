export const DASHBOARD_STARTUP_STATUS = {
  initializingTaskStore: "Initializing task store…",
  startingFileWatcher: "Starting file watcher…",
  initializingAgentStore: "Initializing agent store…",
  startingAgents: "Starting agents…",
  loadingExtensions: "Loading extensions…",
  startingEngine: "Starting engine…",
} as const;

export type DashboardTuiStartupLike = {
  start: () => Promise<void>;
  setLoadingStatus: (status: string) => void;
};

export async function defaultEventLoopYield(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

export async function runTuiStartupPrelude(
  tui: DashboardTuiStartupLike,
  yieldFn: () => Promise<void> = defaultEventLoopYield,
): Promise<void> {
  await tui.start();
  await yieldFn();
  tui.setLoadingStatus(DASHBOARD_STARTUP_STATUS.initializingTaskStore);
}
