import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { usePluginUiContributions, __test_clearContributionsCache } from "../usePluginUiContributions";
import * as api from "../../api";
import type { PluginUiContributionEntry } from "../../api";

vi.mock("../../api", () => ({
  fetchPluginUiContributions: vi.fn(),
}));

const mockFetchPluginUiContributions = vi.mocked(api.fetchPluginUiContributions);

function createContributionEntry(surface: PluginUiContributionEntry["contribution"]["surface"]): PluginUiContributionEntry {
  return {
    pluginId: "plugin-a",
    contribution: {
      surface,
      contributionId: `${surface}-id`,
      title: `${surface} title`,
      providerId: "openai",
      providerType: "api_key",
    } as PluginUiContributionEntry["contribution"],
  };
}

describe("usePluginUiContributions", () => {
  beforeEach(() => {
    mockFetchPluginUiContributions.mockReset();
    __test_clearContributionsCache();
  });

  it("fetches contributions and returns them", async () => {
    const data = [createContributionEntry("settings-provider-card")];
    mockFetchPluginUiContributions.mockResolvedValueOnce(data);

    const { result } = renderHook(() => usePluginUiContributions());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBeNull();
    expect(result.current.contributions).toEqual(data);
  });

  it("filters contributions by surface", async () => {
    const data = [
      createContributionEntry("settings-provider-card"),
      createContributionEntry("onboarding-provider-card"),
    ];
    mockFetchPluginUiContributions.mockResolvedValueOnce(data);

    const { result } = renderHook(() => usePluginUiContributions());

    await waitFor(() => expect(result.current.loading).toBe(false));
    const filtered = result.current.getContributionsForSurface("settings-provider-card");
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.contribution.surface).toBe("settings-provider-card");
  });

  it("uses cache on repeated load", async () => {
    const data = [createContributionEntry("post-onboarding-recommendation")];
    mockFetchPluginUiContributions.mockResolvedValueOnce(data);

    const { result: first } = renderHook(() => usePluginUiContributions("proj"));
    await waitFor(() => expect(first.current.loading).toBe(false));

    mockFetchPluginUiContributions.mockClear();

    const { result: second } = renderHook(() => usePluginUiContributions("proj"));
    await waitFor(() => expect(second.current.loading).toBe(false));

    expect(second.current.contributions).toEqual(data);
    expect(mockFetchPluginUiContributions).not.toHaveBeenCalled();
  });
});
