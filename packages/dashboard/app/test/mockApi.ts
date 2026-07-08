/**
 * Canonical dashboard app API mock helper.
 *
 * Add new `app/api.ts` or `app/api/legacy.ts` exports here first before
 * introducing ad-hoc per-test `vi.mock("../../api", …)` export lists.
 *
 * Behavior contract:
 * - preserve real exports by default
 * - apply canonical/common test mocks
 * - allow per-suite overrides
 * - auto-synthesize stable fallback fns for missing callable exports
 */
import { vi, type Mock } from "vitest";

type AnyFn = Mock;
type AnyModule = Record<string, unknown>;

const fallbackFns = new Map<string, AnyFn>();

function getFallback(name: string): AnyFn {
  if (!fallbackFns.has(name)) {
    fallbackFns.set(name, vi.fn(async () => undefined));
  }
  return fallbackFns.get(name)!;
}

export const dashboardApiMocks: Record<string, AnyFn> = {
  fetchTasks: vi.fn(async () => []),
  // FNXC:ArchivePagination 2026-07-08-00:00: FN-7659 paged archived-tasks read.
  fetchArchivedTasks: vi.fn(async () => ({ tasks: [], total: 0, hasMore: false })),
  fetchSettings: vi.fn(async () => ({})),
  fetchTaskEffectiveSettings: vi.fn().mockRejectedValue(new Error("fetchTaskEffectiveSettings: use fetchSettings mock")),
  updateSettings: vi.fn(async () => ({})),
  fetchGlobalSettings: vi.fn(async () => ({})),
  fetchAuthStatus: vi.fn(async () => ({ providers: [] })),
  fetchModels: vi.fn(async () => ({ models: [], favoriteProviders: [], favoriteModels: [] })),
  fetchTaskDetail: vi.fn(),
  fetchTaskReview: vi.fn(),
  fetchUnreadCount: vi.fn(async () => ({ unreadCount: 0 })),
};

export async function createDashboardApiMock(
  importActual: () => Promise<AnyModule>,
  overrides: Record<string, AnyFn> = {},
): Promise<AnyModule> {
  const actual = await importActual();
  const mocked: AnyModule = { ...actual, ...dashboardApiMocks, ...overrides };

  return new Proxy(mocked, {
    get(target, prop, receiver) {
      if (typeof prop !== "string") return Reflect.get(target, prop, receiver);
      if (Reflect.has(target, prop)) return Reflect.get(target, prop, receiver);

      if (["then", "catch", "finally"].includes(prop)) {
        return undefined;
      }
      const actualValue = (actual as AnyModule)[prop];
      if (typeof actualValue === "function" || actualValue === undefined) {
        const fn = getFallback(prop);
        (target as AnyModule)[prop] = fn;
        return fn;
      }
      return actualValue;
    },
  });
}

export function resetDashboardApiMockState(): void {
  Object.values(dashboardApiMocks).forEach((fn) => fn.mockReset());
  dashboardApiMocks.fetchTasks.mockResolvedValue([]);
  dashboardApiMocks.fetchArchivedTasks.mockResolvedValue({ tasks: [], total: 0, hasMore: false });
  dashboardApiMocks.fetchSettings.mockResolvedValue({});
  dashboardApiMocks.fetchTaskEffectiveSettings.mockRejectedValue(new Error("fetchTaskEffectiveSettings: use fetchSettings mock"));
  dashboardApiMocks.updateSettings.mockResolvedValue({});
  dashboardApiMocks.fetchGlobalSettings.mockResolvedValue({});
  dashboardApiMocks.fetchAuthStatus.mockResolvedValue({ providers: [] });
  dashboardApiMocks.fetchModels.mockResolvedValue({ models: [], favoriteProviders: [], favoriteModels: [] });
  dashboardApiMocks.fetchUnreadCount.mockResolvedValue({ unreadCount: 0 });
  for (const fn of fallbackFns.values()) fn.mockReset();
}
